import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { contextToKBrainMessages, runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");

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

function event(seq, type, payload = {}, overrides = {}) {
  return `data: ${JSON.stringify({
    version: "kbrain.agent.v1",
    seq,
    conversation_id: "backend-session-1",
    run_id: "run-1",
    type,
    created_at: "2026-09-27T00:00:00Z",
    payload,
    ...overrides,
  })}\n\n`;
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function makeFetch({ streams, calls }) {
  let streamIndex = 0;
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return json({ id: "backend-session-1", model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) {
      return json({ version: "kbrain.agent.v1", conversation_id: "backend-session-1", run_id: "run-1", accepted_seq: 1 }, 202);
    }
    if (parsed.pathname.endsWith("/events")) {
      const body = streams[Math.min(streamIndex++, streams.length - 1)]();
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (parsed.pathname.includes("/cancel")) return json({ ok: true });
    if (parsed.pathname.includes("/permissions/")) return json({ ok: true });
    throw new Error(`unexpected K-brain URL ${parsed.pathname}`);
  };
}

function stream(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

async function withHttpFixture(handler, callback) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await callback(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("context conversion preserves canonical image blocks and the turn uses only K-brain traffic", async () => {
  storage.clear();
  const messages = contextToKBrainMessages({
    systemPrompt: "system",
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", data: "abc123", mimeType: "image/png" },
        { type: "file", data: "cGRm", mimeType: "application/pdf", filename: "report.pdf" },
      ],
      timestamp: 1,
    }],
  });
  assert.deepEqual(messages[1].content, [
    { type: "text", text: "look" },
    { type: "image", image_url: "data:image/png;base64,abc123", mime_type: "image/png" },
    { type: "file", file_url: "data:application/pdf;base64,cGRm", filename: "report.pdf", mime_type: "application/pdf" },
  ]);

  const calls = [];
  const text = event(2, "assistant.text.delta", { text: "hi" });
  const done = event(3, "assistant.message.created", {
    content: [{ type: "text", text: "hi" }],
    provider: "fixture",
    model: "fixture-model",
  }) + event(4, "run.completed");
  const fetch = makeFetch({ calls, streams: [() => stream(text + done)] });
  const result = await runKBrainTurn({
    ...baseParams,
    baseUrl: "http://kbrain.test",
    clientRequestId: "stable-request-id",
    context: { messages: [] },
    prompt: "hello",
    fetch,
    onTextDelta: () => {},
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0].text, "hi");
  const runCall = calls.find(({ url }) => url.pathname.endsWith("/runs"));
  assert.ok(runCall, "the turn should post a run to K-brain");
  assert.equal(JSON.parse(runCall.init.body).client_request_id, "stable-request-id");
  assert.equal(calls.every(({ url }) => url.hostname === "kbrain.test"), true);
});

test("final assistant snapshot reconciles the streamed text across tool rounds", async () => {
  storage.clear();
  const calls = [];
  const fetch = makeFetch({ calls, streams: [() => stream(
    event(2, "assistant.text.delta", { text: "Checking. " }) +
    event(3, "tool.call", { tool_call: { id: "inspect", name: "read_file", arguments: {} } }) +
    event(4, "assistant.text.delta", { text: "All done." }) +
    event(5, "assistant.message.created", { role: "assistant", content: [{ type: "text", text: "All done." }] }) +
    event(6, "run.completed")
  )] });
  const result = await runKBrainTurn({ ...baseParams, fetch });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content.filter((part) => part.type === "text").map((part) => part.text).join(""), "Checking. All done.");
});

test("session stream accepts earlier-run subagents without terminating the current turn", async () => {
  storage.clear();
  const children = [];
  const fetch = makeFetch({ calls: [], streams: [() => stream(
    event(2, "subagent.completed", { subagent: { id: "child", parent_id: "earlier-run", status: "done", description: "Review", model, report: "Reviewed" } }, { run_id: "earlier-run" }) +
    event(3, "run.completed", {}, { run_id: "earlier-run" }) +
    event(4, "assistant.text.delta", { text: "Current reply" }) +
    event(5, "run.completed")
  )] });
  const result = await runKBrainTurn({ ...baseParams, fetch, onSubagent: (child) => children.push(child) });
  assert.equal(result.stopReason, "stop");
  assert.equal(result.content[0].text, "Current reply");
  assert.equal(children[0].parent_id, "earlier-run");
});

test("canonical context preserves multiple images and image-only empty-text prompts", () => {
  const content = contextToKBrainMessages({
    messages: [{
      role: "user",
      content: [
        { type: "image", data: "one", mimeType: "image/png" },
        { type: "image", data: "data:image/jpeg;base64,two", mimeType: "image/jpeg" },
      ],
      timestamp: 1,
    }],
  })[0].content;
  assert.deepEqual(content, [
    { type: "image", image_url: "data:image/png;base64,one", mime_type: "image/png" },
    { type: "image", image_url: "data:image/jpeg;base64,two", mime_type: "image/jpeg" },
  ]);
});

test("real HTTP turn sends multimodal content on each round without duplicating bootstrap user history", async () => {
  storage.clear();
  const requests = [];
  let runCount = 0;
  await withHttpFixture((request, response) => {
    const body = [];
    request.on("data", (chunk) => body.push(chunk));
    request.on("end", () => {
      const url = new URL(request.url, "http://127.0.0.1");
      const parsed = body.length ? JSON.parse(Buffer.concat(body).toString()) : undefined;
      requests.push({ method: request.method, url, body: parsed });
      response.setHeader("content-type", url.pathname.endsWith("/events") ? "text/event-stream" : "application/json");
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        response.end(JSON.stringify({ id: "backend-http", model, messages: [], last_seq: 0 }));
      } else if (request.method === "POST" && url.pathname.endsWith("/runs")) {
        runCount += 1;
        response.statusCode = 202;
        response.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "backend-http", run_id: `http-run-${runCount}`, accepted_seq: 1 }));
      } else if (url.pathname.endsWith("/events")) {
        const runId = `http-run-${runCount}`;
        response.end(event(2, "assistant.message.created", { content: [{ type: "text", text: `round-${runCount}` }] }, { conversation_id: "backend-http", run_id: runId }) + event(3, "run.completed", {}, { conversation_id: "backend-http", run_id: runId }));
      } else {
        response.end(JSON.stringify({ ok: true }));
      }
    });
  }, async (baseUrl) => {
    const image = { type: "image", data: "raw-base64", mimeType: "image/jpeg" };
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "describe" }, image], timestamp: 1 }] };
    const first = await runKBrainTurn({ ...baseParams, baseUrl, context, prompt: "describe", content: undefined });
    const second = await runKBrainTurn({ ...baseParams, baseUrl, context: { messages: [...context.messages, first] }, prompt: "describe", content: [{ type: "image", image_url: "data:image/jpeg;base64,raw-base64", mime_type: "image/jpeg" }] });
    assert.equal(first.stopReason, "stop");
    assert.equal(second.stopReason, "stop");
    const creates = requests.filter((request) => request.url.pathname === "/v1/sessions");
    assert.equal(creates.length, 1);
    assert.deepEqual(creates[0].body.messages, []);
    const runs = requests.filter((request) => request.url.pathname.endsWith("/runs"));
    assert.equal(runs.length, 2);
    assert.deepEqual(runs.map((request) => request.body.content), [
      [{ type: "image", image_url: "data:image/jpeg;base64,raw-base64", mime_type: "image/jpeg" }],
      [{ type: "image", image_url: "data:image/jpeg;base64,raw-base64", mime_type: "image/jpeg" }],
    ]);
    assert.notEqual(runs[0].body.client_request_id, runs[1].body.client_request_id);
  });
});

