import { memo, type ReactNode, useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ClaudeIcon,
  GeminiIcon,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu";
import { useLocale } from "../../../i18n";
import { type ModelOption, parseModelValue } from "../../../lib/providers/llm";
import {
  type AppSettings,
  getNextTheme,
  type ProviderId,
  setSelectedModel,
  type Theme,
} from "../../../lib/settings";
import { cn } from "../../../lib/shared/utils";
import type { SectionId } from "../../settings/types";

function ProviderBrandIcon({ type, className }: { type: ProviderId; className?: string }) {
  const cls = cn("h-4 w-4 shrink-0", className);
  if (type === "claude_code") return <ClaudeIcon className={cls} />;
  if (type === "gemini") return <GeminiIcon className={cls} />;
  return <OpenaiChatgptIcon className={cn(cls, "fill-current dark:text-white")} />;
}

function ThemeToggleIcon(props: { theme: Theme }) {
  if (props.theme === "light") return <Sun className="h-4.5 w-4.5" />;
  if (props.theme === "dark") return <Moon className="h-4.5 w-4.5" />;
  return <MonitorSmartphone className="h-4.5 w-4.5" />;
}

export const ChatHeader = memo(function ChatHeader(props: {
  settings: AppSettings;
  hasModels: boolean;
  currentModelLabel: string;
  modelOptions: ModelOption[];
  selectedValue?: string;
  sidebarOpen: boolean;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
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
    setSettings,
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
  const [isModelMenuOpen, setIsModelMenuOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isModelMenuOpen) {
      setModelSearch("");
      setExpandedGroups({});
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [isModelMenuOpen]);

  const normalizedSearch = modelSearch.trim().toLowerCase();
  const groups: {
    name: string;
    providerType: ProviderId;
    opts: ModelOption[];
  }[] = [];
  const groupMap = new Map<string, ModelOption[]>();
  for (const option of modelOptions) {
    const existing = groupMap.get(option.providerName);
    if (existing) {
      existing.push(option);
      continue;
    }
    const nextGroup: ModelOption[] = [option];
    groupMap.set(option.providerName, nextGroup);
    groups.push({
      name: option.providerName,
      providerType: option.providerType,
      opts: nextGroup,
    });
  }

  const selectedOption = modelOptions.find((o) => o.value === selectedValue);
  const selectedGroupName = selectedOption?.providerName;
  // 默认全部折叠，仅当前选中模型所在分组展开；搜索时强制展开所有匹配分组
  const isGroupExpanded = (name: string) =>
    normalizedSearch.length > 0 || (expandedGroups[name] ?? name === selectedGroupName);
  // 基于存储态取反（而非 isGroupExpanded）：搜索强制展开是只读覆盖，
  // 不应让搜索期间的点击把折叠态写坏
  const toggleGroup = (name: string) =>
    setExpandedGroups((prev) => ({
      ...prev,
      [name]: !(prev[name] ?? name === selectedGroupName),
    }));

  return (
    <header data-tauri-drag-region className="flex items-center justify-between gap-2 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {!sidebarOpen && !isMacOsTauri() ? (
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

        <DropdownMenu open={isModelMenuOpen} onOpenChange={setIsModelMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                disabled={!hasModels}
                className={cn(
                  "model-selector-trigger h-9 max-w-[min(20rem,calc(100vw-8.5rem))] justify-between gap-1.5 overflow-hidden rounded-lg px-3 cursor-pointer text-xs font-normal text-foreground transition-all duration-200 ease-out hover:bg-muted/60 dark:text-white",
                  isModelMenuOpen && "bg-muted/70 shadow-sm",
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
                isModelMenuOpen && "rotate-180",
              )}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={8}
            collisionPadding={8}
            className="model-selector-dropdown w-[min(18rem,calc(100vw-1rem))] overflow-hidden rounded-xl border border-border/40 bg-popover/70 p-0 shadow-[0_12px_40px_-12px_rgba(0,0,0,0.25)] ring-1 ring-white/10 backdrop-blur-2xl backdrop-saturate-150 supports-[backdrop-filter]:bg-popover/55"
          >
            <DropdownMenuLabel className="model-selector-menu-title px-3 py-2 text-[calc(11px*var(--zone-font-scale,1))] font-medium uppercase tracking-wider text-muted-foreground/80 dark:text-white/80">
              {t("chat.selectModel")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="my-0 bg-border/40" />
            <div className="px-2 py-1.5">
              <div className="flex items-center gap-1.5 rounded-md border border-border/50 bg-muted/40 px-2 py-1">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                <input
                  ref={searchInputRef}
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder={t("chat.searchModel")}
                  className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
                  onKeyDown={(e) => e.stopPropagation()}
                />
              </div>
            </div>
            <div className="max-h-[min(20rem,var(--available-height,20rem))] overflow-y-auto overscroll-contain px-1 pb-1">
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
                  const expanded = isGroupExpanded(group.name);
                  return (
                    <div key={group.name}>
                      {groupIndex > 0 ? <DropdownMenuSeparator className="bg-border/30" /> : null}
                      <DropdownMenuItem
                        closeOnClick={false}
                        onSelect={() => toggleGroup(group.name)}
                        aria-expanded={expanded}
                        title={expanded ? t("chat.collapseProvider") : t("chat.expandProvider")}
                        className="model-selector-group-label sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 rounded-md bg-popover/60 px-2 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium uppercase tracking-wider text-muted-foreground/80 backdrop-blur-xl transition-colors data-[highlighted]:bg-muted/40 supports-[backdrop-filter]:bg-popover/40 dark:text-white/80"
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
                      </DropdownMenuItem>
                      {expanded
                        ? group.opts.map((option) => {
                            const isSelected = option.value === selectedValue;
                            const itemAnimationDelay = `${Math.min(animationIndex, 5) * 0.025}s`;
                            animationIndex += 1;
                            return (
                              <DropdownMenuItem
                                key={option.value}
                                onSelect={() => {
                                  const parsed = parseModelValue(option.value);
                                  if (!parsed) return;
                                  setSettings((prev) => setSelectedModel(prev, parsed));
                                }}
                                className={cn(
                                  "model-selector-item group/item max-w-full justify-between gap-3 overflow-hidden rounded-md text-foreground transition-all duration-150 ease-out data-[highlighted]:translate-x-0.5 data-[highlighted]:bg-muted/40 dark:text-white",
                                  isSelected && "bg-muted/60 font-medium text-foreground",
                                )}
                                style={{ animationDelay: itemAnimationDelay }}
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  <ProviderBrandIcon
                                    type={option.providerType}
                                    className={cn(
                                      "opacity-70 transition-opacity duration-150 group-data-[highlighted]/item:opacity-100",
                                      isSelected && "opacity-100",
                                    )}
                                  />
                                  <span className="min-w-0 truncate">{option.model}</span>
                                </span>
                                {isSelected ? (
                                  <Check className="h-4 w-4 shrink-0 text-primary" />
                                ) : null}
                              </DropdownMenuItem>
                            );
                          })
                        : null}
                    </div>
                  );
                });
              })()}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex shrink-0 items-center gap-1">
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
        {!isMacOsTauri() && (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onOpenSettings()}
            title={t("tooltip.settings")}
            className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
          >
            <Settings className="h-4.5 w-4.5" />
          </Button>
        )}
        {trailingActions}
      </div>
    </header>
  );
});
