import { issue, type SubagentIssue } from "./errors";
import {
  DEFAULT_CONCURRENCY,
  MAX_AGENTS,
  SUBAGENT_BROADCAST_RECIPIENT,
  SUBAGENT_ID_PATTERN,
  SUBAGENT_PARENT_ID,
  type SubagentApplyPolicy,
  type SubagentIdentity,
  type SubagentMode,
  type SubagentSpec,
  type SubagentTemplate,
} from "./types";
import { asObject, clampInteger, optionalString } from "./utils";

export type ResolvedSubagentSpec = {
  spec: SubagentSpec;
  existingIdentity?: SubagentIdentity;
  template?: SubagentTemplate;
};

export type ParsedSubagentBatch = {
  agents: ResolvedSubagentSpec[];
  concurrency: number;
};

export type ParseBatchResult =
  | { ok: true; batch: ParsedSubagentBatch }
  | { ok: false; issues: SubagentIssue[] };

export function normalizeLookupKey(value: string) {
  return value.trim().toLowerCase();
}

export function createTemplateLookup(templates: SubagentTemplate[]) {
  const byKey = new Map<string, SubagentTemplate>();
  for (const template of templates) {
    if (template.id.trim()) byKey.set(normalizeLookupKey(template.id), template);
    if (template.name.trim()) byKey.set(normalizeLookupKey(template.name), template);
  }
  return byKey;
}

const KNOWN_AGENT_KEYS = new Set([
  "id",
  "prompt",
  "name",
  "role",
  "identity",
  "template",
  "mode",
  "apply_policy",
  "allowed_output_paths",
  "resume",
  "retain_worktree",
]);

const MODES = new Set<SubagentMode>(["readonly", "worktree"]);
const APPLY_POLICIES = new Set<SubagentApplyPolicy>(["none", "explicit", "auto"]);

function parseOptionalBoolean(
  value: unknown,
  field: string,
  agentId: string | undefined,
  issues: SubagentIssue[],
): boolean | undefined {
  if (typeof value === "undefined") return undefined;
  if (typeof value === "boolean") return value;
  issues.push(issue("invalid_arguments", `${field} must be a boolean when present.`, agentId));
  return undefined;
}

function parsePathList(
  value: unknown,
  agentId: string | undefined,
  issues: SubagentIssue[],
): string[] {
  if (typeof value === "undefined") return [];
  if (!Array.isArray(value)) {
    issues.push(
      issue(
        "invalid_arguments",
        "allowed_output_paths must be an array of workspace-relative path strings.",
        agentId,
      ),
    );
    return [];
  }
  const paths: string[] = [];
  for (const entry of value) {
    const text = typeof entry === "string" ? entry.trim() : "";
    if (!text) {
      issues.push(
        issue(
          "invalid_arguments",
          "allowed_output_paths entries must be non-empty strings.",
          agentId,
        ),
      );
      continue;
    }
    if (!paths.includes(text)) paths.push(text);
  }
  return paths;
}

function conflictFields(params: {
  identity: SubagentIdentity;
  name?: string;
  role?: string;
  identityText?: string;
  templateId?: string;
}) {
  const mismatches: string[] = [];
  if (params.name && params.name !== params.identity.name) mismatches.push("name");
  if (params.role && params.role !== params.identity.role) mismatches.push("role");
  if (params.identityText && params.identityText !== params.identity.identityPrompt) {
    mismatches.push("identity");
  }
  if (
    params.templateId &&
    normalizeLookupKey(params.templateId) !== normalizeLookupKey(params.identity.templateId ?? "")
  ) {
    mismatches.push("template");
  }
  return mismatches;
}

/**
 * Validate and resolve one Agent tool call into a batch of runnable specs.
 * All-or-nothing: any issue rejects the whole call so no partial batch spawns.
 * No inference — mode/apply/paths must be stated; defaults are mechanical
 * (new agent -> readonly, resumed agent -> its last mode).
 */
