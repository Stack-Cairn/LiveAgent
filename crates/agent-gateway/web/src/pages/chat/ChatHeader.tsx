import { memo, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ClaudeIcon,
  GeminiIcon,
  MonitorSmartphone,
  Moon,
  OpenaiChatgptIcon,
  PanelLeft,
  Settings,
  Sun,
} from "../../components/icons";

import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { useLocale } from "../../i18n";
import { type ModelOption, parseModelValue } from "../../lib/providers/llm";
import {
  type AppSettings,
  getNextTheme,
  type ProviderId,
  setSelectedModel,
  type Theme,
} from "../../lib/settings";
import { cn } from "../../lib/shared/utils";
import type { SectionId } from "../settings/types";

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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (isModelMenuOpen) {
      setExpandedGroups({});
    }
  }, [isModelMenuOpen]);

  const groups = useMemo(() => {
    const nextGroups: { name: string; providerType: ProviderId; opts: ModelOption[] }[] = [];
    const groupMap = new Map<string, ModelOption[]>();
    for (const option of modelOptions) {
      const existing = groupMap.get(option.providerName);
      if (existing) {
        existing.push(option);
        continue;
      }
      const nextGroup: ModelOption[] = [option];
      groupMap.set(option.providerName, nextGroup);
      nextGroups.push({
        name: option.providerName,
        providerType: option.providerType,
        opts: nextGroup,
      });
    }
    return nextGroups;
  }, [modelOptions]);
  const selectedOption = modelOptions.find((option) => option.value === selectedValue);
  const selectedGroupName = selectedOption?.providerName;
  // 默认全部折叠，仅当前选中模型所在分组展开
  const isGroupExpanded = (name: string) => expandedGroups[name] ?? name === selectedGroupName;
  const toggleGroup = (name: string) =>
    setExpandedGroups((prev) => ({
      ...prev,
      [name]: !(prev[name] ?? name === selectedGroupName),
    }));

  return (
    <header className="flex items-center justify-between gap-2 px-4 py-2.5">
      <div className="flex min-w-0 items-center gap-1.5">
        {!sidebarOpen ? (
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
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              disabled={!hasModels}
              className={cn(
                "model-selector-trigger h-9 max-w-[min(20rem,calc(100vw-8.5rem))] justify-between gap-1.5 overflow-hidden rounded-lg px-3 text-base font-semibold text-foreground transition-all duration-200 ease-out hover:bg-muted/60 dark:text-white",
                isModelMenuOpen && "bg-muted/70 shadow-sm",
              )}
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
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            sideOffset={8}
            collisionPadding={8}
            className="model-selector-dropdown w-[min(18rem,calc(100vw-1rem))] border-border/70 bg-popover/95 p-0 shadow-lg shadow-black/5 backdrop-blur supports-[backdrop-filter]:bg-popover/90"
          >
            <DropdownMenuLabel className="model-selector-menu-title px-3 py-2 text-muted-foreground dark:text-white/80">
              {t("chat.selectModel")}
            </DropdownMenuLabel>
            <DropdownMenuSeparator className="my-0" />
            <div className="max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height))] overflow-y-auto overscroll-contain px-1 pb-1">
              {(() => {
                let animationIndex = 0;
                return groups.map((group, groupIndex) => {
                  const expanded = isGroupExpanded(group.name);
                  return (
                    <div key={group.name}>
                      {groupIndex > 0 ? <DropdownMenuSeparator /> : null}
                      <DropdownMenuItem
                        onSelect={(event) => {
                          // 阻止 Radix 默认的选中即关闭：分组头只负责展开/收起
                          event.preventDefault();
                          toggleGroup(group.name);
                        }}
                        aria-expanded={expanded}
                        title={expanded ? t("chat.collapseProvider") : t("chat.expandProvider")}
                        className="model-selector-group-label sticky top-0 z-10 flex cursor-pointer items-center gap-1.5 bg-popover/95 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur transition-colors supports-[backdrop-filter]:bg-popover/80 dark:text-white/80"
                      >
                        <ProviderBrandIcon
                          type={group.providerType}
                          className="h-3.5 w-3.5 opacity-90"
                        />
                        <span className="min-w-0 flex-1 truncate">{group.name}</span>
                        <span className="inline-flex h-4 min-w-[1.1rem] shrink-0 items-center justify-center rounded-full bg-muted/70 px-1 text-[10px] tabular-nums">
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
                                  "model-selector-item group/item max-w-full justify-between gap-3 overflow-hidden text-foreground transition-all duration-150 ease-out data-[highlighted]:translate-x-0.5 dark:text-white",
                                  isSelected && "bg-muted font-medium text-foreground",
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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onOpenSettings()}
          title={t("tooltip.settings")}
          className="h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
        >
          <Settings className="h-4.5 w-4.5" />
        </Button>
        {trailingActions}
      </div>
    </header>
  );
});
