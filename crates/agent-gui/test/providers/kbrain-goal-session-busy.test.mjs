import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");

const model = { provider: "fixture", model: "fixture-model" };
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

function event(seq, type, payload = {}) {
  return `data: ${JSON.stringify({
    version: "kbrain.agent.v1",
    seq,
    conversation_id: "backend-session-1",
    run_id: "run-1",
    type,
    created_at: "2026-10-20T00:00:00Z",
    payload,
  })}\n\n`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// K-brain internal/backend/goal.go（origin/main 1f27ade）postGoal：replayRunLocked 之后、
// 任何目标状态改动和 startCanonicalRunWith 之前，activeLocked() 为真即返回
// 409 errSessionBusy。被拒的请求没有登记 client_request_id，也没改目标，和普通 /runs
// 的忙拒绝一样可以原样重试。排队的 WebUI/桌面轮次可以带 goal set/resume 指令
// （useChatTurnQueue.enqueueGatewayChatRequest 的 composerCommand）。
function goalBusyFetch({ posts, busyCount }) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return json({ id: "backend-session-1", model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/goal") && init.method === "POST") {
      posts.push(JSON.parse(String(init.body)).run.client_request_id);
      if (posts.length <= busyCount) {
        return json({ version: "kbrain.agent.v1", error: "session already has a running turn" }, 409);
      }
      return json({
        version: "kbrain.agent.v1",
        conversation_id: "backend-session-1",
        goal: "ship",
        status: "active",
        round: 1,
        max_rounds: 5,
        run: {
          version: "kbrain.agent.v1",
          conversation_id: "backend-session-1",
          run_id: "run-1",
          accepted_seq: 1,
        },
      });
    }
    if (parsed.pathname.endsWith("/events")) {
      return new Response(
        event(2, "assistant.message.created", { content: [{ type: "text", text: "ok" }] }) +
          event(3, "run.completed"),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (parsed.pathname.includes("/cancel")) return json({ ok: true });
    throw new Error(`unexpected K-brain URL ${parsed.pathname}`);
  };
}

test("a queued /goal turn sent right after run-now waits out a busy session like a plain run", async () => {
  storage.clear();
  const posts = [];
  const statuses = [];
  const result = await runKBrainTurn({
    conversationId: "conversation-1",
    sessionId: "host-session-1",
    cwd: "/tmp/workspace",
    model,
    prompt: "/goal ship",
    goal: { action: "set", goal: "ship" },
    clientRequestId: "queued-goal-1",
    context: { messages: [{ role: "user", content: "/goal ship", timestamp: 1 }] },
    signal: new AbortController().signal,
    fetch: goalBusyFetch({ posts, busyCount: 1 }),
    onStatus: (status) => statuses.push(status),
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall() {},
    onToolResult() {},
  });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(posts, ["queued-goal-1", "queued-goal-1"], "the same request id is retried");
  assert.ok(statuses.some((status) => String(status).includes('"waiting_session"')));
});
