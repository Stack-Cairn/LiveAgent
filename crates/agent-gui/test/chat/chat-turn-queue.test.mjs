import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const queue = loader.loadModule("src/pages/chat/queue/chatTurnQueue.ts");

function draft(text, segments = [{ type: "text", text }]) {
  return {
    segments,
    text,
    textWithoutLargePastes: text,
    largePastes: [],
    skillMentions: [],
    commitMentions: [],
    gitFileMentions: [],
    isEmpty: text.trim() === "",
  };
}

function turn(id, conversationId, text) {
  return queue.createQueuedChatTurn({
    id,
    conversationId,
    draft: draft(text),
    uploadedFiles: [],
    executionMode: "tools",
    workdir: "/workspace",
    runtimeControls: {
      thinkingEnabled: false,
      reasoning: "off",
      nativeWebSearchEnabled: false,
    },
    createdAt: 1,
  });
}

test("queued chat turns append, promote, remove, and take the next turn", () => {
  const first = turn("a1", "conversation-a", "first");
  const second = turn("a2", "conversation-a", "second");

  const appended = queue.appendQueuedChatTurn(queue.appendQueuedChatTurn([], first), second);
  assert.deepEqual(
    appended.map((item) => item.id),
    ["a1", "a2"],
  );

  const promoted = queue.promoteQueuedChatTurn(appended, "a2");
  assert.deepEqual(
    promoted.map((item) => item.id),
    ["a2", "a1"],
  );

  const taken = queue.takeNextQueuedChatTurn(promoted, "conversation-a");
  assert.equal(taken.item.id, "a2");
  assert.deepEqual(
    taken.queue.map((item) => item.id),
    ["a1"],
  );

  assert.deepEqual(queue.removeQueuedChatTurn(taken.queue, "a1"), []);
});

test("queued gateway turns preserve per-request Skills overrides", () => {
  const queued = queue.createQueuedChatTurn({
    ...turn("gateway-1", "conversation-a", "queued"),
    gatewayRequest: {
      requestId: "request-1",
      skillPresetId: "focused",
      skillsDisabled: true,
    },
  });

  assert.equal(queued.gatewayRequest.skillPresetId, "focused");
  assert.equal(queued.gatewayRequest.skillsDisabled, true);
});

test("queued chat turn movement stays scoped to the same conversation", () => {
  const mixed = [
    turn("a1", "conversation-a", "a one"),
    turn("b1", "conversation-b", "b one"),
    turn("a2", "conversation-a", "a two"),
  ];

  const moved = queue.moveQueuedChatTurn(mixed, "a2", "up");
  assert.deepEqual(
    moved.map((item) => item.id),
    ["a2", "b1", "a1"],
  );
});

test("edited queued chat turns return to their original priority slot", () => {
  const first = turn("a1", "conversation-a", "first");
  const second = turn("a2", "conversation-a", "second");
  const third = turn("a3", "conversation-a", "third");
  const editedSecond = turn("a2", "conversation-a", "edited second");

  const reinserted = queue.insertQueuedChatTurnAtSlot([first, third], editedSecond, {
    conversationId: "conversation-a",
    previousId: "a1",
    nextId: "a3",
    index: 1,
  });

  assert.deepEqual(
    reinserted.map((item) => item.id),
    ["a1", "a2", "a3"],
  );
  assert.equal(reinserted[1].draft.text, "edited second");
});

test("edited queued chat turns keep their scoped priority when anchors disappear", () => {
  const remaining = turn("a4", "conversation-a", "remaining");
  const editedSecond = turn("a2", "conversation-a", "edited second");

  const reinserted = queue.insertQueuedChatTurnAtSlot([remaining], editedSecond, {
    conversationId: "conversation-a",
    previousId: "missing-previous",
    nextId: null,
    index: 1,
  });

  assert.deepEqual(
    reinserted.map((item) => item.id),
    ["a4", "a2"],
  );
});

test("queued chat turn preview keeps structured draft hints compact", () => {
  const richDraft = draft("hello long paste", [
    { type: "text", text: "hello " },
    {
      type: "largePaste",
      paste: {
        id: "paste-1",
        label: "pasted.txt",
        text: "large paste body",
        charCount: 16,
        lineCount: 1,
        preview: "large paste body",
      },
    },
    {
      type: "skillMention",
      skill: {
        name: "reviewer",
        description: "",
        skillFile: "SKILL.md",
        baseDir: "/skills/reviewer",
      },
    },
  ]);

  assert.equal(queue.buildQueuedChatTurnPreview(richDraft), "hello pasted.txt$reviewer");
  assert.equal(queue.queuedChatTurnHasContent(richDraft, []), true);
  assert.equal(queue.queuedChatTurnHasContent(draft(""), [{ fileName: "a.txt" }]), true);
});
