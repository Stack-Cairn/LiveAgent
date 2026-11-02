import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("conversation title job disables thinking, caching, and native web search", async () => {
  const rootLoader = createTsModuleLoader();
  const llmModulePath = rootLoader.resolveLocal("src/lib/providers/llm.ts");
  let capturedParams = null;
  const llmMock = {
    assistantMessageToText: (assistant) => assistant.text,
    streamAssistantMessage: async (params) => {
      capturedParams = params;
      params.onTextDelta("Fast title");
      return { text: "Fast title" };
    },
    toModelValue: (customProviderId, model) => `${customProviderId}::${model}`,
  };
  const loader = createTsModuleLoader({
    mocks: {
      "../../../lib/providers/llm": llmMock,
      [llmModulePath]: llmMock,
    },
  });
  const { buildConversationTitleRuntime, startConversationTitleJob } = loader.loadModule(
    "src/pages/chat/runtime/conversationTitleJob.ts",
  );
  const runtime = {
    baseUrl: "https://example.test",
    apiKey: "secret",
    requestFormat: "openai-responses",
    reasoning: "xhigh",
    promptCachingEnabled: true,
    nativeWebSearchEnabled: true,
    modelConfig: { id: "gpt-5", reasoning: true },
  };

  assert.deepEqual(buildConversationTitleRuntime(runtime), {
    ...runtime,
    reasoning: "off",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
  });

  const historyItemsById = new Map([
    [
      "conversation-1",
      {
        id: "conversation-1",
        title: "新会话",
        updatedAt: 1,
        isPending: true,
      },
    ],
  ]);
  const sidebarStore = {
    peek: (conversationId) => historyItemsById.get(conversationId),
    upsertLocal: (conversation) => {
      historyItemsById.set(conversation.id, conversation);
    },
  };
  const titleJobRef = { current: null };
  const forwardedTitles = [];

  const title = await startConversationTitleJob({
    providerId: "codex",
    model: "gpt-5",
    runtime,
    signal: new AbortController().signal,
    conversationId: "conversation-1",
    titleSourceText: "Please build a fast settings drawer.",
    content: "Please build a fast settings drawer.",
    locale: "en-US",
    sidebarStore,
    titleJobRef,
    gatewayBridgeEvents: {
      queueTitle: (nextTitle) => forwardedTitles.push(nextTitle),
    },
  });

  assert.equal(title, "Fast title");
  assert.equal(runtime.reasoning, "xhigh");
  assert.equal(runtime.promptCachingEnabled, true);
  assert.equal(runtime.nativeWebSearchEnabled, true);
  assert.equal(capturedParams.runtime.reasoning, "off");
  assert.equal(capturedParams.runtime.promptCachingEnabled, false);
  assert.equal(capturedParams.runtime.nativeWebSearchEnabled, false);
  assert.equal(capturedParams.nativeWebSearch, false);
  assert.equal(capturedParams.cacheRetention, "none");
  assert.equal(historyItemsById.get("conversation-1").title, "Fast title");
  assert.equal(forwardedTitles[0], "Fast title");
  // The requested locale must reach the model, not just the prompt builders.
  assert.match(capturedParams.context.systemPrompt, /concise conversation titles/i);
  assert.match(capturedParams.context.messages[0].content, /within 10 words/i);

  historyItemsById.set("conversation-1", {
    id: "conversation-1",
    title: "新会话",
    updatedAt: 1,
    isPending: true,
  });
  await startConversationTitleJob({
    providerId: "codex",
    model: "gpt-5",
    runtime,
    signal: new AbortController().signal,
    conversationId: "conversation-1",
    titleSourceText: "请帮我做一个很快的设置抽屉。",
    content: "请帮我做一个很快的设置抽屉。",
    locale: "zh-CN",
    sidebarStore,
    titleJobRef,
    gatewayBridgeEvents: {
      queueTitle: (nextTitle) => forwardedTitles.push(nextTitle),
    },
  });

  assert.match(capturedParams.context.systemPrompt, /简体中文/);
  assert.match(capturedParams.context.messages[0].content, /简体中文标题/);
});


