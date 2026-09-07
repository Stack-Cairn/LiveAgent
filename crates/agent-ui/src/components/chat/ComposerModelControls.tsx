import {
  type ChatRuntimeControls,
  DEFAULT_CHAT_RUNTIME_CONTROLS,
  type ExecutionMode,
  isAgentDevMode,
  isAgentExecutionMode,
  type ProviderId,
  type ReasoningLevel,
  type SelectedModel,
} from "@liveagent/app/lib/settings";
import {
  ArrowDownAZ,
  Check,
  ChevronDown,
  Globe,
  GlobeOff,
  Layers,
  Lightbulb,
  LightbulbOff,
  Pencil,
  Search,
  Sparkle,
} from "@liveagent/ui/components/IconSet";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { Button } from "@liveagent/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  COMPOSER_CONTROL_CHEVRON_CLASS,
  COMPOSER_CONTROL_LABEL_CLASS,
  COMPOSER_CONTROL_TRIGGER_CLASS,
} from "@liveagent/ui/lib/chat/composerControlStyles";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import {
  groupModelOptionsByProvider,
  type ProviderSortMode,
  persistProviderSortMode,
  readStoredProviderSortMode,
  sortModelOptionGroups,
} from "@liveagent/ui/lib/models/modelOptions";
import { parseModelValue } from "@liveagent/ui/lib/models/modelValue";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { memo, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const REASONING_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

const REASONING_COMPACT_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "chat.runtime.reasoningCompact.off",
  minimal: "chat.runtime.reasoningCompact.minimal",
  low: "chat.runtime.reasoningCompact.low",
  medium: "chat.runtime.reasoningCompact.medium",
  high: "chat.runtime.reasoningCompact.high",
  xhigh: "chat.runtime.reasoningCompact.xhigh",
  max: "chat.runtime.reasoningCompact.max",
};

