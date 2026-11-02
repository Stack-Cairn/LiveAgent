import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHookHarness() {
  const refs = [];
  const effects = [];
  let refIndex = 0;
  let effectIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useEffect(effect, deps) {
      const index = effectIndex++;
      const previous = effects[index];
      const changed =
        !previous ||
        deps.length !== previous.deps.length ||
        deps.some((value, depIndex) => value !== previous.deps[depIndex]);
      if (!changed) return;
      previous?.cleanup?.();
      effects[index] = { deps: [...deps], cleanup: effect() };
    },
  };

  return {
    react,
    render(run) {
      refIndex = 0;
      effectIndex = 0;
      run();
    },
    cleanup() {
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
}

function createEventTarget() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(name, handler) {
      const set = handlers.get(name) ?? new Set();
      set.add(handler);
      handlers.set(name, set);
    },
    removeEventListener(name, handler) {
      handlers.get(name)?.delete(handler);
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

test("gateway bridge listener keeps one worker across renders and handles native wake immediately", async () => {
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const registrations = [];
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  let nextTimerId = 1;
  const timers = new Map();

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    ...windowEvents,
    setInterval(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    ...documentEvents,
    visibilityState: "visible",
  };

  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: hookHarness.react,
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            invokeCalls.push({ command, payload });
            if (command === "gateway_chat_claim_next") return null;
            return undefined;
          },
        },
        "@tauri-apps/api/event": {
          listen(name, handler) {
            let resolve;
            const promise = new Promise((next) => {
              resolve = next;
            });
            registrations.push({ name, handler, resolve, disposed: false });
            return promise;
          },
        },
        "../../../lib/settings": {
          normalizeChatRuntimeControls(value) {
            return value;
          },
          normalizeSystemToolSelection(value) {
            return Array.isArray(value) ? value : [];
          },
        },
      },
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    const currentConversationIdRef = { current: "conversation-1" };
    const ensureGatewayBridgeConversationReadyRef = {
      current: async (id) => id || "conversation-1",
    };
    const sendActionRef = { current: async () => true };
    let firstAbortCalls = 0;
    let secondAbortCalls = 0;
    const stopRequestIds = [];
    const activeStopCalls = [];
    const consumedStopIds = [];
    const baseParams = {
      currentConversationIdRef,
      conversationRuntimeCacheRef: { current: new Map() },
      ensureGatewayBridgeConversationReadyRef,
      sendActionRef,
      queueGatewayBridgeEventForRequest() {},
      shouldQueueGatewayChatRequest() {
        return false;
      },
      async enqueueGatewayChatRequest() {
        return false;
      },
      isConversationRunning() {
        return false;
      },
      getConversationAbortController() {
        return { abort: () => firstAbortCalls++ };
      },
      requestConversationStop(conversationId) {
        stopRequestIds.push(conversationId);
      },
      requestActiveConversationStop(conversationId, options) {
        activeStopCalls.push({ conversationId, options });
        return true;
      },
      consumeConversationStop(conversationId) {
        consumedStopIds.push(conversationId);
        return true;
      },
    };

    hookHarness.render(() => useGatewayBridgeListeners(baseParams));

    assert.ok(
      invokeCalls.some((call) => call.command === "gateway_chat_claim_next"),
      "the inbox must drain before async listen registration resolves",
    );
    assert.equal(registrations.length, 6);
    assert.ok(
      registrations.some((entry) => entry.name === "gateway:composer-action-requested"),
      "the composer action listener must be registered",
    );
    assert.ok(registrations.some((entry) => entry.name === "gateway:chat-runtime-wake"));
    assert.ok(
      registrations.some((entry) => entry.name === "gateway:clarify-turn-requested"),
      "the clarify turn listener must be registered",
    );

    for (const registration of registrations) {
      registration.resolve(() => {
        registration.disposed = true;
      });
    }
    await flushPromises();

    const runtimeHeartbeatsBeforeRender = invokeCalls.filter(
      (call) => call.command === "gateway_chat_runtime_heartbeat",
    );
    assert.ok(runtimeHeartbeatsBeforeRender.length > 0);
    const workerId = runtimeHeartbeatsBeforeRender[0].payload.worker_id;

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        ...baseParams,
        shouldQueueGatewayChatRequest() {
          return true;
        },
        async enqueueGatewayChatRequest() {
          return true;
        },
        getConversationAbortController() {
          return { abort: () => secondAbortCalls++ };
        },
      }),
    );

    assert.equal(registrations.length, 6, "callback identity changes must not remount listeners");
    assert.ok(registrations.every((entry) => entry.disposed === false));

    const claimsBeforeWake = invokeCalls.filter(
      (call) => call.command === "gateway_chat_claim_next",
    ).length;
    registrations.find((entry) => entry.name === "gateway:chat-runtime-wake").handler({
      payload: { reason: "prepare" },
    });
    await flushPromises();
    const claimsAfterWake = invokeCalls.filter(
      (call) => call.command === "gateway_chat_claim_next",
    ).length;
    assert.ok(claimsAfterWake > claimsBeforeWake);

    registrations.find((entry) => entry.name === "gateway:chat-cancel").handler({
      payload: { requestId: "request-1", conversationId: "conversation-1" },
    });
    assert.equal(firstAbortCalls, 0);
    assert.equal(secondAbortCalls, 1, "listeners must dispatch through the latest callback refs");
    assert.deepEqual(stopRequestIds, ["conversation-1"]);
    assert.deepEqual(activeStopCalls, [
      { conversationId: "conversation-1", options: { force: false } },
    ]);
    assert.deepEqual(
      consumedStopIds,
      [],
      "a cancel with a live controller must keep the stop intent for the run to consume",
    );

    // A cancel that finds nothing to stop must consume its own stop intent —
    // a leftover flag would silently swallow the conversation's next send.
    hookHarness.render(() =>
      useGatewayBridgeListeners({
        ...baseParams,
        getConversationAbortController() {
          return null;
        },
        requestActiveConversationStop(conversationId, options) {
          activeStopCalls.push({ conversationId, options });
          return false;
        },
      }),
    );
    registrations.find((entry) => entry.name === "gateway:chat-cancel").handler({
      payload: { requestId: "request-9", conversationId: "conversation-9" },
    });
    assert.deepEqual(stopRequestIds, ["conversation-1", "conversation-9"]);
    assert.deepEqual(consumedStopIds, ["conversation-9"]);

    const runtimeWorkerIds = invokeCalls
      .filter((call) => call.command === "gateway_chat_runtime_heartbeat")
      .map((call) => call.payload.worker_id);
    assert.ok(runtimeWorkerIds.every((candidate) => candidate === workerId));

    hookHarness.cleanup();
    const finalHeartbeat = invokeCalls
      .filter((call) => call.command === "gateway_chat_runtime_heartbeat")
      .at(-1);
    assert.equal(finalHeartbeat.payload.worker_id, workerId);
    assert.equal(finalHeartbeat.payload.state, "suspended");
    assert.ok(registrations.every((entry) => entry.disposed === true));
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

