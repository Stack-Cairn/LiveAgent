import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const connection = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
const { completeAssistantMessage, streamAssistantMessage } = loader.loadModule(
  "src/lib/providers/runtime/textOnlyRuntime.ts",
);
const model = { provider: "opaque-provider", model: "fixture-model" };
const providerBaseUrl = "https://provider.example.invalid/v1/responses";
const providerApiKey = "provider-secret-that-must-not-cross-the-boundary";
const providerHeader = "provider-custom-header-secret";
const backendToken = "fixture-backend-token";
const answer = {
  version: "kbrain.agent.v1",
  text: "backend answer",
  model,
  usage: { input_tokens: 3, output_tokens: 2 },
};

function callParams(backend, deltas, signal) {
  return {
    providerId: "codex",
    model: model.model,
    runtime: {
      ...(backend === undefined ? {} : { backend }),
      backendModelProvider: model.provider,
      baseUrl: providerBaseUrl,
      isFullUrl: true,
      apiKey: providerApiKey,
      customHeaders: [{ key: "X-Provider-Secret", value: providerHeader }],
    },
    context: {
      systemPrompt: "system instruction",
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "earlier answer" }], timestamp: 2 },
        { role: "tool", content: "private tool result", timestamp: 3 },
      ],
    },
    onTextDelta: (delta) => deltas.push(delta),
    signal,
  };
}

function assertNoProviderSecrets(value) {
  const serialized = JSON.stringify(value);
  for (const secret of [providerBaseUrl, providerApiKey, providerHeader]) {
    assert.equal(serialized.includes(secret), false, "provider routing and credentials must stay out of HTTP requests");
  }
}

function assertCanonicalRequest({ method, url, headers, body }) {
  assert.equal(method, "POST");
  assert.equal(url, "/v1/text/generate");
  assert.equal(headers.authorization, `Bearer ${backendToken}`);
  assert.equal(headers["content-type"], "application/json");
  assertNoProviderSecrets({ url, headers, body });
  assert.deepEqual(Object.keys(body).sort(), ["messages", "model", "output"]);
  assert.deepEqual(body.model, model);
  assert.equal(body.output, "text");
  assert.deepEqual(body.messages.map((message) => message.role), ["system", "user", "assistant"]);
  assert.match(body.messages[0].content[0].text, /system instruction/);
  assert.match(body.messages[0].content[0].text, /do not make any tool calls/);
  assert.deepEqual(body.messages.slice(1), [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "earlier answer" }] },
  ]);
}

