import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

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

// 凡是新实例顶替过既有实例——包括 reset 置空后再创建(登出→登录)——都必须
// 触发 replaced,否则模块级 store 会永远挂在已 dispose 的旧实例上收不到事件。
test("单例 reset→create 也触发 replaced", () => {
  let fired = 0;
  const detach = onGatewayWebSocketClientReplaced(() => {
    fired += 1;
  });
  const first = getGatewayWebSocketClient("token-a");
  assert.equal(fired, 0); // 首个创建不算替换
  resetGatewayWebSocketClient();
  assert.equal(fired, 0); // reset 本身不通知(此刻无新实例可接)
  const second = getGatewayWebSocketClient("token-a");
  assert.notEqual(first, second);
  assert.equal(fired, 1);
  detach();
  resetGatewayWebSocketClient();
});
