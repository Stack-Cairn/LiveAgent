import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 独立评审回归（模型目录运行期同步）。每个用例新建 loader 隔离模块级状态。

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const generator = await import(
  pathToFileURL(`${repoRoot}scripts/generate-model-catalog.mjs`).href
);

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

/** 真实生成器从内置快照构造文档，改动 sections 后重算哈希。 */
function makeDocument(mutate, { snapshotDate = laterDate() } = {}) {
  const document = plain(
    generator.buildCatalogJson(plain(bundled.MODEL_CATALOG), {
      snapshotDate,
      generatedAt: "2026-10-31T00:00:00Z",
      commit: "review",
    }),
  );
  mutate?.(document.sections, document);
  document.sha256 = createHash("sha256")
    .update(generator.canonicalSectionsJson(document.sections))
    .digest("hex");
  return document;
}

const ADDED_ID = "gpt-live-only";

function liveDocument() {
  return makeDocument((sections) => {
    sections.openai.push({ id: ADDED_ID, contextWindow: 777_000, maxOutputToken: 77_000 });
  });
}

const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => plain(body) });

async function activateLive(catalogLive, document = liveDocument()) {
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  globalThis.fetch = async () => jsonResponse(document);
  delete globalThis.localStorage;
  try {
    assert.equal(await catalogLive.loadCatalogLiveSupplement(), true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousStorage !== undefined) globalThis.localStorage = previousStorage;
  }
}

// K-brain GET /v1/settings 的真实模型投影（K-brain internal/backend/settings.go
// settingsModel）：同一个输出上限同时以 maxOutputTokens 与 maxOutputToken 返回，
// limitsSource 原样回传。作者用例的后端文档只有 maxOutputToken，与真实形状不符。
function kbrainProjectedModel({ id, contextWindow, maxOutputToken, limitsSource }) {
  return {
    provider: "relay",
    id,
    limitsSource,
    contextWindow,
    maxOutputTokens: maxOutputToken,
    maxOutputToken,
    imageModel: false,
  };
}

function kbrainDocument(models) {
  return {
    version: "kbrain.agent.v1",
    mode: "kbrain",
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
    models,
  };
}

test("review: K-brain projection keeps catalog/fallback limitsSource when read back", () => {
  const { providerSettings } = freshModules();
  const document = kbrainDocument([
    kbrainProjectedModel({
      id: ADDED_ID,
      contextWindow: 400_000,
      maxOutputToken: 142_000,
      limitsSource: "fallback",
    }),
  ]);
  const [provider] = providerSettings.appProvidersFromKBrain(document);
  assert.equal(
    provider.models[0].limitsSource,
    "fallback",
    "a model K-brain stores as fallback must stay fallback in the GUI, otherwise C4 re-resolution never applies",
  );
});

test("review: K-brain catalog reconcile detects drift on the real K-brain document shape", async () => {
  const { catalogLive, providerSettings } = freshModules();
  const document = kbrainDocument([
    kbrainProjectedModel({
      id: ADDED_ID,
      contextWindow: 400_000,
      maxOutputToken: 142_000,
      limitsSource: "fallback",
    }),
  ]);
  await activateLive(catalogLive);
  const update = providerSettings.kBrainSettingsUpdateForCatalogRefresh(document);
  assert.ok(update, "live catalog resolves the fallback model to 777K; K-brain still has 400K");
  const pushed = update.providers[0].models.find((model) => model.id === ADDED_ID);
  assert.deepEqual(
    [pushed.contextWindow, pushed.maxOutputToken, pushed.limitsSource],
    [777_000, 77_000, "catalog"],
  );
});

test("review: GUI settings loaded from K-brain re-resolve fallback limits when the live catalog arrives", async () => {
  const { catalogLive, providerSettings, settings } = freshModules();
  const document = kbrainDocument([
    kbrainProjectedModel({
      id: ADDED_ID,
      contextWindow: 400_000,
      maxOutputToken: 142_000,
      limitsSource: "fallback",
    }),
  ]);
  // 与 storage.ts loadPersistedSettingsWithDefaults 相同：设置的 customProviders 来自
  // appProvidersFromKBrain(document)；之后 App.tsx 在版本变化时调用 refresh。
  const appSettings = {
    ...settings.getDefaultSettings(),
    customProviders: providerSettings.appProvidersFromKBrain(document),
  };
  await activateLive(catalogLive);
  const refreshed = settings.refreshCatalogDerivedModelLimits(appSettings);
  const model = refreshed.customProviders[0].models.find((item) => item.id === ADDED_ID);
  assert.deepEqual(
    [model.contextWindow, model.maxOutputToken, model.limitsSource],
    [777_000, 77_000, "catalog"],
  );
});

