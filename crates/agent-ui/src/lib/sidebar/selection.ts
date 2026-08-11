export type SidebarSelectionState = {
  selectedIds: ReadonlySet<string>;
  anchorId: string | null;
};

export type UpdateSidebarSelectionOptions = SidebarSelectionState & {
  orderedIds: readonly string[];
  selectableIds: ReadonlySet<string>;
  targetId: string;
  shiftKey: boolean;
  toggleKey: boolean;
};

export function updateSidebarSelection(
  options: UpdateSidebarSelectionOptions,
): SidebarSelectionState {
  const { orderedIds, selectableIds, selectedIds, anchorId, targetId, shiftKey, toggleKey } =
    options;

  if (!selectableIds.has(targetId)) {
    return { selectedIds, anchorId };
  }

  if (shiftKey) {
    const anchorIndex = anchorId === null ? -1 : orderedIds.indexOf(anchorId);
    const targetIndex = orderedIds.indexOf(targetId);
    if (anchorIndex !== -1 && targetIndex !== -1) {
      const [start, end] =
        anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      const next = toggleKey ? new Set(selectedIds) : new Set<string>();
      for (const id of orderedIds.slice(start, end + 1)) {
        if (selectableIds.has(id)) {
          next.add(id);
        }
      }
      return { selectedIds: next, anchorId };
    }
  }

  const next = new Set(selectedIds);
  if (next.has(targetId)) {
    next.delete(targetId);
  } else {
    next.add(targetId);
  }
  return { selectedIds: next, anchorId: targetId };
}

export function reconcileSidebarSelection(
  options: Pick<
    UpdateSidebarSelectionOptions,
    "orderedIds" | "selectableIds" | "selectedIds" | "anchorId"
  >,
): SidebarSelectionState {
  const { orderedIds, selectableIds, selectedIds, anchorId } = options;
  const visibleIds = new Set(orderedIds);
  let changed = false;
  const next = new Set<string>();
  for (const id of selectedIds) {
    if (visibleIds.has(id) && selectableIds.has(id)) {
      next.add(id);
    } else {
      changed = true;
    }
  }

  const nextAnchorId = anchorId !== null && visibleIds.has(anchorId) ? anchorId : null;
  return {
    selectedIds: changed ? next : selectedIds,
    anchorId: nextAnchorId,
  };
}
