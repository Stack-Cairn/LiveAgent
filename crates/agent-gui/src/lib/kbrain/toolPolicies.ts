import type { KBrainRunOptions } from "./types";

type KBrainToolPolicy = "ask" | "allow" | "deny";
type KBrainToolPolicies = NonNullable<NonNullable<KBrainRunOptions["tools"]>["policies"]>;

/**
 * Tool names K-brain itself registers and that LiveAgent settings can carry a policy for.
 *
 * K-brain validates `options.tools.policies` strictly: any name it does not register (and that
 * is not declared in `options.client_tools`) rejects the whole run with
 * `options.tools references unavailable tool "<name>"`. LiveAgent's settings, however, are shared
 * with the legacy frontend runtime and can hold policies for frontend-only tools (Browser,
 * McpManager, Agent, Task*, ...). Those must never reach K-brain, otherwise one stale setting
 * blocks every message.
 *
 * Keep in sync with K-brain:
 *   - internal/tools/liveagent_catalog.go (LiveAgentToolCatalogMetadata)
 *   - internal/agent/skills.go (SkillsManager)
 *   - internal/backend/questions.go (AskUserQuestion)
 *   - internal/backend/cron_tool.go (CronTaskManager)
 *   - internal/backend/planning.go (PlanningQuery, PlanningMutate; attached to every session)
 *   - internal/agent/agent.go New (wait, new_context, remember, forget, memory_manager;
 *     registered on every agent, and memory tools stay "known" for validation while memory is off)
 *   - internal/backend/run_options.go (ExitPlanMode, always accepted)
 *
 * Deliberately absent: tools K-brain registers only conditionally (lsp, browser_exec,
 * computer_exec, workflow, ToolSearch, dynamic MCP tools) — a policy for one that is missing
 * in this session would reject the run — and the subagent tools.
 */
export const KBRAIN_POLICY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Image",
  "Write",
  "Edit",
  "Delete",
  "List",
  "Glob",
  "Grep",
  "Bash",
  "ManagedProcess",
  "ProcessWait",
  "ProcessStop",
  "TerminalSession",
  "ReadTerminal",
  "SkillsManager",
  "AskUserQuestion",
  "CronTaskManager",
  "ExitPlanMode",
  "PlanningQuery",
  "PlanningMutate",
  "wait",
  "new_context",
  "remember",
  "forget",
  "memory_manager",
]);

/**
 * LiveAgent settings keys whose K-brain tool has another name. The settings catalog's Memory
 * Manager entry predates K-brain; K-brain's LiveAgent-compatible store tool is `memory_manager`.
 * An explicit policy under the K-brain name wins over the alias.
 */
const KBRAIN_POLICY_ALIASES: Readonly<Record<string, string>> = {
  MemoryManager: "memory_manager",
};

function isKBrainToolPolicy(value: unknown): value is KBrainToolPolicy {
  return value === "ask" || value === "allow" || value === "deny";
}

/**
 * Projects LiveAgent tool settings onto the policies K-brain accepts: drops group/server keys,
 * frontend-only tools and invalid values, and sorts the result for stable request bodies.
 */
export function canonicalKBrainToolPolicies(
  configured: Record<string, unknown> | undefined | null,
): KBrainToolPolicies {
  const policies = new Map<string, KBrainToolPolicy>();
  for (const [alias, target] of Object.entries(KBRAIN_POLICY_ALIASES)) {
    const policy = configured?.[alias];
    if (isKBrainToolPolicy(policy)) policies.set(target, policy);
  }
  for (const [name, policy] of Object.entries(configured ?? {})) {
    if (KBRAIN_POLICY_TOOL_NAMES.has(name) && isKBrainToolPolicy(policy))
      policies.set(name, policy);
  }
  return Object.fromEntries(
    [...policies].sort(([left], [right]) => left.localeCompare(right)),
  ) as KBrainToolPolicies;
}
