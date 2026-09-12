import { GripVertical } from "@liveagent/ui/components/IconSet";
import { Reorder, useDragControls, useReducedMotion } from "motion/react";
import {
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { reorderIdsByKeyboard } from "../../lib/reorder/reorderModel";
import { cn } from "../../lib/shared/utils";

type VerticalReorderItemRenderState = {
  dragging: boolean;
  dragHandle: ReactNode;
};

export type VerticalReorderListProps = {
  itemIds: readonly string[];
  canReorder: boolean;
  reorderLabel: string;
  reorderHint: string;
  disabledHint?: string;
  className?: string;
  itemLabel?: (itemId: string) => string;
  onReorder: (nextIds: string[]) => void;
  onDraggingChange?: (itemId: string | null) => void;
  children: (itemId: string, index: number, state: VerticalReorderItemRenderState) => ReactNode;
};

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function VerticalReorderItem(props: {
  id: string;
  label: string;
  index: number;
  enabled: boolean;
  draggingId: string;
  reducedMotion: boolean;
  reorderLabel: string;
  reorderHint: string;
  disabledHint?: string;
  onDragStart: (id: string) => void;
  onDragEnd: () => void;
  onKeyboardMove: (id: string, key: string, element: HTMLElement) => boolean;
  render: VerticalReorderListProps["children"];
}) {
  const {
    id,
    label,
    index,
    enabled,
    draggingId,
    reducedMotion,
    reorderLabel,
    reorderHint,
    disabledHint,
    onDragStart,
    onDragEnd,
    onKeyboardMove,
    render,
  } = props;
  const controls = useDragControls();
  const dragging = draggingId === id;
  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (!enabled || event.button !== 0) return;
      event.stopPropagation();
      controls.start(event);
    },
    [controls, enabled],
  );
  const dragHandle = (
    <button
      type="button"
      aria-label={`${reorderLabel} ${label}`}
      title={enabled ? reorderHint : disabledHint}
      aria-disabled={!enabled}
      tabIndex={enabled ? 0 : -1}
      className={cn(
        "flex h-8 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/50",
        "transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        enabled
          ? "cursor-grab touch-none hover:bg-muted hover:text-foreground active:cursor-grabbing"
          : "cursor-not-allowed opacity-30",
      )}
      onKeyDown={(event) => {
        if (!onKeyboardMove(id, event.key, event.currentTarget)) return;
        event.preventDefault();
        event.stopPropagation();
      }}
      onPointerDown={handlePointerDown}
      onClick={(event) => event.stopPropagation()}
    >
      <GripVertical className="size-4" />
    </button>
  );

  return (
    <Reorder.Item
      as="div"
      value={id}
      drag={enabled ? "y" : false}
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      layout="position"
      transition={reducedMotion ? { duration: 0 } : undefined}
      onDragStart={() => onDragStart(id)}
      onDragEnd={onDragEnd}
      className="relative"
      data-vertical-reorder-id={id}
    >
      {render(id, index, { dragging, dragHandle })}
    </Reorder.Item>
  );
}

export function VerticalReorderList(props: VerticalReorderListProps) {
  const {
    itemIds,
    canReorder,
    reorderLabel,
    reorderHint,
    disabledHint,
    className,
    onReorder,
    onDraggingChange,
    itemLabel,
    children,
  } = props;
  const reducedMotion = useReducedMotion();
  const [draftIds, setDraftIds] = useState(() => [...itemIds]);
  const [draggingId, setDraggingId] = useState("");
  const draftIdsRef = useRef(draftIds);
  draftIdsRef.current = draftIds;
  const itemIdsRef = useRef(itemIds);
  itemIdsRef.current = itemIds;

  useEffect(() => {
    if (!draggingId && !sameIds(draftIdsRef.current, itemIds)) setDraftIds([...itemIds]);
  }, [draggingId, itemIds]);

  const handleDraftReorder = useCallback((nextIds: string[]) => {
    draftIdsRef.current = nextIds;
    setDraftIds(nextIds);
  }, []);
  const handleDragEnd = useCallback(() => {
    setDraggingId("");
    onDraggingChange?.(null);
    const nextIds = draftIdsRef.current;
    if (!sameIds(nextIds, itemIdsRef.current)) onReorder([...nextIds]);
  }, [onDraggingChange, onReorder]);
  const handleDragStart = useCallback(
    (id: string) => {
      setDraggingId(id);
      onDraggingChange?.(id);
    },
    [onDraggingChange],
  );
  const handleKeyboardMove = useCallback(
    (id: string, key: string, element: HTMLElement) => {
      if (!canReorder || itemIds.length < 2) return false;
      const nextIds = reorderIdsByKeyboard(itemIds, id, key, "vertical");
      if (!nextIds) return false;
      draftIdsRef.current = nextIds;
      setDraftIds(nextIds);
      onReorder(nextIds);
      window.requestAnimationFrame(() => element.scrollIntoView({ block: "nearest" }));
      return true;
    },
    [canReorder, itemIds, onReorder],
  );
  const enabled = canReorder && draftIds.length >= 2;

  return (
    <Reorder.Group
      as="div"
      axis="y"
      values={draftIds}
      onReorder={handleDraftReorder}
      className={className}
    >
      {draftIds.map((id, index) => (
        <VerticalReorderItem
          key={id}
          id={id}
          label={itemLabel?.(id) ?? id}
          index={index}
          enabled={enabled}
          draggingId={draggingId}
          reducedMotion={Boolean(reducedMotion)}
          reorderLabel={reorderLabel}
          reorderHint={reorderHint}
          disabledHint={disabledHint}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onKeyboardMove={handleKeyboardMove}
          render={children}
        />
      ))}
    </Reorder.Group>
  );
}
