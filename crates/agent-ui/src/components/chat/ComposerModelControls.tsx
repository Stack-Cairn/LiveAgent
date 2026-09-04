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
  Brain,
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
import { memo, type ReactNode, useEffect, useId, useRef, useState } from "react";

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
        "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 text-[11px] font-medium outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40",
        pressed
          ? pressedClassName
          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
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
const EFFORT_THUMB_INSET_CLASS = "right-2 left-2";

function ReasoningEffortSlider(props: {
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
  const max = Math.max(1, choices.length - 1);
  const index = Math.max(0, choices.indexOf(value));
  const percent = (index / max) * 100;
  const isOff = value === "off";
  return (
    <div
      title={`${label}: ${formatLevel(value)}`}
      className={cn(
        "model-runtime-effort flex min-w-0 flex-1 items-center gap-2",
        disabled && "opacity-50",
      )}
    >
      <Brain className="size-4 shrink-0 text-foreground/60 dark:text-foreground/70" />
      <div className="group relative flex h-8 min-w-0 flex-1 items-center">
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 h-1 -translate-y-1/2 overflow-visible rounded-full bg-foreground/[0.10] shadow-[inset_0_1px_1px_rgba(15,23,42,0.08)] dark:bg-white/[0.12] dark:shadow-[inset_0_1px_1px_rgba(0,0,0,0.35)]",
            EFFORT_THUMB_INSET_CLASS,
          )}
        >
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/65 transition-[width] duration-150 ease-out dark:bg-white/65"
            style={{ width: `${percent}%` }}
          />
          {choices.map((level, stopIndex) => (
            <span
              key={level}
              className={cn(
                "absolute top-1/2 h-1.5 w-px -translate-x-1/2 -translate-y-1/2 rounded-full",
                stopIndex <= index
                  ? "bg-background/75 dark:bg-background/80"
                  : "bg-foreground/20 dark:bg-white/25",
              )}
              style={{ left: `${(stopIndex / max) * 100}%` }}
            />
          ))}
          <span
            className="absolute top-1/2 flex size-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-foreground/20 bg-background shadow-[0_1px_4px_rgba(15,23,42,0.22),0_0_0_1px_rgba(255,255,255,0.45)] transition-[left,transform] duration-150 ease-out group-hover:scale-105 dark:border-white/25 dark:shadow-[0_1px_5px_rgba(0,0,0,0.55)]"
            style={{ left: `${percent}%` }}
          >
            <span className="size-1.5 rounded-full bg-foreground/70 dark:bg-white/75" />
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={index}
          disabled={disabled}
          aria-label={label}
          aria-valuetext={formatLevel(value)}
          className="relative z-10 h-8 w-full min-w-0 cursor-pointer appearance-none rounded-full bg-transparent outline-hidden disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-foreground/20 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-transparent [&::-moz-range-thumb]:opacity-0 [&::-moz-range-track]:h-8 [&::-moz-range-track]:bg-transparent [&::-webkit-slider-runnable-track]:h-8 [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-transparent [&::-webkit-slider-thumb]:opacity-0"
          onPointerDown={(event) => event.stopPropagation()}
          onChange={(event) => {
            const next = choices[Number(event.target.value)];
            if (next) onSelect(next);
          }}
        />
      </div>
      <span
        className={cn(
          "min-w-9 shrink-0 rounded-lg border border-border/45 bg-background/65 px-1.5 py-1.5 text-center text-[10.5px] font-semibold leading-none text-foreground/75 shadow-sm dark:bg-background/35 dark:text-foreground/80",
          isOff && "text-muted-foreground shadow-none",
        )}
      >
        {formatLevelCompact(value)}
      </span>
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
  const nextProviderSortMode: ProviderSortMode = providerSortMode === "type" ? "alpha" : "type";
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
  const sortToggleTitle =
    nextProviderSortMode === "alpha"
      ? t("chat.sortProvidersByName")
      : t("chat.sortProvidersByType");

  const toggleProviderSortMode = () => {
    persistProviderSortMode(nextProviderSortMode);
    setProviderSortMode(nextProviderSortMode);
  };
  const isGroupExpanded = (id: string) => {
    if (normalizedSearch.length > 0) return true;
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
        className="model-selector-dropdown flex max-h-[min(32rem,var(--available-height,32rem))] w-[min(21rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-2xl border-black/[0.07] bg-popover/96 p-0 text-xs shadow-[0_1px_2px_rgba(15,23,42,0.08),0_18px_56px_-20px_rgba(15,23,42,0.42)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/[0.12] dark:bg-popover/94 dark:shadow-[0_1px_2px_rgba(0,0,0,0.35),0_20px_60px_-20px_rgba(0,0,0,0.82)]"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 border-b border-border/45 bg-muted/[0.12] px-2.5 pb-2.5 pt-2.5">
            <div className="flex items-center justify-between gap-3 px-0.5 pb-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-foreground">
                  {t("chat.selectModel")}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
                  {selectedOption ? (
                    <ProviderBrandIcon
                      type={selectedOption.providerType}
                      className="h-3 w-3 opacity-75"
                    />
                  ) : null}
                  <span className="truncate">
                    {selectedOption
                      ? `${selectedOption.providerName} · ${selectedOption.model}`
                      : currentModelLabel}
                  </span>
                </div>
              </div>
              <div
                role="radiogroup"
                aria-label={t("settings.executionMode")}
                title={t("settings.executionMode")}
                className="flex shrink-0 rounded-lg bg-muted/55 p-0.5 ring-1 ring-border/45"
              >
                <label
                  className={cn(
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-[color,background-color,box-shadow] has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "text-muted-foreground hover:text-foreground"
                      : "bg-background text-foreground shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.08]",
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
                      ? "bg-background text-foreground shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.08]"
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
              <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border/55 bg-background/78 px-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)] transition-[border-color,background-color,box-shadow] focus-within:border-ring/30 focus-within:bg-background focus-within:ring-2 focus-within:ring-ring/15 dark:shadow-none">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/65" />
                <input
                  ref={searchInputRef}
                  value={modelSearch}
                  onChange={(event) => setModelSearch(event.target.value)}
                  placeholder={t("chat.searchModel")}
                  className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                  onKeyDown={(event) => event.stopPropagation()}
                />
              </div>
              <button
                type="button"
                onClick={toggleProviderSortMode}
                title={sortToggleTitle}
                aria-label={sortToggleTitle}
                className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-border/55 bg-background/78 text-muted-foreground/70 transition-[border-color,background-color,color] hover:border-border hover:bg-muted/65 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {nextProviderSortMode === "alpha" ? (
                  <ArrowDownAZ className="h-3.5 w-3.5" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="min-h-24 flex-1 space-y-1 overflow-y-auto overscroll-contain px-1.5 py-1.5 [scrollbar-gutter:stable]">
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
                  <div
                    key={group.id}
                    className={cn(
                      "flex flex-col gap-0.5 rounded-xl border p-0.5 transition-[border-color,background-color]",
                      expanded
                        ? "border-border/50 bg-muted/[0.14]"
                        : isSelectedGroup
                          ? "border-border/35 bg-muted/[0.08]"
                          : "border-transparent",
                    )}
                  >
                    <div
                      className={cn(
                        "group sticky top-0 z-10 flex h-8 shrink-0 items-stretch rounded-lg bg-popover/95 backdrop-blur-xl transition-colors hover:bg-muted/55 focus-within:bg-muted/55 supports-[backdrop-filter]:bg-popover/85",
                        isSelectedGroup && "text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
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
                        className="pointer-events-none flex w-7 shrink-0 cursor-pointer items-center justify-center text-muted-foreground/65 opacity-0 transition-[opacity,color,background-color] duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-muted/65 hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        aria-expanded={expanded}
                        aria-label={`${
                          expanded ? t("chat.collapseProvider") : t("chat.expandProvider")
                        }: ${group.name}`}
                        className="model-selector-group-label flex shrink-0 cursor-pointer items-center gap-1.5 rounded-r-lg px-2 py-0 text-muted-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 dark:text-white/75"
                      >
                        <span className="inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-muted/65 px-1 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums ring-1 ring-border/30">
                          {group.opts.length}
                        </span>
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
                                "model-selector-item flex h-8 w-full max-w-full shrink-0 cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-lg py-0 pl-7 pr-2 text-left text-xs font-normal leading-5 text-foreground transition-[background-color,box-shadow] hover:bg-foreground/[0.045] focus-visible:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/30 dark:text-white",
                                isSelected &&
                                  "bg-background font-medium shadow-sm ring-1 ring-border/45 hover:bg-background focus-visible:bg-background",
                              )}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                <ProviderBrandIcon
                                  type={option.providerType}
                                  className={cn("opacity-70", isSelected && "opacity-100")}
                                />
                                <span className="min-w-0 truncate">{option.model}</span>
                              </span>
                              {isSelected ? (
                                <span className="inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-background shadow-sm">
                                  <Check className="size-3" strokeWidth={3} />
                                </span>
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
          className="model-runtime-controls flex shrink-0 items-center gap-2 border-t border-border/45 bg-muted/[0.16] px-2.5 py-2"
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
            pressedClassName="border-emerald-500/20 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-300"
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
            <ReasoningEffortSlider
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
              pressedClassName="border-amber-500/20 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300"
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
