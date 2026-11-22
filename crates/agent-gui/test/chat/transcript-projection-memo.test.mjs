import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// createTranscriptProjection memoizes timeline items per message group. A
// re-projection of the same message objects must return the same items by
// identity, a changed or moved group must be rebuilt, and every result must
// equal a projection of fresh copies of the messages.

const loader = createTsModuleLoader();
const { createTranscriptProjection, getHistoryMessageContentHash } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);

function conversation(turns) {
  const messages = [];
  let timestamp = 1_700_000_000_000;
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ id: `u${turn}`, role: "user", content: `question ${turn} 中文`, timestamp: ++timestamp });
    messages.push({
      id: `a${turn}`,
      role: "assistant",
      content: [
        { type: "text", text: `answer ${turn}` },
        { type: "toolCall", id: `c${turn}`, name: "Bash", arguments: { command: "ls" } },
      ],
      stopReason: "toolUse",
      timestamp: ++timestamp,
    });
    messages.push({
      role: "toolResult",
      toolCallId: `c${turn}`,
      toolName: "Bash",
      content: [{ type: "text", text: `output ${turn}` }],
      isError: false,
      timestamp: ++timestamp,
    });
  }
  return messages;
}

function project(messages, { segmentIndex = 0, activeSegmentIndex = 0, startMessageIndex = 0 } = {}) {
  return createTranscriptProjection({
    segments: [
      {
        segmentIndex,
        segmentId: `seg-${segmentIndex}`,
        messages,
        startMessageIndex,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    activeSegmentIndex,
    oldestMessageOffset: 0,
    hasMoreBefore: false,
    revision: null,
  }).items;
}

const fresh = (messages, options) => project(structuredClone(messages), options);

test("re-projecting the same messages reuses every item and matches a fresh build", () => {
  const messages = conversation(20);
  const first = project(messages);
  const second = project(messages);
  assert.equal(second.length, 40);
  assert.ok(second.every((item, index) => item === first[index]));
  assert.deepEqual(second, fresh(messages));
  assert.equal(
    second[0].messageRef.contentHash,
    getHistoryMessageContentHash(messages[0]),
    "user items still carry the message's content hash",
  );
});

test("a replaced message rebuilds only its group", () => {
  const messages = conversation(5);
  const before = project(messages);
  const edited = messages.slice();
  edited[7] = { ...edited[7], content: [{ type: "text", text: "a different answer" }] };
  const after = project(edited);
  assert.deepEqual(after, fresh(edited));
  const changed = after.map((item, index) => item !== before[index]);
  // Items: u0 a0 u1 a1 u2 a2 ... message 7 is turn 2's assistant reply (item 5).
  assert.deepEqual(
    changed.map((value, index) => (value ? index : -1)).filter((index) => index >= 0),
    [5],
  );
  assert.match(JSON.stringify(after[5].rounds), /a different answer/);
});

test("appending to the trailing group rebuilds it and keeps the earlier items", () => {
  const messages = conversation(4);
  const before = project(messages);
  const appended = [
    ...messages,
    { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", timestamp: 1 },
  ];
  const after = project(appended);
  assert.deepEqual(after, fresh(appended));
  assert.ok(after.slice(0, -1).every((item, index) => item === before[index]));
  assert.notEqual(after.at(-1), before.at(-1));
});

test("a different segment position or compaction state does not reuse items", () => {
  const messages = conversation(3);
  const active = project(messages);
  const compacted = project(messages, { activeSegmentIndex: 1 });
  assert.ok(compacted.every((item) => item.isFromCompactedSegment === true));
  assert.ok(compacted.every((item, index) => item !== active[index]));
  assert.deepEqual(compacted, fresh(messages, { activeSegmentIndex: 1 }));

  // The same messages as a window starting at message 30: new indexes and keys.
  const shifted = project(messages, { startMessageIndex: 30 });
  assert.deepEqual(shifted, fresh(messages, { startMessageIndex: 30 }));
  assert.equal(shifted[1].messageIndex, 31);
});

test("the content hash of long multi-byte text is unchanged", () => {
  // Computed with the previous for...of byte loop.
  assert.equal(
    getHistoryMessageContentHash({ role: "user", content: "x中🙂".repeat(5000), timestamp: 1 }),
    "fnv1a32:213d9481",
  );
});
