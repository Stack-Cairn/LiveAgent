import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveShareOrigin, buildShareUrl } = loader.loadModule(
  "@liveagent/ui/lib/chat/historyShareOrigin.ts",
);

test("resolveShareOrigin applies the gateway port to explicit origins", () => {
  assert.equal(
    resolveShareOrigin("http://localhost", 8080),
    "http://localhost:8080",
  );
  assert.equal(
    resolveShareOrigin("http://127.0.0.1", 3000),
    "http://127.0.0.1:3000",
  );
  assert.equal(
    resolveShareOrigin("https://gw.example.com", 8443),
    "https://gw.example.com:8443",
  );
  // 端口语义与桌面端 WS build_ws_url 一致：设置端口覆盖基址自带端口。
  assert.equal(
    resolveShareOrigin("https://gw.example.com:9000", 8443),
    "https://gw.example.com:8443",
  );
});

test("resolveShareOrigin omits default ports for their schemes", () => {
  assert.equal(resolveShareOrigin("https://gw.example.com", 443), "https://gw.example.com");
  assert.equal(resolveShareOrigin("http://localhost", 80), "http://localhost");
  // https + 80 是非默认组合，必须保留。
  assert.equal(resolveShareOrigin("https://gw.example.com", 80), "https://gw.example.com:80");
});

test("resolveShareOrigin keeps existing behavior without a port", () => {
  assert.equal(resolveShareOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(resolveShareOrigin("gw.example.com"), "https://gw.example.com");
  assert.equal(resolveShareOrigin("wss://gw.example.com:8443"), "https://gw.example.com:8443");
  assert.equal(resolveShareOrigin("ws://localhost", 8080), "http://localhost:8080");
  assert.equal(resolveShareOrigin(""), "");
  assert.equal(resolveShareOrigin("https://"), "");
  assert.equal(resolveShareOrigin("http:"), "");
});

test("resolveShareOrigin does not apply a gateway port to the browser origin", () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { origin: "http://localhost:5173" } };
  try {
    assert.equal(resolveShareOrigin(undefined, 443), "http://localhost:5173");
  } finally {
    if (previousWindow === undefined) {
      delete globalThis.window;
    } else {
      globalThis.window = previousWindow;
    }
  }
});

test("resolveShareOrigin ignores invalid ports", () => {
  assert.equal(resolveShareOrigin("http://localhost:8080", 0), "http://localhost:8080");
  assert.equal(resolveShareOrigin("http://localhost", 65_536), "http://localhost");
  assert.equal(resolveShareOrigin("http://localhost", Number.NaN), "http://localhost");
});

test("buildShareUrl joins origin token and share path", () => {
  assert.equal(
    buildShareUrl("token-1", "http://localhost:8080"),
    "http://localhost:8080/share/token-1",
  );
  assert.equal(buildShareUrl("with space", "http://localhost:8080"), "http://localhost:8080/share/with%20space");
  assert.equal(buildShareUrl("", "http://localhost:8080"), "");
  assert.equal(buildShareUrl("token-1", ""), "");
});
