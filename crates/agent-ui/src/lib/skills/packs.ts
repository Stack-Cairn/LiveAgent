/**
 * Skill packs: a top-level directory of the Skills root without its own
 * SKILL.md whose skills sit deeper (`<pack>/skills/<module>/SKILL.md`).
 *
 * Enable state follows K-brain (`settings.packs`, capability `skill_packs`):
 * - `packs[pack] === true` turns on every skill of the pack,
 * - `packs[pack] === false` turns all of them off, even ones selected by name,
 * - a pack not listed follows `selected` skill by skill.
 * Shadowed pack skills (another skill kept the name) are never active.
 *
 * Backends without skill packs send no `pack` field; then nothing here groups
 * or writes `packs`, and the Skills list stays flat.
 */

export type SkillPackMember = {
  name: string;
  pack?: string;
  shadowed?: boolean;
};

export type SkillPackSelection = {
  selected: readonly string[];
  packs?: Readonly<Record<string, boolean>>;
};

export type SkillPackToggleState = "on" | "off" | "mixed";

/** Whether the backend reports skill packs (every item then carries `pack`). */
export function skillPacksSupported(skills: readonly SkillPackMember[]): boolean {
  return skills.some((skill) => typeof skill.pack === "string");
}

/** Pack name of a skill, or "" for a top-level skill. */
export function skillPackName(skill: SkillPackMember): string {
  return typeof skill.pack === "string" ? skill.pack.trim() : "";
}

/** Whether a skill is on, given name selection and pack switches. */
export function isSkillEffectivelySelected(
  skill: SkillPackMember,
  selected: ReadonlySet<string>,
  packs?: Readonly<Record<string, boolean>>,
): boolean {
  if (skill.shadowed) return false;
  const pack = skillPackName(skill);
  if (pack && packs && Object.hasOwn(packs, pack)) return packs[pack] === true;
  return selected.has(skill.name);
}

/** Names of the skills that are on (shadowed copies never are). */
export function effectiveSelectedSkillNames(
  skills: readonly SkillPackMember[],
  selection: SkillPackSelection,
): Set<string> {
  const selected = new Set(selection.selected);
  const result = new Set<string>();
  for (const skill of skills) {
    if (isSkillEffectivelySelected(skill, selected, selection.packs)) result.add(skill.name);
  }
  // Names selected without a listed skill (built-ins, not yet scanned) stay on.
  for (const name of selection.selected) {
    if (!skills.some((skill) => skill.name === name)) result.add(name);
  }
  return result;
}

/** Active (non-shadowed) skills grouped by pack name, in pack-name order. */
export function groupSkillsByPack<T extends SkillPackMember>(
  skills: readonly T[],
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    const pack = skillPackName(skill);
    if (!pack || skill.shadowed) continue;
    const members = groups.get(pack);
    if (members) members.push(skill);
    else groups.set(pack, [skill]);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Header switch state of a pack. */
export function skillPackToggleState(
  pack: string,
  members: readonly SkillPackMember[],
  selection: SkillPackSelection,
): SkillPackToggleState {
  const listed = selection.packs && Object.hasOwn(selection.packs, pack);
  if (listed) return selection.packs?.[pack] ? "on" : "off";
  const selected = new Set(selection.selected);
  const active = members.filter((member) => !member.shadowed);
  const on = active.filter((member) => selected.has(member.name)).length;
  if (on === 0) return "off";
  return on === active.length ? "on" : "mixed";
}

function packsWithout(
  packs: Readonly<Record<string, boolean>> | undefined,
  names: ReadonlySet<string>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [pack, value] of Object.entries(packs ?? {})) {
    if (!names.has(pack)) next[pack] = value;
  }
  return next;
}

/** Turns a whole pack on or off. Name selections of its skills are dropped. */
export function setSkillPackEnabled(
  selection: SkillPackSelection,
  pack: string,
  members: readonly SkillPackMember[],
  on: boolean,
): { selected: string[]; packs: Record<string, boolean> } {
  const memberNames = new Set(
    members.filter((member) => !member.shadowed).map((member) => member.name),
  );
  return {
    selected: selection.selected.filter((name) => !memberNames.has(name)),
    packs: { ...packsWithout(selection.packs, new Set([pack])), [pack]: on },
  };
}

/**
 * Applies per-skill on/off changes. A pack skill whose pack is switched as a
 * whole first moves that pack to skill-by-skill selection (keeping what was
 * on), so changing one skill never flips its siblings.
 */
export function applySkillSelectionChanges(
  selection: SkillPackSelection,
  skills: readonly SkillPackMember[],
  changes: ReadonlyMap<string, boolean>,
): { selected: string[]; packs?: Record<string, boolean> } {
  const selected = new Set(selection.selected);
  const touchedPacks = new Set<string>();
  for (const name of changes.keys()) {
    const skill = skills.find((item) => item.name === name && !item.shadowed);
    const pack = skill ? skillPackName(skill) : "";
    if (pack && selection.packs && Object.hasOwn(selection.packs, pack)) touchedPacks.add(pack);
  }
  for (const pack of touchedPacks) {
    const on = selection.packs?.[pack] === true;
    for (const skill of skills) {
      if (skill.shadowed || skillPackName(skill) !== pack) continue;
      if (on) selected.add(skill.name);
      else selected.delete(skill.name);
    }
  }
  for (const [name, on] of changes) {
    if (on) selected.add(name);
    else selected.delete(name);
  }
  const result: { selected: string[]; packs?: Record<string, boolean> } = {
    selected: Array.from(selected),
  };
  if (selection.packs !== undefined || touchedPacks.size > 0) {
    result.packs = packsWithout(selection.packs, touchedPacks);
  }
  return result;
}

/** Selection after deleting a whole pack: its switch and skill names go. */
export function removeSkillPackFromSelection(
  selection: SkillPackSelection,
  pack: string,
  members: readonly SkillPackMember[],
): { selected: string[]; packs?: Record<string, boolean> } {
  const memberNames = new Set(
    members.filter((member) => !member.shadowed).map((member) => member.name),
  );
  return {
    selected: selection.selected.filter((name) => !memberNames.has(name)),
    ...(selection.packs !== undefined
      ? { packs: packsWithout(selection.packs, new Set([pack])) }
      : {}),
  };
}
