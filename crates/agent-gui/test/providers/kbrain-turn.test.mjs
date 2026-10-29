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

test("backend computer screenshots survive live tool result events", async () => {
  storage.clear();
  const results = [];
  const image = "data:image/png;base64,aW1hZ2U=";
  const fetch = makeFetch({ calls: [], streams: [() => stream(
    event(2, "tool.call", { tool_call: { id: "cua", name: "computer_exec", arguments: { action: "call", tool: "get_window_state" } } }) +
    event(3, "tool.result", { tool_result: { id: "cua", name: "computer_exec", output: "observed", content: [{ type: "image", image_url: image, mime_type: "image/png" }] } }) +
    event(4, "run.completed"),
  )] });
  await runKBrainTurn({ ...baseParams, fetch, onToolResult: (_call, result) => results.push(result) });
  assert.equal(results[0].content[1].data, image);
  assert.equal(results[0].content[1].mimeType, "image/png");
});

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

test("session and run bodies preserve provider identity and explicit reasoning off", async () => {
  storage.clear();
  const selected = { provider: "custom-relay-id", model: "claude-opus-5-5" };
  const calls = [];
  const fetch = makeFetch({ calls, streams: [() => stream(
    event(2, "assistant.text.delta", { text: "ok" }) + event(3, "run.completed"),
  )] });
  await runKBrainTurn({ ...baseParams, model: selected, options: { reasoning: "off" }, fetch });
  const create = JSON.parse(calls.find(({ url }) => url.pathname === "/v1/sessions").init.body);
  const run = JSON.parse(calls.find(({ url }) => url.pathname.endsWith("/runs")).init.body);
  assert.deepEqual(create.model, selected);
  assert.deepEqual(run.model, selected);
  assert.equal(run.options.reasoning, "off");
  assert.equal(run.prompt, "hello");
  assert.deepEqual(create.messages, []);
  assert.equal("thinking" in run, false);
  assert.equal("reasoning_effort" in run, false);
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

test("unexpected client tool requests are rejected once without frontend execution", async () => {
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
    options: { mode: "agent" },
    onClientToolRequest: async (incoming) => {
      executed.push(incoming);
      return { text: "Page: Example Domain", images: [{ mime_type: "image/png", data: "AA==" }] };
    },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(executed.length, 0);
  const runCall = calls.find((call) => call.url.pathname.endsWith("/runs"));
  assert.equal(JSON.parse(runCall.init.body).options.client_tools, undefined);
  const post = calls.find((call) => call.url.pathname.includes("/client-tools/"));
  assert.equal(post.url.pathname, "/v1/sessions/backend-session-1/client-tools/call-1");
  assert.deepEqual(JSON.parse(post.init.body), {
    conversation_id: "backend-session-1",
    run_id: "run-1",
    text: "Browser must execute in K-brain; LiveAgent does not execute client tools.",
    is_error: true,
  });
});

test("frontend tool registration fails before making a backend request", async () => {
  await assert.rejects(runKBrainTurn({
    ...baseParams,
    fetch: () => assert.fail("client tool registration reached backend"),
    options: { client_tools: [{ name: "Browser", description: "client tool", parameters: { type: "object" } }] },
  }), /must execute in K-brain/);
});

test("AI review warnings stay outside assistant content", async () => {
 storage.clear();
 const warnings=[];
 const reviewLoader=createTsModuleLoader({mocks:{"@liveagent/ui/components/ui/toast-manager":{toast:{warning:(...args)=>warnings.push(args)}}}});
 const {runKBrainTurn:run}=reviewLoader.loadModule("src/lib/kbrain/turn.ts");
 const text=[];
 const fetch=makeFetch({calls:[],streams:[()=>stream(
  event(2,"approval.reviewed",{tool:"Bash",phase:"action",automatic:false,report:{risk:"high",sandbox:"low",sensitive_data:"high",model_behavior:"unknown",injection:"low",reason:"Sensitive data upload requires confirmation"}})+event(3,"run.completed"))]});
 await run({...baseParams,fetch,onTextDelta:value=>text.push(value)});
 assert.equal(warnings.length,1);
 assert.match(warnings[0][1].description,/Sensitive data/);
 assert.deepEqual(text,[]);
});

test("AI review warnings use the interface language for K-brain's fixed reasons", async () => {
  storage.clear();
  const warnings = [];
  const reviewLoader = createTsModuleLoader({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { warning: (...args) => warnings.push(args) },
      },
    },
  });
  const { runKBrainTurn: run } = reviewLoader.loadModule("src/lib/kbrain/turn.ts");
  const review = (seq, reason) =>
    event(seq, "approval.reviewed", {
      tool: "Bash",
      phase: "action",
      automatic: false,
      report: {
        risk: "unknown",
        sandbox: "unknown",
        sensitive_data: "unknown",
        model_behavior: "unknown",
        injection: "unknown",
        reason,
      },
    });
  const runWith = async (locale, reason) => {
    const fetch = makeFetch({
      calls: [],
      streams: [() => stream(review(2, reason) + event(3, "run.completed"))],
    });
    await run({ ...baseParams, locale, fetch });
    return warnings.at(-1);
  };

  let [title, options] = await runWith(
    "zh-CN",
    "Earlier tool output requires human review. Reviewer unavailable; manual approval required",
  );
  assert.equal(title, "AI 审查 · Bash");
  assert.equal(options.description, "之前的工具输出需要人工复核。未配置可用的审查模型，需要人工确认。");

  [title, options] = await runWith(
    "zh-CN",
    "Sensitive data was redacted; manual approval required. Uploads a file to an unknown host",
  );
  assert.equal(options.description, "已隐去敏感信息，需要人工确认。Uploads a file to an unknown host");

  [title, options] = await runWith("en-US", "Reviewer busy; manual approval required");
  assert.equal(title, "AI review · Bash");
  assert.equal(options.description, "Reviewer busy; manual approval required.");
});

