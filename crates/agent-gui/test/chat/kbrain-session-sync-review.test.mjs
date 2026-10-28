import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { createKBrainSessionSync } = createTsModuleLoader().loadModule(
  "src/lib/kbrain/sessionSync.ts",
);

const session = (id) => ({
  id,
  title: id,
  model: { provider: "fixture", model: "model" },
  created_at: "2026-10-28T00:00:00Z",
  updated_at: "2026-10-28T00:00:01Z",
  message_count: 1,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("more=false cannot hide changes between next_since and head_revision", async () => {
  let changesCalls = 0;
  const errors = [];
  const sync = createKBrainSessionSync({
    client: {
      getCapabilities: async () => ({ session_changes: 2 }),
      createSessionSnapshot: async () => ({
        epoch: "epoch",
        revision: "0",
        snapshot_id: "snapshot",
        total_count: 0,
      }),
      getSessionSnapshot: async () => ({
        epoch: "epoch",
        revision: "0",
        snapshot_id: "snapshot",
        total_count: 0,
        sessions: [],
        next_offset: null,
      }),
      releaseSessionSnapshot: async () => undefined,
      getSessionChanges: async (_params, signal) => {
        changesCalls += 1;
        if (changesCalls === 1) {
          return {
            epoch: "epoch",
            head_revision: "10",
            next_since: "1",
            reset: false,
            more: false,
            changes: [
              { id: "one", revision: "1", kind: "upsert", listed: true, session: session("one") },
            ],
          };
        }
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
    onSnapshot: () => undefined,
    onHealth: (_healthy, error) => {
      if (error) errors.push(error);
    },
    retryMs: 10_000,
    requestTimeoutMs: 20,
  });
  const stop = sync.acquire();
  await delay(80);
  stop();
  assert.equal(changesCalls, 1, "malformed batch must fail before another request");
  assert.equal(errors.length, 1);
});

test("a stalled immediate more batch times out and marks synchronization unhealthy", async () => {
  let changesCalls = 0;
  const errors = [];
  const sync = createKBrainSessionSync({
    client: {
      getCapabilities: async () => ({ session_changes: 2 }),
      createSessionSnapshot: async () => ({
        epoch: "epoch",
        revision: "0",
        snapshot_id: "snapshot",
        total_count: 0,
      }),
      getSessionSnapshot: async () => ({
        epoch: "epoch",
        revision: "0",
        snapshot_id: "snapshot",
        total_count: 0,
        sessions: [],
        next_offset: null,
      }),
      releaseSessionSnapshot: async () => undefined,
      getSessionChanges: async ({ wait }, signal) => {
        changesCalls += 1;
        if (changesCalls === 1) {
          return {
            epoch: "epoch",
            head_revision: "0",
            next_since: "0",
            reset: false,
            more: false,
            changes: [],
          };
        }
        if (changesCalls === 2 && wait === 30) {
          return {
            epoch: "epoch",
            head_revision: "2",
            next_since: "1",
            reset: false,
            more: true,
            changes: [
              { id: "one", revision: "1", kind: "upsert", listed: true, session: session("one") },
            ],
          };
        }
        return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      },
    },
    onSnapshot: () => undefined,
    onHealth: (_healthy, error) => {
      if (error) errors.push(error);
    },
    retryMs: 10_000,
    requestTimeoutMs: 20,
  });
  const stop = sync.acquire();
  await delay(100);
  assert.equal(sync.isHealthy(), false);
  assert.equal(errors.length, 1);
  stop();
});
