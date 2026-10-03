import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function harness(respond) {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, args) {
          calls.push({ command, args: JSON.parse(JSON.stringify(args)) });
          return respond(command, args);
        },
      },
    },
  });
  return { module: loader.loadModule("src/lib/tools/notifyTool.ts"), calls };
}

const call = (args) => ({ id: "call-1", name: "Notify", arguments: args });

test("Notify invokes notifications_notify with trimmed, truncated text", async () => {
  const { module, calls } = harness(() => "sent");
  const result = await module
    .createNotifyTools()
    .executeToolCall(call({ title: `  ${"t".repeat(120)}  `, body: "b".repeat(400) }));
  assert.equal(result.isError, false);
  assert.deepEqual(calls.map((entry) => entry.command), ["notifications_notify"]);
  assert.equal(calls[0].args.title.length, module.NOTIFY_TITLE_MAX_CHARS);
  assert.equal(calls[0].args.body.length, module.NOTIFY_BODY_MAX_CHARS);
  assert.match(result.content[0].text, /^Sent/);
});

test("Notify explains every outcome to the model", async () => {
  for (const [outcome, pattern] of [
    ["disabled", /turned off/],
    ["throttled", /30 seconds/],
    ["disabledByEnv", /disabled in this environment/],
  ]) {
    const { module } = harness(() => outcome);
    const result = await module.createNotifyTools().executeToolCall(call({ title: "Done" }));
    assert.equal(result.isError, false);
    assert.match(result.content[0].text, pattern);
  }
});

test("Notify rejects an empty title without calling the backend", async () => {
  const { module, calls } = harness(() => "sent");
  const result = await module.createNotifyTools().executeToolCall(call({ title: "   " }));
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

test("Notify reports backend errors as tool errors", async () => {
  const { module } = harness(() => {
    throw new Error("E:unavailable");
  });
  const result = await module.createNotifyTools().executeToolCall(call({ title: "Done" }));
  assert.equal(result.isError, true);
  assert.equal(result.content[0].text, "E:unavailable");
});
