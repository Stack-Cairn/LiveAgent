import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";


const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const model = { provider: "fixture", model: "fixture-model" };
const baseParams = {
  conversationId: "conversation-1",
  sessionId: "host-session-1",
  cwd: "/tmp/workspace",
  model,
  prompt: "hello",
  context: { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
  signal: new AbortController().signal,
  onTextDelta() {},
  onThinkingDelta() {},
  onToolCall() {},
  onToolResult() {},
};

function event(seq, type, payload = {}) {
  return `data: ${JSON.stringify({
    version: "kbrain.agent.v1",
    seq,
    conversation_id: "backend-session-1",
    run_id: "run-1",
    type,
    created_at: "2026-09-27T00:00:00Z",
    payload,
  })}\n\n`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFetch(body) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return json({ id: "backend-session-1", model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) {
      return json(
        {
          version: "kbrain.agent.v1",
          conversation_id: "backend-session-1",
          run_id: "run-1",
          accepted_seq: 1,
        },
        202,
      );
    }
    if (parsed.pathname.endsWith("/events")) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (parsed.pathname.includes("/cancel")) return json({ ok: true });
    throw new Error(`unexpected K-brain URL ${parsed.pathname}`);
  };
}

// K-brain internal/backend/server.go publishes, for each failing backend hook:
//   hook.warning {hookName, hookType, event, message}
// on the run's own event stream; the run itself carries on.
async function runWith(events, locale = "en-US") {
  storage.clear();
  const warnings = [];
  const text = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { warning: (...args) => warnings.push(args) },
      },
    },
  });
  const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
  const body = events.map((entry, index) => event(index + 2, ...entry)).join("");
  const result = await runKBrainTurn({
    ...baseParams,
    locale,
    onTextDelta: (delta) => text.push(delta),
    fetch: makeFetch(body),
  });
  return { warnings, text, result };
}

const failingHook = {
  hookName: "lint-on-tool",
  hookType: "command",
  event: "tool_execution_end",
  message: "command failed: exit status 2",
};

test("a failing hook raises a warning toast naming the hook, event and error", async () => {
  const { warnings, text, result } = await runWith([
    ["hook.warning", failingHook],
    ["assistant.text.delta", { text: "done" }],
    ["run.completed"],
  ]);
  assert.equal(warnings.length, 1);
  const [title, options] = warnings[0];
  assert.equal(title, "Hook failed · lint-on-tool");
  assert.equal(options.description, "tool_execution_end: command failed: exit status 2");
  assert.equal(options.id, "hook-warning-conversation-1-run-1-lint-on-tool");
  // The warning is a side channel: it never becomes assistant text or fails the turn.
  assert.deepEqual(text, ["done"]);
  assert.equal(result.stopReason, "stop");
});

test("repeated failures of one hook share a toast id; different hooks get their own", async () => {
  const { warnings } = await runWith([
    ["hook.warning", failingHook],
    ["hook.warning", failingHook],
    ["hook.warning", { ...failingHook, hookName: "notify", hookType: "http", event: "agent_end" }],
    ["assistant.text.delta", { text: "ok" }],
    ["run.completed"],
  ]);
  const ids = warnings.map(([, options]) => options.id);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test("hook warnings follow the interface language and tolerate a sparse payload", async () => {
  const { warnings } = await runWith(
    [
      ["hook.warning", { ...failingHook, event: "turn_start" }],
      ["hook.warning", { message: "context deadline exceeded" }],
      ["hook.warning", { hookName: 7 }],
      ["assistant.text.delta", { text: "ok" }],
      ["run.completed"],
    ],
    "zh-CN",
  );
  assert.equal(warnings.length, 2, "a payload with neither name nor message is ignored");
  assert.equal(warnings[0][0], "Hook 执行失败 · lint-on-tool");
  assert.equal(warnings[0][1].description, "turn_start: command failed: exit status 2");
  assert.equal(warnings[1][0], "Hook 执行失败 · 未命名 Hook");
  assert.equal(warnings[1][1].description, "context deadline exceeded");
});