test("gateway bridge forwards sandboxOffline on a directly claimed agent turn", async () => {
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const sendCalls = [];
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  let nextTimerId = 1;
  const timers = new Map();
  const claimed = {
    requestId: "request-sandbox-direct",
    clientRequestId: "client-sandbox-direct",
    conversationId: "conversation-sandbox-direct",
    state: "claimed",
    attempt: 1,
    leaseMs: 15_000,
    request: {
      requestId: "request-sandbox-direct",
      clientRequestId: "client-sandbox-direct",
      conversationId: "conversation-sandbox-direct",
      message:
        "compare [conversation: Earlier investigation](conversation:conversation-source)",
      referencedConversations: [
        {
          id: "conversation-source",
          title: "Earlier investigation",
          cwd: "/workspace/source",
          updatedAt: 1772000000000,
        },
      ],
      executionMode: "tools",
      workdir: "/workspace/project",
      commandSafetyMode: "sandboxOffline",
      queuePolicy: "auto",
    },
  };
  const claims = [claimed, null];

  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    ...windowEvents,
    setInterval(callback) {
      const id = nextTimerId++;
      timers.set(id, callback);
      return id;
    },
    clearInterval(id) {
      timers.delete(id);
    },
    setTimeout,
    clearTimeout,
  };
  globalThis.document = {
    ...documentEvents,
    visibilityState: "visible",
  };

  try {
    const registry = globalThis.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__;
    registry?.activeRequests?.clear();
    registry?.pendingRequestIds?.clear();
    registry?.pendingClientRequestIds?.clear();
    registry?.pendingConversationIds?.clear();

    const loader = createTsModuleLoader({
      mocks: {
        react: hookHarness.react,
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            invokeCalls.push({ command, payload });
            if (command === "gateway_chat_claim_next") {
              return claims.shift() ?? null;
            }
            return undefined;
          },
        },
        "@tauri-apps/api/event": {
          async listen() {
            return () => undefined;
          },
        },
        "../../../lib/settings": {
          normalizeChatRuntimeControls(value) {
            return value;
          },
        },
      },
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );

    hookHarness.render(() =>
      useGatewayBridgeListeners({
        currentConversationIdRef: { current: "conversation-sandbox-direct" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: {
          current: async (conversationId) => conversationId,
        },
        sendActionRef: {
          current: async (overrides) => {
            sendCalls.push(overrides);
            return true;
          },
        },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest() {
          return false;
        },
        async enqueueGatewayChatRequest() {
          return false;
        },
        isConversationRunning() {
          return false;
        },
        getConversationAbortController() {
          return null;
        },
        requestConversationStop() {
          return false;
        },
        requestActiveConversationStop() {
          return false;
        },
        consumeConversationStop() {
          return false;
        },
      }),
    );

    for (let attempt = 0; attempt < 8 && sendCalls.length === 0; attempt += 1) {
      await flushPromises();
    }

    assert.equal(sendCalls.length, 1);
    const overrides = sendCalls[0];
    assert.equal(overrides.commandSafetyModeOverride, "sandboxOffline");
    assert.equal(
      overrides.gatewayBridgeRequestOverride.commandSafetyModeOverride,
      "sandboxOffline",
    );
    assert.equal(overrides.executionModeOverride, "tools");
    assert.equal(overrides.gatewayBridgeRequestOverride.clientRequestId, "client-sandbox-direct");
    assert.equal(overrides.workdirOverride, "/workspace/project");
    assert.deepEqual(overrides.composerDraftOverride.conversationMentions, [
      {
        id: "conversation-source",
        title: "Earlier investigation",
        cwd: "/workspace/source",
        updatedAt: 1772000000000,
      },
    ]);
    assert.equal(overrides.composerDraftOverride.segments[1].type, "conversationMention");
    assert.ok(
      invokeCalls.some((call) => call.command === "gateway_chat_complete"),
      "the directly claimed request should complete after the sandbox mode is forwarded",
    );
    hookHarness.cleanup();
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

async function runGatewayListenerScenario({ claims, onListen, kbrainMocks = {} }) {
  const hookHarness = createHookHarness();
  const invokeCalls = [];
  const sendCalls = [];
  const listeners = new Map();
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  globalThis.window = {
    ...windowEvents,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
  };
  globalThis.document = { ...documentEvents, visibilityState: "visible" };
  const registry = globalThis.__LIVEAGENT_GATEWAY_BRIDGE_REQUESTS__;
  registry?.activeRequests?.clear();
  registry?.pendingRequestIds?.clear();
  registry?.pendingClientRequestIds?.clear();
  registry?.pendingConversationIds?.clear();
  try {
    const loader = createTsModuleLoader({
      mocks: {
        react: hookHarness.react,
        "@tauri-apps/api/core": {
          async invoke(command, payload) {
            invokeCalls.push({ command, payload });
            if (command === "gateway_chat_claim_next") return claims.shift() ?? null;
            return undefined;
          },
        },
        "@tauri-apps/api/event": {
          async listen(name, handler) {
            listeners.set(name, handler);
            return () => undefined;
          },
        },
        "../../../lib/settings": {
          normalizeChatRuntimeControls(value) {
            return value;
          },
        },
        ...kbrainMocks,
      },
    });
    const { useGatewayBridgeListeners } = loader.loadModule(
      "src/pages/chat/gateway/useGatewayBridgeListeners.ts",
    );
    hookHarness.render(() =>
      useGatewayBridgeListeners({
        currentConversationIdRef: { current: "conversation-1" },
        conversationRuntimeCacheRef: { current: new Map() },
        ensureGatewayBridgeConversationReadyRef: { current: async (id) => id },
        sendActionRef: {
          current: async (overrides) => {
            sendCalls.push(overrides);
            return true;
          },
        },
        queueGatewayBridgeEventForRequest() {},
        shouldQueueGatewayChatRequest: () => false,
        enqueueGatewayChatRequest: async () => false,
        isConversationRunning: () => false,
        getConversationAbortController: () => null,
        requestConversationStop: () => false,
        requestActiveConversationStop: () => false,
        consumeConversationStop: () => false,
      }),
    );
    for (let attempt = 0; attempt < 8; attempt += 1) await flushPromises();
    await onListen?.(listeners);
    for (let attempt = 0; attempt < 4; attempt += 1) await flushPromises();
    hookHarness.cleanup();
    return { invokeCalls, sendCalls };
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
}

function claimedChat(id, request) {
  return {
    requestId: id,
    clientRequestId: `client-${id}`,
    conversationId: "conversation-1",
    state: "claimed",
    attempt: 1,
    leaseMs: 15_000,
    request: {
      requestId: id,
      clientRequestId: `client-${id}`,
      conversationId: "conversation-1",
      queuePolicy: "auto",
      ...request,
    },
  };
}

test("gateway bridge forwards WebUI goal and prompt commands to sendChat", async () => {
  const { sendCalls, invokeCalls } = await runGatewayListenerScenario({
    claims: [
      claimedChat("goal-set", { message: "/goal ship it", goalAction: "set", goalText: "ship it" }),
    ],
  });
  assert.equal(sendCalls.length, 1);
  assert.deepEqual(sendCalls[0].composerCommand, { kind: "goal", action: "set", goal: "ship it" });
  assert.equal(sendCalls[0].textOverride, "/goal ship it");
  assert.ok(invokeCalls.some((call) => call.command === "gateway_chat_complete"));

  const prompt = await runGatewayListenerScenario({
    claims: [claimedChat("prompt", { message: "/review main", promptCommand: true })],
  });
  assert.deepEqual(prompt.sendCalls[0].composerCommand, { kind: "prompt" });

  const plain = await runGatewayListenerScenario({
    claims: [claimedChat("plain", { message: "hello" })],
  });
  assert.equal(plain.sendCalls[0].composerCommand, undefined);
});

test("gateway bridge rejects contradictory composer commands instead of sending raw text", async () => {
  const { sendCalls, invokeCalls } = await runGatewayListenerScenario({
    claims: [claimedChat("goal-bad", { message: "/goal", goalAction: "set", goalText: "  " })],
  });
  assert.equal(sendCalls.length, 0);
  const failed = invokeCalls.find((call) => call.command === "gateway_chat_fail");
  assert.equal(failed?.payload.error_code, "invalid_chat_command");
});

test("gateway composer action listener runs /loop create and responds once", async () => {
  const kbrainCalls = [];
  const { invokeCalls } = await runGatewayListenerScenario({
    claims: [],
    kbrainMocks: {
      "../../../lib/host": {
        isKBrainBackendEnabled: () => true,
        isTauriHost: () => true,
      },
      "../../../lib/kbrain/client": {
        createKBrainClient: () => ({
          async createLoop(sessionId, input) {
            kbrainCalls.push({ sessionId, input });
            return { id: "loop-1", ...input, enabled: true };
          },
        }),
      },
      "../../../lib/kbrain/mapping": {
        getKBrainSessionId: (conversationId) =>
          conversationId === "conversation-1" ? "kb-session-1" : undefined,
      },
      "../../../lib/kbrain/goalStore": { publishGoalState() {} },
    },
    async onListen(listeners) {
      const handler = listeners.get("gateway:composer-action-requested");
      assert.ok(handler, "composer action listener registered");
      await handler({
        payload: {
          requestId: "action-1",
          kind: "loop",
          conversationId: "conversation-1",
          action: "create",
          cron: "0 */10 * * * *",
          interval: "10m",
          prompt: "check the build",
          reasoning: "",
          loopId: "",
        },
      });
    },
  });
  assert.deepEqual(kbrainCalls, [
    {
      sessionId: "kb-session-1",
      input: { cron: "0 */10 * * * *", interval: "10m", prompt: "check the build" },
    },
  ]);
  const responds = invokeCalls.filter((call) => call.command === "gateway_composer_action_respond");
  assert.equal(responds.length, 1);
  assert.equal(responds[0].payload.input.requestId, "action-1");
  assert.equal(responds[0].payload.input.errorMessage, undefined);
  assert.equal(responds[0].payload.input.result.loops[0].id, "loop-1");
});
