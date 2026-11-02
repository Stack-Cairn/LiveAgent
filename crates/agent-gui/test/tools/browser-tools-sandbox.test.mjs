import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadBrowserTools(invoke) {
  const loader = createTsModuleLoader({
    mocks: {
      "@liveagent/app/shims/tauriCore": { invoke },
    },
  });
  return loader.loadModule("src/lib/tools/browserTools.ts").createBrowserTools;
}

const call = {
  type: "toolCall",
  id: "browser-1",
  name: "Browser",
  arguments: { action: "navigate", url: "https://example.com" },
};

test("offline sandbox blocks Browser before native execution", async () => {
  let invoked = false;
  const createBrowserTools = loadBrowserTools(async () => {
    invoked = true;
    return {};
  });
  const result = await createBrowserTools({
    sandbox: { enabled: true, allowNetwork: false },
  }).executeToolCall(call);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /offline sandbox mode/i);
  assert.equal(invoked, false);
});

test("network-enabled sandbox delegates Browser actions", async () => {
  const calls = [];
  const createBrowserTools = loadBrowserTools(async (command, args) => {
    calls.push({ command, args });
    return { action: "navigate", url: "https://example.com", title: "Example Domain" };
  });
  const result = await createBrowserTools({
    sandbox: { enabled: true, allowNetwork: true },
  }).executeToolCall(call);
  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Example Domain/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "browser_action");
});
