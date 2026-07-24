import { Popover } from "@base-ui/react";
import { memo, type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  ArrowDownAZ,
  Check,
  ChevronDown,
  ClaudeIcon,
  GeminiIcon,
  GrokIcon,
  Layers,
  MonitorSmartphone,
  Moon,
  OpenaiChatgptIcon,
  PanelLeft,
  Search,
  Settings,
  Sun,
} from "../../../components/icons";

import { isMacOsTauri } from "../../../components/MacOsTitleBarSpacer";
import { Button } from "../../../components/ui/button";
import { useLocale } from "../../../i18n";
import {
  groupModelOptionsByProvider,
  type ProviderSortMode,
  persistProviderSortMode,
  readStoredProviderSortMode,
  sortModelOptionGroups,
} from "../../../lib/chat/page/chatPageHelpers";
import { type ModelOption, parseModelValue } from "../../../lib/providers/llm";
import {
  type AppSettings,
  getNextTheme,
  isAgentDevMode,
  isAgentExecutionMode,
  type ProviderId,
  type SelectedModel,
  type Theme,
} from "../../../lib/settings";
import { cn } from "../../../lib/shared/utils";
import type { SectionId } from "../../settings/types";

function ProviderBrandIcon({ type, className }: { type: ProviderId; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  if (type === "xai") return <GrokIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
}

function ThemeToggleIcon(props: { theme: Theme }) {
  if (props.theme === "light") return <Sun className="h-4 w-4" />;
  if (props.theme === "dark") return <Moon className="h-4 w-4" />;
  return <MonitorSmartphone className="h-4 w-4" />;
}

export const ChatHeader = memo(function ChatHeader(props: {
  settings: AppSettings;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: ModelOption[];
  selectedValue?: string;
  sidebarOpen: boolean;
  onSelectModel: (selection: SelectedModel) => void;
  // 模型下拉内嵌的执行模式分段器：请求切到 Chat("text") 或 Agent("tools")。
  // agent-dev 视为 Agent 的一种，由调用方决定是否保持不降级。
  onSelectExecutionMode: (mode: "text" | "tools") => void;
  onOpenSettings: (section?: SectionId) => void;
  onToggleTheme: () => void;
  onOpenSidebar: () => void;
  preThemeActions?: ReactNode;
  trailingActions?: ReactNode;
}) {
  const {
    settings,
    hasModels,
    currentModelLabel,
    modelOptions,
    selectedValue,
    sidebarOpen,
    onSelectModel,
    onSelectExecutionMode,
    onOpenSettings,
    onToggleTheme,
    onOpenSidebar,
    preThemeActions,
    trailingActions,
  } = props;
  const { t } = useLocale();
  const nextTheme = getNextTheme(settings.theme);
  const themeToggleTitle =
    nextTheme === "light"
      ? t("tooltip.switchToLight")
      : nextTheme === "dark"
        ? t("tooltip.switchToDark")
        : t("tooltip.switchToAuto");
  const [isModelPickerOpen, setIsModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const [providerSortMode, setProviderSortMode] = useState<ProviderSortMode>(() =>
    readStoredProviderSortMode(),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const executionModeRadioName = useId();
  const macOsTauri = isMacOsTauri();

  useEffect(() => {
    if (isModelPickerOpen) {
      setModelSearch("");
      setExpandedGroups({});
    }
  }, [isModelPickerOpen]);

  const normalizedSearch = modelSearch.trim().toLowerCase();
  const groups = sortModelOptionGroups(groupModelOptionsByProvider(modelOptions), providerSortMode);

  // 副作用放在 updater 外：StrictMode 会双调用传给 setState 的函数
  const nextProviderSortMode: ProviderSortMode = providerSortMode === "type" ? "alpha" : "type";
  const toggleProviderSortMode = () => {
    persistProviderSortMode(nextProviderSortMode);
    setProviderSortMode(nextProviderSortMode);
  };
  const sortToggleTitle =
    nextProviderSortMode === "alpha"
      ? t("chat.sortProvidersByName")
      : t("chat.sortProvidersByType");

  const selectedOption = modelOptions.find((o) => o.value === selectedValue);
  const selectedGroupId = selectedOption?.providerId;
  // 默认全部折叠，仅当前选中模型所在分组展开；搜索时强制展开所有匹配分组
  const isGroupExpanded = (id: string) =>
    normalizedSearch.length > 0 || (expandedGroups[id] ?? id === selectedGroupId);
  // 基于存储态取反（而非 isGroupExpanded）：搜索强制展开是只读覆盖，
  // 不应让搜索期间的点击把折叠态写坏
  const toggleGroup = (id: string) =>
    setExpandedGroups((prev) => ({
      ...prev,
      [id]: !(prev[id] ?? id === selectedGroupId),
    }));

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex items-center justify-between gap-2 py-2.5 pr-4",
        !sidebarOpen && macOsTauri ? "pl-[232px]" : "pl-4",
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        {!sidebarOpen && !macOsTauri ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={onOpenSidebar}
            title={t("tooltip.openSidebar")}
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <PanelLeft className="h-4.5 w-4.5" />
          </Button>
        ) : null}

        <Popover.Root open={isModelPickerOpen} onOpenChange={setIsModelPickerOpen}>
          <Popover.Trigger
            render={
              <Button
                variant="ghost"
                disabled={!hasModels}
                className={cn(
                  "model-selector-trigger h-8 max-w-[min(20rem,calc(100vw-8.5rem))] -translate-y-px justify-between gap-1.5 overflow-hidden rounded-lg px-2.5 py-1 cursor-pointer text-xs font-normal text-foreground transition-all duration-200 ease-out hover:bg-muted/60 dark:text-white",
                  isModelPickerOpen && "bg-muted/60",
                )}
              />
            }
          >
            <span className="model-selector-current-label flex min-w-0 items-center gap-1.5 text-left">
              {selectedOption ? (
                <ProviderBrandIcon type={selectedOption.providerType} className="opacity-80" />
              ) : null}
              <span className="min-w-0 truncate">{currentModelLabel}</span>
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out dark:text-white",
                isModelPickerOpen && "rotate-180",
              )}
            />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Positioner
              side="bottom"
              align="start"
              sideOffset={4}
              collisionPadding={8}
              className="z-[9999]"
            >
              <Popover.Popup
                initialFocus={searchInputRef}
                aria-label={t("chat.selectModel")}
                className="model-selector-dropdown w-[min(18rem,calc(100vw-1rem))] overflow-hidden rounded-xl border bg-popover p-0 text-xs text-popover-foreground shadow-md outline-none"
              >
                {(() => {
                  const isAgent = isAgentExecutionMode(settings.system.executionMode);
                  const isDev = isAgentDevMode(settings.system.executionMode);
                  return (
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
                              "relative cursor-pointer rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
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
                              "relative cursor-pointer rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition-colors has-[:focus-visible]:outline-none has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary/40",
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
                  );
                })()}
                <div className="px-2 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
                      <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                      <input
                        ref={searchInputRef}
                        value={modelSearch}
                        onChange={(e) => setModelSearch(e.target.value)}
                        placeholder={t("chat.searchModel")}
                        className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/60"
                        onKeyDown={(e) => e.stopPropagation()}
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
                <div className="max-h-[min(20rem,var(--available-height,20rem))] overflow-y-auto overscroll-contain px-1 pb-1 [scrollbar-gutter:stable]">
                  {(() => {
                    let animationIndex = 0;
                    const filteredGroups = normalizedSearch
                      ? groups
                          .map((group) => ({
                            ...group,
                            opts: group.opts.filter(
                              (o) =>
                                o.model.toLowerCase().includes(normalizedSearch) ||
                                o.providerName.toLowerCase().includes(normalizedSearch),
                            ),
                          }))
                          .filter((g) => g.opts.length > 0)
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
                          {groupIndex > 0 ? (
                            <hr className="my-1 h-px border-0 bg-border/30" />
                          ) : null}
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.id)}
                            aria-expanded={expanded}
                            title={expanded ? t("chat.collapseProvider") : t("chat.expandProvider")}
                            className="model-selector-group-label sticky top-0 z-10 flex h-[30px] w-full shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-popover/60 px-2 py-0 text-left text-xs font-medium uppercase tracking-wider text-muted-foreground/80 backdrop-blur-xl transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 supports-[backdrop-filter]:bg-popover/40 dark:text-white/80"
                          >
                            <ProviderBrandIcon
                              type={group.providerType}
                              className="h-3.5 w-3.5 opacity-90"
                            />
                            <span className="min-w-0 flex-1 truncate normal-case tracking-normal">
                              {group.name}
                            </span>
                            <span className="inline-flex h-4 min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-muted/70 px-1 text-[calc(10px*var(--zone-font-scale,1))] tabular-nums tracking-normal">
                              {group.opts.length}
                            </span>
                            <ChevronDown
                              className={cn(
                                "h-3.5 w-3.5 shrink-0 transition-transform duration-200",
                                expanded && "rotate-180",
                              )}
                            />
                          </button>
                          {expanded
                            ? group.opts.map((option) => {
                                const isSelected = option.value === selectedValue;
                                const itemAnimationDelay = `${Math.min(animationIndex, 5) * 0.025}s`;
                                animationIndex += 1;
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
                                      "model-selector-item flex h-[30px] w-full max-w-full shrink-0 cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-md px-2 py-0 text-left text-xs font-normal leading-5 text-foreground transition-none hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 dark:text-white",
                                      isSelected &&
                                        "bg-foreground/[0.07] font-medium text-foreground hover:bg-foreground/[0.09] focus-visible:bg-foreground/[0.09]",
                                    )}
                                    style={{ animationDelay: itemAnimationDelay }}
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
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      </div>

      <div className="flex shrink-0 -translate-y-px items-center gap-1">
        {preThemeActions}
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleTheme}
          title={themeToggleTitle}
          aria-label={themeToggleTitle}
          className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
        >
          <ThemeToggleIcon theme={nextTheme} />
        </Button>
        {!sidebarOpen && !isMacOsTauri() && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenSettings()}
            title={t("tooltip.settings")}
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-4 w-4" />
          </Button>
        )}
        {trailingActions}
      </div>
    </header>
  );
});
