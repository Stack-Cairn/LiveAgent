import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const s = loader.loadModule("src/lib/settings/index.ts");
const { resolveActiveModelSelection } = loader.loadModule("src/app/chatEventUtils.ts");
const { resolveConversationRuntimeControls } = loader.loadModule(
  "src/app/gatewayChatCommandActions.ts",
);

test("web requests use each conversation's persisted or local thinking", () => {
  const model = { customProviderId: "p", model: "gpt-5.2" };
  const app = s.normalizeSettings({
    customProviders: [
      { id: "p", name: "P", type: "codex", models: [model.model], activeModels: [model.model], requestFormat: "openai-responses" },
    ],
    selectedModel: model,
    chatRuntimeControls: { reasoning: "medium" },
  });
  const resolve = (selection) =>
    resolveConversationRuntimeControls({
      activeProviders: app.customProviders,
      selectedModel: selection,
      runtimeControls: app.chatRuntimeControls,
    });
  const persisted = resolveActiveModelSelection({
    settings: app,
    persistedSelectedModelJson: JSON.stringify({ ...model, reasoning: "low", thinkingEnabled: false }),
  });
  assert.equal(resolve(persisted).reasoning, "low");
  assert.equal(resolve(persisted).thinkingEnabled, false);
  const local = resolveActiveModelSelection({ settings: app, override: { ...model, reasoning: "xhigh" } });
  assert.equal(resolve(local).reasoning, "xhigh");
  assert.equal(resolve(resolveActiveModelSelection({ settings: app })).reasoning, "medium");
});
