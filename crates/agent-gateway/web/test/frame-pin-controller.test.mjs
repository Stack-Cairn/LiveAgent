import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({ rootDir: fileURLToPath(new URL("../", import.meta.url)) });
const { createFramePinController } = loader.loadModule(
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
  callbacks.shift()();
  assert.equal(writes, 1);
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