export function parseSubagentBatch(
  rawArgs: unknown,
  options: {
    identities: Map<string, SubagentIdentity>;
    templates: SubagentTemplate[];
  },
): ParseBatchResult {
  const issues: SubagentIssue[] = [];
  const args = asObject(rawArgs);

  for (const key of Object.keys(args)) {
    if (key !== "agents" && key !== "concurrency") {
      issues.push(
        issue(
          "invalid_arguments",
          `Unknown Agent parameter "${key}". Provide { agents: [...], concurrency? } only.`,
        ),
      );
    }
  }

  const rawAgents = args.agents;
  if (!Array.isArray(rawAgents) || rawAgents.length === 0) {
    issues.push(
      issue("invalid_arguments", "agents must be a non-empty array of agent request objects."),
    );
    return { ok: false, issues };
  }
  if (rawAgents.length > MAX_AGENTS) {
    issues.push(
      issue(
        "invalid_arguments",
        `agents supports at most ${MAX_AGENTS} entries per call; got ${rawAgents.length}. Split dependent work across sequential calls.`,
      ),
    );
  }

  const identitiesByKey = new Map<string, SubagentIdentity>();
  for (const identity of options.identities.values()) {
    identitiesByKey.set(normalizeLookupKey(identity.agentId), identity);
  }
  const templateLookup = createTemplateLookup(options.templates);

  const resolved: ResolvedSubagentSpec[] = [];
  const seenIds = new Map<string, string>();

  for (const [index, rawEntry] of rawAgents.entries()) {
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
      issues.push(issue("invalid_arguments", `agents[${index}] must be an object.`));
      continue;
    }
    const entry = asObject(rawEntry);
    const id = optionalString(entry.id) ?? "";
    const agentRef = id || `agents[${index}]`;

    for (const key of Object.keys(entry)) {
      if (!KNOWN_AGENT_KEYS.has(key)) {
        issues.push(
          issue(
            "invalid_arguments",
            `Unknown agent field "${key}". Allowed fields: ${[...KNOWN_AGENT_KEYS].join(", ")}.`,
            agentRef,
          ),
        );
      }
    }

    if (!id || !SUBAGENT_ID_PATTERN.test(id)) {
      issues.push(
        issue(
          "invalid_arguments",
          "id is required and must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ (stable, reusable agent id).",
          agentRef,
        ),
      );
    }

    const prompt = optionalString(entry.prompt) ?? "";
    if (!prompt) {
      issues.push(
        issue("invalid_arguments", "prompt is required and must be non-empty.", agentRef),
      );
    }

    const duplicateKey = normalizeLookupKey(id);
    if (id && seenIds.has(duplicateKey)) {
      issues.push(
        issue(
          "duplicate_agent_id",
          `Duplicate agent id "${id}" in one call. Merge both requests into one prompt for that agent.`,
          agentRef,
        ),
      );
    } else if (id) {
      seenIds.set(duplicateKey, id);
    }

    const name = optionalString(entry.name);
    const role = optionalString(entry.role);
    const identityText = optionalString(entry.identity);
    const templateRef = optionalString(entry.template);

    let template: SubagentTemplate | undefined;
    if (templateRef) {
      template = templateLookup.get(normalizeLookupKey(templateRef));
      if (!template) {
        issues.push(
          issue(
            "unknown_template",
            `Unknown template "${templateRef}". Only enabled AGENTS templates can be referenced.`,
            agentRef,
          ),
        );
      }
    }

    const existingIdentity = id ? identitiesByKey.get(normalizeLookupKey(id)) : undefined;
    if (existingIdentity) {
      const mismatches = conflictFields({
        identity: existingIdentity,
        name,
        role,
        identityText,
        templateId: template?.id ?? templateRef,
      });
      if (mismatches.length > 0) {
        issues.push(
          issue(
            "identity_conflict",
            `Agent "${id}" already exists with a stored identity; conflicting field(s): ${mismatches.join(", ")}. Omit creation fields to reuse it, or pick a new id for a genuinely new persona.`,
            agentRef,
          ),
        );
      }
    }

    const rawMode = optionalString(entry.mode);
    let mode: SubagentMode;
    if (rawMode) {
      if (!MODES.has(rawMode as SubagentMode)) {
        issues.push(
          issue(
            "invalid_arguments",
            `mode must be "readonly" or "worktree"; got "${rawMode}".`,
            agentRef,
          ),
        );
        mode = "readonly";
      } else {
        mode = rawMode as SubagentMode;
      }
    } else {
      mode = existingIdentity?.lastMode ?? "readonly";
    }

    const rawApplyPolicy = optionalString(entry.apply_policy);
    let applyPolicy: SubagentApplyPolicy = "none";
    if (rawApplyPolicy) {
      if (!APPLY_POLICIES.has(rawApplyPolicy as SubagentApplyPolicy)) {
        issues.push(
          issue(
            "invalid_arguments",
            `apply_policy must be "none", "explicit", or "auto"; got "${rawApplyPolicy}".`,
            agentRef,
          ),
        );
      } else if (mode !== "worktree") {
        issues.push(
          issue(
            "invalid_arguments",
            "apply_policy is only valid with mode=worktree. Readonly agents cannot write files.",
            agentRef,
          ),
        );
      } else {
        applyPolicy = rawApplyPolicy as SubagentApplyPolicy;
      }
    }

    const allowedOutputPaths = parsePathList(entry.allowed_output_paths, agentRef, issues);
    if (allowedOutputPaths.length > 0 && applyPolicy !== "explicit") {
      issues.push(
        issue(
          "invalid_arguments",
          "allowed_output_paths requires apply_policy=explicit (and mode=worktree).",
          agentRef,
        ),
      );
    }
    if (applyPolicy === "explicit" && allowedOutputPaths.length === 0) {
      issues.push(
        issue(
          "invalid_arguments",
          "apply_policy=explicit requires at least one allowed_output_paths entry.",
          agentRef,
        ),
      );
    }

    const resume = parseOptionalBoolean(entry.resume, "resume", agentRef, issues) ?? true;
    const retainWorktree =
      parseOptionalBoolean(entry.retain_worktree, "retain_worktree", agentRef, issues) ?? false;

    resolved.push({
      spec: {
        id,
        prompt,
        name,
        role,
        identity: identityText,
        templateId: template?.id ?? existingIdentity?.templateId,
        mode,
        applyPolicy,
        allowedOutputPaths,
        resume,
        retainWorktree,
      },
      existingIdentity,
      template,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const concurrency = Math.min(
    resolved.length,
    clampInteger(args.concurrency, DEFAULT_CONCURRENCY, 1, MAX_AGENTS),
  );
  return { ok: true, batch: { agents: resolved, concurrency } };
}

export type RecipientValidation =
  | { ok: true; recipientId: string }
  | { ok: false; message: string };

/**
 * Resolve and validate a SendMessage recipient against the live roster.
 * Unknown recipients are rejected so a typo can never create a message
 * nobody will ever read.
 */
export function validateRecipient(params: {
  to: unknown;
  channel?: string;
  senderId: string;
  knownAgentIds: Iterable<string>;
}): RecipientValidation {
  const known = new Map<string, string>();
  for (const idValue of params.knownAgentIds) {
    const id = idValue.trim();
    if (id) known.set(normalizeLookupKey(id), id);
  }
  const describeValid = () => {
    const ids = [...known.values()];
    const targets = [
      params.senderId === SUBAGENT_PARENT_ID ? "" : `"${SUBAGENT_PARENT_ID}"`,
      `"${SUBAGENT_BROADCAST_RECIPIENT}"`,
      ...ids.filter((id) => id !== params.senderId).map((id) => `"${id}"`),
    ].filter(Boolean);
    return targets.length > 0
      ? `Valid recipients: ${targets.join(", ")}.`
      : "No recipients available.";
  };

  const raw = typeof params.to === "string" ? params.to.trim() : "";
  if (!raw) {
    if (params.channel === "shared") {
      return { ok: true, recipientId: SUBAGENT_BROADCAST_RECIPIENT };
    }
    return {
      ok: false,
      message: `SendMessage requires "to" unless channel=shared (which broadcasts to *). ${describeValid()}`,
    };
  }
  if (raw === SUBAGENT_BROADCAST_RECIPIENT) {
    return { ok: true, recipientId: SUBAGENT_BROADCAST_RECIPIENT };
  }
  if (normalizeLookupKey(raw) === SUBAGENT_PARENT_ID) {
    if (params.senderId === SUBAGENT_PARENT_ID) {
      return {
        ok: false,
        message: `The parent agent cannot send a message to itself. ${describeValid()}`,
      };
    }
    return { ok: true, recipientId: SUBAGENT_PARENT_ID };
  }
  const canonical = known.get(normalizeLookupKey(raw));
  if (!canonical) {
    return {
      ok: false,
      message: `Unknown recipient "${raw}". ${describeValid()}`,
    };
  }
  return { ok: true, recipientId: canonical };
}