async function withHttpFixture(reply, callback) {
  const requests = [];
  const calls = [];
  let requestReceived;
  const received = new Promise((resolve) => { requestReceived = resolve; });
  const server = createServer(async (request, response) => {
    try {
      let rawBody = "";
      for await (const chunk of request) rawBody += chunk;
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: JSON.parse(rawBody),
      });
      requestReceived(response);
      reply(response);
    } catch (error) {
      response.destroy(error);
    }
  });
  const originalFetch = globalThis.fetch;
  const originalConnection = connection.getKBrainRuntimeConnection();
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    connection.setKBrainRuntimeConnection({ baseUrl, token: backendToken, protocolVersion: "kbrain.agent.v1" });
    globalThis.fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = Object.fromEntries(new Headers(init.headers ?? input.headers));
      const call = { url: url.href, method: init.method, headers, body: init.body, signal: init.signal };
      calls.push(call);
      assert.equal(url.origin, baseUrl, "only the K-brain fixture origin may receive requests");
      assert.equal(url.pathname, "/v1/text/generate");
      assert.equal(url.search, "");
      assert.equal(init.method, "POST");
      assertNoProviderSecrets(call);
      return originalFetch(input, init);
    };
    await callback({ calls, requests, received });
    for (const request of requests) assertCanonicalRequest(request);
    for (const call of calls) {
      assert.equal(call.url, `${baseUrl}/v1/text/generate`, "no direct fallback may be attempted");
      assertNoProviderSecrets(call);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalConnection) connection.setKBrainRuntimeConnection(originalConnection);
    else connection.clearKBrainRuntimeConnection();
    await new Promise((resolve, reject) => {
      server.close((error) => (error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
}

function jsonReply(value, status = 200) {
  return (response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
}

for (const generate of [completeAssistantMessage, streamAssistantMessage]) {
  for (const backend of ["kbrain", "direct", undefined]) {
    test(`${generate.name}: ${backend ?? "missing"} backend flag still uses only K-brain HTTP`, { timeout: 5000 }, async () => {
      await withHttpFixture(jsonReply(answer), async ({ calls, requests }) => {
        const deltas = [];
        const result = await generate(callParams(backend, deltas));
        assert.equal(result.role, "assistant");
        assert.deepEqual(result.content, [{ type: "text", text: "backend answer" }]);
        assert.equal(result.api, "kbrain-text");
        assert.equal(result.provider, model.provider);
        assert.equal(result.model, model.model);
        assert.equal(result.stopReason, "stop");
        assert.equal(result.usage.input, 3);
        assert.equal(result.usage.output, 2);
        assert.deepEqual(deltas, generate === streamAssistantMessage ? ["backend answer"] : []);
        assert.equal(calls.length, 1);
        assert.equal(requests.length, 1);
      });
    });
  }

  const failures = [
    { name: "HTTP 503", reply: jsonReply({ error: "backend unavailable" }, 503), error: { message: "backend unavailable", status: 503 } },
    { name: "wrong protocol version", reply: jsonReply({ ...answer, version: "v0" }), error: /Malformed K-brain text-generation response/ },
    { name: "missing text", reply: jsonReply({ version: answer.version, model }), error: /Malformed K-brain text-generation response/ },
    { name: "non-string text", reply: jsonReply({ ...answer, text: 42 }), error: /Malformed K-brain text-generation response/ },
    { name: "missing model", reply: jsonReply({ version: answer.version, text: "answer" }), error: /model identity mismatch/ },
    { name: "wrong provider", reply: jsonReply({ ...answer, model: { ...model, provider: "other-provider" } }), error: /model identity mismatch/ },
    { name: "wrong model", reply: jsonReply({ ...answer, model: { ...model, model: "other-model" } }), error: /model identity mismatch/ },
    {
      name: "invalid JSON",
      reply: (response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("not JSON");
      },
      error: { name: "SyntaxError" },
    },
  ];
  for (const failure of failures) {
    test(`${generate.name}: ${failure.name} rejects without direct fallback or deltas`, { timeout: 5000 }, async () => {
      await withHttpFixture(failure.reply, async ({ calls, requests }) => {
        const deltas = [];
        await assert.rejects(generate(callParams("direct", deltas)), failure.error);
        assert.deepEqual(deltas, []);
        assert.equal(calls.length, 1);
        assert.equal(requests.length, 1);
      });
    });
  }

  test(`${generate.name}: in-flight cancellation closes K-brain HTTP without direct fallback`, { timeout: 5000 }, async (t) => {
    await withHttpFixture(() => {}, async ({ calls, requests, received }) => {
      const controller = new AbortController();
      t.after(() => controller.abort());
      const deltas = [];
      const pending = generate(callParams("direct", deltas, controller.signal));
      const rejection = assert.rejects(pending, { name: "AbortError" });
      const response = await Promise.race([
        received,
        pending.then(() => assert.fail("generation completed before cancellation")),
      ]);
      const closed = new Promise((resolve) => response.once("close", resolve));
      controller.abort();
      await rejection;
      await closed;
      assert.equal(calls[0].signal, controller.signal);
      assert.equal(response.writableEnded, false, "request must abort before a backend answer");
      assert.deepEqual(deltas, []);
      assert.equal(calls.length, 1);
      assert.equal(requests.length, 1);
    });
  });

  test(`${generate.name}: a pre-aborted signal cannot reach either backend or provider`, { timeout: 5000 }, async () => {
    await withHttpFixture(jsonReply(answer), async ({ calls, requests }) => {
      const controller = new AbortController();
      controller.abort();
      const deltas = [];
      await assert.rejects(generate(callParams(undefined, deltas, controller.signal)), { name: "AbortError" });
      assert.deepEqual(deltas, []);
      assert.equal(requests.length, 0);
      assert.ok(calls.length <= 1);
      if (calls.length) assert.equal(calls[0].signal, controller.signal);
    });
  });
}
