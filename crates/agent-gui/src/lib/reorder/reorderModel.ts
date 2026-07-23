export type ReorderSlot = {
  id: string;
  start: number;
  size: number;
};

export function computeDragInsertIndex(
  slots: readonly ReorderSlot[],
  draggedId: string,
  draggedOffset: number,
) {
  const draggedIndex = slots.findIndex((slot) => slot.id === draggedId);
  const dragged = slots[draggedIndex];
  if (!dragged) return 0;
  const draggedStart = dragged.start + draggedOffset;
  const draggedEnd = draggedStart + dragged.size;
  let index = 0;
  for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
    if (slotIndex === draggedIndex) continue;
    const slot = slots[slotIndex];
    if (!slot) continue;
    const midpoint = slot.start + slot.size / 2;
    const staysBefore = slotIndex < draggedIndex ? midpoint <= draggedStart : midpoint < draggedEnd;
    if (staysBefore) index += 1;
  }
  return index;
}

export function applyDragInsertIndex(
  order: readonly string[],
  draggedId: string,
  insertIndex: number,
) {
  const others = order.filter((id) => id !== draggedId);
  if (others.length === order.length) return [...order];
  const index = Math.max(0, Math.min(others.length, insertIndex));
  return [...others.slice(0, index), draggedId, ...others.slice(index)];
}

export function computeDragShiftOffsets(
  slots: readonly ReorderSlot[],
  draggedId: string,
  insertIndex: number,
  gap: number,
) {
  const draggedIndex = slots.findIndex((slot) => slot.id === draggedId);
  const dragged = slots[draggedIndex];
  if (!dragged) return {};
  const step = dragged.size + gap;
  const shifts: Record<string, number> = {};
  let otherIndex = 0;
  for (let index = 0; index < slots.length; index += 1) {
    if (index === draggedIndex) continue;
    const slot = slots[index];
    if (!slot) continue;
    if (index < draggedIndex && otherIndex >= insertIndex) {
      shifts[slot.id] = step;
    } else if (index > draggedIndex && otherIndex < insertIndex) {
      shifts[slot.id] = -step;
    }
    otherIndex += 1;
  }
  return shifts;
}

export function clampDragOffset(slots: readonly ReorderSlot[], draggedId: string, offset: number) {
  const dragged = slots.find((slot) => slot.id === draggedId);
  if (!dragged) return 0;
  let minStart = dragged.start;
  let maxEnd = dragged.start + dragged.size;
  for (const slot of slots) {
    minStart = Math.min(minStart, slot.start);
    maxEnd = Math.max(maxEnd, slot.start + slot.size);
  }
  const minOffset = minStart - dragged.start;
  const maxOffset = maxEnd - dragged.size - dragged.start;
  return Math.min(maxOffset, Math.max(minOffset, offset));
}

export const REORDER_AUTO_SCROLL_EDGE_PX = 40;
export const REORDER_AUTO_SCROLL_MAX_STEP_PX = 12;

export function computeDragAutoScrollVelocity(
  containerStart: number,
  containerEnd: number,
  pointerPosition: number,
) {
  const edge = Math.min(
    REORDER_AUTO_SCROLL_EDGE_PX,
    Math.max(8, (containerEnd - containerStart) / 4),
  );
  if (pointerPosition < containerStart + edge) {
    const depth = Math.min(1, (containerStart + edge - pointerPosition) / edge);
    return -(1 + depth * (REORDER_AUTO_SCROLL_MAX_STEP_PX - 1));
  }
  if (pointerPosition > containerEnd - edge) {
    const depth = Math.min(1, (pointerPosition - (containerEnd - edge)) / edge);
    return 1 + depth * (REORDER_AUTO_SCROLL_MAX_STEP_PX - 1);
  }
  return 0;
}

export type ReorderAxis = "horizontal" | "vertical";

export function reorderIdsByKeyboard(
  ids: readonly string[],
  id: string,
  key: string,
  axis: ReorderAxis,
) {
  const currentIndex = ids.indexOf(id);
  if (currentIndex < 0) return null;

  let targetIndex = currentIndex;
  if (key === (axis === "horizontal" ? "ArrowLeft" : "ArrowUp")) {
    targetIndex = currentIndex - 1;
  } else if (key === (axis === "horizontal" ? "ArrowRight" : "ArrowDown")) {
    targetIndex = currentIndex + 1;
  } else if (key === "Home") {
    targetIndex = 0;
  } else if (key === "End") {
    targetIndex = ids.length - 1;
  } else {
    return null;
  }

  targetIndex = Math.max(0, Math.min(ids.length - 1, targetIndex));
  if (targetIndex === currentIndex) return null;
  const nextIds = [...ids];
  const [movedId] = nextIds.splice(currentIndex, 1);
  if (!movedId) return null;
  nextIds.splice(targetIndex, 0, movedId);
  return nextIds;
}