test("a stale mapped session recovers only from a 404", async () => {
  storage.clear();
  let creates = 0;
  let starts = 0;
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push({ url: parsed, init });
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      creates += 1;
      return json({ id: `backend-recovered-${creates}`, model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) {
      starts += 1;
      if (starts === 1) return json({ error: "gone" }, 404);
      return json({ version: "kbrain.agent.v1", conversation_id: "backend-recovered-2", run_id: "run-recovered", accepted_seq: 1 }, 202);
    }
    if (parsed.pathname.endsWith("/events")) {
      return new Response(stream(event(2, "assistant.message.created", { content: [{ type: "text", text: "recovered" }] }, { conversation_id: "backend-recovered-2", run_id: "run-recovered" }) + event(3, "run.completed", {}, { conversation_id: "backend-recovered-2", run_id: "run-recovered" })), { headers: { "content-type": "text/event-stream" } });
    }
    throw new Error(`unexpected URL ${parsed.pathname}`);
  };
  const result = await runKBrainTurn({ ...baseParams, fetch, baseUrl: "http://kbrain-recovery.test" });
  assert.equal(result.stopReason, "stop");
  assert.equal(creates, 2);
  assert.equal(starts, 2);
});

test("turn reconnects with after_seq and treats EOF without terminal as an error", async () => {
  storage.clear();
  const calls = [];
  const fetch = makeFetch({
    calls,
    streams: [
      () => stream(event(2, "assistant.text.delta", { text: "partial" })),
      () => stream(event(3, "run.completed")),
    ],
  });
  const result = await runKBrainTurn({ ...baseParams, fetch, baseUrl: "http://kbrain.test" });
  assert.equal(result.stopReason, "stop");
  assert.deepEqual(calls.filter(({ url }) => url.pathname.endsWith("/events")).map(({ url }) => url.searchParams.get("after_seq")), ["1", "2"]);

  const eofCalls = [];
  const eofFetch = makeFetch({ calls: eofCalls, streams: [() => stream(event(2, "assistant.text.delta", { text: "partial" })), () => stream("")] });
  const failed = await runKBrainTurn({ ...baseParams, fetch: eofFetch, baseUrl: "http://kbrain.test" });
  assert.equal(failed.stopReason, "error");
  assert.match(failed.errorMessage, /terminal|event stream/i);
  assert.equal(eofCalls.some(({ url }) => url.pathname.includes("/cancel")), true);
});