function RuntimeToggleChip(props: {
  pressed: boolean;
  disabled?: boolean;
  label: string;
  ariaLabel: string;
  pressedClassName: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  const { pressed, disabled = false, label, ariaLabel, pressedClassName, icon, onClick } = props;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={pressed}
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40",
        pressed
          ? pressedClassName
          : "bg-muted/60 text-muted-foreground hover:bg-muted/80 hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

// The visible range thumb is 16px wide, so the custom track is inset by 8px.
// Keeping the track and thumb on the same geometry avoids browser-specific
// range alignment drift while preserving native keyboard and pointer behavior.
// 推理强度：分段按钮。此前是「脑图标 + 带刻度滑块 + 数值胶囊」——同一个值
// 的三重渲染，其中只有滑块可交互，胶囊却长得和旁边真正的按钮一样，必然被
// 误点；且滑块要拖动才能改，看不出总共几档。分段按钮一眼看全、一击直达，
// 也顺带消除了 indexOf 夹取导致的拇指/数值不同步。
function ReasoningEffortSegments(props: {
  choices: ReasoningLevel[];
  value: ReasoningLevel;
  disabled?: boolean;
  label: string;
  formatLevel: (level: ReasoningLevel) => string;
  formatLevelCompact: (level: ReasoningLevel) => string;
  onSelect: (level: ReasoningLevel) => void;
}) {
  const {
    choices,
    value,
    disabled = false,
    label,
    formatLevel,
    formatLevelCompact,
    onSelect,
  } = props;
  const trackRef = useRef<HTMLDivElement>(null);
  // 选中指示器单独成层并用 CSS 过渡移动：若把底色挂在各按钮上，切换只能是
  // 跳变。位置按真实 DOM 量取，因为各段宽度随标签长短而不同。
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  const activeIndex = choices.indexOf(value);

  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const measure = () => {
      const segments = track.querySelectorAll<HTMLElement>("[data-effort-segment]");
      const active = activeIndex >= 0 ? segments[activeIndex] : undefined;
      setIndicator(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    // 字体加载、弹层宽度变化都会改变分段尺寸，指示器要跟着重新量。
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [activeIndex]);

  // 命中测试按真实 DOM 矩形做，而不是按 index 均分百分比：各段宽度随标签
  // 长短而不同（flex 项的 min-width:auto 不会让它们收缩到比文字更窄）。
  const selectAtClientX = (clientX: number) => {
    const track = trackRef.current;
    if (!track) return;
    const segments = Array.from(track.querySelectorAll<HTMLElement>("[data-effort-segment]"));
    if (segments.length === 0) return;
    // 取中心点最近的一段，而不是「命中矩形」：容器有 gap-0.5，段与段之间
    // 存在 2px 缝隙，按命中判定会全部落空；再按左右钳到端点的话，点在任意
    // 内部缝隙上都会被判成「在轨道右侧」而跳到最高档。按距离取最近段同时
    // 覆盖了滑出轨道两端的情况。
    let hit = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    segments.forEach((segment, index) => {
      const rect = segment.getBoundingClientRect();
      const distance = Math.abs(clientX - (rect.left + rect.width / 2));
      if (distance < bestDistance) {
        bestDistance = distance;
        hit = index;
      }
    });
    const next = choices[hit];
    if (next && next !== value) onSelect(next);
  };

  return (
    <div
      ref={trackRef}
      role="radiogroup"
      aria-label={label}
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        // 捕获指针：拖动过程中即使滑出轨道也继续收到 move 事件。
        event.currentTarget.setPointerCapture(event.pointerId);
        selectAtClientX(event.clientX);
      }}
      onPointerMove={(event) => {
        if (disabled) return;
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        selectAtClientX(event.clientX);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      className={cn(
        "relative flex h-7 min-w-0 flex-1 touch-none select-none items-stretch gap-0.5 rounded-lg bg-muted/60 p-0.5",
        disabled && "opacity-50",
      )}
    >
      {indicator ? (
        <span
          aria-hidden="true"
          style={{ left: indicator.left, width: indicator.width }}
          className="pointer-events-none absolute bottom-0.5 top-0.5 rounded-md bg-sky-500/15 transition-[left,width] duration-200 ease-out motion-reduce:transition-none"
        />
      ) : null}
      {choices.map((level, index) => {
        const isSelected = level === value;
        return (
          // biome-ignore lint/a11y/useSemanticElements: Segmented buttons need button semantics for the shared focus/disabled styling; native radios cannot carry it.
          <button
            key={level}
            data-effort-segment=""
            data-active={isSelected ? "true" : undefined}
            type="button"
            role="radio"
            aria-checked={isSelected}
            disabled={disabled}
            // radiogroup 的漫游焦点：整组只占一个 Tab 停靠点，落在当前选中项上。
            tabIndex={isSelected || (activeIndex < 0 && index === 0) ? 0 : -1}
            title={`${label}: ${formatLevel(level)}`}
            onClick={() => onSelect(level)}
            onKeyDown={(event) => {
              // radiogroup 约定用方向键改选。原实现是 input[type=range]，
              // 方向键本就可用；换成分段按钮后必须自己实现，否则 role="radio"
              // 承诺的交互与实际不符。
              const step =
                event.key === "ArrowRight" || event.key === "ArrowDown"
                  ? 1
                  : event.key === "ArrowLeft" || event.key === "ArrowUp"
                    ? -1
                    : 0;
              if (step === 0) return;
              event.preventDefault();
              const from = activeIndex < 0 ? 0 : activeIndex;
              const next = choices[Math.min(choices.length - 1, Math.max(0, from + step))];
              if (next && next !== value) onSelect(next);
            }}
            className={cn(
              "relative z-10 flex flex-1 items-center justify-center whitespace-nowrap rounded-md px-1.5 text-[11px] font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40",
              isSelected
                ? "text-sky-700 dark:text-sky-300"
                : "text-muted-foreground hover:text-foreground",
              disabled ? "cursor-not-allowed" : "cursor-pointer",
            )}
          >
            {formatLevelCompact(level)}
          </button>
        );
      })}
    </div>
  );
}

export type ComposerModelControlsProps = {
  executionMode: ExecutionMode;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: SharedModelOption<ProviderId>[];
  selectedValue?: string;
  chatRuntimeControls: ChatRuntimeControls;
  reasoningOptions: ReasoningLevel[];
  thinkingAlwaysOn: boolean;
  disabled?: boolean;
  onSelectModel: (selection: SelectedModel) => void;
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onOpenSettings: (section?: "providers", providerId?: string) => void;
  onChatRuntimeControlsChange: (patch: Partial<ChatRuntimeControls>) => void;
};

export const ComposerModelControls = memo(function ComposerModelControls(
  props: ComposerModelControlsProps,
) {
  const {
    executionMode,
    hasModels,
    currentModelLabel,
    modelOptions,
    selectedValue,
    chatRuntimeControls,
    reasoningOptions,
    thinkingAlwaysOn,
    disabled = false,
    onSelectModel,
    onSelectExecutionMode,
    onOpenSettings,
    onChatRuntimeControlsChange,
  } = props;
  const { t } = useLocale();
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [expandedGroupId, setExpandedGroupId] = useState<string | null | undefined>(undefined);
  const [providerSortMode, setProviderSortMode] = useState<ProviderSortMode>(() =>
    readStoredProviderSortMode(),
  );
  // 图标与提示描述「当前模式」而非切换目标：此前显示目标模式，使 Layers
  // 图标的含义变成「你现在处于字母序」，与直觉相反；且没有 aria-pressed，
  // 唯一反馈只有图标替换。
  const sortByName = providerSortMode === "alpha";
  const sortToggleTitle = sortByName
    ? t("chat.sortProvidersByName")
    : t("chat.sortProvidersByType");
  const toggleProviderSortMode = () => {
    const next: ProviderSortMode = sortByName ? "type" : "alpha";
    persistProviderSortMode(next);
    setProviderSortMode(next);
  };
  const searchInputRef = useRef<HTMLInputElement>(null);
  const popoverContentRef = useRef<HTMLDivElement>(null);
  const executionModeRadioName = useId();

  useEffect(() => {
    if (!isModelPickerOpen) return;
    setModelSearch("");
    setExpandedGroupId(undefined);
  }, [isModelPickerOpen]);

  useEffect(() => {
    const reasoningNeedsReset =
      !(reasoningOptions.length > 0 && reasoningOptions.includes(chatRuntimeControls.reasoning)) &&
      !(
        reasoningOptions.length === 0 &&
        chatRuntimeControls.reasoning === DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
      );
    const thinkingNeedsEnable = thinkingAlwaysOn && !chatRuntimeControls.thinkingEnabled;
    if (!reasoningNeedsReset && !thinkingNeedsEnable) return;
    onChatRuntimeControlsChange({
      ...(reasoningNeedsReset ? { reasoning: DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning } : {}),
      ...(thinkingNeedsEnable ? { thinkingEnabled: true } : {}),
    });
  }, [
    chatRuntimeControls.reasoning,
    chatRuntimeControls.thinkingEnabled,
    onChatRuntimeControlsChange,
    reasoningOptions,
    thinkingAlwaysOn,
  ]);

  const normalizedSearch = modelSearch.trim().toLowerCase();
  const groups = sortModelOptionGroups(groupModelOptionsByProvider(modelOptions), providerSortMode);
  const selectedOption = modelOptions.find((option) => option.value === selectedValue);
  const selectedGroupId = selectedOption?.providerId;
  const triggerLabel = selectedOption?.model ?? currentModelLabel;
  const isAgent = isAgentExecutionMode(executionMode);
  const isDev = isAgentDevMode(executionMode);
  const thinkingSupported = reasoningOptions.length > 0 || thinkingAlwaysOn;
  const selectedReasoning = reasoningOptions.includes(chatRuntimeControls.reasoning)
    ? chatRuntimeControls.reasoning
    : reasoningOptions.includes(DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning)
      ? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning
      : (reasoningOptions[reasoningOptions.length - 1] ?? DEFAULT_CHAT_RUNTIME_CONTROLS.reasoning);
  const thinkingOn = thinkingSupported && (thinkingAlwaysOn || chatRuntimeControls.thinkingEnabled);
  const showEffortBar = thinkingSupported && reasoningOptions.length > 1;
  const effortChoices: ReasoningLevel[] = showEffortBar
    ? thinkingAlwaysOn
      ? reasoningOptions.filter((level) => level !== "off")
      : ["off", ...reasoningOptions.filter((level) => level !== "off")]
    : [];
  const selectedEffort: ReasoningLevel = thinkingOn ? selectedReasoning : "off";
  // 搜索期间所有分组强制展开：此时折叠切换必须一并禁用，否则点击会静默
  // 改写 expandedGroupId（画面无变化），且 aria-expanded 会与实际不符。
  const groupToggleLocked = normalizedSearch.length > 0;
  const isGroupExpanded = (id: string) => {
    if (groupToggleLocked) return true;
    const activeGroupId = expandedGroupId === undefined ? selectedGroupId : expandedGroupId;
    return activeGroupId === id;
  };
  const toggleGroup = (id: string) =>
    setExpandedGroupId((previous) => {
      const activeGroupId = previous === undefined ? selectedGroupId : previous;
      return activeGroupId === id ? null : id;
    });
  const resolveModelPickerInitialFocus = (openType: string) => {
    // Touch / coarse-pointer must not land on the search field: that opens the IME.
    // Focus the popup itself, matching Base UI's default touch behavior.
    const openedByTouch = openType === "touch";
    const coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    if (openedByTouch || coarsePointer) {
      return popoverContentRef.current ?? false;
    }
    return searchInputRef.current;
  };

  return (
    <Popover open={isModelPickerOpen} onOpenChange={setIsModelPickerOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled || !hasModels}
            title={triggerLabel}
            aria-label={`${t("chat.selectModel")}: ${triggerLabel}`}
            className={cn(COMPOSER_CONTROL_TRIGGER_CLASS, isModelPickerOpen && "bg-muted/60")}
          />
        }
      >
        {selectedOption ? (
          <ProviderBrandIcon type={selectedOption.providerType} className="opacity-90" />
        ) : (
          <Sparkle className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-400" />
        )}
        <span className={COMPOSER_CONTROL_LABEL_CLASS}>{triggerLabel}</span>
        <ChevronDown
          className={cn(COMPOSER_CONTROL_CHEVRON_CLASS, isModelPickerOpen && "rotate-180")}
        />
      </PopoverTrigger>

      <PopoverContent
        ref={popoverContentRef}
        side="top"
        align="start"
        alignOffset={-48}
        sideOffset={8}
        collisionPadding={8}
        initialFocus={resolveModelPickerInitialFocus}
        aria-label={t("chat.selectModel")}
        className="model-selector-dropdown flex max-h-[min(26rem,var(--available-height,26rem))] w-[min(25rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-xl border border-border/60 bg-popover p-0 text-xs shadow-lg"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          {/* 头部只留「执行模式」+ 搜索两行。原本还有「选择模型」标题与
              provider·model 副标题：模型名在触发器、副标题、列表勾选处重复
              三次，且 11px 的标题比 12px 的模型行还小，标题反而是面板里最小
              的粗体字。弹层自身的 aria-label 已覆盖无障碍命名。 */}
          <div className="shrink-0 px-2 py-2">
            <div className="flex items-center justify-between gap-2 pb-1.5">
              <span className="min-w-0 shrink truncate pl-0.5 text-xs font-semibold text-foreground">
                {t("chat.selectModel")}
              </span>
              <div
                role="radiogroup"
                aria-label={t("settings.executionMode")}
                title={t("settings.executionMode")}
                className="flex shrink-0 rounded-lg bg-muted/60 p-0.5"
              >
                <label
                  className={cn(
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,box-shadow] has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "text-muted-foreground hover:text-foreground"
                      : "bg-background text-foreground shadow-sm",
                  )}
                >
                  <input
                    type="radio"
                    name={executionModeRadioName}
                    value="text"
                    checked={!isAgent}
                    onChange={() => onSelectExecutionMode("text")}
                    className="sr-only"
                  />
                  Chat
                </label>
                <label
                  className={cn(
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,box-shadow] has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <input
                    type="radio"
                    name={executionModeRadioName}
                    value="tools"
                    checked={isAgent}
                    onChange={() => onSelectExecutionMode("tools")}
                    className="sr-only"
                  />
                  {isDev ? "Agent·dev" : "Agent"}
                </label>
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="flex h-7 min-w-0 flex-1 items-center gap-2 rounded-lg bg-muted/60 px-2.5 transition-shadow focus-within:ring-2 focus-within:ring-ring/25">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/65" />
                <input
                  ref={searchInputRef}
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder={t("chat.searchModel")}
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                  onKeyDown={(event) => {
                    // Escape 必须冒泡给 Popover 关闭，方向键留给列表导航；
                    // 其余按键才拦下，避免触发编辑器/全局快捷键。
                    if (
                      event.key === "Escape" ||
                      event.key === "ArrowDown" ||
                      event.key === "ArrowUp" ||
                      event.key === "Enter"
                    ) {
                      return;
                    }
                    event.stopPropagation();
                  }}
                />
              </div>
              <button
                type="button"
                onClick={toggleProviderSortMode}
                title={sortToggleTitle}
                aria-label={sortToggleTitle}
                aria-pressed={sortByName}
                className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-muted/60 text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 aria-pressed:text-foreground"
              >
                {sortByName ? (
                  <ArrowDownAZ className="h-3.5 w-3.5" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
          {/* pt-0：sticky 分组表头贴 top-0，容器顶部若还有内边距，那条带子里的
              内容会在表头停靠位置之上滚过并露出来。底部留白由 pb 负责。 */}
          <div className="min-h-20 flex-1 space-y-0.5 overflow-y-auto overscroll-contain px-2 pb-1 [scrollbar-gutter:stable]">
            {(() => {
              const filteredGroups = normalizedSearch
                ? groups
                    .map((group) => ({
                      ...group,
                      opts: group.opts.filter(
                        (option) =>
                          option.model.toLowerCase().includes(normalizedSearch) ||
                          option.providerName.toLowerCase().includes(normalizedSearch),
                      ),
                    }))
                    .filter((group) => group.opts.length > 0)
                : groups;

              if (filteredGroups.length === 0) {
                return (
                  <div className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {t("chat.noModelFound")}
                  </div>
                );
              }

              return filteredGroups.map((group) => {
                const expanded = isGroupExpanded(group.id);
                const isSelectedGroup = selectedGroupId === group.id;
                return (
                  <div key={group.id} className={cn("flex flex-col gap-0.5")}>
                    <div
                      className={cn(
                        "group sticky top-0 z-10 flex h-8 shrink-0 items-stretch rounded-lg bg-popover transition-colors hover:bg-muted/55 focus-within:bg-muted/55",
                        isSelectedGroup && "text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        disabled={groupToggleLocked}
                        aria-expanded={expanded}
                        className={cn(
                          "model-selector-group-label flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-l-lg px-2.5 py-0 text-left text-xs font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30",
                          isSelectedGroup
                            ? "text-foreground"
                            : "text-muted-foreground/85 dark:text-white/80",
                        )}
                      >
                        <ProviderBrandIcon
                          type={group.providerType}
                          className="h-3.5 w-3.5 opacity-90"
                        />
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setIsModelPickerOpen(false);
                          onOpenSettings("providers", group.id);
                        }}
                        aria-label={`${t("settings.editProvider")}: ${group.name}`}
                        className="flex w-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground/50 opacity-100 transition-colors duration-150 hover:bg-muted/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        disabled={groupToggleLocked}
                        aria-expanded={expanded}
                        aria-label={`${
                          expanded ? t("chat.collapseProvider") : t("chat.expandProvider")
                        }: ${group.name}`}
                        className="flex shrink-0 cursor-pointer items-center rounded-r-lg px-2 py-0 text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 dark:text-white/75"
                      >
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                            expanded && "rotate-180",
                          )}
                        />
                      </button>
                    </div>
                    {expanded
                      ? group.opts.map((option) => {
                          const isSelected = option.value === selectedValue;
                          return (
                            <button
                              type="button"
                              key={option.value}
                              aria-pressed={isSelected}
                              onClick={() => {
                                const parsed = parseModelValue(option.value);
                                if (!parsed) return;
                                onSelectModel(parsed);
                                setIsModelPickerOpen(false);
                              }}
                              className={cn(
                                "model-selector-item flex h-7 w-full max-w-full shrink-0 cursor-pointer items-center justify-between gap-2 overflow-hidden rounded-lg py-0 pl-8 pr-2 text-left text-xs font-normal leading-5 text-foreground transition-[background-color,box-shadow] hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 dark:text-white",
                                isSelected &&
                                  "bg-muted/70 font-medium hover:bg-muted/70 focus-visible:bg-muted/70",
                              )}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                {/* 12px：比分组表头的 14px 小一档，避免子行图标
                                    压过父行（改前是 16px，层级是倒的）。 */}
                                <ProviderBrandIcon
                                  type={option.providerType}
                                  className={cn(
                                    "h-3 w-3 shrink-0",
                                    isSelected ? "opacity-80" : "opacity-45",
                                  )}
                                />
                                <span className="min-w-0 truncate">{option.model}</span>
                              </span>
                              {isSelected ? (
                                <Check
                                  className="size-3.5 shrink-0 text-foreground"
                                  strokeWidth={2.5}
                                />
                              ) : null}
                            </button>
                          );
                        })
                      : null}
                  </div>
                );
              });
            })()}
          </div>
        </div>
        <fieldset
          aria-label={t("chat.runtime.controls")}
          className="flex shrink-0 items-center gap-2 border-t border-border/45 px-2 py-1.5"
        >
          <RuntimeToggleChip
            pressed={chatRuntimeControls.nativeWebSearchEnabled}
            disabled={disabled}
            label={t("chat.runtime.webSearch")}
            ariaLabel={
              chatRuntimeControls.nativeWebSearchEnabled
                ? t("chat.runtime.webSearchOn")
                : t("chat.runtime.webSearchOff")
            }
            pressedClassName="bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/20 dark:text-emerald-300"
            icon={
              chatRuntimeControls.nativeWebSearchEnabled ? (
                <Globe className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <GlobeOff className="h-3.5 w-3.5 shrink-0" />
              )
            }
            onClick={() =>
              onChatRuntimeControlsChange({
                nativeWebSearchEnabled: !chatRuntimeControls.nativeWebSearchEnabled,
              })
            }
          />

          <div aria-hidden="true" className="h-4 w-px shrink-0 bg-border/70" />

          {showEffortBar ? (
            <ReasoningEffortSegments
              choices={effortChoices}
              value={selectedEffort}
              disabled={disabled}
              label={t("chat.runtime.reasoning")}
              formatLevel={(level) => t(REASONING_I18N_KEYS[level])}
              formatLevelCompact={(level) => t(REASONING_COMPACT_I18N_KEYS[level])}
              onSelect={(level) => {
                if (level === "off") {
                  onChatRuntimeControlsChange({ thinkingEnabled: false });
                  return;
                }
                onChatRuntimeControlsChange({ thinkingEnabled: true, reasoning: level });
              }}
            />
          ) : (
            <RuntimeToggleChip
              pressed={thinkingOn}
              disabled={disabled || !thinkingSupported || thinkingAlwaysOn}
              label={t("chat.runtime.thinking")}
              ariaLabel={
                !thinkingSupported
                  ? t("chat.runtime.thinkingUnavailable")
                  : thinkingOn
                    ? t("chat.runtime.thinkingOn")
                    : t("chat.runtime.thinkingOff")
              }
              pressedClassName="bg-amber-500/15 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
              icon={
                thinkingOn ? (
                  <Lightbulb className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <LightbulbOff className="h-3.5 w-3.5 shrink-0" />
                )
              }
              onClick={() =>
                onChatRuntimeControlsChange({
                  thinkingEnabled: !chatRuntimeControls.thinkingEnabled,
                })
              }
            />
          )}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
});
