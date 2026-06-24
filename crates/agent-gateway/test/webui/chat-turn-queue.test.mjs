import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
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
    workdir: "/workspace",
    runtimeControls: {
      thinkingEnabled: false,
      reasoning: "off",
      nativeWebSearchEnabled: false,
    },
    createdAt: 1,
  });
}

test("gateway web queued chat turns append, promote, remove, and take the next turn", () => {
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

test("gateway web queued chat turn movement stays scoped to the same conversation", () => {
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

test("gateway web edited queued chat turns return to their original priority slot", () => {
  const first = turn("a1", "conversation-a", "first");
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

test("gateway web queued chat turn preview keeps structured draft hints compact", () => {
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
      type: "fileMention",
      reference: {
        path: "src/notes.txt",
        kind: "file",
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

  assert.equal(queue.buildQueuedChatTurnPreview(richDraft), "hello pasted.txtnotes.txt$reviewer");
  assert.equal(queue.queuedChatTurnHasContent(richDraft, []), true);
  assert.equal(queue.queuedChatTurnHasContent(draft(""), [{ fileName: "a.txt" }]), true);
});
