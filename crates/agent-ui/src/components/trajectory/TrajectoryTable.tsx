/**
 * 账本列表。
 *
 * 超过阈值才虚拟化：短会话直接渲染，省掉测量与滚动补偿的复杂度；长会话（几千行
 * 工具调用）必须虚拟化，否则一次布局就会掉帧。
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocale } from "../../i18n/index";
import { cn } from "../../lib/shared/utils";
import {
  buildTrajectoryDisplayItems,
  TRAJECTORY_DISPLAY_HEIGHTS,
  type TrajectoryDisplayItem,
  trajectoryDisplayItemHeight,
} from "../../lib/trajectory/displayItems";
import type { TrajectoryTurnModel } from "../../lib/trajectory/types";
import { ChevronDown, ChevronRight } from "../IconSet";
import { TrajectoryRow } from "./TrajectoryRow";

const VIRTUALIZATION_THRESHOLD = 120;
const OVERSCAN_ROWS = 12;

export function TrajectoryTable(props: {
  turns: readonly TrajectoryTurnModel[];
  collapsedTurns: ReadonlySet<number>;
  collapsedAssistants: ReadonlySet<string>;
  searchMatchIndexes: ReadonlySet<number> | null;
  timelineFocusIndexes: ReadonlySet<number> | null;
  selectedIndex: number | null;
  onSelect: (index: number) => void;
  onToggleTurn: (turn: number) => void;
}) {
  const { t } = useLocale();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const items = useMemo(
    () =>
      buildTrajectoryDisplayItems(props.turns, {
        collapsedTurns: props.collapsedTurns,
        collapsedAssistants: props.collapsedAssistants,
        searchMatchIndexes: props.searchMatchIndexes,
      }),
    [props.turns, props.collapsedTurns, props.collapsedAssistants, props.searchMatchIndexes],
  );

  const virtualized = items.length >= VIRTUALIZATION_THRESHOLD;
  // 滚动副作用只依赖选中值；列表与虚拟化开关通过 ref 读最新值，避免把它们
  // 变成触发条件。
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const virtualizedRef = useRef(virtualized);
  virtualizedRef.current = virtualized;
  const getDisplayItemKey = useCallback((index: number) => items[index]?.key ?? index, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const item = items[index];
      return item === undefined
        ? TRAJECTORY_DISPLAY_HEIGHTS.record
        : trajectoryDisplayItemHeight(item);
    },
    getItemKey: getDisplayItemKey,
    overscan: OVERSCAN_ROWS,
    enabled: virtualized,
  });

  const measuredProjectionRef = useRef<{
    collapsedTurns: ReadonlySet<number>;
    collapsedAssistants: ReadonlySet<string>;
    searchMatchIndexes: ReadonlySet<number> | null;
  } | null>(null);
  useLayoutEffect(() => {
    if (!virtualized) {
      measuredProjectionRef.current = null;
      return;
    }
    const measured = measuredProjectionRef.current;
    if (
      measured?.collapsedTurns === props.collapsedTurns &&
      measured.collapsedAssistants === props.collapsedAssistants &&
      measured.searchMatchIndexes === props.searchMatchIndexes
    ) {
      return;
    }
    measuredProjectionRef.current = {
      collapsedTurns: props.collapsedTurns,
      collapsedAssistants: props.collapsedAssistants,
      searchMatchIndexes: props.searchMatchIndexes,
    };
    virtualizer.measure();
  }, [
    props.collapsedTurns,
    props.collapsedAssistants,
    props.searchMatchIndexes,
    virtualized,
    virtualizer,
  ]);

  // 外部选中（时间轴点击、跨视图跳转）要把对应行带进视口——但只在**选中变化**时
  // 做。若跟着 items 变化一起触发，实时回合里每来一条事件都会把视口拽回选中行，
  // 用户根本没法往别处看。
  const selectedIndex = props.selectedIndex;
  const scrolledToRef = useRef<number | null>(null);
  useEffect(() => {
    if (selectedIndex === null) {
      scrolledToRef.current = null;
      return;
    }
    if (scrolledToRef.current === selectedIndex) return;
    const position = itemsRef.current.findIndex(
      (item) => item.kind === "record" && item.record.index === selectedIndex,
    );
    if (position < 0) return;
    scrolledToRef.current = selectedIndex;
    if (virtualizedRef.current) {
      virtualizer.scrollToIndex(position, { align: "auto" });
      return;
    }
    scrollRef.current
      ?.querySelector(`[data-trajectory-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex, virtualizer]);

  if (items.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-[13px] text-muted-foreground">
        {props.searchMatchIndexes === null
          ? t("trajectory.empty.title")
          : t("trajectory.empty.noMatch")}
      </div>
    );
  }

  const renderItem = (item: TrajectoryDisplayItem) => {
    if (item.kind === "turnHeader") {
      return (
        <TurnHeader
          turn={item.turn}
          collapsible={item.collapsible}
          collapsed={item.collapsed}
          hiddenCount={item.hiddenCount}
          onToggle={() => {
            if (item.turn !== null && item.collapsible) props.onToggleTurn(item.turn);
          }}
        />
      );
    }
    return (
      <TrajectoryRow
        record={item.record}
        selected={props.selectedIndex === item.record.index}
        focused={props.timelineFocusIndexes?.has(item.record.index) === true}
        dimmed={
          props.timelineFocusIndexes !== null && !props.timelineFocusIndexes.has(item.record.index)
        }
        onSelect={props.onSelect}
      />
    );
  };

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {virtualized ? (
        <div className="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const item = items[virtualRow.index];
            if (item === undefined) return null;
            return (
              <div
                key={virtualRow.key}
                ref={virtualizer.measureElement}
                data-index={virtualRow.index}
                className="absolute inset-x-0 top-0"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                {renderItem(item)}
              </div>
            );
          })}
        </div>
      ) : (
        items.map((item) => <div key={item.key}>{renderItem(item)}</div>)
      )}
    </div>
  );
}

function TurnHeader(props: {
  turn: number | null;
  collapsible: boolean;
  collapsed: boolean;
  hiddenCount: number;
  onToggle: () => void;
}) {
  const { t } = useLocale();
  const label =
    props.turn === null
      ? t("trajectory.betweenTurns")
      : t("trajectory.turn").replace("{turn}", String(props.turn));

  return (
    <button
      type="button"
      disabled={!props.collapsible}
      onClick={props.onToggle}
      aria-expanded={props.collapsible ? !props.collapsed : undefined}
      className={cn(
        "flex h-[30px] w-full items-center gap-1 bg-muted/30 px-3 text-[11px] text-muted-foreground",
        props.collapsible && "hover:bg-muted/60 hover:text-foreground",
      )}
    >
      {props.collapsible ? (
        props.collapsed ? (
          <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
        ) : (
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        )
      ) : (
        <span className="size-3 shrink-0" />
      )}
      <span className="font-medium">{label}</span>
      {props.collapsed && props.hiddenCount > 0 && (
        <span className="ml-1 tabular-nums opacity-70">+{props.hiddenCount}</span>
      )}
    </button>
  );
}
