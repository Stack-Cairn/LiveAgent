import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Hub（Skills/MCP 商店）出网适配层契约：桌面端把完整上游 URL 改写为
// 本地反代请求，并恒带 use-system-proxy 头交由 Rust 按应用代理配置出网。
const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      async invoke(command) {
        if (command === "proxy_get_server_info") {
          return { baseUrl: "http://127.0.0.1:43110/", token: "test-proxy-token" };
        }
        throw new Error(`unexpected invoke: ${command}`);
      },
    },
  },
});

const proxy = loader.loadModule("src/lib/providers/proxy.ts");
const hubFetchModule = loader.loadModule("src/lib/hubFetch.ts");

test("prepareUpstreamProxyRequest 保留路径与查询串并携带三个反代头", async () => {
  const prepared = await proxy.prepareUpstreamProxyRequest(
    "https://clawhub.ai/api/v1/skills?limit=24&sort=downloads",
  );

  assert.equal(prepared.url, "http://127.0.0.1:43110/proxy/hub/api/v1/skills?limit=24&sort=downloads");
  assert.equal(prepared.headers["x-liveagent-upstream-origin"], "https://clawhub.ai");
  assert.equal(prepared.headers["x-liveagent-proxy-token"], "test-proxy-token");
  assert.equal(prepared.headers["x-liveagent-use-system-proxy"], "1");
});

test("prepareUpstreamProxyRequest 拒绝相对地址、非 http(s) 与内嵌凭据", async () => {
  await assert.rejects(() => proxy.prepareUpstreamProxyRequest("/api/v1/skills"), /absolute URL/);
  await assert.rejects(
    () => proxy.prepareUpstreamProxyRequest("ftp://clawhub.ai/api"),
    /http:\/\/ or https:\/\//,
  );
  await assert.rejects(
    () => proxy.prepareUpstreamProxyRequest("https://user:pass@clawhub.ai/api"),
    /username or password/,
  );
});

test("prepareUpstreamProxyRequest 拒绝 // 开头路径（防 Url::join 改写上游主机）", async () => {
  await assert.rejects(
    () => proxy.prepareUpstreamProxyRequest("https://api.smithery.ai//servers/foo"),
    /must not begin with \/\//,
  );
});

test("prepareUpstreamProxyRequest 根路径映射为无尾斜杠形态", async () => {
  const bare = await proxy.prepareUpstreamProxyRequest("https://clawhub.ai");
  assert.equal(bare.url, "http://127.0.0.1:43110/proxy/hub");

  const withQuery = await proxy.prepareUpstreamProxyRequest("https://clawhub.ai/?probe=1");
  assert.equal(withQuery.url, "http://127.0.0.1:43110/proxy/hub?probe=1");
});

test("hubFetch 桌面端改写请求地址并合并调用方 headers", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  try {
    await hubFetchModule.hubFetch("https://registry.modelcontextprotocol.io/v0.1/servers?limit=18", {
      headers: { Accept: "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    "http://127.0.0.1:43110/proxy/hub/v0.1/servers?limit=18",
  );
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(
    headers.get("x-liveagent-upstream-origin"),
    "https://registry.modelcontextprotocol.io",
  );
  assert.equal(headers.get("x-liveagent-proxy-token"), "test-proxy-token");
  assert.equal(headers.get("x-liveagent-use-system-proxy"), "1");
});

test("hubFetch 桌面端透传 init 的 method/body/signal", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  try {
    await hubFetchModule.hubFetch("https://clawhub.ai/api/v1/search", {
      method: "POST",
      body: '{"q":"git"}',
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.body, '{"q":"git"}');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.equal(new Headers(calls[0].init.headers).get("content-type"), "application/json");
});

test("hubFetch 在 Gateway WebUI 运行时直连、不改写地址不加反代头", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200 };
  };
  // 模拟 web main.tsx 在渲染前写入的运行时标记。
  globalThis.document = { documentElement: { dataset: { liveagentWebui: "gateway" } } };
  try {
    await hubFetchModule.hubFetch("https://clawhub.ai/api/v1/skills?limit=24", {
      headers: { Accept: "application/json" },
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = originalDocument;
    }
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://clawhub.ai/api/v1/skills?limit=24");
  const headers = new Headers(calls[0].init.headers);
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("x-liveagent-upstream-origin"), null);
  assert.equal(headers.get("x-liveagent-use-system-proxy"), null);
});
