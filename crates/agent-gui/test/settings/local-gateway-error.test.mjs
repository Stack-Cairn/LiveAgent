import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { localizeLocalGatewayError } = loader.loadModule(
  "@liveagent/ui/lib/settings/localGatewayError.ts",
);
const { t } = loader.loadModule("src/i18n/config.ts");

test("local Gateway supervisor errors follow the interface language", () => {
  const zh = (key) => t(key, "zh-CN");
  assert.equal(
    localizeLocalGatewayError("Local Gateway port 50052 is already in use", zh),
    "本地 Gateway 端口 50052 已被占用。请先关闭占用该端口的程序（例如另一个正在运行的 LiveAgent），再重试 Gateway 连接。",
  );
  // String(error) from a rejected invoke keeps the message inside a prefix.
  assert.equal(
    localizeLocalGatewayError("Error: Unable to start the local Gateway executable", zh),
    "无法启动本地 Gateway 程序。",
  );
  assert.match(
    localizeLocalGatewayError("Local Gateway port 50052 is already in use", (key) => t(key, "en-US")),
    /^Local Gateway port 50052 is already in use\. Close the program/,
  );
});

test("every supervisor error has a Chinese and English translation", () => {
  const messages = [
    "Local Gateway port 1 is already in use",
    "Local Gateway executable was not found",
    "Local Gateway must be a Windows executable (.exe)",
    "Local Gateway startup timed out waiting for its health check",
    "Unable to start the local Gateway executable",
    "Unable to stop the local Gateway process",
    "Unable to inspect the local Gateway process",
    "Unable to collect the local Gateway process",
    "Unable to prepare the local Gateway data directory",
    "Unable to prepare the local Gateway health check",
    "Unable to update the local Gateway image backend",
    // services/gateway/connection.rs
    "Local gateway supervisor task failed",
    "Unable to locate desktop executable",
    "Unable to locate desktop directory",
  ];
  for (const locale of ["zh-CN", "en-US"]) {
    for (const message of messages) {
      const localized = localizeLocalGatewayError(message, (key) => t(key, locale));
      assert.doesNotMatch(localized, /^settings\./, `${locale}: ${message}`);
      if (locale === "zh-CN") assert.match(localized, /[一-鿿]/, message);
    }
  }
});

test("unrelated connection errors are shown unchanged", () => {
  const message = "websocket: bad handshake";
  assert.equal(
    localizeLocalGatewayError(message, (key) => t(key, "zh-CN")),
    message,
  );
});
