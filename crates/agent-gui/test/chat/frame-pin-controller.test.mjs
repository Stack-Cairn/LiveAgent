import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { createFramePinController } = createTsModuleLoader().loadModule(
  "src/lib/chat-scroll/framePinController.ts",
);

test("coalesces repeated live growth into one pin per frame", () => {
  const callbacks = [];
  let writes = 0;
  const controller = createFramePinController(
    () => {
      writes += 1;
    },
    (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    () => {},
  );

  controller.schedule();
  controller.schedule();
  controller.schedule();
  assert.equal(callbacks.length, 1);
  assert.equal(writes, 0);
  callbacks.shift()();
  assert.equal(writes, 1);

  controller.schedule();
  assert.equal(callbacks.length, 1);
});

test("a queued growth pin cannot reclaim a detached reader", () => {
  const callbacks = [];
  let following = true;
  let writes = 0;
  const controller = createFramePinController(
    () => {
      writes += 1;
    },
    (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    () => {},
    () => following,
  );

  controller.schedule();
  following = false;
  callbacks.shift()();
  assert.equal(writes, 0);

  following = true;
  controller.schedule();
  callbacks.shift()();
  assert.equal(writes, 1);
});

test("an immediate pin cancels the queued frame and writes once", () => {
  const callbacks = [];
  const cancelled = [];
  let writes = 0;
  const controller = createFramePinController(
    () => {
      writes += 1;
    },
    (callback) => {
      callbacks.push(callback);
      return callbacks.length;
    },
    (handle) => cancelled.push(handle),
  );
  controller.schedule();
  controller.flush();
  assert.deepEqual(cancelled, [1]);
  assert.equal(writes, 1);
});
