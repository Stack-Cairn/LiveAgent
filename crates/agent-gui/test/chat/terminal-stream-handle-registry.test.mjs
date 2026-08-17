import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createTerminalStreamHandleRegistry } = loader.loadModule(
  "@liveagent/ui/lib/terminal/streamHandleRegistry.ts",
);

function makeHandle() {
  const received = [];
  return {
    received,
    accept(chunk) {
      received.push(chunk);
    },
  };
}

function chunk(sessionId, marker = 0) {
  return {
    sessionId,
    projectPathKey: "",
    bytes: new Uint8Array([marker]),
    startOffset: 0,
    endOffset: 1,
  };
}

test("dispatch routes chunks only to handles of the matching session", () => {
  const registry = createTerminalStreamHandleRegistry();
  const a = makeHandle();
  const b = makeHandle();
  registry.add("session-a", a);
  registry.add("session-b", b);

  registry.dispatch(chunk("session-a", 1));
  registry.dispatch(chunk("session-b", 2));
  registry.dispatch(chunk("session-unknown", 3));

  assert.equal(a.received.length, 1);
  assert.equal(a.received[0].bytes[0], 1);
  assert.equal(b.received.length, 1);
  assert.equal(b.received[0].bytes[0], 2);
});

test("multiple handles on one session all receive the chunk (defensive overlap)", () => {
  const registry = createTerminalStreamHandleRegistry();
  const first = makeHandle();
  const second = makeHandle();
  registry.add("session-a", first);
  registry.add("session-a", second);

  registry.dispatch(chunk("session-a"));

  assert.equal(first.received.length, 1);
  assert.equal(second.received.length, 1);
  assert.equal(registry.handleCount("session-a"), 2);
});

test("remove detaches a handle and empties the bucket", () => {
  const registry = createTerminalStreamHandleRegistry();
  const handle = makeHandle();
  registry.add("session-a", handle);
  assert.equal(registry.sessionCount(), 1);

  registry.remove("session-a", handle);
  registry.dispatch(chunk("session-a"));

  assert.equal(handle.received.length, 0);
  assert.equal(registry.handleCount("session-a"), 0);
  assert.equal(registry.sessionCount(), 0);
});

test("remove is a no-op for unknown session or handle", () => {
  const registry = createTerminalStreamHandleRegistry();
  const handle = makeHandle();
  registry.add("session-a", handle);

  registry.remove("session-unknown", handle);
  registry.remove("session-a", makeHandle());

  assert.equal(registry.handleCount("session-a"), 1);
});

test("add ignores blank session ids and trims keys", () => {
  const registry = createTerminalStreamHandleRegistry();
  const handle = makeHandle();
  registry.add("   ", handle);
  assert.equal(registry.sessionCount(), 0);

  registry.add(" session-a ", handle);
  registry.dispatch(chunk("session-a"));
  assert.equal(handle.received.length, 1);
});

test("a handle removing itself during dispatch does not break iteration", () => {
  const registry = createTerminalStreamHandleRegistry();
  const other = makeHandle();
  const selfRemoving = {
    received: [],
    accept(c) {
      this.received.push(c);
      registry.remove("session-a", selfRemoving);
    },
  };
  registry.add("session-a", selfRemoving);
  registry.add("session-a", other);

  registry.dispatch(chunk("session-a"));

  assert.equal(selfRemoving.received.length, 1);
  assert.equal(other.received.length, 1);
  assert.equal(registry.handleCount("session-a"), 1);

  registry.dispatch(chunk("session-a"));
  assert.equal(selfRemoving.received.length, 1);
  assert.equal(other.received.length, 2);
});
