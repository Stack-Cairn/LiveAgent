import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 运行期模型目录（docs/design/2026-10-30-model-catalog-live-sync.md §9）。
// 每个用例新建 loader：生效目录、版本号、缓存都是模块级状态，必须互相隔离。

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const generator = await import(
  pathToFileURL(`${repoRoot}scripts/generate-model-catalog.mjs`).href
);
const snapshotPath = `${repoRoot}crates/agent-ui/src/lib/models/catalog.generated.ts`;

function freshModules() {
  const loader = createTsModuleLoader();
  return {
    catalogLive: loader.loadModule("@liveagent/ui/lib/models/catalogLive.ts"),
    modelCatalog: loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts"),
    settings: loader.loadModule("@liveagent/ui/lib/settings/index.ts"),
    providerSettings: loader.loadModule("src/lib/kbrain/providerSettings.ts"),
  };
}

const bundled = freshModules().modelCatalog;
const BUNDLED_DATE = bundled.MODEL_CATALOG_SNAPSHOT_DATE;
const plain = (value) => JSON.parse(JSON.stringify(value));

function laterDate(days = 1) {
  const date = new Date(`${BUNDLED_DATE}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function rehash(document) {
  document.sha256 = createHash("sha256")
    .update(generator.canonicalSectionsJson(document.sections))
    .digest("hex");
  return document;
}

/** 由真实生成器从内置快照构造文档，再按需改动 sections 并重算哈希。 */
function makeDocument(mutate, { snapshotDate = laterDate(), keepHash = false } = {}) {
  const document = plain(
    generator.buildCatalogJson(plain(bundled.MODEL_CATALOG), {
      snapshotDate,
      generatedAt: "2026-10-31T00:00:00Z",
      commit: "test",
    }),
  );
  mutate?.(document.sections, document);
  return keepHash ? document : rehash(document);
}

// 生效后的可观察差异：新增一个快照没有的模型、改一个已有模型的限额、删掉一个
// 已有模型（应从快照补回）、把一个模型从 openai 挪到 xai（不应在 openai 复活）。
const ADDED_ID = "gpt-live-only";
const CHANGED_ID = "claude-haiku-4-5";
const REMOVED_ID = "claude-opus-4-5";
const MOVED_ID = bundled.MODEL_CATALOG.openai.find((entry) => entry.id.startsWith("gpt-4")).id;

function liveDocument() {
  return makeDocument((sections) => {
    sections.openai.push({ id: ADDED_ID, contextWindow: 777_000, maxOutputToken: 77_000 });
    const changed = sections.anthropic.find((entry) => entry.id === CHANGED_ID);
    changed.contextWindow = 333_000;
    sections.anthropic = sections.anthropic.filter((entry) => entry.id !== REMOVED_ID);
    const moved = sections.openai.find((entry) => entry.id === MOVED_ID);
    sections.openai = sections.openai.filter((entry) => entry.id !== MOVED_ID);
    sections.xai.push(moved);
  });
}

function stubStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => (values.has(key) ? values.get(key) : null),
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    values,
  };
}

async function withGlobals({ fetch, localStorage }, run) {
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const previousWarn = console.warn;
  const warnings = [];
  globalThis.fetch = fetch;
  if (localStorage) globalThis.localStorage = localStorage;
  else delete globalThis.localStorage;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return await run(warnings);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    console.warn = previousWarn;
  }
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => plain(body) });

// ---------------------------------------------------------------------------
// 生成器一致性
// ---------------------------------------------------------------------------

test("generator renders the checked-in snapshot from the sections it publishes", () => {
  const snapshotText = readFileSync(snapshotPath, "utf8").replace(/\r\n/g, "\n");
  assert.equal(
    generator.renderCatalog(plain(bundled.MODEL_CATALOG), BUNDLED_DATE),
    snapshotText,
    "TS snapshot and runtime JSON must be two renderings of the same sections",
  );
  const document = makeDocument(undefined, { snapshotDate: BUNDLED_DATE });
  const { catalogLive } = freshModules();
  const parsed = catalogLive.parseRuntimeCatalog(document);
  assert.equal(parsed.ok, true, parsed.detail);
  assert.deepEqual(plain(parsed.catalog.sections), plain(bundled.MODEL_CATALOG));
  assert.deepEqual(
    document.minimums,
    Object.fromEntries(generator.SECTIONS.map((section) => [section.key, section.min])),
  );
  assert.equal(document.schemaVersion, catalogLive.CATALOG_LIVE_SCHEMA_VERSION);
});

// ---------------------------------------------------------------------------
// 校验（§7.2 六项 + 形状）
// ---------------------------------------------------------------------------

test("parseRuntimeCatalog rejects each invalid document as a whole", () => {
  const { catalogLive } = freshModules();
  const cases = [
    ["not-object", null],
    ["not-object", []],
    ["schema-version", makeDocument((_, doc) => Object.assign(doc, { schemaVersion: 2 }))],
    ["snapshot-date", makeDocument(undefined, { snapshotDate: "2026-01-01" })],
    ["snapshot-date", makeDocument(undefined, { snapshotDate: "Oct 30" })],
    [
      "sha256",
      makeDocument(
        (sections) => {
          sections.openai[0].contextWindow += 1;
        },
        { keepHash: true },
      ),
    ],
    [
      "section-minimum",
      makeDocument((sections) => {
        sections.anthropic = sections.anthropic.slice(0, 2);
      }),
    ],
    [
      "entry",
      makeDocument((sections) => {
        sections.openai[0].maxOutputToken = sections.openai[0].contextWindow;
      }),
    ],
    [
      "entry",
      makeDocument((sections) => {
        sections.openai[0].contextWindow = 1.5;
      }),
    ],
    [
      "entry",
      makeDocument((sections) => {
        sections.openai[0].id = ` ${sections.openai[0].id}`;
      }),
    ],
    [
      "entry",
      makeDocument((sections) => {
        sections.anthropic[0].inputModalities = ["text", "smell"];
      }),
    ],
    [
      "entry",
      makeDocument((sections) => {
        sections.anthropic[0].thinking = { levels: ["ultra"], off: true };
      }),
    ],
    [
      "duplicate-id",
      makeDocument((sections) => {
        sections.xai.push({ ...sections.openai[0], id: sections.openai[0].id.toUpperCase() });
      }),
    ],
  ];
  for (const [reason, document] of cases) {
    const result = catalogLive.parseRuntimeCatalog(document);
    assert.equal(result.ok, false, `${reason} must be rejected`);
    assert.equal(result.reason, reason, result.detail);
  }
});

test("parseRuntimeCatalog drops unknown sections and fields without rejecting", () => {
  const { catalogLive } = freshModules();
  const document = makeDocument((sections) => {
    sections["future-vendor"] = [{ id: "future-1", contextWindow: 10, maxOutputToken: 1 }];
    sections.openai[0].pricing = { input: 1 };
  });
  const result = catalogLive.parseRuntimeCatalog(document);
  assert.equal(result.ok, true, result.detail);
  assert.equal(result.catalog.sections["future-vendor"], undefined);
  assert.equal("pricing" in result.catalog.sections.openai[0], false);
});

// ---------------------------------------------------------------------------
// 合并、索引失效、版本信号
// ---------------------------------------------------------------------------

test("a live catalog replaces sections, backfills dropped ids and invalidates the index", async () => {
  const { catalogLive, modelCatalog } = freshModules();
  // 先查一次，确保索引在生效前已经建好（验证生效后会被清掉）。
  assert.equal(modelCatalog.resolveModelLimits("claude_code", CHANGED_ID).contextWindow, 200_000);
  assert.equal(modelCatalog.findCatalogModelAcrossProviders(ADDED_ID), undefined);
  let notified = 0;
  catalogLive.subscribeCatalogLive(() => {
    notified += 1;
  });

  await withGlobals({ fetch: async () => jsonResponse(liveDocument()) }, async () => {
    assert.equal(await catalogLive.loadCatalogLiveSupplement(), true);
  });

  assert.equal(catalogLive.getCatalogLiveVersion(), 1);
  assert.equal(notified, 1);
  assert.equal(catalogLive.getCatalogLiveStatus().origin, "network");
  assert.equal(modelCatalog.resolveModelLimits("claude_code", CHANGED_ID).contextWindow, 333_000);
  assert.deepEqual(plain(modelCatalog.resolveModelLimitsAcrossProviders(ADDED_ID)), {
    contextWindow: 777_000,
    maxOutputToken: 77_000,
  });
  const bundledRemoved = bundled.MODEL_CATALOG.anthropic.find((entry) => entry.id === REMOVED_ID);
  assert.equal(
    modelCatalog.resolveModelLimits("claude_code", REMOVED_ID).contextWindow,
    bundledRemoved.contextWindow,
    "ids missing from the live catalog come back from the bundled snapshot",
  );
  assert.equal(modelCatalog.findCatalogModel("codex", MOVED_ID), undefined);
  assert.equal(modelCatalog.findCatalogModel("xai", MOVED_ID)?.id, MOVED_ID);
  const ids = modelCatalog.getEffectiveModelCatalog().anthropic.map((entry) => entry.id);
  assert.deepEqual(ids, [...ids].sort(), "merged sections stay sorted");
});

test("the same document again does not bump the version", async () => {
  const { catalogLive } = freshModules();
  const document = liveDocument();
  await withGlobals({ fetch: async () => jsonResponse(document) }, async () => {
    await catalogLive.loadCatalogLiveSupplement();
    await catalogLive.loadCatalogLiveSupplement({ force: true });
  });
  assert.equal(catalogLive.getCatalogLiveVersion(), 1);
});

// ---------------------------------------------------------------------------
// 缓存、TTL、地址顺序、失败回退
// ---------------------------------------------------------------------------

test("cold start applies the disk cache synchronously, then refreshes in the background", async () => {
  const { catalogLive, modelCatalog } = freshModules();
  const cached = liveDocument();
  const storage = stubStorage({
    "liveagent.catalogLive.v1": JSON.stringify({
      v: 1,
      fetchedAt: Date.now() - 7 * 60 * 60 * 1000,
      url: catalogLive.CATALOG_LIVE_DEFAULT_URL,
      document: cached,
    }),
  });
  const newer = makeDocument(
    (sections) => {
      sections.openai.push({ id: ADDED_ID, contextWindow: 888_000, maxOutputToken: 88_000 });
    },
    { snapshotDate: laterDate(2) },
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await withGlobals(
    {
      fetch: async () => {
        await gate;
        return jsonResponse(newer);
      },
      localStorage: storage,
    },
    async () => {
      const pending = catalogLive.loadCatalogLiveSupplement();
      // 第一个 await 之前缓存已生效：设置加载可以直接用上。
      assert.equal(catalogLive.getCatalogLiveStatus().origin, "cache");
      assert.equal(modelCatalog.resolveModelLimitsAcrossProviders(ADDED_ID).contextWindow, 777_000);
      release();
      assert.equal(await pending, true);
    },
  );
  assert.equal(catalogLive.getCatalogLiveStatus().origin, "network");
  assert.equal(modelCatalog.resolveModelLimitsAcrossProviders(ADDED_ID).contextWindow, 888_000);
  assert.equal(catalogLive.getCatalogLiveVersion(), 2);
  const stored = JSON.parse(storage.getItem("liveagent.catalogLive.v1"));
  assert.equal(stored.document.sha256, newer.sha256, "the newer document replaces the cache");
});

test("a cache older than the bundled snapshot is ignored", async () => {
  const { catalogLive, modelCatalog } = freshModules();
  const old = makeDocument(
    (sections) => {
      sections.openai.push({ id: ADDED_ID, contextWindow: 777_000, maxOutputToken: 77_000 });
    },
    { snapshotDate: "2026-01-01" },
  );
  const storage = stubStorage({
    "liveagent.catalogLive.v1": JSON.stringify({ v: 1, fetchedAt: Date.now(), url: "x", document: old }),
  });
  await withGlobals(
    {
      fetch: async () => {
        throw new TypeError("offline");
      },
      localStorage: storage,
    },
    async () => {
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), false);
    },
  );
  assert.equal(catalogLive.getCatalogLiveStatus().origin, "bundled");
  assert.equal(modelCatalog.findCatalogModelAcrossProviders(ADDED_ID), undefined);
});

test("offline with no cache keeps the bundled snapshot", async () => {
  const { catalogLive, modelCatalog } = freshModules();
  await withGlobals(
    {
      fetch: async () => {
        throw new TypeError("offline");
      },
    },
    async () => {
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), false);
    },
  );
  assert.equal(catalogLive.getCatalogLiveVersion(), 0);
  assert.equal(modelCatalog.getEffectiveModelCatalog(), modelCatalog.MODEL_CATALOG);
});

test("a rejected document keeps the previous data and falls through to the next source", async () => {
  const { catalogLive, modelCatalog } = freshModules();
  catalogLive.configureCatalogLiveSources(["/api/public/model-catalog", "https://raw.example/c.json"]);
  const requested = [];
  const good = liveDocument();
  const corrupted = makeDocument(
    (sections) => {
      sections.openai[0].contextWindow = 1;
    },
    { keepHash: true },
  );
  await withGlobals(
    {
      fetch: async (url) => {
        requested.push(url);
        return jsonResponse(url.startsWith("/api/") ? corrupted : good);
      },
    },
    async (warnings) => {
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), true);
      assert.match(warnings.join("\n"), /rejected \(sha256\)/);
    },
  );
  assert.deepEqual(requested, ["/api/public/model-catalog", "https://raw.example/c.json"]);
  assert.equal(catalogLive.getCatalogLiveStatus().url, "https://raw.example/c.json");

  // 之后只剩损坏的数据可拿：保留已生效的目录。
  catalogLive.configureCatalogLiveSources(["/api/public/model-catalog"]);
  await withGlobals({ fetch: async () => jsonResponse(corrupted) }, async () => {
    assert.equal(await catalogLive.loadCatalogLiveSupplement({ force: true }), false);
  });
  assert.equal(modelCatalog.resolveModelLimitsAcrossProviders(ADDED_ID).contextWindow, 777_000);
  assert.equal(catalogLive.getCatalogLiveVersion(), 1);
});

test("fetches once per TTL; force refetches; non-OK responses are skipped", async () => {
  const { catalogLive } = freshModules();
  let calls = 0;
  await withGlobals(
    {
      fetch: async (_url, init) => {
        calls += 1;
        assert.equal(init.cache, "no-cache", "revalidate through the HTTP cache, no custom headers");
        assert.equal(init.headers, undefined);
        return calls === 1 ? { ok: false, status: 503, json: async () => ({}) } : jsonResponse(liveDocument());
      },
    },
    async () => {
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), false);
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), true);
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), true);
      assert.equal(calls, 2, "a fresh network result is reused inside the TTL");
      await catalogLive.loadCatalogLiveSupplement({ force: true });
      assert.equal(calls, 3);
    },
  );
});

// ---------------------------------------------------------------------------
// 设置重解析与 K-brain 对账
// ---------------------------------------------------------------------------

function codexProvider(settings, models) {
  return settings.normalizeCustomProvider({
    id: "relay",
    name: "relay",
    type: "codex",
    baseUrl: "https://relay.invalid/v1",
    apiKey: "",
    models,
    activeModels: models.map((model) => model.id),
  });
}

test("refreshCatalogDerivedModelLimits re-resolves catalog/fallback limits only", async () => {
  const { catalogLive, settings } = freshModules();
  const appSettings = {
    ...settings.getDefaultSettings(),
    customProviders: [
      codexProvider(settings, [
        { id: ADDED_ID },
        { id: "user-tuned", contextWindow: 1234, maxOutputToken: 100, limitsSource: "user" },
        { id: "declared", contextWindow: 5555, maxOutputToken: 500, limitsSource: "provider" },
      ]),
    ],
  };
  const before = appSettings.customProviders[0].models.find((model) => model.id === ADDED_ID);
  assert.equal(before.limitsSource, "fallback");
  assert.equal(
    settings.refreshCatalogDerivedModelLimits(appSettings),
    appSettings,
    "nothing changed → same object",
  );

  await withGlobals({ fetch: async () => jsonResponse(liveDocument()) }, () =>
    catalogLive.loadCatalogLiveSupplement(),
  );
  const refreshed = settings.refreshCatalogDerivedModelLimits(appSettings);
  assert.notEqual(refreshed, appSettings);
  const byId = Object.fromEntries(refreshed.customProviders[0].models.map((model) => [model.id, model]));
  assert.deepEqual(
    [byId[ADDED_ID].contextWindow, byId[ADDED_ID].maxOutputToken, byId[ADDED_ID].limitsSource],
    [777_000, 77_000, "catalog"],
  );
  assert.equal(byId["user-tuned"].contextWindow, 1234);
  assert.equal(byId.declared.contextWindow, 5555);
  assert.equal(settings.refreshCatalogDerivedModelLimits(refreshed), refreshed, "idempotent");
});

// K-brain GET /v1/settings 的真实形状：同一输出上限同时放在 maxOutputTokens 与
// maxOutputToken（K-brain internal/backend/settings.go settingsModel）。
function kbrainDocument(models) {
  models = models.map((model) =>
    model.maxOutputToken === undefined ? model : { ...model, maxOutputTokens: model.maxOutputToken },
  );
  return {
    defaultProvider: "relay",
    defaultModel: models[0].id,
    providers: [
      {
        id: "relay",
        name: "relay",
        type: "codex",
        api: "openai-responses",
        apiKeyConfigured: true,
        models,
        activeModels: models.map((model) => model.id),
      },
    ],
  };
}

test("K-brain catalog reconcile pushes drifted catalog limits once and never touches user limits", async () => {
  const { catalogLive, providerSettings } = freshModules();
  const fallbackModel = {
    id: ADDED_ID,
    contextWindow: 400_000,
    maxOutputToken: 142_000,
    limitsSource: "fallback",
  };
  const userModel = { id: "user-tuned", contextWindow: 1234, maxOutputToken: 100, limitsSource: "user" };
  const document = kbrainDocument([fallbackModel, userModel]);
  assert.equal(
    providerSettings.kBrainSettingsUpdateForCatalogRefresh(document),
    undefined,
    "bundled snapshot only: backend already matches",
  );

  await withGlobals({ fetch: async () => jsonResponse(liveDocument()) }, () =>
    catalogLive.loadCatalogLiveSupplement(),
  );
  const update = providerSettings.kBrainSettingsUpdateForCatalogRefresh(document);
  assert.ok(update, "a live catalog that changes a fallback model must be pushed to K-brain");
  assert.equal(update.deleteProviders, undefined);
  assert.equal(update.defaultModel, ADDED_ID);
  const pushed = update.providers[0].models;
  const added = pushed.find((model) => model.id === ADDED_ID);
  assert.deepEqual(
    [added.contextWindow, added.maxOutputToken, added.limitsSource],
    [777_000, 77_000, "catalog"],
  );
  const user = pushed.find((model) => model.id === "user-tuned");
  assert.deepEqual([user.contextWindow, user.limitsSource], [1234, "user"]);
  assert.equal("apiKey" in update.providers[0], false, "never sends secrets");

  const reconciled = kbrainDocument(pushed);
  assert.equal(providerSettings.kBrainSettingsUpdateForCatalogRefresh(reconciled), undefined);
});

test("startCatalogLiveRefresh retries on its interval and stops cleanly", async () => {
  const { catalogLive } = freshModules();
  let calls = 0;
  await withGlobals(
    {
      fetch: async () => {
        calls += 1;
        if (calls < 3) throw new TypeError("offline");
        return jsonResponse(liveDocument());
      },
    },
    async () => {
      const stop = catalogLive.startCatalogLiveRefresh(15);
      const deadline = Date.now() + 2_000;
      while (catalogLive.getCatalogLiveVersion() === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      stop();
      assert.equal(catalogLive.getCatalogLiveVersion(), 1, "a later tick picks up the catalog");
      const settled = calls;
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.ok(calls <= settled + 1, "no further ticks after stop (at most one in flight)");
      // 已拿到新鲜数据：之后的 tick 在 TTL 内不再拉取。
      assert.equal(await catalogLive.loadCatalogLiveSupplement(), true);
    },
  );
});
