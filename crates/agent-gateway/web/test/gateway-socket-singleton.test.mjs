import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// 网关 socket 单例替换契约：凡是新实例顶替过既有实例（包括 reset 置空后再创建
// 的序列），都必须触发 onGatewayWebSocketClientReplaced，否则模块级 store
// （如 managed-process backend）会永远挂在已 dispose 的旧实例上收不到事件。

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
globalThis.location = { origin: "http://127.0.0.1:9", href: "http://127.0.0.1:9/" };

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { getGatewayWebSocketClient, onGatewayWebSocketClientReplaced, resetGatewayWebSocketClient } =
  loader.loadModule("src/lib/gatewaySocket.ts");

test("首个客户端创建不触发 replaced", () => {
  let fired = 0;
  const detach = onGatewayWebSocketClientReplaced(() => {
    fired += 1;
  });
  const first = getGatewayWebSocketClient("token-a");
  assert.ok(first);
  assert.equal(fired, 0);
  detach();
  resetGatewayWebSocketClient();
});

test("换 token 直接替换会触发 replaced", () => {
  let fired = 0;
  const a = getGatewayWebSocketClient("token-a");
  const detach = onGatewayWebSocketClientReplaced(() => {
    fired += 1;
  });
  const b = getGatewayWebSocketClient("token-b");
  assert.notEqual(a, b);
  assert.equal(fired, 1);
  detach();
  resetGatewayWebSocketClient();
});

test("reset 置空后再创建同样触发 replaced(登出→登录路径)", () => {
  let fired = 0;
  const a = getGatewayWebSocketClient("token-a");
  const detach = onGatewayWebSocketClientReplaced(() => {
    fired += 1;
  });
  resetGatewayWebSocketClient();
  assert.equal(fired, 0);
  const b = getGatewayWebSocketClient("token-a");
  assert.notEqual(a, b);
  assert.equal(fired, 1);
  // replaced 回调内再取 client 应命中新实例的快速路径。
  assert.equal(getGatewayWebSocketClient("token-a"), b);
  detach();
  resetGatewayWebSocketClient();
});
