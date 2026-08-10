import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

// The chat turn queue itself lives in the desktop GUI (the gateway relays
// snapshots); the web module keeps only the composer-side content check.
const loader = createWebModuleLoader();
const { queuedChatTurnHasContent } = loader.loadModule(
  "@liveagent/ui/lib/chat/queuedChatTurn.ts",
);

function draft(overrides = {}) {
  return {
    isEmpty: false,
    text: "hello",
    textWithoutLargePastes: "hello",
    largePastes: [],
    segments: [{ type: "text", text: "hello" }],
    ...overrides,
  };
}

test("queuedChatTurnHasContent accepts drafts with text", () => {
  assert.equal(queuedChatTurnHasContent(draft(), []), true);
});

test("queuedChatTurnHasContent accepts empty drafts with uploads", () => {
  const uploads = [
    {
      relativePath: "notes.md",
      absolutePath: "/workspace/notes.md",
      fileName: "notes.md",
      kind: "text",
      sizeBytes: 12,
    },
  ];
  assert.equal(queuedChatTurnHasContent(draft({ isEmpty: true, text: "" }), uploads), true);
});

test("queuedChatTurnHasContent rejects missing or empty drafts", () => {
  assert.equal(queuedChatTurnHasContent(null, []), false);
  assert.equal(queuedChatTurnHasContent(undefined, []), false);
  assert.equal(queuedChatTurnHasContent(draft({ isEmpty: true, text: "   " }), []), false);
});

test("queuedChatTurnHasContent treats structured-only drafts as content", () => {
  assert.equal(
    queuedChatTurnHasContent(draft({ isEmpty: false, text: "" }), []),
    true,
    "non-empty draft flag wins even without plain text",
  );
});
