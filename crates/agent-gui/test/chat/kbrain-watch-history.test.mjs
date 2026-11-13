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

test("terminal events and normal stream closure request history reconciliation", async () => {
  let changed = 0;
  let finish;
  const stop = watchKBrainHistory({
    getHistory: async () => ({ session: { last_seq: 12 } }),
    subscribe: async (_id, _after, handlers) => {
      for (const [seq, type] of [[13, "run.cancelled"], [14, "run.failed"], [15, "run.completed"], [16, "subagent.completed"]]) {
        handlers.onEvent({ seq, type });
      }
      await new Promise(resolve => { finish = resolve; });
    },
  }, "session", () => changed++);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(changed, 5);
  finish();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(changed, 6);
  stop();
});

test("reconnect reconciles a history write after terminal stream closure, even without another event", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let revision = "before-final-write";
  let changed = 0;
  let reads = 0;
  let subscriptions = 0;
  const stop = watchKBrainHistory({
    getHistory: async () => {
      reads++;
      return { session: { last_seq: 12 }, revision };
    },
    subscribe: async () => {
      subscriptions++;
      if (subscriptions === 1) return;
      await new Promise(() => {});
    },
  }, "session", () => changed++);
  t.after(stop);
  await new Promise(setImmediate);
  assert.equal(changed, 1);
  revision = "after-final-write";
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(reads, 2);
  assert.equal(changed, 2, "late authority writes must reach the view without a restart");
});

for (const fault of ["disconnect", "sequence-gap", "wrong-session"]) {
  test(`${fault} resnapshots on reconnect and unchanged idle history does not reload the transcript`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let reads = 0;
    let subscriptions = 0;
    let changed = 0;
    const stop = watchKBrainHistory({
      getHistory: async () => ({ session: { last_seq: ++reads === 1 ? 12 : 20 }, revision: reads === 1 ? "old" : "new" }),
      subscribe: async (_id, after, handlers) => {
        subscriptions++;
        if (subscriptions === 1) {
          if (fault === "disconnect") throw new Error("connection lost");
          handlers.onEvent({ seq: fault === "sequence-gap" ? 14 : 13, conversation_id: fault === "wrong-session" ? "foreign" : "session", type: "history.updated" });
        } else {
          assert.equal(after, 20);
        }
      },
    }, "session", () => changed++);
    t.after(stop);
    await new Promise(setImmediate);
    assert.equal(changed, 1);
    t.mock.timers.tick(2000);
    await new Promise(setImmediate);
    assert.equal(changed, 2);
    t.mock.timers.tick(2000);
    await new Promise(setImmediate);
    assert.equal(reads, 3);
    assert.equal(changed, 2, "idle polling checks only metadata; unchanged history needs no full reload");
  });
}

test("a failed transcript reconciliation retries without another backend mutation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let attempts = 0;
  const stop = watchKBrainHistory({
    getHistory: async () => ({ session: { last_seq: 12 }, revision: "unchanged" }),
    subscribe: async () => {},
  }, "session", async () => {
    attempts++;
    if (attempts === 1) throw new Error("history temporarily unavailable");
  });
  t.after(stop);
  await new Promise(setImmediate);
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(attempts, 2);
  t.mock.timers.tick(2000);
  await new Promise(setImmediate);
  assert.equal(attempts, 2);
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
