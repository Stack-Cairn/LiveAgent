import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

/**
 * WebSocket 通路选择的回归护栏。
 *
 * 背景：此前 piAiAdapter 把「是 chatgpt.com 端点」+「凭证是 ChatGPT JWT」当作
 * **准入**条件，导致 CPA / 自建等一切非 chatgpt.com 端点在资格检查阶段就被排除，
 * 从未真正发起 WebSocket，UI 却显示「连接失败」。现在这两个判据只决定**走哪条
 * 通路**，本文件锁死这个语义。
 */

/** 构造一个形状合法、payload 带 chatgpt_account_id 的 JWT 样本（非真实凭证）。 */
function fakeChatGptJwt() {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" },
    }),
    "utf8",
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function createLoader() {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@earendil-works/pi-ai/api/openai-responses": {
        stream: () => {
          calls.push("sse");
          return "sse-stream";
        },
      },
      "@earendil-works/pi-ai/api/openai-codex-responses": {
        stream: () => {
          calls.push("chatgpt-codex");
          return "codex-stream";
        },
      },
      [abs("src/lib/providers/runtime/cpaResponsesWebSocket.ts")]: {
        streamCpaResponsesWithFallback: () => {
          calls.push("cpa-responses");
          return "cpa-stream";
        },
      },
      [abs("src/lib/providers/runtime/codexWebSocketProxy.ts")]: {
        installCodexWebSocketProxy: () => {
          calls.push("install-proxy");
        },
      },
      // withStreamRetry 只是包装，直接执行一次即可观测分支归属。
      [abs("src/lib/providers/runtime/streamRetry.ts")]: {
        withStreamRetry: (factory) => factory(),
      },
    },
  });
  return { calls, loader };
}

function loadAdapter(loader) {
  return loader.loadModule(abs("src/lib/providers/service/piAiAdapter.ts")).piAiAdapter;
}

function responsesModel(baseUrl) {
  return {
    api: "openai-responses",
    provider: "openai",
    id: "gpt-5.6-luna",
    baseUrl,
    maxTokens: 128_000,
  };
}

const emptyContext = { messages: [], tools: [] };

test("transport auto on a CPA endpoint with a plain Bearer key picks the CPA WebSocket route", () => {
  const { calls, loader } = createLoader();
  const adapter = loadAdapter(loader);

  adapter.stream(responsesModel("http://127.0.0.1:8765/proxy/codex/v1"), emptyContext, {
    apiKey: "cpa-plain-key",
    transport: "auto",
    headers: { "x-liveagent-upstream-origin": "https://claw.example.com" },
  });

  assert.deepEqual(calls, ["cpa-responses"]);
  assert.ok(!calls.includes("sse"), "不得在资格检查阶段就退回 SSE");
});

test("transport auto on a ChatGPT endpoint with a JWT keeps the pi-ai Codex route", () => {
  const { calls, loader } = createLoader();
  const adapter = loadAdapter(loader);

  adapter.stream(responsesModel("https://chatgpt.com/backend-api/codex"), emptyContext, {
    apiKey: fakeChatGptJwt(),
    transport: "auto",
    headers: { "x-liveagent-upstream-origin": "https://chatgpt.com" },
  });

  assert.deepEqual(calls, ["install-proxy", "chatgpt-codex"]);
});

test("a ChatGPT endpoint without a JWT credential falls to the CPA route rather than being blocked", () => {
  const { calls, loader } = createLoader();
  const adapter = loadAdapter(loader);

  adapter.stream(responsesModel("https://chatgpt.com/backend-api/codex"), emptyContext, {
    apiKey: "not-a-jwt",
    transport: "auto",
    headers: { "x-liveagent-upstream-origin": "https://chatgpt.com" },
  });

  assert.deepEqual(calls, ["cpa-responses"]);
});

test("without transport auto the Responses API stays on plain SSE", () => {
  const { calls, loader } = createLoader();
  const adapter = loadAdapter(loader);

  adapter.stream(responsesModel("http://127.0.0.1:8765/proxy/codex/v1"), emptyContext, {
    apiKey: "cpa-plain-key",
    headers: {},
  });

  assert.deepEqual(calls, ["sse"]);
});

test("a non-openai provider never enters a WebSocket route even with transport auto", () => {
  const { calls, loader } = createLoader();
  const adapter = loadAdapter(loader);

  adapter.stream(
    { ...responsesModel("https://api.x.ai/v1"), provider: "xai" },
    emptyContext,
    { apiKey: "xai-key", transport: "auto", headers: {} },
  );

  assert.deepEqual(calls, ["sse"]);
});
