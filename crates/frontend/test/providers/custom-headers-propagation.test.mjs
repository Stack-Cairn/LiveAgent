import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 回归网：自定义请求头曾在 Agent 聊天 / 文本聊天 / 自动标题 / Compaction 四条链路
// 上被逐字段转抄的 runtime 对象整体丢弃。这里对每个真实的供应商请求入口各跑一遍，
// 断言 customHeaders 与 promptCacheRetention 一路抵达上游头集与覆盖包。

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const powerActivityModulePath = path.join(rootDir, "src/lib/system/powerActivity.ts");

const PROXY_SERVER_INFO = { baseUrl: "http://127.0.0.1:18080", token: "proxy-token" };

const CUSTOM_HEADERS = [
  { key: "X-Trace-Id", value: "liveagent-e2e" },
  // 覆盖内置默认头，且大小写与内置键不同——必须替换而非并存。
  { key: "user-agent", value: "my-agent/9.9" },
  // 浏览器禁止头名：只能靠覆盖包送达上游。
  { key: "Cookie", value: "session=abc" },
  // 保留头：一律丢弃。
  { key: "Authorization", value: "Bearer hijacked" },
  { key: "anthropic-beta", value: "hijacked" },
  { key: "x-liveagent-proxy-token", value: "hijacked" },
];

function createUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function createAssistantStream() {
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: createUsage(),
    stopReason: "stop",
    timestamp: 1,
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "text_delta", contentIndex: 0, delta: "ok" };
    },
    async result() {
      return assistant;
    },
  };
}

/**
 * 走真实的 prepareProviderRequest + prepareProxyRequest（只把 tauri invoke 与
 * 电源活动这两个平台边界换成 mock），因此断言覆盖整条装配链。
 */
function loadProvidersWithCapturedStream() {
  const captured = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command) {
          if (command === "proxy_get_server_info") return PROXY_SERVER_INFO;
          throw new Error(`unexpected tauri invoke: ${command}`);
        },
      },
      "@earendil-works/pi-ai/api/anthropic-messages": {
        stream(model, context, options) {
          captured.push({ model, context, options });
          return createAssistantStream();
        },
      },
      [powerActivityModulePath]: {
        async withPowerActivity(_scope, _reason, run) {
          return run();
        },
      },
    },
  });
  return { providers: loader.loadModule("src/lib/providers/llm.ts"), captured };
}

function buildRuntime() {
  return {
    baseUrl: "https://relay.example/v1",
    apiKey: "test-key",
    customHeaders: CUSTOM_HEADERS,
    promptCachingEnabled: true,
    promptCacheRetention: "long",
  };
}

function readHeader(headers, name) {
  const matches = Object.keys(headers).filter((key) => key.toLowerCase() === name.toLowerCase());
  assert.ok(matches.length <= 1, `${name} must not appear twice (found ${matches.join(", ")})`);
  return matches.length === 1 ? headers[matches[0]] : undefined;
}

