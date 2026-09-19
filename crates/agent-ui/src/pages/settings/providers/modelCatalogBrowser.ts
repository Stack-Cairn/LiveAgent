// "模型目录"浏览抽屉的纯函数层：分区选项（分区 → 对应预设名）、搜索匹配（id /
// 名称 / 系列 + 去前缀候选链）、能力过滤芯片与分页。数据只读自 MODEL_CATALOG，
// 用户在渠道里对模型做的覆盖存在渠道的模型配置里，不经过这里。

import {
  type CatalogModelEntry,
  type CatalogProviderId,
  catalogEntryIsFree,
  MODEL_CATALOG,
  normalizeModelIdCandidates,
} from "@liveagent/ui/lib/models/modelCatalog";
import { listProviderPresets } from "@liveagent/ui/lib/providers/registry";

export const CATALOG_BROWSER_PAGE_SIZE = 100;

export const CATALOG_BROWSER_FILTERS = [
  "image",
  "file",
  "reasoning",
  "tools",
  "free",
  "deprecated",
] as const;
export type CatalogBrowserFilter = (typeof CATALOG_BROWSER_FILTERS)[number];

export type CatalogBrowserRow = { sectionId: CatalogProviderId; entry: CatalogModelEntry };

export type CatalogSectionOption = {
  id: CatalogProviderId;
  /** 以该分区为目录源的预设名（含隐藏预设），可能为空 */
  presetNames: readonly string[];
  count: number;
};

export function listCatalogSectionIds(): readonly CatalogProviderId[] {
  return Object.keys(MODEL_CATALOG) as CatalogProviderId[];
}

/** 分区下拉的选项：按目录顺序，附上引用该分区的预设名与条目数。 */
export function listCatalogSectionOptions(
  presets: readonly { name: string; catalogProviderId?: CatalogProviderId }[] = listProviderPresets(
    { includeHidden: true },
  ),
): readonly CatalogSectionOption[] {
  const names = new Map<CatalogProviderId, string[]>();
  for (const preset of presets) {
    if (!preset.catalogProviderId) continue;
    const list = names.get(preset.catalogProviderId) ?? [];
    if (!list.includes(preset.name)) list.push(preset.name);
    names.set(preset.catalogProviderId, list);
  }
  return listCatalogSectionIds().map((id) => ({
    id,
    presetNames: names.get(id) ?? [],
    count: MODEL_CATALOG[id].length,
  }));
}

/**
 * 搜索匹配：先按 id / 名称 / 系列做小写子串匹配；不中时把查询词过一遍
 * normalizeModelIdCandidates（去 @版本、[1m]、日期后缀、聚合商前缀），
 * 让用户粘贴渠道里的装饰 id（bailian/glm-5@2026）也能命中裸 id。
 */
export function catalogEntryMatchesQuery(entry: CatalogModelEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const id = entry.id.toLowerCase();
  if (id.includes(q)) return true;
  if (entry.name?.toLowerCase().includes(q)) return true;
  if (entry.family?.toLowerCase().includes(q)) return true;
  return normalizeModelIdCandidates(q).some(
    (candidate) => candidate !== q && id.includes(candidate),
  );
}

export function catalogEntryMatchesFilter(
  entry: CatalogModelEntry,
  filter: CatalogBrowserFilter,
): boolean {
  switch (filter) {
    case "image":
      return entry.inputModalities?.includes("image") === true;
    case "file":
      return entry.attachment === true || entry.inputModalities?.includes("pdf") === true;
    case "reasoning":
      return entry.thinking !== undefined;
    case "tools":
      return entry.toolCall === true;
    case "free":
      return catalogEntryIsFree(entry);
    case "deprecated":
      return entry.status === "deprecated";
  }
}

/** 过滤芯片取交集：全部勾选的条件都满足才保留。 */
export function filterCatalogRows(options: {
  sectionId: CatalogProviderId | "all";
  query: string;
  filters: ReadonlySet<CatalogBrowserFilter> | readonly CatalogBrowserFilter[];
  catalog?: Partial<Record<CatalogProviderId, readonly CatalogModelEntry[]>>;
}): CatalogBrowserRow[] {
  const catalog = options.catalog ?? MODEL_CATALOG;
  const filters = [...options.filters];
  const sections =
    options.sectionId === "all"
      ? (Object.keys(catalog) as CatalogProviderId[])
      : [options.sectionId];
  const rows: CatalogBrowserRow[] = [];
  for (const sectionId of sections) {
    for (const entry of catalog[sectionId] ?? []) {
      if (!catalogEntryMatchesQuery(entry, options.query)) continue;
      if (!filters.every((filter) => catalogEntryMatchesFilter(entry, filter))) continue;
      rows.push({ sectionId, entry });
    }
  }
  return rows;
}

/** "显示更多"分页：返回本页应渲染的行与剩余条数。 */
export function pageCatalogRows<T>(
  rows: readonly T[],
  pages: number,
  pageSize = CATALOG_BROWSER_PAGE_SIZE,
): { visible: readonly T[]; remaining: number } {
  const limit = Math.max(1, pages) * pageSize;
  return { visible: rows.slice(0, limit), remaining: Math.max(0, rows.length - limit) };
}
