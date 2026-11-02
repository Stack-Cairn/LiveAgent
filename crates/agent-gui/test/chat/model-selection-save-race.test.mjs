import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const requests = [];
const env = await createDomTestEnv({
  mocks: {
    "../../../lib/chat/history/chatHistory": {
      setChatHistoryModel(id, json) {
        return new Promise((resolve, reject) => requests.push({ id, json, resolve, reject }));
      },
    },
  },
});
after(() => env.cleanup());
const { React, act, createRoot, loadModule } = env;
const { normalizeSettings } = loadModule("src/lib/settings/index.ts");
const { useChatModelSelection } = loadModule("src/pages/chat/runtime/useChatModelSelection.ts");
const model = (name) => ({ customProviderId: "p", model: name });

async function mount(run) {
  requests.length = 0;
  let settings = normalizeSettings({
    customProviders: [{ id: "p", type: "codex", name: "test", apiKey: "", baseUrl: "",
      models: ["a", "b", "c"], activeModels: ["a", "b", "c"] }],
    selectedModel: model("a"),
  });
  const rows = new Map(["one", "two"].map((id) => [id, { id, selectedModelJson: JSON.stringify(model("a")) }]));
  const cache = { current: new Map(["one", "two"].map((id) => [id, { selectedModel: model("a"), isSending: false, errorMessage: null }])) };
  const idRef = { current: "one" };
  const update = (id, fn) => { const next = fn(cache.current.get(id)); cache.current.set(id, next); return next; };
  const store = { peek: (id) => rows.get(id), upsertLocal: (row) => rows.set(row.id, row) };
  const setSettings = (fn) => { settings = fn(settings); };
  let snapshot;
  function Page() {
    snapshot = useChatModelSelection({ settings, setSettings, t: (key) => key, sidebarStore: store,
      sidebarConversationsById: rows, currentConversationId: idRef.current,
      currentConversationSelectedModel: cache.current.get(idRef.current).selectedModel,
      currentConversationIdRef: idRef, conversationRuntimeCacheRef: cache,
      updateConversationRuntimeEntry: update });
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => act(async () => root.render(React.createElement(Page)));
  const pick = async (name) => { await act(async () => snapshot.handleSelectModel(model(name))); await render(); };
  const settle = async (request, error) => {
    await act(async () => error ? request.reject(error) : request.resolve({ id: request.id, selectedModelJson: request.json }));
    await render();
  };
  try {
    await render();
    await run({ cache, rows, idRef, render, pick, settle, snapshot: () => snapshot,
      refresh: async () => { settings = normalizeSettings(settings); await render(); } });
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

test("first model pick survives closing/rerendering and stale history during a slow save", async () => {
  await mount(async ({ cache, pick, refresh, settle }) => {
    await pick("b");
    assert.equal(cache.current.get("one").selectedModel.model, "b");
    await refresh();
    assert.equal(cache.current.get("one").selectedModel.model, "b");
    await settle(requests[0]);
    assert.equal(cache.current.get("one").selectedModel.model, "b");
  });
});

test("rapid picks serialize backend writes and never publish an obsolete selection", async () => {
  await mount(async ({ cache, rows, pick, settle }) => {
    await pick("b");
    await pick("c");
    assert.equal(requests.length, 1, "one in-flight write per conversation prevents backend reordering");
    await settle(requests[0]);
    assert.equal(requests.length, 2);
    assert.equal(cache.current.get("one").selectedModel.model, "c");
    assert.equal(JSON.parse(rows.get("one").selectedModelJson).model, "a", "obsolete response stays out of sidebar");
    await settle(requests[1]);
    assert.equal(JSON.parse(rows.get("one").selectedModelJson).model, "c");
  });
});

test("failed save preserves local selection, reports the error and permits retry", async () => {
  await mount(async ({ cache, pick, refresh, settle }) => {
    await pick("b");
    await settle(requests[0], new Error("save unavailable"));
    await refresh();
    assert.equal(cache.current.get("one").selectedModel.model, "b");
    assert.match(cache.current.get("one").errorMessage, /save unavailable/);
    await pick("b");
    assert.equal(cache.current.get("one").errorMessage, null, "retry clears its own save error");
    await settle(requests[1]);
    assert.equal(cache.current.get("one").selectedModel.model, "b");
  });
});

test("an obsolete failure cannot affect the latest choice or block its write", async () => {
  await mount(async ({ cache, pick, settle }) => {
    await pick("b"); await pick("c");
    await settle(requests[0], new Error("obsolete failure"));
    assert.equal(cache.current.get("one").errorMessage, null);
    assert.equal(cache.current.get("one").selectedModel.model, "c");
    await settle(requests[1]);
  });
});

test("thinking changes share the model write queue and retain the latest model", async () => {
  await mount(async ({ cache, pick, snapshot, render, settle }) => {
    await pick("b");
    await act(async () => snapshot().handleChatRuntimeControlsChange({ thinkingEnabled: false }));
    await render();
    assert.equal(requests.length, 1);
    assert.equal(cache.current.get("one").selectedModel.model, "b");
    assert.equal(cache.current.get("one").selectedModel.thinkingEnabled, false);
    await settle(requests[0]);
    assert.equal(requests.length, 2);
    assert.equal(JSON.parse(requests[1].json).thinkingEnabled, false);
    await settle(requests[1]);
  });
});

test("conversation saves are independent and remote synchronization resumes after acknowledgement", async () => {
  await mount(async ({ cache, rows, idRef, pick, render, refresh, settle }) => {
    await pick("b"); idRef.current = "two"; await render(); await pick("c");
    assert.equal(requests.length, 2);
    await settle(requests[1]);
    idRef.current = "one"; await render(); await refresh();
    assert.equal(cache.current.get("one").selectedModel.model, "b");
    await settle(requests[0]);
    rows.set("one", { id: "one", selectedModelJson: JSON.stringify(model("c")) });
    await render();
    assert.equal(cache.current.get("one").selectedModel.model, "c");
  });
});


test("a save completed in an inactive conversation must not block later remote updates", async () => {
  await mount(async ({ cache, rows, idRef, pick, render, settle }) => {
    await pick("b");
    idRef.current = "two";
    await render();
    await settle(requests[0]);
    rows.set("one", { id: "one", selectedModelJson: JSON.stringify(model("c")) });
    await render();
    idRef.current = "one";
    await render();
    assert.equal(cache.current.get("one").selectedModel.model, "c");
  });
});


test("a remote update batched with save completion is accepted", async () => {
  await mount(async ({ cache, rows, pick, render }) => {
    await pick("b");
    await act(async () => {
      requests[0].resolve({ id: "one", selectedModelJson: requests[0].json });
      await new Promise(resolve => setTimeout(resolve, 0));
      rows.set("one", { id: "one", selectedModelJson: JSON.stringify(model("c")) });
    });
    await render();
    assert.equal(cache.current.get("one").selectedModel.model, "c");
  });
});
