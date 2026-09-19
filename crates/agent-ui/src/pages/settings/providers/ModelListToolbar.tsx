// 渠道详情"模型列表"标题行的工具栏：已启用计数之后是文档 / 收起展开 / 搜索 / 过滤
// 四个图标按钮，右侧保留全部测试 / 刷新模型列表 / 手动添加。搜索与过滤只改本组件
// 的 ModelListFilter，可见集合由父组件用 filterProviderModels 算。容器窄于 640px
// 时（section 上的 @container/models）文字按钮只留图标，四个图标按钮始终一排。

import { PROVIDER_CHAT_PROTOCOLS, type ProviderChatProtocol } from "@liveagent/app/lib/settings";
import { openUrl } from "@liveagent/app/shims/tauriOpener";
import {
  Activity,
  BookOpen,
  ChevronsDownUp,
  ChevronsUpDown,
  Filter,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  X,
} from "@liveagent/ui/components/IconSet";
import { Button } from "@liveagent/ui/components/ui/button";
import { Checkbox } from "@liveagent/ui/components/ui/checkbox";
import { Popover, PopoverContent, PopoverTrigger } from "@liveagent/ui/components/ui/popover";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { protocolLabel } from "./providerChips";
import {
  MODEL_LIST_CAPABILITY_KEYS,
  type ModelListCapabilityKey,
  type ModelListEnabledKey,
  type ModelListFilter,
  modelListFilterCount,
} from "./providerSettingsModel";

const ICON_BUTTON_CLASS = "h-7 w-7 text-muted-foreground hover:text-foreground";
/** 文字按钮：窄容器只留图标，文字由 title / aria-label 兜底。 */
const TEXT_BUTTON_CLASS =
  "h-7 gap-1.5 px-2 text-[11px] @max-[640px]/models:w-7 @max-[640px]/models:px-0";
const NARROW_HIDDEN_CLASS = "@max-[640px]/models:hidden";

const CAPABILITY_LABEL_KEY: Record<ModelListCapabilityKey, string> = {
  vision: "settings.modelCapability.imageUnderstanding",
  file: "settings.modelCapability.fileInput",
  reasoning: "settings.modelCapability.reasoning",
  tools: "settings.modelCapability.tools",
  search: "settings.modelCapability.nativeWebSearch",
};

const ENABLED_KEYS: readonly ModelListEnabledKey[] = ["enabled", "disabled"];
const ENABLED_LABEL_KEY: Record<ModelListEnabledKey, string> = {
  enabled: "settings.modelFilterEnabled",
  disabled: "settings.modelFilterDisabled",
};

/** 桌面走 opener 插件，WebUI 的 shim 是 window.open；插件失败时同样退回 window.open。 */
async function openDoc(url: string) {
  try {
    await openUrl(url);
  } catch (error) {
    console.error("Failed to open model docs via opener", error);
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function toggleInList<T>(list: readonly T[], item: T, checked: boolean): T[] {
  if (checked) return list.includes(item) ? [...list] : [...list, item];
  return list.filter((entry) => entry !== item);
}

function FilterGroup(props: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="px-1.5 pb-0.5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/65">
        {props.label}
      </div>
      {props.children}
    </div>
  );
}

function FilterOption(props: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { id, label, checked, onCheckedChange } = props;
  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-accent/40"
    >
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </label>
  );
}

