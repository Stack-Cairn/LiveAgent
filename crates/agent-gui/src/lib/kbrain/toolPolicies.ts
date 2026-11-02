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
 *   - internal/backend/run_options.go (ExitPlanMode, always accepted)
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
]);

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
  return Object.fromEntries(
    Object.entries(configured ?? {})
      .filter(([name, policy]) => KBRAIN_POLICY_TOOL_NAMES.has(name) && isKBrainToolPolicy(policy))
      .sort(([left], [right]) => left.localeCompare(right)),
  ) as KBrainToolPolicies;
}
