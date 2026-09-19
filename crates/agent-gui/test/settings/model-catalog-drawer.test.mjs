import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// "模型目录"浏览抽屉的纯函数层（modelCatalogBrowser.ts）的反漂移锁：分区选项
// 反查预设名、搜索匹配（id / 名称 / 系列 + 去前缀候选链）、过滤芯片交集、分页。
const loader = createTsModuleLoader();
const browser = loader.loadModule(
  "@liveagent/ui/pages/settings/providers/modelCatalogBrowser.ts",
);
const { MODEL_CATALOG } = loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts");

const glm = {
  id: "glm-5",
  name: "GLM-5",
  family: "glm",
  contextWindow: 200_000,
  maxOutputToken: 128_000,
  inputModalities: ["text"],
  thinking: { levels: [], off: true },
  toolCall: true,
  pricing: { input: 1, output: 3.2, cacheRead: 0.2 },
};
const glmVision = {
  id: "glm-4.6v",
  name: "GLM-4.6V",
  family: "glm",
  contextWindow: 128_000,
  maxOutputToken: 32_000,
  inputModalities: ["text", "image", "video"],
  toolCall: true,
  pricing: { input: 0, output: 0 },
};
const legacy = {
  id: "MiniMax-Text-01",
  name: "MiniMax Text 01",
  contextWindow: 1_000_000,
  maxOutputToken: 32_000,
  inputModalities: ["text", "pdf"],
  attachment: true,
  status: "deprecated",
};
const catalog = { zhipuai: [glm, glmVision], minimax: [legacy] };

test("section options follow catalog order and map back to preset names", () => {
  const options = browser.listCatalogSectionOptions([
    { name: "智谱 Z.AI", catalogProviderId: "zhipuai" },
    { name: "智谱 Z.AI（国际）", catalogProviderId: "zhipuai" },
    { name: "智谱 Z.AI", catalogProviderId: "zhipuai" },
    { name: "自定义" },
  ]);
  assert.deepEqual(
    options.map((option) => option.id),
    Object.keys(MODEL_CATALOG),
  );
  const zhipu = options.find((option) => option.id === "zhipuai");
  assert.deepEqual(zhipu.presetNames, ["智谱 Z.AI", "智谱 Z.AI（国际）"]);
  assert.equal(zhipu.count, MODEL_CATALOG.zhipuai.length);
  assert.deepEqual(options.find((option) => option.id === "openrouter").presetNames, []);
});

test("query matches id, name and family case-insensitively", () => {
  assert.equal(browser.catalogEntryMatchesQuery(glm, ""), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "  "), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "GLM-5"), true);
  assert.equal(browser.catalogEntryMatchesQuery(legacy, "minimax text"), true);
  assert.equal(browser.catalogEntryMatchesQuery(glmVision, "glm"), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "claude"), false);
});

test("query strips channel decorations before matching bare ids", () => {
  // 聚合商前缀、@版本、[1m] 与日期后缀都走 normalizeModelIdCandidates 的候选链。
  assert.equal(browser.catalogEntryMatchesQuery(glm, "bailian/glm-5"), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "glm-5@2026-01"), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "GLM-5[1m]"), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "openrouter/zhipu/glm-5-20260101"), true);
  assert.equal(browser.catalogEntryMatchesQuery(glm, "bailian/qwen-max"), false);
});

test("filters read the raw catalog flags", () => {
  assert.equal(browser.catalogEntryMatchesFilter(glmVision, "image"), true);
  assert.equal(browser.catalogEntryMatchesFilter(glm, "image"), false);
  assert.equal(browser.catalogEntryMatchesFilter(legacy, "file"), true);
  assert.equal(browser.catalogEntryMatchesFilter(glm, "file"), false);
  assert.equal(browser.catalogEntryMatchesFilter(glm, "reasoning"), true);
  assert.equal(browser.catalogEntryMatchesFilter(glmVision, "reasoning"), false);
  assert.equal(browser.catalogEntryMatchesFilter(glm, "tools"), true);
  assert.equal(browser.catalogEntryMatchesFilter(legacy, "tools"), false);
  assert.equal(browser.catalogEntryMatchesFilter(legacy, "deprecated"), true);
  assert.equal(browser.catalogEntryMatchesFilter(glm, "deprecated"), false);
});

