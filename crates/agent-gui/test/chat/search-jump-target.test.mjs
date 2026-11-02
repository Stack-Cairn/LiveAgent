import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loadModule = () =>
  createTsModuleLoader().loadModule("@liveagent/ui/lib/chat/searchJumpTarget");

const items = [
  { kind: "assistant", key: "a0", messageIndex: 0 },
  { kind: "user", key: "u2", messageId: "m2", messageIndex: 2 },
  { kind: "assistant", key: "a3", messageIndex: 3 },
  { kind: "checkpoint", key: "c" },
  { kind: "user", key: "u8", messageId: "m8", messageIndex: 8 },
  { kind: "assistant", key: "a9", messageIndex: 9 },
];

test("search jump resolves user rows by messageId first", () => {
  const { resolveSearchJumpRowKey } = loadModule();
  assert.equal(resolveSearchJumpRowKey(items, { conversationId: "c", messageId: "m8", messageIndex: 2 }), "u8");
});

test("search jump falls back to messageIndex and maps assistant ranges to the preceding user", () => {
  const { resolveSearchJumpRowKey } = loadModule();
  const r = (messageIndex) => resolveSearchJumpRowKey(items, { conversationId: "c", messageId: "gone", messageIndex });
  assert.equal(r(2), "u2");
  assert.equal(r(5), "u2");
  assert.equal(r(8), "u8");
  assert.equal(r(42), "u8");
});

test("search jump returns null before the first user row or outside the loaded window", () => {
  const { resolveSearchJumpRowKey } = loadModule();
  assert.equal(resolveSearchJumpRowKey(items, { conversationId: "c", messageIndex: 1 }), null);
  assert.equal(resolveSearchJumpRowKey(items.slice(1), { conversationId: "c", messageIndex: 0 }), null);
  assert.equal(resolveSearchJumpRowKey([], { conversationId: "c", messageId: "m2" }), null);
});

test("search jump target is scoped to its conversation and cleared once consumed", () => {
  const mod = loadModule();
  mod.setSearchJumpTarget({ conversationId: "c1", messageId: "m" });
  assert.equal(mod.peekSearchJumpTarget("c2"), null);
  const target = mod.peekSearchJumpTarget("c1");
  assert.equal(target?.messageId, "m");
  mod.clearSearchJumpTarget(target);
  assert.equal(mod.peekSearchJumpTarget("c1"), null);
  mod.setSearchJumpTarget({ conversationId: "c1" });
  assert.equal(mod.peekSearchJumpTarget("c1"), null);
});

test("search jump target notifies subscribers so an already-open conversation can jump", () => {
  const mod = loadModule();
  let calls = 0;
  const unsubscribe = mod.subscribeSearchJumpTarget(() => {
    calls += 1;
  });
  mod.setSearchJumpTarget({ conversationId: "c1", messageIndex: 4 });
  assert.equal(calls, 1);
  assert.equal(mod.getSearchJumpTargetSnapshot()?.messageIndex, 4);
  unsubscribe();
  mod.setSearchJumpTarget(null);
  assert.equal(calls, 1);
});
