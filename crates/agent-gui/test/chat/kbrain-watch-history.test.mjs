import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { watchKBrainHistory } = createTsModuleLoader().loadModule("src/lib/kbrain/watchHistory.ts");

test("history watcher starts at the snapshot cursor and aborts on disposal", async () => {
  let changed = 0;
  let signal;
  const stop = watchKBrainHistory({
    getHistory: async () => ({ session: { last_seq: 12 } }),
    subscribe: async (id, after, handlers, abort) => {
      assert.equal(id, "session");
      assert.equal(after, 12);
      signal = abort;
      handlers.onEvent({ seq: 13, type: "history.updated" });
      handlers.onEvent({ seq: 14, type: "assistant.delta" });
      await new Promise(resolve => abort.addEventListener("abort", resolve, { once: true }));
    },
  }, "session", () => changed++);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(changed, 2);
  stop();
  assert.equal(signal.aborted, true);
});

test("disposing during the initial fetch never subscribes or updates the view", async () => {
  let finish;
  let subscriptions = 0;
  let changed = 0;
  const stop = watchKBrainHistory({
    getHistory: () => new Promise(resolve => finish = resolve),
    subscribe: async () => subscriptions++,
  }, "session", () => changed++);
  stop();
  finish({ session: { last_seq: 0 } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(subscriptions, 0);
  assert.equal(changed, 0);
});
