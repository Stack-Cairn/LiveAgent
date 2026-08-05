const ALWAYS_ENABLED_SKILL_NAMES = ["skills-creator", "skills-installer"] as const;

const alwaysEnabledSkillNameSet = new Set<string>(ALWAYS_ENABLED_SKILL_NAMES);

export function isAlwaysEnabledSkillName(name: string) {
  return alwaysEnabledSkillNameSet.has(name);
}

export function isUserSelectableSkillName(name: string) {
  return !isAlwaysEnabledSkillName(name);
}

export function isUserSelectableSkill(skill: { name: string }) {
  return isUserSelectableSkillName(skill.name);
}

export function mergeAlwaysEnabledSkillNames(selected: readonly string[]) {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const name of ALWAYS_ENABLED_SKILL_NAMES) {
    seen.add(name);
    next.push(name);
  }
  for (const rawName of selected) {
    const name = String(rawName).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    next.push(name);
  }
  return next;
}

function alwaysEnabledSkillRank(name: string) {
  const rank = ALWAYS_ENABLED_SKILL_NAMES.indexOf(
    name as (typeof ALWAYS_ENABLED_SKILL_NAMES)[number],
  );
  return rank === -1 ? Number.POSITIVE_INFINITY : rank;
}

export function sortSkillsForDisplay<T extends { name: string }>(skills: readonly T[]) {
  return [...skills].sort((a, b) => {
    const aRank = alwaysEnabledSkillRank(a.name);
    const bRank = alwaysEnabledSkillRank(b.name);
    if (aRank !== bRank) return aRank < bRank ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
