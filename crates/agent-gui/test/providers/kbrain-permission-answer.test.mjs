import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// LA-2a: the K-brain turn reads suggestion/shell from permission.requested, posts the
// remember scope and a denial reason, and reports permission.auto_resolved.

const loader = createTsModuleLoader();
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");

const model = { provider: "fixture", model: "fixture-model" };
const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
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
    created_at: "2026-11-01T00:00:00Z",
    payload,
  })}\n\n`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

// The event stream stays open until the permission answer is posted, as K-brain's
// does while the tool waits.
function makeFetch(events) {
  const posts = [];
  let answered;
  const answeredPromise = new Promise((resolve) => {
    answered = resolve;
  });
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return json({ id: "backend-session-1", model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) {
      return json({ version: "kbrain.agent.v1", conversation_id: "backend-session-1", run_id: "run-1", accepted_seq: 1 }, 202);
    }
    if (parsed.pathname.endsWith("/events")) {
      const body = new ReadableStream({
        async start(controller) {
          const encode = (text) => controller.enqueue(new TextEncoder().encode(text));
          encode(events.join(""));
          if (events.some((text) => text.includes('"permission.requested"'))) await answeredPromise;
          encode(event(99, "run.completed"));
          controller.close();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (parsed.pathname.includes("/permissions/")) {
      posts.push({ path: parsed.pathname, body: JSON.parse(init.body) });
      answered();
      return json({ ok: true });
    }
    if (parsed.pathname.includes("/cancel")) return json({ ok: true });
    throw new Error(`unexpected K-brain URL ${parsed.pathname}`);
  };
  return { fetch, posts };
}

const requested = (extra = {}) =>
  event(2, "permission.requested", {
    permission_id: "perm-1",
    tool: "Bash",
    command: "npm test && echo done",
    rule: "npm test",
    shell: "pwsh",
    tool_call_id: "call-1",
    options: [
      { id: "allow_once", kind: "allow_once" },
      { id: "allow_always", label: "Allow and remember", kind: "allow_always" },
      { id: "reject", kind: "reject_once" },
    ],
    suggestion: { rules: ["Bash(npm test:*)"], default_scope: "project" },
    ...extra,
  });

test("the request exposes shell and suggestion, and allow_always posts its scope", async () => {
  storage.clear();
  const { fetch, posts } = makeFetch([requested()]);
  const seen = [];
  await runKBrainTurn({
    ...baseParams,
    fetch,
    onPermissionRequest: async (request) => {
      seen.push(request);
      return { decision: "allow_always", scope: "project" };
    },
  });
  assert.equal(seen[0].shell, "pwsh");
  assert.deepEqual(seen[0].suggestion, { rules: ["Bash(npm test:*)"], default_scope: "project" });
  assert.deepEqual(posts[0].body.decision, { permission_id: "perm-1", decision: "allow_always", scope: "project" });
});

test("a rejection posts the reason for the model", async () => {
  storage.clear();
  const { fetch, posts } = makeFetch([requested()]);
  await runKBrainTurn({
    ...baseParams,
    fetch,
    onPermissionRequest: async () => ({ decision: "reject", reason: "change utils.ts instead" }),
  });
  assert.deepEqual(posts[0].body.decision, { permission_id: "perm-1", decision: "reject", reason: "change utils.ts instead" });
});

test("a plain string answer still posts only the decision", async () => {
  storage.clear();
  const { fetch, posts } = makeFetch([requested({ suggestion: undefined })]);
  await runKBrainTurn({ ...baseParams, fetch, onPermissionRequest: async () => "allow_always" });
  assert.deepEqual(posts[0].body.decision, { permission_id: "perm-1", decision: "allow_always" });
});

test("scope and reason only travel with the decision they belong to", async () => {
  storage.clear();
  const { fetch, posts } = makeFetch([requested()]);
  await runKBrainTurn({
    ...baseParams,
    fetch,
    onPermissionRequest: async () => ({ decision: "allow_once", scope: "user", reason: "ignored" }),
  });
  assert.deepEqual(posts[0].body.decision, { permission_id: "perm-1", decision: "allow_once" });
});

test("permission.auto_resolved reaches the turn callback", async () => {
  storage.clear();
  const { fetch } = makeFetch([
    event(2, "tool.call", { tool_call: { id: "call-2", name: "Bash", arguments: { command: "git status" } } }),
    event(3, "permission.auto_resolved", { tool_call_id: "call-2", tool: "Bash", command: "git status", source: "read_only" }),
    event(4, "permission.auto_resolved", { tool_call_id: "call-3", tool: "Bash", command: "npm test", source: "rule", rule: "Bash(npm test:*)", scope: "project" }),
    event(5, "permission.auto_resolved", { tool_call_id: "", tool: "Bash", source: "rule" }),
  ]);
  const resolved = [];
  await runKBrainTurn({ ...baseParams, fetch, onPermissionAutoResolved: (value) => resolved.push(value) });
  assert.deepEqual(resolved, [
    { toolCallId: "call-2", source: "read_only" },
    { toolCallId: "call-3", source: "rule", rule: "Bash(npm test:*)", scope: "project" },
  ]);
});
