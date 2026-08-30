import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const drag = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/chat/conversationReferenceDrag.ts",
);
const sidebarRowsSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHistorySidebarRows.tsx", import.meta.url),
  "utf8",
);
const composerBarSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);
const mentionComposerSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/MentionComposer.tsx", import.meta.url),
  "utf8",
);

function fakeDataTransfer() {
  const values = new Map();
  return {
    effectAllowed: "none",
    get types() {
      return [...values.keys()];
    },
    setData(type, value) {
      values.set(type, value);
    },
    getData(type) {
      return values.get(type) ?? "";
    },
  };
}

test("conversation drag payload round-trips a cross-project structured reference", () => {
  const dataTransfer = fakeDataTransfer();
  assert.equal(
    drag.writeConversationReferenceDragPayload(dataTransfer, {
      id: " history-2 ",
      title: "  Other   project  ",
      cwd: "/workspace/other-project",
      updatedAt: 123,
    }),
    true,
  );

  assert.equal(dataTransfer.effectAllowed, "copy");
  assert.equal(drag.hasConversationReferenceDragPayload(dataTransfer), true);
  assert.deepEqual(drag.readConversationReferenceDragPayload(dataTransfer), {
    id: "history-2",
    title: "Other project",
    cwd: "/workspace/other-project",
    updatedAt: 123,
  });
  assert.deepEqual(drag.getActiveConversationReferenceDrag(), {
    id: "history-2",
    title: "Other project",
    cwd: "/workspace/other-project",
    updatedAt: 123,
  });

  drag.clearActiveConversationReferenceDrag();
  assert.equal(drag.getActiveConversationReferenceDrag(), null);
});

test("conversation drag payload rejects malformed data", () => {
  const dataTransfer = fakeDataTransfer();
  dataTransfer.setData(drag.CONVERSATION_REFERENCE_DRAG_MIME, "not-json");
  assert.equal(drag.readConversationReferenceDragPayload(dataTransfer), null);
  assert.equal(
    drag.writeConversationReferenceDragPayload(dataTransfer, { id: "", title: "Missing id" }),
    false,
  );
});

test("shared sidebar and composer wire native drag to a structured mention insertion", () => {
  assert.match(sidebarRowsSource, /writeConversationReferenceDragPayload/);
  assert.match(sidebarRowsSource, /draggable=\{!onWorkbenchDragIntent && !item\.isPending\}/);
  assert.match(composerBarSource, /data-conversation-reference-drop-zone/);
  assert.match(composerBarSource, /readConversationReferenceDragPayload/);
  assert.match(composerBarSource, /insertConversationMention\(reference\)/);
  assert.match(mentionComposerSource, /insertConversationMention:/);
});
