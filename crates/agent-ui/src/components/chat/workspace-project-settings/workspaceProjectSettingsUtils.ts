import type { WorkspaceProjectRootState } from "@liveagent/ui/contracts/workspaceProjectRoots";
import {
  type ClawHubCategorySlug,
  classifyClawHubSkill,
} from "@liveagent/ui/lib/skills/clawHubCategories";
import { isAlwaysEnabledSkillName, type SkillSummary } from "@liveagent/ui/lib/skills/index";

const RESERVED_ROOT_ALIASES = new Set(["workspace", "skill", "uploads", "external"]);

export function classifyWorkspaceSkill(
  skill: Pick<SkillSummary, "name" | "description">,
): ClawHubCategorySlug[] {
  if (isAlwaysEnabledSkillName(skill.name)) return ["other"];
  return classifyClawHubSkill({
    slug: skill.name,
    displayName: skill.name,
    summary: skill.description,
    topics: [],
  });
}

export function rootAliasFromPath(path: string, existingAliases: ReadonlySet<string>): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  const basename = parts.at(-1) ?? "reference";
  const stem =
    basename
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "reference";
  const safeStem = /^[a-z]/.test(stem) ? stem : `root-${stem}`;
  const base = RESERVED_ROOT_ALIASES.has(safeStem) ? `root-${safeStem}` : safeStem;
  let alias = base.slice(0, 32);
  let suffix = 2;
  while (existingAliases.has(alias)) {
    const suffixText = `-${suffix}`;
    alias = `${base.slice(0, 32 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return alias;
}

export function rootStateTone(state: WorkspaceProjectRootState): string {
  if (state === "active") {
    return "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (state === "pending-approval") {
    return "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300";
  }
  return "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300";
}
