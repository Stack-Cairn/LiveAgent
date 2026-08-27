import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { scrubSecretsFromErrorText } = loader.loadModule("src/lib/trajectory/scrub.ts");
const { captureTransportSnapshot } = loader.loadModule(
  "src/lib/providers/runtime/transportSnapshot.ts",
);

// ---------------------------------------------------------------------------
// scrubSecretsFromErrorText
// ---------------------------------------------------------------------------

test("scrubs API keys from URL query parameters", () => {
  const scrubbed = scrubSecretsFromErrorText(
    "400 from https://generativelanguage.googleapis.com/v1beta/models?key=AIzaSyC0123456789abcdefghijklmnopqrstu&alt=sse",
  );
  assert.ok(!scrubbed.includes("AIzaSyC0123456789abcdefghijklmnopqrstu"));
  assert.ok(scrubbed.includes("?key=[redacted]"));
  assert.ok(scrubbed.includes("&alt=sse"), "non-secret query params survive");
});

test("scrubs bearer tokens wherever they are echoed", () => {
  const scrubbed = scrubSecretsFromErrorText(
    'fetch failed: header Authorization: Bearer sk-proj-secretsecretsecret1234 rejected',
  );
  assert.ok(!scrubbed.includes("sk-proj-secretsecretsecret1234"));
  assert.match(scrubbed, /Bearer \[redacted\]/i);
});

test("scrubs bare known-shape keys outside URLs and headers", () => {
  const scrubbed = scrubSecretsFromErrorText(
    "provider rejected key sk-ant-api03-0123456789abcdef0123 (expired)",
  );
  assert.ok(!scrubbed.includes("sk-ant-api03-0123456789abcdef0123"));
  assert.ok(scrubbed.includes("(expired)"));
});

test("does not mangle ordinary provider errors", () => {
  const text =
    "503 service unavailable: upstream connect error or disconnect/reset before headers";
  assert.equal(scrubSecretsFromErrorText(text), text);
});

test("does not mangle error text mentioning token counts or model names", () => {
  const text = "400: max_tokens (128000) exceeds model limit; model=claude-sonnet-4";
  assert.equal(scrubSecretsFromErrorText(text), text);
});

// ---------------------------------------------------------------------------
// captureTransportSnapshot
// ---------------------------------------------------------------------------

test("snapshot keeps header names and routing flags, never values", () => {
  const snapshot = captureTransportSnapshot({
    Authorization: "Bearer sk-proj-supersecret",
    "x-api-key": "sk-ant-anothersecret",
    "x-liveagent-proxy-token": "proxy-token-value",
    "x-liveagent-upstream-origin": "https://api.example.com",
    "x-liveagent-use-system-proxy": "1",
    "x-liveagent-upstream-headers": "eyJzZWNyZXQiOiJ2YWx1ZSJ9",
  });
  assert.equal(snapshot.upstreamOrigin, "https://api.example.com");
  assert.equal(snapshot.useSystemProxy, true);
  assert.equal(snapshot.fullUrl, false);
  assert.deepEqual(snapshot.headerNames, [
    "authorization",
    "x-api-key",
    "x-liveagent-proxy-token",
    "x-liveagent-upstream-headers",
    "x-liveagent-upstream-origin",
    "x-liveagent-use-system-proxy",
  ]);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("sk-proj-supersecret"));
  assert.ok(!serialized.includes("sk-ant-anothersecret"));
  assert.ok(!serialized.includes("proxy-token-value"));
  assert.ok(!serialized.includes("eyJzZWNyZXQ"), "base64 override pack value must not leak");
});

test("snapshot flags full-URL mode without recording the URL itself", () => {
  const snapshot = captureTransportSnapshot({
    "x-liveagent-upstream-url": "https://api.example.com/v1/chat?key=AIzaSyCsecret012345678901234",
    "x-liveagent-upstream-origin": "https://api.example.com",
  });
  assert.equal(snapshot.fullUrl, true);
  const serialized = JSON.stringify(snapshot);
  assert.ok(!serialized.includes("AIzaSy"), "full URL (may contain query keys) must not leak");
  assert.ok(!serialized.includes("/v1/chat"));
});

test("null header values (deletion markers) stay out of the snapshot", () => {
  const snapshot = captureTransportSnapshot({
    "x-liveagent-use-system-proxy": null,
    accept: "text/event-stream",
  });
  assert.equal(snapshot.useSystemProxy, false);
  assert.deepEqual(snapshot.headerNames, ["accept"]);
});

test("a direct-connection candidate snapshot omits the proxy flag entirely", () => {
  const withProxy = captureTransportSnapshot({
    "x-liveagent-use-system-proxy": "1",
    "x-liveagent-upstream-origin": "https://api.foreign.example",
  });
  const direct = captureTransportSnapshot({
    "x-liveagent-upstream-origin": "https://api.domestic.example",
  });
  // failover 逐候选独立性:主选走代理、备选直连,两份快照互不泄漏。
  assert.equal(withProxy.useSystemProxy, true);
  assert.equal(direct.useSystemProxy, false);
  assert.ok(withProxy.headerNames.includes("x-liveagent-use-system-proxy"));
  assert.ok(!direct.headerNames.includes("x-liveagent-use-system-proxy"));
});