function decodeOverrides(headers) {
  const encoded = readHeader(headers, "x-liveagent-upstream-headers");
  assert.ok(encoded, "the upstream override package must be present");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

function assertCustomHeadersReachedUpstream(options) {
  const headers = options.headers ?? {};

  // 1) 普通自定义头抵达请求头集。
  assert.equal(readHeader(headers, "x-trace-id"), "liveagent-e2e");
  // 2) 同名内置头被替换而非并存（内置值是 claude-cli/... 的 UA）。
  assert.equal(readHeader(headers, "user-agent"), "my-agent/9.9");
  // 3) 浏览器禁止头名同样进入头集，并由覆盖包负责真正送达。
  assert.equal(readHeader(headers, "cookie"), "session=abc");
  // 4) 保留头不可被自定义头劫持。
  assert.equal(readHeader(headers, "authorization"), undefined);
  assert.equal(readHeader(headers, "x-api-key"), "test-key");
  // anthropic-beta 由长上下文中间件独占：劫持尝试被保留头策略拦下，中间件算出的
  // beta 串必须完好无损（覆盖包在其之前构建，不含该头，因此不会回头压掉它）。
  assert.equal(readHeader(headers, "anthropic-beta"), "context-1m-2025-08-07");
  assert.equal(readHeader(headers, "x-liveagent-proxy-token"), PROXY_SERVER_INFO.token);

  // 5) 覆盖包携带全部非鉴权头，由 Rust 反代在转发前最后一步覆盖写入。
  const overrides = decodeOverrides(headers);
  assert.equal(overrides["X-Trace-Id"], "liveagent-e2e");
  assert.equal(overrides["user-agent"], "my-agent/9.9");
  assert.equal(overrides.Cookie, "session=abc");
  for (const excluded of ["authorization", "x-api-key", "x-goog-api-key"]) {
    assert.ok(
      !Object.keys(overrides).some((key) => key.toLowerCase() === excluded),
      `${excluded} must not be duplicated into the override package`,
    );
  }
  assert.ok(
    !Object.keys(overrides).some((key) => key.toLowerCase().startsWith("x-liveagent-")),
    "the proxy's own control headers must never be echoed into the override package",
  );
  assert.ok(
    !Object.keys(overrides).some((key) => key.toLowerCase() === "anthropic-beta"),
    "anthropic-beta must stay owned by attachAnthropicLongContextBeta",
  );

  // 6) promptCacheRetention 与 customHeaders 一同在四条链路上失效过，一并锁定。
  assert.equal(options.cacheRetention, "long");
}

test("streamAssistantMessage sends provider custom headers and cache retention", async () => {
  const { providers, captured } = loadProvidersWithCapturedStream();

  await providers.streamAssistantMessage({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: buildRuntime(),
    context: { messages: [{ role: "user", content: "hi", timestamp: 1 }] },
    onTextDelta() {},
  });

  assert.equal(captured.length, 1);
  assertCustomHeadersReachedUpstream(captured[0].options);
});

test("completeAssistantMessage sends provider custom headers (compaction summarizer path)", async () => {
  const { providers, captured } = loadProvidersWithCapturedStream();

  await providers.completeAssistantMessage({
    providerId: "claude_code",
    model: "claude-sonnet-4-6",
    runtime: buildRuntime(),
    context: { messages: [{ role: "user", content: "summarize", timestamp: 1 }] },
  });

  assert.equal(captured.length, 1);
  const { options } = captured[0];
  const headers = options.headers ?? {};
  assert.equal(readHeader(headers, "x-trace-id"), "liveagent-e2e");
  assert.equal(readHeader(headers, "user-agent"), "my-agent/9.9");
  assert.equal(decodeOverrides(headers).Cookie, "session=abc");
});

test("compaction summarizer forwards the whole runtime config untouched", async () => {
  // 摘要器只改 reasoning 档位（展开派生），其余字段必须原样透传——曾经的
  // 逐字段转抄正是在这一层之上把 customHeaders 抹掉的。
  const loader = createTsModuleLoader();
  const { summarizeConversation } = loader.loadModule("src/lib/chat/compaction/summarizer.ts");
  const runtime = buildRuntime();
  const seen = [];

  await summarizeConversation({
    providerId: "codex",
    model: "gpt-5",
    runtime,
    payload: {
      active_segment_messages: [{ role: "user", content: "hello" }],
      compaction_reason: { omitted_message_count: 0 },
    },
    async complete(params) {
      seen.push(params.runtime);
      return {
        role: "assistant",
        content: [{ type: "text", text: SUMMARY_TEXT }],
        api: "liveagent-compaction",
        provider: "codex",
        model: "gpt-5",
        usage: createUsage(),
        stopReason: "stop",
        timestamp: 1,
      };
    },
  });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].customHeaders, CUSTOM_HEADERS);
  assert.equal(seen[0].promptCacheRetention, "long");
  // Codex 摘要固定用 medium 档，其余字段来自原 runtime。
  assert.equal(seen[0].reasoning, "medium");
});

const SUMMARY_TEXT = `<summary>
<task>Verify that custom request headers survive the compaction path</task>
<state>Runtime config is forwarded whole to the summarizer request ${"x".repeat(300)}</state>
<artifacts>
- [file] src/lib/chat/compaction/summarizer.ts | reviewed | forwards runtime untouched
</artifacts>
<next_steps>
1. keep the runtime object intact across every provider entry point
</next_steps>
</summary>`;
