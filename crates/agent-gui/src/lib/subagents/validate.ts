import type { ReasoningLevel } from "../settings";
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
  type SubagentModelOptions,
  type SubagentSpec,
  type SubagentTemplate,
} from "./types";
import { asObject, clampInteger, optionalString } from "./utils";

/** 校验只需要可选空间，不需要 runtime 派生能力。 */
export type SubagentModelValidationOptions = Pick<
  SubagentModelOptions,
  "models" | "thinkingLevelsFor"
> & {
  /** 父会话模型；未指定 model 时思考档位按它校验。 */
  parentModel: string;
  /** 用户已在设置里钉死子代理模型时的可读标签；置位则一切覆盖都被拒绝。 */
  pinnedLabel?: string;
};

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
  "model",
  "thinking",
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

function describeAllowed(values: readonly string[]) {
  return values.length > 0 ? values.join(", ") : "(none)";
}

/**
 * 解析 model / thinking 覆盖。两者都是可选的；任一被指定但当前运行时没有可选
 * 空间（modelOptions 缺省）时报错而非静默忽略——静默忽略会让模型以为自己成功
 * 指定了一个更强的模型，然后拿着错误的预期去分派任务。
 */
function parseModelOverrides(params: {
  entry: Record<string, unknown>;
  agentRef: string;
  modelOptions?: SubagentModelValidationOptions;
  issues: SubagentIssue[];
}): { model?: string; reasoning?: ReasoningLevel } {
  const { entry, agentRef, modelOptions, issues } = params;
  const rawModel = optionalString(entry.model);
  const rawThinking = optionalString(entry.thinking);
  if (!rawModel && !rawThinking) return {};

  if (modelOptions?.pinnedLabel) {
    // 告诉模型「谁定的」，它才不会换个写法再试一次。
    issues.push(
      issue(
        "invalid_arguments",
        `The user pinned every subagent to ${modelOptions.pinnedLabel} in settings; model/thinking cannot be overridden. Retry with both fields omitted.`,
        agentRef,
      ),
    );
    return {};
  }

  if (!modelOptions || modelOptions.models.length === 0) {
    issues.push(
      issue(
        "invalid_arguments",
        "model/thinking overrides are not available in this runtime; omit both fields so the subagent inherits the parent conversation's model.",
        agentRef,
      ),
    );
    return {};
  }

  let model: string | undefined;
  if (rawModel) {
    if (!modelOptions.models.includes(rawModel)) {
      issues.push(
        issue(
          "invalid_arguments",
          `Unknown model "${rawModel}". Subagents run on the parent conversation's provider; allowed models: ${describeAllowed(modelOptions.models)}.`,
          agentRef,
        ),
      );
    } else {
      model = rawModel;
    }
  }

  let reasoning: ReasoningLevel | undefined;
  if (rawThinking) {
    // 档位合法性按**生效模型**判定：指定了 model 就按新模型查，否则按父模型查。
    // 用父模型的档位表去校验另一个模型的请求会一路放过再在请求期被 clamp。
    const effectiveModel = model ?? rawModel ?? modelOptions.parentModel;
    const levels = modelOptions.thinkingLevelsFor(effectiveModel);
    if (levels.length === 0) {
      issues.push(
        issue(
          "invalid_arguments",
          `Model "${effectiveModel}" does not expose thinking levels; omit thinking.`,
          agentRef,
        ),
      );
    } else if (!levels.includes(rawThinking as ReasoningLevel)) {
      issues.push(
        issue(
          "invalid_arguments",
          `thinking must be one of ${describeAllowed(levels)} for model "${effectiveModel}"; got "${rawThinking}".`,
          agentRef,
        ),
      );
    } else {
      reasoning = rawThinking as ReasoningLevel;
    }
  }

  return { ...(model ? { model } : {}), ...(reasoning ? { reasoning } : {}) };
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
    /** Plan mode:强制一切子代理 readonly(worktree 请求成为错误而非静默降级)。 */
    forceReadonly?: boolean;
    /** 缺省表示不允许 model/thinking 覆盖。 */
    modelOptions?: SubagentModelValidationOptions;
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
      } else if (options.forceReadonly && rawMode === "worktree") {
        // Plan mode 下 worktree 是明确冲突,按仓库取向报错而非静默降级:
        // 模型应改用 readonly 调研,文件改动留到计划批准后的执行轮。
        issues.push(
          issue(
            "invalid_arguments",
            "Plan mode is active: subagents are readonly-only. Use mode=readonly (or omit mode); do file changes after the plan is approved.",
            agentRef,
          ),
        );
        mode = "readonly";
      } else {
        mode = rawMode as SubagentMode;
      }
    } else if (options.forceReadonly) {
      // 缺省也强制 readonly:复用的 worktree 身份在 plan mode 里同样只读。
      mode = "readonly";
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
    const overrides = parseModelOverrides({
      entry,
      agentRef,
      modelOptions: options.modelOptions,
      issues,
    });

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
        ...overrides,
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