/** 标题行计数芯片之后的四个图标按钮（SectionTitle 的 badge 槽）。 */
export function ModelListToolbar(props: {
  /** 文档页地址；undefined 时按钮禁用并提示去请求配置里填写 */
  docUrl: string | undefined;
  hasGroups: boolean;
  allCollapsed: boolean;
  onToggleCollapseAll: () => void;
  filter: ModelListFilter;
  onFilterChange: (next: ModelListFilter) => void;
}) {
  const { docUrl, hasGroups, allCollapsed, onToggleCollapseAll, filter, onFilterChange } = props;
  const { t } = useLocale();
  const [searchOpen, setSearchOpen] = useState(() => filter.query.length > 0);
  const [filterOpen, setFilterOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const filterCount = modelListFilterCount(filter);
  const filterLabel =
    filterCount > 0 ? `${t("settings.modelFilter")} · ${filterCount}` : t("settings.modelFilter");
  const collapseLabel = allCollapsed
    ? t("settings.modelGroupsExpandAll")
    : t("settings.modelGroupsCollapseAll");

  function closeSearch() {
    setSearchOpen(false);
    if (filter.query) onFilterChange({ ...filter, query: "" });
  }

  function clearFilter() {
    onFilterChange({ ...filter, capabilities: [], enabled: [], protocols: [] });
  }

  return (
    <span className="settings-model-toolbar flex shrink-0 items-center gap-0.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={ICON_BUTTON_CLASS}
        disabled={!docUrl}
        onClick={() => docUrl && void openDoc(docUrl)}
        title={docUrl ? `${t("settings.modelDocs")} · ${docUrl}` : t("settings.modelDocsMissing")}
        aria-label={t("settings.modelDocs")}
      >
        <BookOpen className="h-3.5 w-3.5" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={ICON_BUTTON_CLASS}
        disabled={!hasGroups}
        onClick={onToggleCollapseAll}
        title={collapseLabel}
        aria-label={collapseLabel}
        aria-pressed={allCollapsed}
      >
        {allCollapsed ? (
          <ChevronsUpDown className="h-3.5 w-3.5" />
        ) : (
          <ChevronsDownUp className="h-3.5 w-3.5" />
        )}
      </Button>
      {searchOpen ? (
        <span className="flex h-7 items-center gap-1 rounded-md border bg-background pl-2 pr-0.5 focus-within:border-ring">
          <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="text"
            value={filter.query}
            className="h-full w-36 min-w-0 bg-transparent font-mono text-xs outline-none placeholder:text-muted-foreground/60 @max-[640px]/models:w-24"
            placeholder={t("settings.modelSearchPlaceholder")}
            aria-label={t("settings.modelSearch")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => onFilterChange({ ...filter, query: event.currentTarget.value })}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeSearch();
              }
            }}
            onBlur={() => {
              if (!filter.query.trim()) closeSearch();
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            onClick={closeSearch}
            title={t("settings.modelSearchClose")}
            aria-label={t("settings.modelSearchClose")}
          >
            <X className="h-3 w-3" />
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={ICON_BUTTON_CLASS}
          onClick={() => setSearchOpen(true)}
          title={t("settings.modelSearch")}
          aria-label={t("settings.modelSearch")}
        >
          <Search className="h-3.5 w-3.5" />
        </Button>
      )}
      <Popover open={filterOpen} onOpenChange={setFilterOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className={cn(
                "relative",
                ICON_BUTTON_CLASS,
                filterCount > 0 && "bg-primary/10 text-primary hover:text-primary",
              )}
              title={filterLabel}
              aria-label={filterLabel}
            >
              <Filter className="h-3.5 w-3.5" />
              {filterCount > 0 ? (
                <span
                  aria-hidden="true"
                  className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-none tabular-nums text-primary-foreground"
                >
                  {filterCount}
                </span>
              ) : null}
            </Button>
          }
        />
        <PopoverContent align="end" sideOffset={6} className="w-56 p-2">
          <div className="space-y-2.5">
            <FilterGroup label={t("settings.modelFilterCapabilities")}>
              {MODEL_LIST_CAPABILITY_KEYS.map((key) => (
                <FilterOption
                  key={key}
                  id={`model-filter-capability-${key}`}
                  label={t(CAPABILITY_LABEL_KEY[key])}
                  checked={filter.capabilities.includes(key)}
                  onCheckedChange={(checked) =>
                    onFilterChange({
                      ...filter,
                      capabilities: toggleInList(filter.capabilities, key, checked),
                    })
                  }
                />
              ))}
            </FilterGroup>
            <FilterGroup label={t("settings.modelFilterStatus")}>
              {ENABLED_KEYS.map((key) => (
                <FilterOption
                  key={key}
                  id={`model-filter-status-${key}`}
                  label={t(ENABLED_LABEL_KEY[key])}
                  checked={filter.enabled.includes(key)}
                  onCheckedChange={(checked) =>
                    onFilterChange({
                      ...filter,
                      enabled: toggleInList(filter.enabled, key, checked),
                    })
                  }
                />
              ))}
            </FilterGroup>
            <FilterGroup label={t("settings.modelFilterProtocol")}>
              {PROVIDER_CHAT_PROTOCOLS.map((protocol: ProviderChatProtocol) => (
                <FilterOption
                  key={protocol}
                  id={`model-filter-protocol-${protocol}`}
                  label={protocolLabel(protocol)}
                  checked={filter.protocols.includes(protocol)}
                  onCheckedChange={(checked) =>
                    onFilterChange({
                      ...filter,
                      protocols: toggleInList(filter.protocols, protocol, checked),
                    })
                  }
                />
              ))}
            </FilterGroup>
            <div className="border-t pt-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-full justify-start gap-1.5 px-1.5 text-xs"
                disabled={filterCount === 0}
                onClick={clearFilter}
              >
                <X className="h-3 w-3" />
                {t("settings.modelFilterClear")}
              </Button>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </span>
  );
}

/** 标题行右侧的文字按钮（SectionTitle 的 actions 槽）：窄容器退化为图标。 */
export function ModelListActions(props: {
  checkingAll: boolean;
  checkAllDisabled: boolean;
  /** 搜索 / 过滤生效中：全部测试只测可见模型，提示随之变化 */
  checkAllScoped: boolean;
  onCheckAll: () => void;
  refreshing: boolean;
  refreshDisabled: boolean;
  onRefreshModels: () => void;
  onAddModel: () => void;
}) {
  const {
    checkingAll,
    checkAllDisabled,
    checkAllScoped,
    onCheckAll,
    refreshing,
    refreshDisabled,
    onRefreshModels,
    onAddModel,
  } = props;
  const { t } = useLocale();
  const checkAllLabel = checkingAll ? t("settings.modelCheckStop") : t("settings.modelCheckAll");
  const refreshLabel = refreshing ? t("settings.fetching") : t("settings.refreshModels");

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={TEXT_BUTTON_CLASS}
        disabled={checkAllDisabled}
        onClick={onCheckAll}
        title={
          checkAllScoped ? t("settings.modelCheckAllVisibleHint") : t("settings.modelCheckAllHint")
        }
        aria-label={checkAllLabel}
      >
        {checkingAll ? (
          <Loader2 className="h-3 w-3 animate-spin" />
        ) : (
          <Activity className="h-3 w-3" />
        )}
        <span className={NARROW_HIDDEN_CLASS}>{checkAllLabel}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={TEXT_BUTTON_CLASS}
        disabled={refreshDisabled}
        onClick={onRefreshModels}
        title={refreshLabel}
        aria-label={refreshLabel}
      >
        <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
        <span className={NARROW_HIDDEN_CLASS}>{refreshLabel}</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={TEXT_BUTTON_CLASS}
        onClick={onAddModel}
        title={t("settings.manualAddModel")}
        aria-label={t("settings.manualAddModel")}
      >
        <Plus className="h-3 w-3" />
        <span className={NARROW_HIDDEN_CLASS}>{t("settings.manualAddModel")}</span>
      </Button>
    </>
  );
}
