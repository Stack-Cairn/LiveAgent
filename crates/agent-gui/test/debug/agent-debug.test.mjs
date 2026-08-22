import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const agentDebug = loader.loadModule("src/lib/debug/agentDebug.ts");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("debug sanitizer redacts base64 data URLs", () => {
  const payload = {
    input: [
      {
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,aW1hZ2U=",
          },
          {
            type: "input_file",
            file_data: "data:application/pdf;base64,cGRm",
          },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aW1hZ2U=",
            },
          },
          {
            type: "document",
            source: {
              type: "text",
              media_type: "text/plain",
              data: "Hello Claude",
            },
          },
          {
            inlineData: {
              mimeType: "image/png",
              data: "aW1hZ2U=",
            },
          },
        ],
      },
    ],
  };

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(payload);
  assert.equal(
    sanitized.input[0].content[0].image_url,
    "[redacted data URL: image/png, base64 chars=8]",
  );
  assert.equal(
    sanitized.input[0].content[1].file_data,
    "[redacted data URL: application/pdf, base64 chars=4]",
  );
  assert.equal(
    sanitized.input[0].content[2].source.data,
    "[redacted base64: image/png, chars=8]",
  );
  assert.equal(
    sanitized.input[0].content[3].source.data,
    "[redacted text document: text/plain, chars=12]",
  );
  assert.equal(
    sanitized.input[0].content[4].inlineData.data,
    "[redacted inlineData: image/png, chars=8]",
  );
});

test("debug sanitizer redacts nested credentials without hiding token usage", () => {
  const payload = {
    apiKey: "raw-api-key",
    headers: {
      Authorization: "Bearer raw-authorization",
      "X-API-Key": "raw-header-key",
      Cookie: "session=raw-cookie",
      "X-Request-ID": "raw-custom-header",
    },
    provider: {
      client_secret: "raw-client-secret",
      refreshToken: "raw-refresh-token",
      password: "raw-password",
    },
    hasApiKey: true,
    inputTokens: 123,
    maxTokens: 456,
  };

  const sanitized = agentDebug.__agentDebugTest.sanitizeDebugValue(payload);
  const serialized = JSON.stringify(sanitized);

  for (const secret of [
    "raw-api-key",
    "raw-authorization",
    "raw-header-key",
    "raw-cookie",
    "raw-custom-header",
    "raw-client-secret",
    "raw-refresh-token",
    "raw-password",
  ]) {
    assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
  }
  assert.equal(sanitized.apiKey, "[redacted credential]");
  assert.equal(sanitized.headers.Authorization, "[redacted credential]");
  assert.equal(sanitized.headers["X-Request-ID"], "[redacted credential]");
  assert.equal(sanitized.provider.client_secret, "[redacted credential]");
  assert.equal(sanitized.hasApiKey, true);
  assert.equal(sanitized.inputTokens, 123);
  assert.equal(sanitized.maxTokens, 456);
});

test("stream request debug payload never includes runtime or option credentials", () => {
  const payload = agentDebug.buildStreamRequestDebugPayload({
    runtime: {
      baseUrl: "https://example.test/v1",
      apiKey: "raw-runtime-key",
    },
    context: { messages: [] },
    options: {
      apiKey: "raw-option-key",
      headers: { authorization: "Bearer raw-option-auth" },
    },
  });
  const serialized = JSON.stringify(payload);

  assert.equal(payload.runtime.hasApiKey, true);
  assert.equal(serialized.includes("raw-runtime-key"), false);
  assert.equal(serialized.includes("raw-option-key"), false);
  assert.equal(serialized.includes("raw-option-auth"), false);
});

test("stream request debug payload carries prefix cache diagnostics", () => {
  const payload = agentDebug.buildStreamRequestDebugPayload({
    runtime: {
      baseUrl: "https://example.test/v1",
      apiKey: "raw-runtime-key",
      promptCachingEnabled: true,
    },
    context: { messages: [] },
    round: 2,
    prefixCache: {
      prefixHash: "0123456789abcdef",
      systemHash: "1111111122222222",
      toolsHash: "3333333344444444",
      toolCount: 7,
      prefixChanged: true,
      prefixChangeReasons: ["system"],
      prefixChangeSummary: "system",
    },
  });

  assert.equal(payload.prefixCache.prefixChangeSummary, "system");
  assert.deepEqual(payload.prefixCache.prefixChangeReasons, ["system"]);
  assert.equal(payload.prefixCache.prefixHash, "0123456789abcdef");
  assert.equal(payload.prefixCache.toolCount, 7);
  assert.equal(payload.runtime.promptCachingEnabled, true);
});

test("stream request debug payload omits prefix cache when not provided", () => {
  const payload = agentDebug.buildStreamRequestDebugPayload({
    runtime: { baseUrl: "https://example.test/v1", apiKey: "k" },
    context: { messages: [] },
  });

  assert.equal(payload.prefixCache, undefined);
});

test("background debug flush does not block and observes a late failure", async () => {
  const gate = deferred();
  const warnings = [];
  const originalWarn = console.warn;
  let flushCalls = 0;
  console.warn = (...args) => warnings.push(args);
  try {
    const result = agentDebug.flushDebugLoggerInBackground(
      {
        flush() {
          flushCalls += 1;
          return gate.promise;
        },
      },
      "test",
    );

    assert.equal(result, undefined);
    assert.equal(flushCalls, 1);

    gate.reject(new Error("late debug write failure"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /Agent dev debug test flush failed/);
  } finally {
    console.warn = originalWarn;
  }
});