test("free filter keeps only entries priced at zero for both input and output", () => {
  assert.ok(browser.CATALOG_BROWSER_FILTERS.includes("free"));
  assert.equal(browser.catalogEntryMatchesFilter(glmVision, "free"), true);
  assert.equal(browser.catalogEntryMatchesFilter(glm, "free"), false);
  // 未公布价格不算免费。
  assert.equal(browser.catalogEntryMatchesFilter(legacy, "free"), false);
  const free = browser.filterCatalogRows({
    sectionId: "all",
    query: "",
    filters: ["free"],
    catalog,
  });
  assert.deepEqual(
    free.map((row) => row.entry.id),
    ["glm-4.6v"],
  );
  // 与其他芯片取交集；排序仍是目录顺序。
  const freeTools = browser.filterCatalogRows({
    sectionId: "all",
    query: "",
    filters: new Set(["free", "tools"]),
    catalog,
  });
  assert.deepEqual(
    freeTools.map((row) => row.entry.id),
    ["glm-4.6v"],
  );
  const realFree = browser.filterCatalogRows({ sectionId: "zhipuai", query: "", filters: ["free"] });
  assert.ok(realFree.some((row) => row.entry.id === "glm-4.7-flash"));
  assert.ok(
    realFree.every((row) => row.entry.pricing.input === 0 && row.entry.pricing.output === 0),
  );
  const ids = MODEL_CATALOG.zhipuai.map((entry) => entry.id);
  const positions = realFree.map((row) => ids.indexOf(row.entry.id));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test("filterCatalogRows intersects section, query and filter chips", () => {
  const all = browser.filterCatalogRows({ sectionId: "all", query: "", filters: [], catalog });
  assert.deepEqual(
    all.map((row) => `${row.sectionId}/${row.entry.id}`),
    ["zhipuai/glm-5", "zhipuai/glm-4.6v", "minimax/MiniMax-Text-01"],
  );
  const zhipuOnly = browser.filterCatalogRows({
    sectionId: "zhipuai",
    query: "",
    filters: [],
    catalog,
  });
  assert.deepEqual(
    zhipuOnly.map((row) => row.entry.id),
    ["glm-5", "glm-4.6v"],
  );
  const toolsAndImage = browser.filterCatalogRows({
    sectionId: "all",
    query: "",
    filters: new Set(["tools", "image"]),
    catalog,
  });
  assert.deepEqual(
    toolsAndImage.map((row) => row.entry.id),
    ["glm-4.6v"],
  );
  const searched = browser.filterCatalogRows({
    sectionId: "all",
    query: "glm",
    filters: ["reasoning"],
    catalog,
  });
  assert.deepEqual(
    searched.map((row) => row.entry.id),
    ["glm-5"],
  );
  assert.deepEqual(
    browser.filterCatalogRows({ sectionId: "openrouter", query: "", filters: [], catalog }),
    [],
  );
});

test("filterCatalogRows over the real catalog finds glm-5 in the zhipuai section", () => {
  const rows = browser.filterCatalogRows({ sectionId: "all", query: "glm-5", filters: [] });
  assert.ok(rows.some((row) => row.sectionId === "zhipuai" && row.entry.id === "glm-5"));
  assert.ok(rows.every((row) => row.entry.id.toLowerCase().includes("glm-5")));
});

test("pageCatalogRows grows by page size and reports the remainder", () => {
  const rows = Array.from({ length: 250 }, (_, index) => index);
  assert.equal(browser.CATALOG_BROWSER_PAGE_SIZE, 100);
  let page = browser.pageCatalogRows(rows, 1);
  assert.equal(page.visible.length, 100);
  assert.equal(page.remaining, 150);
  page = browser.pageCatalogRows(rows, 3);
  assert.equal(page.visible.length, 250);
  assert.equal(page.remaining, 0);
  page = browser.pageCatalogRows(rows, 0, 40);
  assert.equal(page.visible.length, 40);
  assert.equal(page.remaining, 210);
});