test("Stop recovers and cancels a run accepted before its HTTP acknowledgement", async () => {
  storage.clear();
  const controller = new AbortController();
  const calls = [];
  let running = false;
  await withHttpFixture((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/sessions") {
      res.end(JSON.stringify({ id: "backend-session-1", model, messages: [], last_seq: 0 }));
    } else if (req.method === "POST" && req.url.endsWith("/runs")) {
      running = true;
      // Acceptance is durable, but the POST response has not reached the caller.
      setTimeout(() => controller.abort(), 10);
    } else if (req.url.endsWith("/cancel")) {
      running = false;
      res.end(JSON.stringify({ ok: true }));
    } else if (req.method === "GET" && req.url.includes("client_request_id=stop-before-ack")) {
      res.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "backend-session-1", run_id: "run-1", accepted_seq: 1 }));
    } else {
      res.writeHead(404).end();
    }
  }, async (baseUrl) => {
    await assert.rejects(runKBrainTurn({ ...baseParams, baseUrl, fetch: globalThis.fetch, clientRequestId: "stop-before-ack", signal: controller.signal }), /aborted/i);
    assert.equal(running, false);
    assert.equal(calls.filter((call) => call === "POST /v1/sessions/backend-session-1/runs").length, 1);
    assert.ok(calls.includes("POST /v1/sessions/backend-session-1/runs/run-1/cancel"));
  });
});

test("attaching to a goal round stops early once the backend paused the goal", async () => {
  storage.clear();
  const calls = [];
  const updates = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    calls.push(parsed.pathname);
    if (parsed.pathname === "/v1/sessions" && init.method === "POST") {
      return json({ id: "backend-session-1", model, messages: [], last_seq: 0 });
    }
    if (parsed.pathname.endsWith("/runs")) return json({ error: "run acceptance not found" }, 404);
    if (parsed.pathname.endsWith("/goal")) {
      return json({ version: "kbrain.agent.v1", conversation_id: "backend-session-1", goal: "ship", status: "paused", round: 2, max_rounds: 5, reason: "start failed" });
    }
    throw new Error(`unexpected K-brain URL ${parsed.pathname}`);
  };
  const started = Date.now();
  await assert.rejects(
    runKBrainTurn({ ...baseParams, fetch, attachClientRequestId: "goal-next", onGoalUpdate: (state) => updates.push(state.status) }),
    /goal paused: start failed/,
  );
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(updates, ["paused"]);
  assert.ok(calls.filter((path) => path.endsWith("/runs")).length >= 2);
});

test("Stop waits for the backend to settle the cancelled run before the turn returns", async () => {
  storage.clear();
  const controller = new AbortController();
  const order = [];
  let cancelled = false;
  await withHttpFixture((req, res) => {
    if (req.url === "/v1/sessions") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "backend-session-1", model, messages: [], last_seq: 0 }));
    } else if (req.method === "POST" && req.url.endsWith("/runs")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "backend-session-1", run_id: "run-1", accepted_seq: 1 }));
    } else if (req.url.endsWith("/cancel")) {
      cancelled = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    } else if (req.url.includes("/events")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (!cancelled) {
        res.write(event(2, "assistant.text.delta", { text: "working" }));
        return;
      }
      // The run winds down after the cancel request; its terminal event lands later.
      setTimeout(() => {
        order.push("terminal");
        res.end(event(3, "run.cancelled"));
      }, 150);
    } else {
      res.writeHead(404).end();
    }
  }, async (baseUrl) => {
    const result = await runKBrainTurn({
      ...baseParams,
      baseUrl,
      fetch: globalThis.fetch,
      signal: controller.signal,
      onTextDelta: () => controller.abort(),
    });
    order.push("returned");
    assert.equal(result.stopReason, "aborted");
    assert.deepEqual(order, ["terminal", "returned"]);
  });
});

function busyFetch({ calls, busyCount, message = "session already has a running turn" }) {
  const base = makeFetch({ calls: [], streams: [() => stream(event(2, "assistant.message.created", { content: [{ type: "text", text: "ok" }] }) + event(3, "run.completed"))] });
  let posts = 0;
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    if (parsed.pathname.endsWith("/runs") && init.method === "POST") {
      calls.push(parsed.pathname);
      posts += 1;
      if (posts <= busyCount) return json({ error: message }, 409);
    }
    return base(url, init);
  };
}

test("a session still winding down delays the run instead of failing it", async () => {
  storage.clear();
  const calls = [];
  const statuses = [];
  const result = await runKBrainTurn({
    ...baseParams,
    fetch: busyFetch({ calls, busyCount: 2 }),
    onStatus: (status) => statuses.push(status),
  });
  assert.equal(result.stopReason, "stop");
  assert.equal(calls.length, 3);
  assert.ok(statuses.some((status) => String(status).includes('"waiting_session"')));
});

test("Stop while waiting for a busy session aborts without starting a run", async () => {
  storage.clear();
  const calls = [];
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 400);
  await assert.rejects(
    runKBrainTurn({ ...baseParams, fetch: busyFetch({ calls, busyCount: Number.POSITIVE_INFINITY }), signal: controller.signal }),
    /aborted/i,
  );
  const postsAtAbort = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(calls.length, postsAtAbort, "no run may be submitted after Stop");
});

test("other run conflicts are not retried as a busy session", async () => {
  storage.clear();
  const calls = [];
  await assert.rejects(
    runKBrainTurn({ ...baseParams, fetch: busyFetch({ calls, busyCount: 1, message: "session has queued work; submit through /queue" }) }),
    /queued work/,
  );
  assert.equal(calls.length, 1);
});
