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
  ChevronRight,
  Layers,
  Lightbulb,
  LightbulbOff,
  Search,
  SquarePen,
} from "@liveagent/ui/components/IconSet";
import { ProviderBrandIcon } from "@liveagent/ui/components/ProviderBrandIcon";
import { Button } from "@liveagent/ui/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@liveagent/ui/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { Switch } from "@liveagent/ui/components/ui/switch";
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
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-lg px-2.5",
        "text-xs font-medium outline-hidden transition-colors",
        "focus-visible:ring-2 focus-visible:ring-primary/35 disabled:pointer-events-none disabled:opacity-40",
        pressed
          ? pressedClassName
          : "bg-muted/60 text-muted-foreground hover:bg-settings-active/60/80 hover:text-foreground",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
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
  const [providerFilter, setProviderFilter] = useState("");
  const [view, setView] = useState<"root" | "model" | "reasoning">("root");
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
    setView("root");
    setProviderFilter("");
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
  const triggerLabel = selectedOption?.label ?? currentModelLabel;
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
  const showView = (next: "root" | "model" | "reasoning") => {
    setView(next);
    setModelSearch("");
  };
  useEffect(() => {
    if (!isModelPickerOpen) return;
    const selector = view === "root" ? "button" : "[data-model-back]";
    popoverContentRef.current?.querySelector<HTMLButtonElement>(selector)?.focus();
  }, [view, isModelPickerOpen]);
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
    return popoverContentRef.current;
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
          <Layers className="size-4 shrink-0" />
        )}
        <span className={COMPOSER_CONTROL_LABEL_CLASS}>
          {triggerLabel}
          {thinkingOn ? ` · ${t(REASONING_COMPACT_I18N_KEYS[selectedEffort])}` : ""}
        </span>
        <ChevronDown
          className={cn(COMPOSER_CONTROL_CHEVRON_CLASS, isModelPickerOpen && "rotate-180")}
        />
      </PopoverTrigger>

      <PopoverContent
        ref={popoverContentRef}
        side="top"
        align="end"
        sideOffset={8}
        collisionPadding={8}
        initialFocus={resolveModelPickerInitialFocus}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (event.target instanceof HTMLInputElement && event.target.type === "radio") return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                view === "model" ? "button[data-model-option]" : "button:not(:disabled)",
              ),
            );
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next =
              items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }
          if (event.key !== "Escape") event.stopPropagation();
        }}
        aria-label={t("chat.selectModel")}
        className={cn(
          "flex max-h-[min(360px,75dvh)] w-[300px] max-w-[calc(100vw-16px)] flex-col overflow-hidden",
          "rounded-2xl border border-border/40 bg-popover p-1.5 text-xs leading-5 shadow-lg",
          "web:font-app web:text-xs web:leading-5",
        )}
      >
        {view === "root" ? (
          <div className="space-y-1">
            <button
              type="button"
              onClick={() => showView("model")}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-lg px-2.5",
                "text-left hover:bg-settings-active/60 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span>{t("chat.selectModel")}</span>
              <span className="ml-auto min-w-0 truncate text-muted-foreground">{triggerLabel}</span>
              <ChevronRight className="size-3.5 shrink-0" />
            </button>
            <button
              type="button"
              onClick={() => showView("reasoning")}
              disabled={!thinkingSupported}
              className={cn(
                "flex h-8 w-full items-center gap-2 rounded-lg px-2.5",
                "text-left hover:bg-settings-active/60 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <span>{t("chat.runtime.reasoning")}</span>
              <span className="ml-auto text-muted-foreground">
                {thinkingSupported
                  ? t(REASONING_I18N_KEYS[selectedEffort])
                  : t("chat.runtime.thinkingUnavailable")}
              </span>
              <ChevronRight className="size-3.5 shrink-0" />
            </button>
            <div className="flex h-9 items-center justify-between gap-2 border-t border-border/40 px-2.5">
              <span className="text-xs text-muted-foreground">{t("settings.executionMode")}</span>
              <div
                role="radiogroup"
                aria-label={t("settings.executionMode")}
                title={t("settings.executionMode")}
                className="flex shrink-0 rounded-lg bg-muted/60 p-0.5"
              >
                <label
                  className={cn(
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow]",
                    "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
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
                    "relative cursor-pointer rounded-md px-2.5 py-1 text-xs font-medium transition-[color,background-color,box-shadow]",
                    "has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
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
            <fieldset aria-label={t("chat.runtime.controls")} className="border-0 px-2.5">
              <label
                htmlFor={`${executionModeRadioName}-web`}
                className="flex h-8 cursor-pointer items-center justify-between gap-2"
              >
                <span>{t("chat.runtime.webSearch")}</span>
                <Switch
                  id={`${executionModeRadioName}-web`}
                  checked={chatRuntimeControls.nativeWebSearchEnabled}
                  disabled={disabled}
                  aria-label={t("chat.runtime.webSearch")}
                  onCheckedChange={(checked) =>
                    onChatRuntimeControlsChange({ nativeWebSearchEnabled: checked })
                  }
                />
              </label>
            </fieldset>
          </div>
        ) : (
          <div className="flex min-h-0 flex-col">
            <button
              type="button"
              data-model-back
              onClick={() => showView("root")}
              className={cn(
                "mb-1 flex h-8 items-center gap-2 rounded-lg px-2.5",
                "text-left hover:bg-settings-active/60 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <ChevronRight className="size-3.5 rotate-180" />
              {t(view === "model" ? "chat.selectModel" : "chat.runtime.reasoning")}
            </button>
            {view === "model" ? (
              <>
                <div className="mb-2 flex items-center gap-2 px-1">
                  <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg bg-settings-tile-hover px-2.5">
                    <Search className="size-3.5 shrink-0 text-muted-foreground" />
                    <input
                      ref={searchInputRef}
                      value={modelSearch}
                      onChange={(event) => setModelSearch(event.target.value)}
                      placeholder={t("chat.searchModel")}
                      aria-label={t("chat.searchModel")}
                      className="min-w-0 w-full bg-transparent outline-none"
                    />
                  </label>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleProviderSortMode}
                    title={sortToggleTitle}
                    aria-label={sortToggleTitle}
                    aria-pressed={sortByName}
                  >
                    {sortByName ? (
                      <ArrowDownAZ className="size-3.5" />
                    ) : (
                      <Layers className="size-3.5" />
                    )}
                  </Button>
                </div>
                <div className="mb-1 shrink-0">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          className="h-7 w-full justify-between bg-settings-tile-hover px-2 text-xs"
                        />
                      }
                    >
                      <span className="truncate">
                        {groups.find((group) => group.id === providerFilter)?.name ??
                          t("settings.modelAllProviders")}
                      </span>
                      <ChevronDown className="size-3 shrink-0" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent className="max-h-64 w-64 overflow-y-auto">
                      <DropdownMenuRadioGroup
                        value={providerFilter}
                        onValueChange={setProviderFilter}
                      >
                        <DropdownMenuRadioItem value="">
                          {t("settings.modelAllProviders")}
                        </DropdownMenuRadioItem>
                        {groups.map((group) => (
                          <DropdownMenuRadioItem key={group.id} value={group.id}>
                            {group.name} ({group.opts.length})
                          </DropdownMenuRadioItem>
                        ))}
                      </DropdownMenuRadioGroup>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <div className="min-h-0 overflow-y-auto overscroll-contain">
                  {(() => {
                    const filteredGroups = groups
                      .filter(
                        (group) =>
                          normalizedSearch || !providerFilter || group.id === providerFilter,
                      )
                      .map((group) => ({
                        ...group,
                        opts: group.opts.filter(
                          (option) =>
                            option.model.toLowerCase().includes(normalizedSearch) ||
                            option.label.toLowerCase().includes(normalizedSearch) ||
                            option.providerName.toLowerCase().includes(normalizedSearch),
                        ),
                      }))
                      .filter((group) => group.opts.length > 0);
                    if (!filteredGroups.length)
                      return (
                        <p className="px-3 py-6 text-center text-muted-foreground">
                          {t("chat.noModelFound")}
                        </p>
                      );
                    return filteredGroups.map((group) => (
                      <div key={group.id}>
                        <div className="flex h-8 items-center justify-between px-2.5 text-xs text-muted-foreground">
                          <span>{group.name}</span>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`${t("settings.editProvider")}: ${group.name}`}
                            onClick={() => {
                              setIsModelPickerOpen(false);
                              onOpenSettings("providers", group.id);
                            }}
                          >
                            <SquarePen className="size-3" />
                          </Button>
                        </div>
                        {group.opts.map((option) => {
                          const isSelected = option.value === selectedValue;
                          return (
                            <button
                              type="button"
                              key={option.value}
                              data-model-option=""
                              aria-pressed={isSelected}
                              onClick={() => {
                                const parsed = parseModelValue(option.value);
                                if (!parsed) return;
                                onSelectModel(parsed);
                                setIsModelPickerOpen(false);
                              }}
                              className={cn(
                                "flex h-7 w-full items-center justify-between gap-2 rounded-lg px-2.5",
                                "text-left hover:bg-settings-active/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                                isSelected && "bg-settings-active/60",
                              )}
                            >
                              <span className="min-w-0 flex-1 truncate" title={option.model}>
                                {option.label}
                              </span>
                              <span className="flex shrink-0 items-center gap-1 text-tiny text-muted-foreground">
                                {option.reasoning && (
                                  <span className="rounded bg-settings-tile-hover px-1">
                                    {t("settings.modelBadgeReasoning")}
                                  </span>
                                )}
                                {option.vision && (
                                  <span className="rounded bg-settings-tile-hover px-1">
                                    {t("settings.modelBadgeVision")}
                                  </span>
                                )}
                                {option.contextWindow && (
                                  <span>
                                    {new Intl.NumberFormat("en", {
                                      notation: "compact",
                                      maximumFractionDigits: 1,
                                    }).format(option.contextWindow)}
                                  </span>
                                )}
                              </span>
                              <span className="size-3.5 shrink-0">
                                {isSelected && <Check className="size-3.5" />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ));
                  })()}
                </div>
              </>
            ) : (
              <div className="space-y-1 overflow-y-auto">
                <p className="px-3 pb-2 text-xs text-muted-foreground">{triggerLabel}</p>
                {showEffortBar ? (
                  <div role="radiogroup" aria-label={t("chat.runtime.reasoning")}>
                    {effortChoices.map((level) => (
                      <label
                        key={level}
                        className={cn(
                          "flex h-8 cursor-pointer items-center justify-between gap-2 rounded-lg px-2.5",
                          "hover:bg-settings-active/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                          selectedEffort === level && "bg-settings-active/60",
                        )}
                      >
                        <input
                          type="radio"
                          name={`${executionModeRadioName}-reasoning`}
                          value={level}
                          checked={selectedEffort === level}
                          className="sr-only"
                          onChange={() => {
                            if (level === "off")
                              onChatRuntimeControlsChange({ thinkingEnabled: false });
                            else
                              onChatRuntimeControlsChange({
                                thinkingEnabled: true,
                                reasoning: level,
                              });
                          }}
                        />
                        {t(REASONING_I18N_KEYS[level])}
                        {selectedEffort === level && <Check className="size-3.5" />}
                      </label>
                    ))}
                  </div>
                ) : (
                  <RuntimeToggleChip
                    pressed={thinkingOn}
                    disabled={disabled || !thinkingSupported || thinkingAlwaysOn}
                    label={t("chat.runtime.thinking")}
                    ariaLabel={
                      thinkingOn ? t("chat.runtime.thinkingOn") : t("chat.runtime.thinkingOff")
                    }
                    pressedClassName="bg-muted text-foreground"
                    icon={
                      thinkingOn ? (
                        <Lightbulb className="size-3.5" />
                      ) : (
                        <LightbulbOff className="size-3.5" />
                      )
                    }
                    onClick={() =>
                      onChatRuntimeControlsChange({
                        thinkingEnabled: !chatRuntimeControls.thinkingEnabled,
                      })
                    }
                  />
                )}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
