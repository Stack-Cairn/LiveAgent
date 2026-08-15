import type {
  SubagentRosterEntry,
  SubagentTemplateEntry,
} from "@liveagent/ui/lib/subagents/protocol";
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
 * 归一化身份列表：过滤空 id/name、按 agentId 排序、按上限截断。
 * 稳定段与易变段共用同一份选择结果，保证两段的截断口径一致——否则会出现
 * “稳定段列了某个 agent、易变段却没有它”的错位。
 *
 * 排序**不用 `localeCompare`**：它依赖 locale 与 ICU 版本，同样输入在不同环境下
 * 可能给出不同顺序，等于凭空制造前缀差异
 * （见 spec/liveagent/frontend/prompt-cache-stability.md 的 Common Mistake 一节）。
 * 归一化本身也是必需的：`listIdentities()` 按 `updatedAt` 倒序返回，任一身份被更新
 * 都会改变返回顺序，而稳定段要求“身份集合不变则字节不变”。
 * 代价是超过上限时列出的不再是最近更新的 12 个，而是 id 序最靠前的 12 个。
 */
function selectListedIdentities(identities: SubagentIdentity[]) {
  const usable = identities
    .filter((identity) => identity.agentId.trim() && identity.name.trim())
    .sort((a, b) => (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
  return {
    listed: usable.slice(0, MAX_LISTED_AGENTS),
    omittedCount: Math.max(0, usable.length - MAX_LISTED_AGENTS),
  };
}

/**
 * System-prompt reminder for the parent agent listing existing subagents,
 * so follow-up user requests are routed to the stable ids instead of the
 * parent impersonating them.
 *
 * 只含身份字段（id / name / role / mode）：身份集合不变则字节不变，可以安全地待在
 * systemPrompt 里。运行状态（status / last_task / last_summary）随子代理 run 推进而变，
 * 由 buildRosterRunStatusSection 单独渲染并后置到消息尾部。
 */
export function buildRosterIdentitySection(params: { identities: SubagentIdentity[] }) {
  const { listed, omittedCount } = selectListedIdentities(params.identities);
  if (listed.length === 0) return "";

  const agentLines = listed.map((identity) => {
    const fields = [
      `id=${identity.agentId}`,
      `name=${truncateReminderField(identity.name, 120)}`,
      `role=${truncateReminderField(identity.role, 160)}`,
      `mode=${identity.lastMode}`,
    ];
    return `- ${fields.join(" ")}`;
  });

  if (omittedCount > 0) {
    agentLines.push(`- ... ${omittedCount} more omitted`);
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

/**
 * roster 的易变段：只含随子代理 run 推进而变的字段。
 *
 * 与稳定段共用 selectListedIdentities 的选择结果，所以列出的 id 必定是稳定段的子集；
 * 没有历史 run 的身份不出现（与拆分前“无 latestRun 就不带这些字段”同口径）。
 *
 * 纯函数：不含时间量、不含随机量，同样输入恒等输出——调用方据此用“输出是否与上次
 * 相同”判定要不要投递。
 */
export function buildRosterRunStatusSection(params: {
  identities: SubagentIdentity[];
  latestRunsByAgent: Map<string, SubagentRunSummary>;
}) {
  const { listed } = selectListedIdentities(params.identities);

  const agentLines: string[] = [];
  for (const identity of listed) {
    const latestRun = params.latestRunsByAgent.get(identity.agentId);
    if (!latestRun) continue;
    const fields = [
      `id=${identity.agentId}`,
      `status=${latestRun.status}`,
      `last_task=${truncateReminderField(latestRun.prompt)}`,
    ];
    if (latestRun.summary) {
      fields.push(`last_summary=${truncateReminderField(latestRun.summary)}`);
    }
    agentLines.push(`- ${fields.join(" ")}`);
  }
  if (agentLines.length === 0) return "";

  return [
    "Latest run state of the delegated agents listed in the system prompt:",
    ...agentLines,
  ].join("\n");
}
