import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const { createProviderRuntimeConfig } = loader.loadModule(
  "src/lib/providers/runtime/providerRuntimeConfig.ts",
);
const params = { providerId: "codex", requestFormat: "openai-responses", modelId: "gpt-5.2" };
const first = { customProviderId: "p", model: "gpt-5.2" };
const second = { customProviderId: "p", model: "gpt-5" };
const provider = settings.normalizeCustomProvider({
  id: "p",
  name: "P",
  type: "codex",
  models: [first.model, second.model],
  activeModels: [first.model, second.model],
  requestFormat: "openai-responses",
});

test("conversation thinking round-trips through selectedModelJson and drops invalid values", () => {
  const json = settings.serializeSelectedModelJson({ ...first, thinkingEnabled: false, reasoning: "xhigh" });
  assert.deepEqual(settings.parseSelectedModelJson(json), { ...first, thinkingEnabled: false, reasoning: "xhigh" });
  assert.deepEqual(
    settings.parseSelectedModelJson(JSON.stringify({ ...first, thinkingEnabled: "no", reasoning: "off" })),
    first,
  );
});

test("same-model conversations use their own thinking without changing stored defaults", () => {
  const defaults = settings.normalizeChatRuntimeControls({ reasoning: "medium" });
  const stored = JSON.stringify(defaults);
  const read = (selection) =>
    settings.normalizeChatRuntimeControlsForProvider(settings.applyConversationThinking(defaults, selection), params);
  assert.equal(read({ ...first, reasoning: "xhigh" }).reasoning, "xhigh");
  assert.equal(read({ ...first, reasoning: "low", thinkingEnabled: false }).thinkingEnabled, false);
  assert.equal(read(first).reasoning, "medium");
  assert.equal(JSON.stringify(defaults), stored);
  const request = createProviderRuntimeConfig(
    provider,
    first.model,
    settings.applyConversationThinking(defaults, { ...first, reasoning: "low" }),
  );
  assert.equal(request.reasoning, "low");
});

test("thinking patches become the conversation selection; other patches do not", () => {
  const current = { thinkingEnabled: true, reasoning: "high" };
  assert.deepEqual(settings.applyThinkingPatchToSelection(first, current, { reasoning: "low" }), {
    ...first,
    thinkingEnabled: true,
    reasoning: "low",
  });
  assert.equal(settings.applyThinkingPatchToSelection(first, current, { planModeEnabled: true }), undefined);
  assert.equal(settings.applyThinkingPatchToSelection(undefined, current, { reasoning: "low" }), undefined);
});

test("desktop saves thinking and model per conversation and keeps thinking across model switches", () => {
  const effects = [];
  const hookLoader = createTsModuleLoader({
    mocks: {
      react: {
        useCallback: (fn) => fn,
        useMemo: (fn) => fn(),
        useEffect: (fn) => effects.push(fn),
        useSyncExternalStore: (_subscribe, get) => get(),
      },
    },
  });
  const s = hookLoader.loadModule("src/lib/settings/index.ts");
  const { useChatModelSelection } = hookLoader.loadModule(
    "src/pages/chat/runtime/useChatModelSelection.ts",
  );
  let app = s.normalizeSettings({ customProviders: [provider], selectedModel: first });
  const cache = new Map([["a", {}], ["b", {}]]);
  const currentId = { current: "a" };
  const render = () => {
    const hook = useChatModelSelection({
      settings: app,
      setSettings: (fn) => {
        app = fn(app);
      },
      t: (key) => key,
      sidebarStore: { peek: () => undefined },
      sidebarConversationsById: new Map(),
      currentConversationId: currentId.current,
      currentConversationSelectedModel: cache.get(currentId.current)?.selectedModel,
      currentConversationIdRef: currentId,
      conversationRuntimeCacheRef: { current: cache },
      updateConversationRuntimeEntry: (id, fn) => {
        const next = fn(cache.get(id) ?? {});
        cache.set(id, next);
        return next;
      },
    });
    for (const effect of effects.splice(0)) effect();
    return hook;
  };
  render().handleChatRuntimeControlsChange({ reasoning: "low" });
  currentId.current = "b";
  render().handleChatRuntimeControlsChange({ reasoning: "xhigh" });
  currentId.current = "a";
  assert.equal(render().chatRuntimeControlsForCurrentProvider.reasoning, "low");
  render().handleSelectModel(second);
  assert.deepEqual(cache.get("a").selectedModel, { ...second, thinkingEnabled: true, reasoning: "low" });
  assert.deepEqual(app.selectedModel, second, "global default records only the model");
  currentId.current = "b";
  const b = render();
  assert.equal(b.activeSelectedModel.model, first.model);
  assert.equal(b.chatRuntimeControlsForCurrentProvider.reasoning, "xhigh");
});
