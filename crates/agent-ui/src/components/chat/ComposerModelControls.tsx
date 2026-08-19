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
  ClaudeIcon,
  DeepseekIcon,
  GeminiIcon,
  Globe,
  GlobeOff,
  GrokIcon,
  Layers,
  Lightbulb,
  LightbulbOff,
  OpenaiChatgptIcon,
  Pencil,
  Search,
  Sparkle,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
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
import { memo, useEffect, useId, useRef, useState } from "react";

const REASONING_I18N_KEYS: Record<ReasoningLevel, string> = {
  off: "settings.reasoning.off",
  minimal: "settings.reasoning.minimal",
  low: "settings.reasoning.low",
  medium: "settings.reasoning.medium",
  high: "settings.reasoning.high",
  xhigh: "settings.reasoning.xhigh",
  max: "settings.reasoning.max",
};

function isReasoningLevel(value: unknown): value is ReasoningLevel {
  return typeof value === "string" && Object.hasOwn(REASONING_I18N_KEYS, value);
}

function ProviderBrandIcon({ type, className }: { type: ProviderId; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "xai") return <GrokIcon className={cls} />;
  if (type === "deepseek") return <DeepseekIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
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

  return (
    <Popover open={isModelPickerOpen} onOpenChange={setIsModelPickerOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            disabled={disabled || !hasModels}
            title={currentModelLabel}
            aria-label={`${t("chat.selectModel")}: ${currentModelLabel}`}
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
        side="top"
        align="start"
        sideOffset={8}
        collisionPadding={8}
        initialFocus={searchInputRef}
        aria-label={t("chat.selectModel")}
        className="model-selector-dropdown flex max-h-[min(30rem,var(--available-height,30rem))] w-[min(19rem,calc(100vw-1rem))] flex-col overflow-hidden p-0 text-xs"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="px-2 pt-2">
            <div className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2 py-1.5">
              <span className="text-[11px] font-medium text-muted-foreground">
                {t("settings.executionMode")}
              </span>
              <div
                role="radiogroup"
                aria-label={t("settings.executionMode")}
                className="flex rounded-md bg-background/80 p-0.5 shadow-sm ring-1 ring-border/40"
              >
                <label
                  className={cn(
                    "relative cursor-pointer rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "text-muted-foreground hover:text-foreground"
                      : "bg-foreground/[0.07] text-foreground",
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
                    "relative cursor-pointer rounded-sm px-2.5 py-1 text-[11px] font-medium transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
                    isAgent
                      ? "bg-foreground/[0.07] text-foreground"
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
          </div>

          <div className="px-2 py-1.5">
            <div className="flex items-center gap-1.5">
              <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
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
                className="flex w-7 shrink-0 cursor-pointer items-center justify-center self-stretch rounded-md border border-border/50 bg-muted/40 text-muted-foreground/70 transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                {nextProviderSortMode === "alpha" ? (
                  <ArrowDownAZ className="h-3.5 w-3.5" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>

          <div className="min-h-24 flex-1 overflow-y-auto overscroll-contain px-1 pb-1 [scrollbar-gutter:stable]">
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

              return filteredGroups.map((group, groupIndex) => {
                const expanded = isGroupExpanded(group.id);
                return (
                  <div key={group.id} className="flex flex-col gap-0.5">
                    {groupIndex > 0 ? <hr className="my-1 h-px border-0 bg-border/30" /> : null}
                    <div className="group sticky top-0 z-10 flex h-[30px] shrink-0 items-stretch rounded-md bg-popover/60 backdrop-blur-xl transition-colors hover:bg-muted/40 focus-within:bg-muted/40 supports-[backdrop-filter]:bg-popover/40">
                      <button
                        type="button"
                        onClick={() => toggleGroup(group.id)}
                        aria-expanded={expanded}
                        className="model-selector-group-label flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-l-md px-2 py-0 text-left text-xs font-medium text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:text-white/80"
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
                        className="pointer-events-none flex w-7 max-w-0 shrink-0 cursor-pointer items-center justify-center overflow-hidden text-muted-foreground/70 opacity-0 transition-[max-width,opacity,color,background-color] duration-150 group-hover:max-w-7 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:max-w-7 group-focus-within:pointer-events-auto group-focus-within:opacity-100 hover:bg-muted/60 hover:text-foreground focus-visible:max-w-7 focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
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
                        className="model-selector-group-label flex shrink-0 cursor-pointer items-center gap-1.5 rounded-r-md px-2 py-0 text-muted-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:text-white/80"
                      >
                        <span className="inline-flex h-4 min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-muted/70 px-1 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums">
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
                                "model-selector-item flex h-[30px] w-full max-w-full shrink-0 cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-md py-0 pl-6 pr-2 text-left text-xs font-normal leading-5 text-foreground transition-none hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:text-white",
                                isSelected &&
                                  "bg-foreground/[0.07] font-medium hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09]",
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
                                <Check className="h-4 w-4 shrink-0 text-primary" />
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
          className={cn(
            "grid shrink-0 items-center gap-1 border-t border-border/50 bg-muted/20 p-2",
            reasoningOptions.length > 0 ? "grid-cols-3" : "grid-cols-2",
          )}
        >
          <button
            type="button"
            disabled={disabled}
            aria-pressed={chatRuntimeControls.nativeWebSearchEnabled}
            aria-label={
              chatRuntimeControls.nativeWebSearchEnabled
                ? t("chat.runtime.webSearchOn")
                : t("chat.runtime.webSearchOff")
            }
            onClick={() =>
              onChatRuntimeControlsChange({
                nativeWebSearchEnabled: !chatRuntimeControls.nativeWebSearchEnabled,
              })
            }
            className={cn(
              "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 text-[11px] font-medium outline-hidden transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40",
              chatRuntimeControls.nativeWebSearchEnabled
                ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground",
            )}
          >
            {chatRuntimeControls.nativeWebSearchEnabled ? (
              <Globe className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <GlobeOff className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{t("chat.runtime.webSearch")}</span>
          </button>

          <button
            type="button"
            disabled={disabled || !thinkingSupported || thinkingAlwaysOn}
            aria-pressed={chatRuntimeControls.thinkingEnabled && thinkingSupported}
            aria-label={
              !thinkingSupported
                ? t("chat.runtime.thinkingUnavailable")
                : chatRuntimeControls.thinkingEnabled
                  ? t("chat.runtime.thinkingOn")
                  : t("chat.runtime.thinkingOff")
            }
            onClick={() =>
              onChatRuntimeControlsChange({
                thinkingEnabled: !chatRuntimeControls.thinkingEnabled,
              })
            }
            className={cn(
              "inline-flex h-8 min-w-0 items-center justify-center gap-1.5 rounded-lg border border-transparent px-2 text-[11px] font-medium outline-hidden transition-colors hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40",
              chatRuntimeControls.thinkingEnabled && thinkingSupported
                ? "border-amber-500/20 bg-amber-500/10 text-amber-700 dark:text-amber-300"
                : "text-muted-foreground",
            )}
          >
            {chatRuntimeControls.thinkingEnabled && thinkingSupported ? (
              <Lightbulb className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <LightbulbOff className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="truncate">{t("chat.runtime.thinking")}</span>
          </button>

          {reasoningOptions.length > 0 ? (
            <Select
              value={selectedReasoning}
              onValueChange={(value) =>
                onChatRuntimeControlsChange({ reasoning: value as ReasoningLevel })
              }
              disabled={
                disabled || !chatRuntimeControls.thinkingEnabled || reasoningOptions.length === 1
              }
            >
              <SelectTrigger
                className="h-8 w-full min-w-0 gap-0.5 rounded-lg border border-violet-500/15 bg-violet-500/[0.07] pl-2 pr-1.5 text-[11px] font-medium text-foreground shadow-none outline-hidden disabled:opacity-45 [&>svg:last-child]:h-3 [&>svg:last-child]:w-3 [&>svg:last-child]:opacity-50"
                aria-label={t("chat.runtime.reasoning")}
              >
                <Sparkle className="h-3.5 w-3.5 shrink-0 text-violet-500 dark:text-violet-400" />
                <SelectValue>
                  {(value) =>
                    t(REASONING_I18N_KEYS[isReasoningLevel(value) ? value : selectedReasoning])
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="sidebar-context-menu min-w-36 rounded-xl border-0">
                {reasoningOptions.map((value) => (
                  <SelectItem
                    key={value}
                    value={value}
                    className="mb-0.5 h-[30px] rounded-md py-0 text-sm font-normal leading-5 transition-none last:mb-0 focus:bg-foreground/[0.05] focus:text-foreground"
                  >
                    {t(REASONING_I18N_KEYS[value])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </fieldset>
      </PopoverContent>
    </Popover>
  );
});
