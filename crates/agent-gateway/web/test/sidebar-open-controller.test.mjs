import assert from "node:assert/strict";
import test from "node:test";

import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { createConversationOpenController } = loader.loadModule("src/lib/sidebar/openController.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness(overrides = {}) {
  const states = [];
  const calls = { openInitial: [], hydrateFull: [] };
  const controller = createConversationOpenController({
    openInitial: async (id, seq) => {
      calls.openInitial.push({ id, seq });
      return overrides.openInitial ? overrides.openInitial(id, seq) : "painted";
    },
    hydrateFull: async (id, seq) => {
      calls.hydrateFull.push({ id, seq });
      if (overrides.hydrateFull) {
        return overrides.hydrateFull(id, seq);
      }
    },
    scheduleIdle: (task) => {
      const timer = setTimeout(task, 0);
      return () => clearTimeout(timer);
    },
    onStateChange: (state) => {
      states.push(state);
    },
    overlayDelayMs: overrides.overlayDelayMs ?? 20,
  });
  return { controller, states, calls };
}

test("cache hit resolves synchronously with no overlay and no hydration", async () => {
  const { controller, states, calls } = createHarness({
    openInitial: async () => "cache-hit",
  });
  controller.open("conv");
  await sleep(60);
  assert.equal(states.some((state) => state.showOverlay), false);
  assert.equal(states.at(-1).phase, "ready");
  assert.equal(states.at(-1).errorCode, null);
  assert.equal(calls.hydrateFull.length, 0);
});

test("slow open shows the overlay only after the delay, then hydrates at idle", async () => {
  const { controller, states, calls } = createHarness({
    openInitial: async () => {
      await sleep(50);
      return "painted";
    },
  });
  controller.open("conv");
  await sleep(5);
  assert.equal(states.some((state) => state.showOverlay), false);
  await sleep(30);
  assert.equal(states.some((state) => state.showOverlay), true);
  await sleep(60);
  assert.equal(states.at(-1).phase, "ready");
  assert.deepEqual(calls.hydrateFull, [{ id: "conv", seq: 1 }]);
});

test("rapid switches invalidate the earlier open", async () => {
  const resolvers = new Map();
  const { controller, states, calls } = createHarness({
    openInitial: (id) =>
      new Promise((resolve) => {
        resolvers.set(id, resolve);
      }),
  });
  controller.open("first");
  controller.open("second");
  resolvers.get("first")("painted");
  resolvers.get("second")("painted");
  await sleep(20);

  assert.equal(calls.openInitial.length, 2);
  // Only the second open may hydrate; the first resolution was stale.
  assert.deepEqual(calls.hydrateFull, [{ id: "second", seq: 2 }]);
  assert.equal(states.at(-1).conversationId, "second");
  assert.equal(states.at(-1).phase, "ready");
});

test("initial-slice failure surfaces openFailed", async () => {
  const { controller, states } = createHarness({
    openInitial: async () => {
      throw new Error("nope");
    },
  });
  controller.open("conv");
  await sleep(10);
  assert.equal(states.at(-1).phase, "failed");
  assert.equal(states.at(-1).errorCode, "openFailed");
  assert.equal(states.at(-1).showOverlay, false);
});

test("full-hydration failure keeps the paint and flags openFullFailed", async () => {
  const { controller, states } = createHarness({
    hydrateFull: async () => {
      throw new Error("tail failed");
    },
  });
  controller.open("conv");
  await sleep(30);
  assert.equal(states.at(-1).phase, "ready");
  assert.equal(states.at(-1).errorCode, "openFullFailed");
});

test("cancel resets to idle and invalidates in-flight work", async () => {
  let resolveOpen;
  const { controller, states, calls } = createHarness({
    openInitial: () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  });
  controller.open("conv");
  controller.cancel();
  resolveOpen("painted");
  await sleep(10);
  assert.equal(states.at(-1).phase, "idle");
  assert.equal(calls.hydrateFull.length, 0);
});