test("only explicitly edit-pending users resume a persisted turn; ordinary repeated text is appended", async () => {
  const { setKBrainSessionId } = loader.loadModule("src/lib/kbrain/mapping.ts");
  for (const pending of [true, false]) {
    storage.clear();
    setKBrainSessionId(baseParams.conversationId, "backend-session-1", "http://kbrain.test");
    const calls = [];
    const fetch = makeFetch({ calls, streams: [() => stream(event(2, "assistant.message.created", { id: "assistant-stable", role: "assistant", content: [{ type: "text", text: "done" }] }) + event(3, "run.completed"))] });
    const result = await runKBrainTurn({ ...baseParams, baseUrl: "http://kbrain.test", fetch, context: { messages: [{ id: "persisted-user", role: "user", content: "hello", timestamp: 1, ...(pending ? { kbrainEditPending: true } : {}) }] } });
    const body = JSON.parse(calls.find(({ url }) => url.pathname.endsWith("/runs")).init.body);
    assert.equal(body.resume_message_id, pending ? "persisted-user" : undefined);
    assert.equal(result.id, "assistant-stable");
    assert.equal(result.responseId, "assistant-stable");
    assert.equal(calls.some(({ url, init }) => url.pathname === "/v1/sessions" && init.method === "POST"), false);
  }
});

test("client tool requests run the desktop executor once and post the result back", async () => {
  storage.clear();
  const calls = [];
  const executed = [];
  let posted;
  const postedOnce = new Promise((resolve) => { posted = resolve; });
  const request = { call_id: "call-1", tool_call_id: "browser-call", run_id: "run-1", tool: "Browser", arguments: { action: "navigate", url: "https://example.com" }, deadline_at: Date.now() + 60_000 };
  const base = makeFetch({ calls, streams: [() => new ReadableStream({
    async start(controller) {
      const encode = (text) => controller.enqueue(new TextEncoder().encode(text));
      // The replayed request (same call_id) must not run the action a second time.
      encode(event(2, "client_tool.requested", request) + event(3, "client_tool.requested", request));
      await postedOnce;
      encode(event(4, "client_tool.resolved", { call_id: "call-1", run_id: "run-1", tool: "Browser", text: "Page: Example Domain" }) + event(5, "assistant.text.delta", { text: "Opened it." }) + event(6, "run.completed"));
      controller.close();
    },
  })] });
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.includes("/client-tools/")) {
      calls.push({ url: parsed, init });
      posted();
      return json({ ok: true });
    }
    return base(url, init);
  };
  const result = await runKBrainTurn({
    ...baseParams,
    fetch,
    options: { mode: "agent", client_tools: [{ name: "Browser", description: "Drive the browser.", parameters: { type: "object" } }] },
    onClientToolRequest: async (incoming) => {
      executed.push(incoming);
      return { text: "Page: Example Domain", images: [{ mime_type: "image/png", data: "AA==" }] };
    },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].arguments, request.arguments);
  const runCall = calls.find((call) => call.url.pathname.endsWith("/runs"));
  assert.equal(JSON.parse(runCall.init.body).options.client_tools[0].name, "Browser");
  const post = calls.find((call) => call.url.pathname.includes("/client-tools/"));
  assert.equal(post.url.pathname, "/v1/sessions/backend-session-1/client-tools/call-1");
  assert.deepEqual(JSON.parse(post.init.body), {
    conversation_id: "backend-session-1",
    run_id: "run-1",
    text: "Page: Example Domain",
    images: [{ mime_type: "image/png", data: "AA==" }],
  });
});
