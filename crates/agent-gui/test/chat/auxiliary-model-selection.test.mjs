import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 摘要 / 标题 / 提交信息模型的解析与聊天主选同一可用性判定：供应商停用
// （enabled === false）等同于模型未启用，失效时沿用各自既有的回退（null / fallback）。

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const runtimeConfig = loader.loadModule("src/pages/chat/runtime/providerRuntimeConfig.ts");

const AUX = { customProviderId: "aux", model: "aux-model" };
const MAIN = { customProviderId: "main", model: "main-model" };

function buildSettings() {
  return settings.normalizeSettings({
    customProviders: [
      {
        id: "main",
        name: "Main",
        type: "codex",
        baseUrl: "https://main.example/v1",
        apiKey: "k",
        models: ["main-model"],
        activeModels: ["main-model"],
      },
      {
        id: "aux",
        name: "Aux",
        type: "claude_code",
        baseUrl: "https://aux.example/v1",
        apiKey: "k",
        models: ["aux-model", "inactive-model"],
        activeModels: ["aux-model"],
      },
    ],
    selectedModel: MAIN,
    memory: { summaryModel: AUX },
    customSettings: { conversationTitleModel: AUX, commitMessageModel: AUX },
  });
}

/** 选择先于停用落盘：normalize 之后再关掉 aux 的总开关。 */
function withAuxDisabled(app) {
  return {
    ...app,
    customProviders: app.customProviders.map((item) =>
      item.id === "aux" ? { ...item, enabled: false } : item,
    ),
  };
}

const fallback = {
  selectedModel: MAIN,
  provider: null,
  providerId: "codex",
  model: "main-model",
};

test("enabled aux provider resolves for summary / title / commit-message models", () => {
  const app = buildSettings();
  assert.deepEqual(app.memory.summaryModel, AUX);
  assert.deepEqual(app.customSettings.conversationTitleModel, AUX);
  assert.deepEqual(app.customSettings.commitMessageModel, AUX);

  assert.equal(runtimeConfig.resolveMemorySummaryModelSelection(app)?.provider.id, "aux");
  assert.equal(
    runtimeConfig.resolveConversationTitleModelSelection(app, fallback).provider.id,
    "aux",
  );
  assert.equal(runtimeConfig.resolveCommitMessageModelSelection(app)?.provider.id, "aux");
});

test("a disabled provider is never picked as the summary / title / commit-message model", () => {
  const app = withAuxDisabled(buildSettings());
  assert.equal(app.customProviders.find((item) => item.id === "aux").enabled, false);

  assert.equal(runtimeConfig.resolveMemorySummaryModelSelection(app), null);
  assert.equal(runtimeConfig.resolveConversationTitleModelSelection(app, fallback), fallback);
  assert.equal(runtimeConfig.resolveCommitMessageModelSelection(app), null);
});

test("an inactive model keeps the same fallback contract as a disabled provider", () => {
  const base = buildSettings();
  const inactive = { customProviderId: "aux", model: "inactive-model" };
  const app = {
    ...base,
    memory: { ...base.memory, summaryModel: inactive },
    customSettings: {
      ...base.customSettings,
      conversationTitleModel: inactive,
      commitMessageModel: inactive,
    },
  };

  assert.equal(runtimeConfig.resolveMemorySummaryModelSelection(app), null);
  assert.equal(runtimeConfig.resolveConversationTitleModelSelection(app, fallback), fallback);
  assert.equal(runtimeConfig.resolveCommitMessageModelSelection(app), null);
});
