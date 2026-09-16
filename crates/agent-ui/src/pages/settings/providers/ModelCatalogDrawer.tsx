// "模型目录"浏览抽屉：只读地翻看 MODEL_CATALOG（models.dev + Codex models.json 的
// 生成快照）。顶部说明来源 / 快照 / 刷新方式与"渠道里的修改是覆盖值、不改目录"，
// 下面是搜索、分区下拉、能力 / 免费过滤芯片与分页列表（行副标题带输入 / 输出简写
// 价格）；点击一行展开 CatalogEntryDetails。
// 入口：供应商页齿轮菜单的"模型目录"，以及编辑模型抽屉"目录信息"的"查看目录"
//（预选该模型所在分区并把搜索词填成模型 id）。

import { Brain, ChevronRight, Search, Wrench, X } from "@liveagent/ui/components/IconSet";
import { Input } from "@liveagent/ui/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@liveagent/ui/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@liveagent/ui/components/ui/sheet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CatalogModality,
  type CatalogModelEntry,
  type CatalogProviderId,
  MODEL_CATALOG_SNAPSHOT_DATE,
} from "@liveagent/ui/lib/models/modelCatalog";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { useMemo, useState } from "react";
import {
  CatalogEntryDetails,
  CatalogStatusChip,
  catalogLimitsText,
  catalogPriceSummary,
  MODALITY_ICONS,
} from "./ModelCatalogInfoPanel";
import {
  CATALOG_BROWSER_FILTERS,
  type CatalogBrowserFilter,
  type CatalogBrowserRow,
  filterCatalogRows,
  listCatalogSectionOptions,
  pageCatalogRows,
} from "./modelCatalogBrowser";
import { Chip, ChipButton } from "./providerChips";

const ROW_MODALITIES: readonly Exclude<CatalogModality, "text">[] = [
  "image",
  "pdf",
  "audio",
  "video",
];

function rowKey(row: CatalogBrowserRow): string {
  return `${row.sectionId}/${row.entry.id}`;
}

/** 列表行右侧的能力小图标：非文本输入模态 + 推理 + 工具调用。 */
function RowCapabilityIcons(props: { entry: CatalogModelEntry }) {
  const { entry } = props;
  const { t } = useLocale();
  const icons: { key: string; Icon: typeof Brain; title: string }[] = [];
  for (const modality of ROW_MODALITIES) {
    if (entry.inputModalities?.includes(modality)) {
      icons.push({
        key: modality,
        Icon: MODALITY_ICONS[modality],
        title: `${t("settings.modelCatalogInput")} · ${t(`settings.modelModality.${modality}`)}`,
      });
    }
  }
  if (entry.thinking) {
    icons.push({ key: "thinking", Icon: Brain, title: t("settings.modelCatalogThinking") });
  }
  if (entry.toolCall) {
    icons.push({ key: "tools", Icon: Wrench, title: t("settings.modelCatalogFlag.toolCall") });
  }
  if (icons.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center gap-1 text-muted-foreground/70">
      {icons.map(({ key, Icon, title }) => (
        <span key={key} title={title} aria-label={title} role="img" className="flex">
          <Icon className="h-3 w-3" />
        </span>
      ))}
    </span>
  );
}

