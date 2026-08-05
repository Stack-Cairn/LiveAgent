import type { SubagentRosterEntry, SubagentTemplateEntry } from "./protocol";
import type { SubagentIdentity, SubagentRunSummary, SubagentSpec, SubagentTemplate } from "./types";
import { truncateText } from "./utils";

const MAX_LISTED_AGENTS = 12;
const MAX_REMINDER_FIELD_CHARS = 360;

export function titleizeStableId(value: string) {
  const words = value
    .trim()
    .split(/[^a-zA-Z0-9]+/g)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

/**
 * Create the persistent identity for a new stable agent id. Creation fields
 * are honored verbatim; missing fields are derived mechanically from the id
 * or the referenced template — never inferred from prompt text.
 */
export function createSubagentIdentity(params: {
  parentConversationId: string;
  toolCallId: string;
  spec: SubagentSpec;
  template?: SubagentTemplate;
  now: number;
}): SubagentIdentity {
  const name =
    params.spec.name?.trim() ||
    params.template?.name.trim() ||
    titleizeStableId(params.spec.id) ||
    params.spec.id;
  const role = params.spec.role?.trim() || params.template?.description.trim() || name;
  return {
    parentConversationId: params.parentConversationId,
    agentId: params.spec.id,
    name,
    role,
    identityPrompt: params.spec.identity?.trim() ?? "",
    templateId: params.template?.id ?? params.spec.templateId,
    lastMode: params.spec.mode,
    createdToolCallId: params.toolCallId,
    createdAt: params.now,
    updatedAt: params.now,
  };
}

export function buildRosterEntries(
  identities: Iterable<SubagentIdentity>,
  latestRunsByAgent: Map<string, SubagentRunSummary>,
): SubagentRosterEntry[] {
  const entries: SubagentRosterEntry[] = [];
  for (const identity of identities) {
    const latestRun = latestRunsByAgent.get(identity.agentId);
    entries.push({
      id: identity.agentId,
      name: identity.name,
      role: identity.role,
      lastMode: identity.lastMode,
      lastStatus: latestRun?.status,
      lastSummary: latestRun?.summary ? truncateText(latestRun.summary, 500) : undefined,
    });
  }
  return entries;
}

export function buildTemplateEntries(templates: SubagentTemplate[]): SubagentTemplateEntry[] {
  return templates.map((template) => ({
    id: template.id,
    name: template.name,
    description: template.description || undefined,
  }));
}

/** Roster block embedded in the Agent tool description. */
export function formatRoster(entries: SubagentRosterEntry[]) {
  if (entries.length === 0) {
    return "No existing agents are recorded for this parent conversation.";
  }
  return entries
    .slice(0, MAX_LISTED_AGENTS)
    .map((entry) => {
      const status = entry.lastStatus ? ` status=${entry.lastStatus}` : "";
      const summary = entry.lastSummary ? ` summary=${entry.lastSummary}` : "";
      return `id=${entry.id} name=${entry.name} role=${entry.role} mode=${entry.lastMode}${status}${summary}`;
    })
    .join("\n");
}

/** Template block embedded in the Agent tool description. */
export function formatTemplates(entries: SubagentTemplateEntry[]) {
  if (entries.length === 0) return "No enabled AGENTS templates are available.";
  return entries
    .slice(0, MAX_LISTED_AGENTS)
    .map((entry) => {
      const description = entry.description ? ` - ${entry.description}` : "";
      return `${entry.id} (${entry.name})${description}`;
    })
    .join("\n");
}

function truncateReminderField(value: string, maxChars = MAX_REMINDER_FIELD_CHARS) {
  const text = value.trim().replace(/\s+/g, " ");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

/**
 * System-prompt reminder for the parent agent listing existing subagents,
 * so follow-up user requests are routed to the stable ids instead of the
 * parent impersonating them.
 */
export function buildRosterReminder(params: {
  identities: SubagentIdentity[];
  latestRunsByAgent: Map<string, SubagentRunSummary>;
}) {
  const identities = params.identities.filter(
    (identity) => identity.agentId.trim() && identity.name.trim(),
  );
  if (identities.length === 0) return "";

  const agentLines = identities.slice(0, MAX_LISTED_AGENTS).map((identity) => {
    const latestRun = params.latestRunsByAgent.get(identity.agentId);
    const fields = [
      `id=${identity.agentId}`,
      `name=${truncateReminderField(identity.name, 120)}`,
      `role=${truncateReminderField(identity.role, 160)}`,
      `mode=${identity.lastMode}`,
    ];
    if (latestRun) {
      fields.push(
        `status=${latestRun.status}`,
        `last_task=${truncateReminderField(latestRun.prompt)}`,
      );
      if (latestRun.summary) {
        fields.push(`last_summary=${truncateReminderField(latestRun.summary)}`);
      }
    }
    return `- ${fields.join(" ")}`;
  });

  if (identities.length > MAX_LISTED_AGENTS) {
    agentLines.push(`- ... ${identities.length - MAX_LISTED_AGENTS} more omitted`);
  }

  return [
    "Existing delegated agents in this parent conversation:",
    ...agentLines,
    "",
    "If the latest user message is addressed to these existing agents, experts, or the previous team — or asks them to continue, revise, compare, or discuss a follow-up — call Agent again with an `agents` entry per existing id. Do not impersonate those agents from the parent transcript.",
    "Agent resumes each id's previous private context by default, so put only the new user request and any necessary parent-visible context in each resumed agent's prompt. Do not restate name, role, or identity for an existing id. Set resume=false only when the user asks to replace, rebuild, or start fresh.",
    "For simple parent-level summaries of already returned reports, you may answer directly without calling Agent.",
  ].join("\n");
}
