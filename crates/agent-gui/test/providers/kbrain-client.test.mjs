import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("K-brain client loads through the generic TypeScript test helper", async () => {
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async (url) => {
      assert.equal(new URL(url).pathname, "/v1/models");
      return jsonResponse({
        version: "kbrain.agent.v1",
        models: [{ provider: "opaque-provider", model: "model-v1" }],
      });
    },
  });

  assert.deepEqual(await client.listModels(), [
    { provider: "opaque-provider", model: "model-v1" },
  ]);
});

test("K-brain provider discovery disables WebView caching for shared proxy paths", async () => {
  let call;
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async (url, init = {}) => {
      call = { url: String(url), init };
      return jsonResponse({ version: "kbrain.agent.v1", provider: "p", models: [] });
    },
  });
  await client.discoverProviderModels("provider-a", {
    type: "codex",
    baseUrl: "https://first.example/v1",
    apiKey: "key-a",
  });
  assert.equal(new URL(call.url).pathname, "/v1/settings/providers/provider-a/models");
  assert.equal(call.init.cache, "no-store");
  assert.equal(call.init.headers?.["Cache-Control"], undefined);
});

test("K-brain client sends auxiliary text generation through the versioned backend contract", async () => {
  const calls = [];
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    token: "backend-token",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({
        version: "kbrain.agent.v1",
        text: "generated",
        model: { provider: "opaque-provider", model: "model-v1" },
      });
    },
  });
  const result = await client.generateText({
    model: { provider: "opaque-provider", model: "model-v1" },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    output: "text",
  });
  assert.equal(result.text, "generated");
  assert.equal(new URL(calls[0].url).pathname, "/v1/text/generate");
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer backend-token");
  assert.deepEqual(JSON.parse(calls[0].init.body).model, {
    provider: "opaque-provider",
    model: "model-v1",
  });
});

test("K-brain client uses the canonical session, run, permission, and SSE contract", async () => {
  const calls = [];
  const stream = new ReadableStream({
    start(controller) {
      const event = (seq, type, payload) =>
        `id: ${seq}\ndata: ${JSON.stringify({
          version: "kbrain.agent.v1",
          seq,
          conversation_id: "session-1",
          run_id: "run-1",
          type,
          created_at: "2026-09-27T00:00:00Z",
          payload,
        })}\n\n`;
      controller.enqueue(
        new TextEncoder().encode(
          event(2, "assistant.text.delta", { text: "hi" }),
        ),
      );
      controller.enqueue(
        new TextEncoder().encode(
          event(3, "run.completed", { state: "completed" }),
        ),
      );
      controller.close();
    },
  });
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/v1/sessions")) {
      if (init.method === "POST")
        return jsonResponse({
          id: "session-1",
          model: { provider: "fixture", model: "m" },
          messages: [],
          last_seq: 0,
        });
      return jsonResponse({ sessions: [] });
    }
    if (String(url).endsWith("/v1/sessions/session-1"))
      return jsonResponse({
        id: "session-1",
        model: { provider: "fixture", model: "m2" },
        messages: [],
        last_seq: 0,
      });
    if (String(url).endsWith("/runs"))
      return jsonResponse(
        {
          version: "kbrain.agent.v1",
          conversation_id: "session-1",
          run_id: "run-1",
          accepted_seq: 1,
        },
        202,
      );
    if (String(url).includes("/permissions/"))
      return jsonResponse({ ok: true });
    if (String(url).includes("/events"))
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    throw new Error(`unexpected URL ${String(url)}`);
  };
  const client = createKBrainClient({
    baseUrl: "http://127.0.0.1:47321",
    token: "secret",
    fetch: fetchImpl,
  });
  const created = await client.createSession({
    model: { provider: "fixture", model: "m" },
    messages: [],
  });
  assert.equal(created.id, "session-1");
  const updated = await client.updateSession("session-1", {
    model: { provider: "fixture", model: "m2" },
  });
  assert.equal(updated.id, "session-1");
  const updateCall = calls.find(
    ({ url, init }) =>
      url.endsWith("/v1/sessions/session-1") && init.method === "PATCH",
  );
  assert.deepEqual(JSON.parse(updateCall.init.body), {
    model: { provider: "fixture", model: "m2" },
  });
  const accepted = await client.startRun({
    conversation_id: "session-1",
    client_request_id: "req-1",
    prompt: "hello",
  });
  assert.equal(accepted.run_id, "run-1");
  const events = [];
  await client.subscribe("session-1", 1, {
    onEvent: (event) => events.push(event),
  });
  await client.resolvePermission("session-1", "p-1", "allow_once", "run-1");
  assert.deepEqual(
    events.map((event) => event.type),
    ["assistant.text.delta", "run.completed"],
  );
  assert.equal(
    calls.every(({ url }) => url.startsWith("http://127.0.0.1:47321/v1/")),
    true,
  );
  assert.equal(
    calls.some(({ url }) => /google|openai|anthropic/.test(url)),
    false,
  );
  const runCall = calls.find(({ url }) => url.endsWith("/runs"));
  assert.equal(JSON.parse(runCall.init.body).model, undefined);
  assert.equal(new Headers(runCall.init.headers).get("Authorization"), "Bearer secret");
});