export function ModelCatalogDrawer(props: {
  initialSectionId?: CatalogProviderId;
  initialQuery?: string;
  onClose: () => void;
}) {
  const { initialSectionId, initialQuery, onClose } = props;
  const { t } = useLocale();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [sectionId, setSectionId] = useState<CatalogProviderId | "all">(initialSectionId ?? "all");
  const [filters, setFilters] = useState<ReadonlySet<CatalogBrowserFilter>>(() => new Set());
  const [pages, setPages] = useState(1);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const sections = useMemo(() => listCatalogSectionOptions(), []);
  const total = useMemo(
    () =>
      sectionId === "all"
        ? sections.reduce((sum, section) => sum + section.count, 0)
        : (sections.find((section) => section.id === sectionId)?.count ?? 0),
    [sections, sectionId],
  );
  const rows = useMemo(
    () => filterCatalogRows({ sectionId, query, filters }),
    [sectionId, query, filters],
  );
  const { visible, remaining } = pageCatalogRows(rows, pages);

  // 任何筛选条件变化都回到第一页并收起展开行，避免"显示更多"越滚越长。
  function resetView() {
    setPages(1);
    setExpandedKey(null);
  }
  function updateQuery(next: string) {
    setQuery(next);
    resetView();
  }
  function updateSection(next: CatalogProviderId | "all") {
    setSectionId(next);
    resetView();
  }
  function toggleFilter(filter: CatalogBrowserFilter) {
    setFilters((current) => {
      const next = new Set(current);
      if (next.has(filter)) next.delete(filter);
      else next.add(filter);
      return next;
    });
    resetView();
  }

  const sectionLabel = (id: CatalogProviderId) => {
    const option = sections.find((section) => section.id === id);
    return option && option.presetNames.length > 0 ? option.presetNames.join(" / ") : undefined;
  };

  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        variant="inset"
        className="settings-provider-drawer max-w-none border-border bg-background sm:max-w-[640px]"
        closeLabel={t("settings.close")}
        showCloseButton={false}
      >
        <div className="settings-provider-drawer-header relative flex items-center gap-3 px-6 pb-4 pt-[22px]">
          <SheetTitle className="min-w-0 flex-1 truncate text-[17px] leading-tight tracking-tight text-foreground/95">
            {t("settings.modelCatalogBrowser")}
          </SheetTitle>
          <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground">
            {t("settings.modelCatalogSnapshot")} {MODEL_CATALOG_SNAPSHOT_DATE}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.06] text-muted-foreground/80 transition-colors hover:bg-foreground/[0.12] hover:text-foreground"
            title={t("settings.close")}
            aria-label={t("settings.close")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div
          aria-hidden="true"
          className="relative mx-6 h-px bg-gradient-to-r from-transparent via-foreground/[0.08] to-transparent"
        />
        <div className="settings-provider-drawer-body relative flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6 pt-4">
          <div className="space-y-1.5 rounded-xl border bg-muted/20 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
            <p>
              {t("settings.modelCatalogBrowserIntro").replace(
                "{date}",
                MODEL_CATALOG_SNAPSHOT_DATE,
              )}
            </p>
            <p>{t("settings.modelCatalogBrowserOverrideNote")}</p>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_220px] gap-2 max-[560px]:grid-cols-1">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                className="h-8 pl-8 pr-8 font-mono text-xs shadow-none"
                placeholder={t("settings.modelCatalogBrowserSearch")}
                aria-label={t("settings.modelCatalogBrowserSearch")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => updateQuery(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query) {
                    event.stopPropagation();
                    updateQuery("");
                  }
                }}
              />
              {query ? (
                <button
                  type="button"
                  className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground"
                  onClick={() => updateQuery("")}
                  title={t("settings.clearModelSearch")}
                  aria-label={t("settings.clearModelSearch")}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
            <Select
              value={sectionId}
              onValueChange={(value) => updateSection(value as CatalogProviderId | "all")}
            >
              <SelectTrigger
                className="h-8 text-xs shadow-none"
                aria-label={t("settings.modelCatalogBrowserSection")}
              >
                <SelectValue className="min-w-0 flex-1 truncate text-left">
                  {sectionId === "all" ? (
                    t("settings.modelCatalogBrowserAllSections")
                  ) : (
                    <>
                      <span className="font-mono">{sectionId}</span>
                      {sectionLabel(sectionId) ? (
                        <span className="ml-1.5 text-muted-foreground">
                          {sectionLabel(sectionId)}
                        </span>
                      ) : null}
                    </>
                  )}
                </SelectValue>
              </SelectTrigger>
              <SelectContent className="max-h-[60vh]">
                <SelectItem value="all">
                  {t("settings.modelCatalogBrowserAllSections")}
                  <span className="ml-1.5 tabular-nums text-muted-foreground">
                    {sections.reduce((sum, section) => sum + section.count, 0)}
                  </span>
                </SelectItem>
                {sections.map((section) => (
                  <SelectItem key={section.id} value={section.id}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="font-mono">{section.id}</span>
                      <span className="truncate text-muted-foreground">
                        {section.presetNames.length > 0
                          ? section.presetNames.join(" / ")
                          : t("settings.modelCatalogBrowserSectionNoPreset")}
                      </span>
                      <span className="tabular-nums text-muted-foreground/70">{section.count}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {CATALOG_BROWSER_FILTERS.map((filter) => (
              <ChipButton
                key={filter}
                tone={filters.has(filter) ? "on" : "default"}
                active={filters.has(filter)}
                onClick={() => toggleFilter(filter)}
              >
                {t(`settings.modelCatalogBrowserFilter.${filter}`)}
              </ChipButton>
            ))}
            <span className="ml-auto tabular-nums text-[10.5px] text-muted-foreground">
              {t("settings.modelCatalogBrowserCount")
                .replace("{count}", String(rows.length))
                .replace("{total}", String(total))}
            </span>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border">
            {visible.length === 0 ? (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                {t("settings.modelCatalogBrowserEmpty")}
              </p>
            ) : (
              <ul className="divide-y divide-foreground/[0.06]">
                {visible.map((row) => {
                  const key = rowKey(row);
                  const expanded = expandedKey === key;
                  const { entry } = row;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() => setExpandedKey(expanded ? null : key)}
                        className={cn(
                          "flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-muted/40",
                          expanded && "bg-muted/30",
                        )}
                      >
                        <ChevronRight
                          className={cn(
                            "h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform",
                            expanded && "rotate-90",
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span className="truncate font-mono text-xs">{entry.id}</span>
                            {sectionId === "all" ? (
                              <Chip className="shrink-0 font-mono">{row.sectionId}</Chip>
                            ) : null}
                            {entry.status ? <CatalogStatusChip entry={entry} /> : null}
                          </span>
                          <span className="block truncate text-[10.5px] text-muted-foreground">
                            {[
                              entry.name && entry.name !== entry.id ? entry.name : null,
                              entry.family
                                ? `${t("settings.modelCatalogFamily")} ${entry.family}`
                                : null,
                              catalogLimitsText(t, entry),
                              catalogPriceSummary(t, entry),
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        </span>
                        <RowCapabilityIcons entry={entry} />
                      </button>
                      {expanded ? (
                        <div className="px-2.5 pb-2.5">
                          <CatalogEntryDetails
                            entry={entry}
                            catalogProviderId={row.sectionId}
                            className="bg-background"
                          />
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {remaining > 0 ? (
              <div className="border-t border-foreground/[0.06] p-2">
                <button
                  type="button"
                  className="flex h-8 w-full items-center justify-center rounded-lg text-xs text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
                  onClick={() => setPages((current) => current + 1)}
                >
                  {t("settings.modelCatalogBrowserShowMore").replace("{count}", String(remaining))}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
