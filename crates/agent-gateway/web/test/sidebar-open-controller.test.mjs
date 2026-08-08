import assert from "node:assert/strict";
import test from "node:test";

import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const { createConversationOpenController } = loader.loadModule("@liveagent/ui/lib/sidebar/openController.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createHarness(overrides = {}) {
  const states = [];
  const calls = [];
  const controller = createConversationOpenController({
    openInitial: async (id) => {
      calls.push(id);
      return overrides.openInitial ? overrides.openInitial(id) : "painted";
    },
    onStateChange: (state) => {
      states.push(state);
    },
    overlayDelayMs: overrides.overlayDelayMs ?? 20,
  });
  return { controller, states, calls };
}

test("window-only cache hit becomes ready without showing the overlay", async () => {
  const { controller, states, calls } = createHarness({
    openInitial: async () => "cache-hit",
  });
  controller.open("conv");
  await sleep(0);

  assert.deepEqual(calls, ["conv"]);
  assert.deepEqual(
    states.map(({ phase, showOverlay }) => ({ phase, showOverlay })),
    [
      { phase: "opening", showOverlay: false },
      { phase: "ready", showOverlay: false },
    ],
  );
  assert.equal(states.some((state) => state.showOverlay), false);
  assert.equal(states.at(-1).phase, "ready");
  assert.equal(states.at(-1).errorCode, null);
});

test("painted history window becomes ready with no secondary phase", async () => {
  const { controller, states } = createHarness();
  controller.open("conv");
  await sleep(0);

  assert.equal(states.at(-1).phase, "ready");
  assert.equal(states.at(-1).errorCode, null);
  assert.deepEqual(
    [...new Set(states.map((state) => state.phase))],
    ["opening", "ready"],
  );
});

test("slow window load shows the delayed overlay and clears it when painted", async () => {
  let resolveOpen;
  const { controller, states } = createHarness({
    overlayDelayMs: 5,
    openInitial: () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  });
  controller.open("conv");
  await sleep(15);

  assert.deepEqual(states.at(-1), {
    conversationId: "conv",
    phase: "opening",
    showOverlay: true,
    errorCode: null,
  });

  resolveOpen("painted");
  await sleep(0);
  assert.equal(states.at(-1).phase, "ready");
  assert.equal(states.at(-1).showOverlay, false);
});

test("rapid switches ignore an earlier window result", async () => {
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
  await sleep(0);

  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(states.at(-1).conversationId, "second");
  assert.equal(states.at(-1).phase, "opening");

  resolvers.get("second")("painted");
  await sleep(0);

  assert.equal(states.at(-1).conversationId, "second");
  assert.equal(states.at(-1).phase, "ready");
  assert.equal(controller.getSequence(), 2);
});

test("window load failure surfaces openFailed", async () => {
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

test("cancel resets to idle and invalidates an in-flight window load", async () => {
  let resolveOpen;
  const { controller, states } = createHarness({
    openInitial: () =>
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
  });
  controller.open("conv");
  controller.cancel();
  resolveOpen("painted");
  await sleep(0);

  assert.equal(states.at(-1).phase, "idle");
  assert.deepEqual(controller.getState(), {
    conversationId: "",
    phase: "idle",
    showOverlay: false,
    errorCode: null,
  });
});