test("K-brain client rejects malformed event sequences and incomplete SSE records", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ version: "kbrain.agent.v1", seq: 2, conversation_id: "s", run_id: "r", type: "run.completed", created_at: "2026-09-27T00:00:00Z" })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  const client = createKBrainClient({
    baseUrl: "http://kbrain.test",
    fetch: async () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  await assert.rejects(
    () => client.subscribe("s", 0, { onEvent() {} }),
    /Malformed K-brain event sequence/,
  );

  const incomplete = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ version: "kbrain.agent.v1", seq: 1, conversation_id: "s", run_id: "r", type: "run.completed", created_at: "2026-09-27T00:00:00Z" })}`,
        ),
      );
      controller.close();
    },
  });
  const incompleteClient = createKBrainClient({
    baseUrl: "http://kbrain.test",
    fetch: async () =>
      new Response(incomplete, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  await assert.rejects(
    () => incompleteClient.subscribe("s", 0, { onEvent() {} }),
    /incomplete event/,
  );
});

test("K-brain client validates run acceptance before opening a stream", async () => {
  for (const override of [
    { version: "v0" },
    { conversation_id: "other" },
    { run_id: "" },
    { accepted_seq: 0 },
    { accepted_seq: 1.5 },
  ]) {
    const client = createKBrainClient({
      baseUrl: "http://kbrain.test",
      fetch: async () =>
        jsonResponse({
          version: "kbrain.agent.v1",
          conversation_id: "s",
          run_id: "r",
          accepted_seq: 1,
          ...override,
        }),
    });
    await assert.rejects(
      () =>
        client.startRun({
          conversation_id: "s",
          client_request_id: "request",
          prompt: "hello",
        }),
      /protocol|acceptance/,
    );
  }
});

test("K-brain client accepts the backend compaction run contract", async () => {
  const calls = [];
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse(
        {
          version: "kbrain.agent.v1",
          conversation_id: "session-1",
          run_id: "compact-1",
          accepted_seq: 7,
          status: "accepted",
        },
        202,
      );
    },
  });
  const accepted = await client.compactSession("session-1", {
    client_request_id: "compact-request-1",
    expected_revision: "revision-1",
  });
  assert.equal(accepted.run_id, "compact-1");
  assert.equal(
    new URL(calls[0].url).pathname,
    "/v1/sessions/session-1/compact",
  );
  assert.equal(calls[0].init.method, "POST");
});

test("K-brain client sends remote cancellation to the backend run", async () => {
  const calls = [];
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    token: "secret",
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return jsonResponse({ ok: true });
    },
  });
  await client.cancelRun("session/id", "run/id");
  assert.equal(
    new URL(calls[0].url).pathname,
    "/v1/sessions/session%2Fid/runs/run%2Fid/cancel",
  );
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    conversation_id: "session/id",
    run_id: "run/id",
  });
  assert.equal(new Headers(calls[0].init.headers).get("Authorization"), "Bearer secret");
});

test("K-brain client surfaces a backend failure before remote run acceptance", async () => {
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async () => jsonResponse({ error: "backend unavailable" }, 503),
  });
  await assert.rejects(
    () =>
      client.startRun({
        conversation_id: "session",
        client_request_id: "request",
        prompt: "hello",
      }),
    /backend unavailable/,
  );
});

test("K-brain client rejects an incompatible protocol version", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ version: "v0", seq: 1, conversation_id: "s", run_id: "r", type: "run.completed", created_at: "2026-09-27T00:00:00Z" })}\n\n`,
        ),
      );
      controller.close();
    },
  });
  const client = createKBrainClient({
    baseUrl: "http://kbrain.test",
    fetch: async () =>
      new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      }),
  });
  await assert.rejects(
    () => client.subscribe("s", 0, { onEvent() {} }),
    /Unsupported K-brain protocol/,
  );
});

