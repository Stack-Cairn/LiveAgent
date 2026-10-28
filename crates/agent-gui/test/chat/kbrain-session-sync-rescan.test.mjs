import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { createKBrainSessionSync } = createTsModuleLoader().loadModule(
  "src/lib/kbrain/sessionSync.ts",
);

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await tick();
  }
  throw new Error("condition timed out");
}

test("focus rescan reissues the live poll without rebuilding the snapshot baseline", async () => {
  let snapshotCreates = 0;
  const changeCalls = [];
  const client = {
    async getCapabilities() {
      return { session_changes: 2 };
    },
    async createSessionSnapshot() {
      snapshotCreates += 1;
      return {
        epoch: "stable-epoch",
        revision: "0",
        snapshot_id: "stable-snapshot",
        total_count: 0,
        expires_in_seconds: 60,
        workdirs: [],
      };
    },
    async getSessionSnapshot() {
      return {
        epoch: "stable-epoch",
        revision: "0",
        snapshot_id: "stable-snapshot",
        total_count: 0,
        sessions: [],
        next_offset: null,
      };
    },
    async releaseSessionSnapshot() {},
    getSessionChanges(params, signal) {
      changeCalls.push({ ...params });
      if (params.wait === 0 || params.rescan) {
        return Promise.resolve({
          epoch: "stable-epoch",
          head_revision: "0",
          next_since: "0",
          reset: false,
          more: false,
          changes: [],
        });
      }
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const sync = createKBrainSessionSync({
    client,
    onSnapshot() {},
    onHealth() {},
    retryMs: 1,
    random: () => 0.5,
  });
  const stop = sync.acquire();
  try {
    await until(() => sync.isHealthy() && changeCalls.some((call) => call.wait === 30));
    sync.requestRescan();
    sync.requestRescan();
    await until(() => changeCalls.some((call) => call.rescan === true));
    assert.equal(snapshotCreates, 1, "rescan must preserve the established snapshot baseline");
    assert.equal(
      changeCalls.filter((call) => call.rescan === true).length,
      1,
      "duplicate focus signals must coalesce into one rescan poll",
    );
    const rescan = changeCalls.find((call) => call.rescan === true);
    assert.equal(rescan.epoch, "stable-epoch");
    assert.equal(rescan.since, "0");
  } finally {
    stop();
  }
});

test("a rate-limited rescan retries the live poll without dropping a healthy baseline", async () => {
  let snapshotCreates = 0;
  let rateLimited = false;
  let liveCalls = 0;
  const health = [];
  const client = {
    async getCapabilities() {
      return { session_changes: 2 };
    },
    async createSessionSnapshot() {
      snapshotCreates += 1;
      return {
        epoch: "stable-epoch",
        revision: "0",
        snapshot_id: `snapshot-${snapshotCreates}`,
        total_count: 0,
        expires_in_seconds: 60,
        workdirs: [],
      };
    },
    async getSessionSnapshot(id) {
      return {
        epoch: "stable-epoch",
        revision: "0",
        snapshot_id: id,
        total_count: 0,
        sessions: [],
        next_offset: null,
      };
    },
    async releaseSessionSnapshot() {},
    getSessionChanges(params, signal) {
      if (params.wait === 0) {
        return Promise.resolve({
          epoch: "stable-epoch",
          head_revision: "0",
          next_since: "0",
          reset: false,
          more: false,
          changes: [],
        });
      }
      liveCalls += 1;
      if (params.rescan && !rateLimited) {
        rateLimited = true;
        const error = Object.assign(new Error("rescan rate limited"), {
          status: 429,
          retryAfterMs: 10,
        });
        return Promise.reject(error);
      }
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const sync = createKBrainSessionSync({
    client,
    onSnapshot() {},
    onHealth(value) {
      health.push(value);
    },
    retryMs: 5,
    random: () => 0.5,
  });
  const stop = sync.acquire();
  try {
    await until(() => sync.isHealthy() && liveCalls === 1);
    sync.requestRescan();
    await until(() => rateLimited && liveCalls >= 3);
    assert.equal(snapshotCreates, 1, "HTTP 429 must not rebuild the snapshot baseline");
    assert.equal(sync.isHealthy(), true);
    assert.deepEqual(health, [true], "retryable rescan throttling must not publish unhealthy");
  } finally {
    stop();
  }
});
