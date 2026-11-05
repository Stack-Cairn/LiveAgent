import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// The desktop stamps whether it has the question pending on the synced tool call.
// K-brain sends the tool call before the question registers (AI review or an
// approval can sit in between), so WebUI must not offer the card until then.
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const shared = loader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts");
const adapter = loader.loadModule("src/agent-ui-adapters/assistantBubble.ts");

test("the pending marker reads only booleans", () => {
  const key = shared.ASK_USER_QUESTION_PENDING_ARG;
  assert.equal(shared.readAskUserQuestionPendingMarker({ [key]: true }), true);
  assert.equal(shared.readAskUserQuestionPendingMarker({ [key]: false }), false);
  assert.equal(shared.readAskUserQuestionPendingMarker({ [key]: "false" }), null);
  assert.equal(shared.readAskUserQuestionPendingMarker({}), null);
  assert.equal(shared.readAskUserQuestionPendingMarker(null), null);
});

test("WebUI answers only while the desktop has the question pending", () => {
  const key = shared.ASK_USER_QUESTION_PENDING_ARG;
  assert.equal(adapter.useAskUserQuestionPending("call", { [key]: false }), false);
  assert.equal(adapter.useAskUserQuestionPending("call", { [key]: true }), true);
  // Desktops that predate the marker keep the card answerable as before.
  assert.equal(adapter.useAskUserQuestionPending("call", { questions: [] }), true);
});

test("the marker stays out of the displayed tool arguments", () => {
  const { toolCallArgsForDisplay } = loader.loadModule("@liveagent/ui/lib/chat/uiMessages.ts");
  const display = toolCallArgsForDisplay({
    type: "toolCall",
    id: "call",
    name: "AskUserQuestion",
    arguments: { questions: [], [shared.ASK_USER_QUESTION_PENDING_ARG]: true },
  });
  assert.equal(shared.ASK_USER_QUESTION_PENDING_ARG in display, false);
});