test("history client sends encoded canonical paging, mutation, and public sharing contracts", async () => {
  const calls = [];
  const client = createKBrainClient({
    baseUrl: "https://history.test/",
    fetch: async (url, init = {}) => {
      calls.push({ url: new URL(url), init });
      if (new URL(url).pathname === "/v1/sessions")
        return jsonResponse({
          sessions: [],
          total_count: 42,
          version: "kbrain.agent.v1",
        });
      return jsonResponse({ ok: true });
    },
  });
  const page = await client.listSessions({
    page: 2,
    pageSize: 25,
    cwd: "/a b",
    cwdEmpty: false,
    shared: true,
  });
  assert.equal(page.total_count, 42);
  assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), {
    page: "2",
    page_size: "25",
    cwd: "/a b",
    cwd_empty: "false",
    shared: "true",
  });
  await client.getHistory("id/slash", {
    maxMessages: 10,
    beforeOffset: 20,
    expectedRevision: "rev:a",
    includeActive: false,
  });
  assert.equal(calls.at(-1).url.pathname, "/v1/sessions/id%2Fslash/history");
  assert.deepEqual(Object.fromEntries(calls.at(-1).url.searchParams), {
    max_messages: "10",
    before_offset: "20",
    expected_revision: "rev:a",
    include_active: "false",
  });
  await client.resolveShareToken("a/b");
  assert.equal(calls.at(-1).url.pathname, "/v1/shares/a%2Fb");
  await client.deleteSession("id/slash");
  assert.equal(calls.at(-1).init.method, "DELETE");
});

test("history import validates checkpoint statuses, identities, and partial reasons", async () => {
  const valid = { source_id: "legacy", backend_id: "legacy", status: "imported", checkpoint: "available", fingerprint: "sha256" };
  for (const checkpoint of ["available", "partial", "not_found", "unresolved"]) {
    const client = createKBrainClient({ fetch: async () => jsonResponse({ ...valid, checkpoint, checkpoint_reason: "detail" }) });
    assert.equal((await client.importLegacyHistory({ source_id: "legacy" })).checkpoint, checkpoint);
  }
  for (const invalid of [null, {}, { ...valid, checkpoint: "complete" }, { ...valid, source_id: "" }, { ...valid, fingerprint: "" }, { ...valid, checkpoint_reason: 3 }]) {
    const client = createKBrainClient({ fetch: async () => jsonResponse(invalid) });
    await assert.rejects(() => client.importLegacyHistory({ source_id: "legacy" }), /Malformed K-brain history import response/);
  }
});

test("K-brain model catalog request only sends CORS-allowed headers", async () => {
  let call;
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    token: "secret",
    fetch: async (url, init = {}) => {
      call = { url: String(url), init };
      return jsonResponse({ models: [] });
    },
  });
  await client.listModels();
  assert.equal(call.init.cache, "no-store");
  const allowed = new Set(["authorization", "content-type", "accept"]);
  for (const name of new Headers(call.init.headers).keys()) {
    assert.ok(allowed.has(name.toLowerCase()), `header ${name} is outside the K-brain CORS allow-list`);
  }
});

test("Stop during lost-ACK lookup does not abort recovery or resubmit the run", async () => {
  const controller = new AbortController();
  const calls = [];
  const accepted = { version: "kbrain.agent.v1", conversation_id: "session-1", run_id: "run-1", accepted_seq: 1 };
  const client = createKBrainClient({
    baseUrl: "https://kbrain.test",
    fetch: async (url, init = {}) => {
      calls.push(init.method ?? "GET");
      if (init.method === "POST") throw new TypeError("lost response");
      controller.abort();
      assert.equal(init.signal.aborted, false);
      assert.notEqual(init.signal, controller.signal);
      return jsonResponse(accepted);
    },
  });
  assert.deepEqual(await client.startRun({ conversation_id: "session-1", client_request_id: "stable", prompt: "hello" }, controller.signal), accepted);
  assert.deepEqual(calls, ["POST", "GET"]);
});

test("an already stopped run makes no HTTP requests", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = createKBrainClient({ baseUrl: "https://kbrain.test", fetch: async () => assert.fail("unexpected request") });
  await assert.rejects(client.startRun({ conversation_id: "session-1", client_request_id: "stable", prompt: "hello" }, controller.signal), { name: "AbortError" });
});