test("review: chat model options follow a live catalog that only changes modalities", async () => {
  const { createDomTestEnv } = await import("../helpers/dom-test-env.mjs");
  const env = await createDomTestEnv({
    mocks: { "../../../lib/chat/history/chatHistory": { setChatHistoryModel: async () => ({}) } },
  });
  const { React, act, createRoot, loadModule } = env;
  const catalogLive = loadModule("@liveagent/ui/lib/models/catalogLive.ts");
  const { normalizeSettings, refreshCatalogDerivedModelLimits } = loadModule(
    "src/lib/settings/index.ts",
  );
  const { useChatModelSelection } = loadModule("src/pages/chat/runtime/useChatModelSelection.ts");
  // gpt-4 在内置快照里是纯文本；运行期目录只把模态改成 text+image，限额不变。
  const settings = normalizeSettings({
    customProviders: [
      { id: "p", type: "codex", name: "relay", apiKey: "", baseUrl: "",
        models: ["gpt-4"], activeModels: ["gpt-4"] },
    ],
    selectedModel: { customProviderId: "p", model: "gpt-4" },
  });
  const selection = { customProviderId: "p", model: "gpt-4" };
  const cache = { current: new Map([["one", { selectedModel: selection, isSending: false, errorMessage: null }]]) };
  const rows = new Map([["one", { id: "one", selectedModelJson: JSON.stringify(selection) }]]);
  let snapshot;
  function Page() {
    snapshot = useChatModelSelection({
      settings, setSettings: () => {}, t: (key) => key,
      sidebarStore: { peek: (id) => rows.get(id), upsertLocal: () => {} },
      sidebarConversationsById: rows, currentConversationId: "one",
      currentConversationSelectedModel: selection, currentConversationIdRef: { current: "one" },
      conversationRuntimeCacheRef: cache, updateConversationRuntimeEntry: () => {},
    });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Page)));
    assert.equal(snapshot.modelOptions[0].vision, false);
    await act(async () => {
      await activateLive(
        catalogLive,
        makeDocument((sections) => {
          sections.openai.find((entry) => entry.id === "gpt-4").inputModalities = ["text", "image"];
        }),
      );
    });
    assert.equal(
      refreshCatalogDerivedModelLimits(settings),
      settings,
      "limits unchanged → App/WebUI keep the same settings object",
    );
    // 对照：同一模块实例里，生效目录与 buildModelOptions 本身已经是新结果。
    const { buildModelOptions } = loadModule("@liveagent/ui/lib/models/modelOptions.ts");
    assert.equal(buildModelOptions(settings, { floatSelectedFirst: false })[0].vision, true);
    await act(async () => root.render(React.createElement(Page)));
    assert.equal(
      snapshot.modelOptions[0].vision,
      true,
      "the picker's vision flag must follow the effective catalog",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
    env.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 第二轮：P1 修复的副作用（provider 来源、旧数据、推送字段）
// ---------------------------------------------------------------------------

test("review r2: real provider declarations survive the read-back and a live catalog", async () => {
  const { catalogLive, providerSettings, settings } = freshModules();
  // gpt-4 在目录里有限额（8192/2048）；供应商声明的 32K/4K 不得被目录覆盖。
  const document = kbrainDocument([
    { ...kbrainProjectedModel({ id: "gpt-4", contextWindow: 32_768, maxOutputToken: 4_096, limitsSource: "provider" }),
      inputModalities: ["text"] },
  ]);
  const [provider] = providerSettings.appProvidersFromKBrain(document);
  assert.deepEqual(
    [provider.models[0].contextWindow, provider.models[0].maxOutputToken, provider.models[0].limitsSource],
    [32_768, 4_096, "provider"],
  );
  await activateLive(
    catalogLive,
    makeDocument((sections) => {
      const entry = sections.openai.find((item) => item.id === "gpt-4");
      entry.contextWindow = 9_000;
    }),
  );
  const appSettings = { ...settings.getDefaultSettings(), customProviders: [provider] };
  assert.equal(settings.refreshCatalogDerivedModelLimits(appSettings), appSettings);
  assert.equal(providerSettings.kBrainSettingsUpdateForCatalogRefresh(document), undefined);
});

test("review r2: legacy K-brain models without limitsSource keep their stored limits", () => {
  const { providerSettings } = freshModules();
  const legacy = kbrainProjectedModel({ id: ADDED_ID, contextWindow: 64_000, maxOutputToken: 8_000 });
  delete legacy.limitsSource;
  delete legacy.maxOutputToken; // 早期 K-brain 只回传复数字段
  const [provider] = providerSettings.appProvidersFromKBrain(kbrainDocument([legacy]));
  assert.deepEqual(
    [provider.models[0].contextWindow, provider.models[0].maxOutputToken, provider.models[0].limitsSource],
    [64_000, 8_000, "provider"],
  );
});

test("review r2: a reconcile push never carries a stale maxOutputTokens (K-brain prefers it on update)", async () => {
  const { catalogLive, providerSettings } = freshModules();
  const document = kbrainDocument([
    kbrainProjectedModel({ id: ADDED_ID, contextWindow: 400_000, maxOutputToken: 142_000, limitsSource: "fallback" }),
  ]);
  await activateLive(catalogLive);
  const update = providerSettings.kBrainSettingsUpdateForCatalogRefresh(document);
  assert.ok(update);
  for (const model of update.providers[0].models) {
    assert.equal("maxOutputTokens" in model, false, `${model.id} must push only maxOutputToken`);
  }
  // 推送后 K-brain 回传新值：再对账无差异，不形成循环写入。
  const reconciled = kbrainDocument(
    update.providers[0].models.map((model) =>
      kbrainProjectedModel({ ...model, limitsSource: model.limitsSource }),
    ),
  );
  assert.equal(providerSettings.kBrainSettingsUpdateForCatalogRefresh(reconciled), undefined);
});
