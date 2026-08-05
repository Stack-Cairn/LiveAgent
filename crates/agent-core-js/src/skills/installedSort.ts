import { isAlwaysEnabledSkillName } from "./builtin";
import type { SkillSummary } from "./index";

export type InstalledSkillSort = "name-asc" | "name-desc" | "installed-desc";

export const DEFAULT_INSTALLED_SKILL_SORT: InstalledSkillSort = "name-asc";

export function isInstalledSkillSort(value: unknown): value is InstalledSkillSort {
  return value === "name-asc" || value === "name-desc" || value === "installed-desc";
}

function installedAtValue(skill: SkillSummary) {
  return typeof skill.installedAt === "number" && Number.isFinite(skill.installedAt)
    ? skill.installedAt
    : null;
}

export function sortInstalledSkillItems<T>(
  items: readonly T[],
  sort: InstalledSkillSort,
  selectedNames: ReadonlySet<string>,
  getSkill: (item: T) => SkillSummary,
): T[] {
  return [...items].sort((left, right) => {
    const leftSkill = getSkill(left);
    const rightSkill = getSkill(right);
    const leftRank = isAlwaysEnabledSkillName(leftSkill.name)
      ? 0
      : selectedNames.has(leftSkill.name)
        ? 1
        : 2;
    const rightRank = isAlwaysEnabledSkillName(rightSkill.name)
      ? 0
      : selectedNames.has(rightSkill.name)
        ? 1
        : 2;

    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }

    if (sort === "installed-desc") {
      const leftInstalledAt = installedAtValue(leftSkill);
      const rightInstalledAt = installedAtValue(rightSkill);
      if (leftInstalledAt !== null || rightInstalledAt !== null) {
        if (leftInstalledAt === null) return 1;
        if (rightInstalledAt === null) return -1;
        if (leftInstalledAt !== rightInstalledAt) return rightInstalledAt - leftInstalledAt;
      }
    }

    const nameOrder = leftSkill.name.localeCompare(rightSkill.name);
    if (nameOrder !== 0) {
      return sort === "name-desc" ? -nameOrder : nameOrder;
    }

    return leftSkill.baseDir.localeCompare(rightSkill.baseDir);
  });
}
