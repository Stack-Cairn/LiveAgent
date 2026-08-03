export type ConversationSkillsSelection = {
  skillPresetId: string;
  skillsDisabled: boolean;
};

export type ConversationSkillsState = {
  selections: ReadonlyMap<string, ConversationSkillsSelection>;
  dirtyIds: ReadonlySet<string>;
};

function normalizeSelection(selection: ConversationSkillsSelection): ConversationSkillsSelection {
  return {
    skillPresetId: selection.skillPresetId.trim() || "default",
    skillsDisabled: selection.skillsDisabled === true,
  };
}

function selectionsEqual(
  left: ConversationSkillsSelection | undefined,
  right: ConversationSkillsSelection,
) {
  return (
    left?.skillPresetId === right.skillPresetId && left.skillsDisabled === right.skillsDisabled
  );
}

export function applyConversationSkillsOverride(
  state: ConversationSkillsState,
  conversationId: string,
  selection: ConversationSkillsSelection,
): ConversationSkillsState {
  const id = conversationId.trim();
  if (!id) return state;
  const normalized = normalizeSelection(selection);
  const selections = new Map(state.selections);
  selections.set(id, normalized);
  const dirtyIds = new Set(state.dirtyIds);
  dirtyIds.add(id);
  return { selections, dirtyIds };
}

export function applyPersistedConversationSkills(
  state: ConversationSkillsState,
  conversationId: string,
  selection: ConversationSkillsSelection,
): ConversationSkillsState {
  const id = conversationId.trim();
  if (!id) return state;
  const normalized = normalizeSelection(selection);
  const previous = state.selections.get(id);
  if (state.dirtyIds.has(id) && !selectionsEqual(previous, normalized)) {
    return state;
  }

  const dirtyIds = new Set(state.dirtyIds);
  dirtyIds.delete(id);
  if (selectionsEqual(previous, normalized)) {
    return dirtyIds.size === state.dirtyIds.size
      ? state
      : { selections: state.selections, dirtyIds };
  }
  const selections = new Map(state.selections);
  selections.set(id, normalized);
  return { selections, dirtyIds };
}

export function rekeyConversationSkills(
  state: ConversationSkillsState,
  previousConversationId: string,
  nextConversationId: string,
): ConversationSkillsState {
  const previousId = previousConversationId.trim();
  const nextId = nextConversationId.trim();
  if (!previousId || !nextId || previousId === nextId) return state;

  const selection = state.selections.get(previousId);
  const wasDirty = state.dirtyIds.has(previousId);
  if (!selection && !wasDirty) return state;

  const selections = new Map(state.selections);
  selections.delete(previousId);
  if (selection && !selections.has(nextId)) selections.set(nextId, selection);
  const dirtyIds = new Set(state.dirtyIds);
  dirtyIds.delete(previousId);
  if (wasDirty) dirtyIds.add(nextId);
  return { selections, dirtyIds };
}