async function withTitleHttpFixture(t, callback) {
  const requests = [];
  const model = { provider: "provider-1", model: "gpt-5" };
  const session = {
    id: "backend-conversation",
    title: "Original backend title",
    model,
    created_at: "2026-09-28T00:00:00Z",
    updated_at: "2026-09-28T00:01:00Z",
    message_count: 1,
    messages: [],
    tasks: [],
    last_seq: 1,
  };
  let respondToTitle;
  const titleRequested = new Promise((resolve) => {
    respondToTitle = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    requests.push({ method: request.method, path: request.url, headers: request.headers, body });
    response.setHeader("content-type", "application/json");
    if (request.method === "POST" && request.url === "/v1/text/generate") {
      respondToTitle((text, status = 200) => {
        response.statusCode = status;
        response.end(JSON.stringify(status === 200
          ? { version: "kbrain.agent.v1", text, model }
          : { error: "Title provider unavailable" }));
      });
    } else if (request.method === "PATCH" && request.url === "/v1/sessions/backend-conversation") {
      session.title = body.title;
      response.end(JSON.stringify(session));
    } else {
      response.statusCode = 404;
      response.end(JSON.stringify({ error: "Unexpected endpoint" }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const previousFetch = globalThis.fetch;
  const previousStorage = globalThis.localStorage;
  const previousWindow = globalThis.window;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  globalThis.window = { setTimeout, clearTimeout };
  // Only relocate the default backend origin; fetch, client and runtime stay real.
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, "http://127.0.0.1:47321");
    url.port = String(server.address().port);
    return previousFetch(url, init);
  };
  t.after(async () => {
    globalThis.fetch = previousFetch;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const root = createTsModuleLoader();
  let tauriCalls = 0;
  const loader = createTsModuleLoader({
    mocks: {
      react: { useRef: (current) => ({ current }) },
      [root.resolveLocal("src/lib/providers/runtime/providerRuntimeConfig.ts")]: {
        getProviderRuntimeBackend: () => "kbrain",
      },
      [root.resolveLocal("src/shims/tauriCore.ts")]: {
        invoke() { tauriCalls++; throw new Error("Unexpected Tauri IPC"); },
      },
    },
  });
  const runtimeConnection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  runtimeConnection.setKBrainRuntimeConnection({
    baseUrl: "http://127.0.0.1:47321",
    token: "",
    protocolVersion: "kbrain.agent.v1",
  });
  const { startConversationTitleJob } = loader.loadModule("src/pages/chat/runtime/conversationTitleJob.ts");
  const { useConversationHistoryActions } = loader.loadModule("src/pages/chat/history/useConversationHistoryActions.ts");
  const { createConversationStateFromContext } = loader.loadModule("src/lib/chat/conversation/conversationState.ts");
  const { setKBrainSessionId } = loader.loadModule("src/lib/kbrain/mapping.ts");
  setKBrainSessionId("conversation-1", session.id);
  const state = createConversationStateFromContext({
    messages: [{ role: "user", content: "Build a fast settings drawer", timestamp: 1 }],
  });
  let row = { id: "conversation-1", title: "New conversation", isPending: true };
  let titlePersisted;
  const persisted = new Promise((resolve) => { titlePersisted = resolve; });
  const sidebarStore = {
    peek: () => row,
    upsertLocal: (next) => {
      row = next;
      if (!next.isPending && next.title === "Backend generated title" && session.title === next.title) {
        titlePersisted();
      }
    },
  };
  const titleJobRef = { current: null };
  const previews = [];
  const controller = new AbortController();
  const titlePromise = startConversationTitleJob({
    providerId: "codex",
    model: model.model,
    runtime: {
      backend: "kbrain", backendModelProvider: model.provider,
      baseUrl: "https://forbidden-provider.test", apiKey: "provider-secret",
      customHeaders: [{ key: "Authorization", value: "Bearer header-secret" }],
      reasoning: "xhigh", promptCachingEnabled: true, nativeWebSearchEnabled: true,
    },
    signal: controller.signal,
    conversationId: row.id,
    titleSourceText: "Build a fast settings drawer",
    content: "Unused content",
    locale: "en-US",
    sidebarStore,
    titleJobRef,
    gatewayBridgeEvents: { queueTitle: (title, force) => previews.push({ title, force }) },
  });
  const { persistConversation } = useConversationHistoryActions({
    conversationState: state,
    conversationRuntimeCacheRef: { current: new Map() },
    conversationPersistenceCursorRef: { current: new Map() },
    markLocalHistorySnapshotSynced() {},
    updateConversationRuntimeEntry() {},
    sidebarStore,
    titleJobRef,
    t: () => "New conversation",
  });
  const persist = (titleLookahead = true) => persistConversation({
    conversationId: row.id, sessionId: "session-1", providerId: model.provider,
    model: model.model, state, fallbackTitle: "Build a fast settings drawer", createdAt: 1,
    titlePromise, titleLookahead,
  });
  await callback({ requests, titleRequested, titlePromise, persist, persisted, controller,
    previews, titleJobRef, getRow: () => row, sidebarStore, session });
  assert.equal(tauriCalls, 0);
  const [request] = requests;
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/text/generate");
  assert.equal(request.headers.authorization, undefined);
  assert.deepEqual(request.body.model, model);
  assert.equal(request.body.output, "text");
  assert.equal(request.body.messages[0].role, "system");
  assert.match(request.body.messages[0].content[0].text, /concise conversation titles/i);
  assert.match(request.body.messages[1].content[0].text, /within 10 words.*\nBuild a fast settings drawer/i);
  assert.doesNotMatch(JSON.stringify(request), /provider-secret|header-secret|forbidden-provider|Unused content/);
}

for (const late of [false, true]) {
  test(`shipped title job generates over HTTP and persists ${late ? "late" : "lookahead"} K-brain title`, { timeout: 10_000 }, async (t) => {
    await withTitleHttpFixture(t, async ({ titleRequested, titlePromise, persist, persisted, getRow, requests, previews, session }) => {
      const respond = await titleRequested;
      if (late) {
        assert.ok(await persist(false));
        assert.equal(getRow().title, "Build a fast settings drawer");
      }
      respond('"Backend generated title"');
      assert.equal(await titlePromise, "Backend generated title");
      if (!late) {
        assert.equal(getRow().title, "Backend generated title");
        assert.ok(await persist());
      } else {
        assert.equal(getRow().title, "Build a fast settings drawer");
      }
      await persisted;
      assert.equal(session.title, "Backend generated title");
      assert.equal(getRow().isPending, undefined);
      assert.equal(previews.at(-1).title, "Backend generated title");
      assert.deepEqual(requests.map(({ method, path }) => ({ method, path })), [
        { method: "POST", path: "/v1/text/generate" },
        { method: "PATCH", path: "/v1/sessions/backend-conversation" },
      ]);
      assert.deepEqual(requests[1].body, { title: "Backend generated title" });
    });
  });
}

for (const failure of ["http", "empty", "abort"]) {
  test(`shipped K-brain title job preserves fallback on ${failure}`, { timeout: 10_000 }, async (t) => {
    await withTitleHttpFixture(t, async ({ titleRequested, titlePromise, persist, controller, getRow, requests, previews }) => {
      const respond = await titleRequested;
      if (failure === "abort") controller.abort();
      else respond("", failure === "http" ? 503 : 200);
      assert.equal(await titlePromise, null);
      assert.equal(getRow().title, "New conversation");
      assert.ok(await persist());
      assert.equal(getRow().title, "Build a fast settings drawer");
      assert.equal(requests.length, 1);
      assert.deepEqual(previews, []);
    });
  });
}

test("late generated title does not overwrite a manual rename", { timeout: 10_000 }, async (t) => {
  await withTitleHttpFixture(t, async ({ titleRequested, titlePromise, persist, getRow, sidebarStore, requests }) => {
    const respond = await titleRequested;
    assert.ok(await persist(false));
    sidebarStore.upsertLocal({ ...getRow(), title: "My manual title" });
    respond("Backend generated title");
    await titlePromise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(getRow().title, "My manual title");
    assert.equal(requests.length, 1);
  });
});

for (const outcome of ["error", "empty"]) {
  test(`direct title jobs preserve null fallback on ${outcome}`, async () => {
    const loader = createTsModuleLoader({
      mocks: {
        "../../../lib/providers/llm": {
          assistantMessageToText: (assistant) => assistant.text,
          async streamAssistantMessage() {
            if (outcome === "error") throw new Error("Provider unavailable");
            return { text: "" };
          },
        },
      },
    });
    const { startConversationTitleJob } = loader.loadModule("src/pages/chat/runtime/conversationTitleJob.ts");
    const row = { id: "conversation-1", title: "New conversation", isPending: true };
    const titleJobRef = { current: null };
    assert.equal(await startConversationTitleJob({
      providerId: "codex", model: "gpt-5", runtime: { backend: "direct" },
      signal: new AbortController().signal, conversationId: row.id,
      titleSourceText: "Build a drawer", content: "Build a drawer", locale: "en-US",
      titleJobRef,
      sidebarStore: { peek: () => row, upsertLocal() { assert.fail("Unexpected preview"); } },
      gatewayBridgeEvents: { queueTitle() { assert.fail("Unexpected gateway title"); } },
    }), null);
    assert.equal(await titleJobRef.current.promise, null);
  });
}
