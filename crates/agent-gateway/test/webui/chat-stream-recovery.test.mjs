import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

test("chat stream recovery detects released attach streams", () => {
  const loader = createWebModuleLoader();
  const {
    isChatStreamNotAvailableEvent,
    isChatStreamNotAvailableMessage,
    resolveChatStreamUnavailableRecoveryAction,
    shouldHydrateRestoredConversationSnapshot,
  } = loader.loadModule("src/lib/chatStreamRecovery.ts");

  assert.equal(isChatStreamNotAvailableMessage("chat stream not available"), true);
  assert.equal(
    isChatStreamNotAvailableMessage(new Error("Error: chat stream not available")),
    true,
  );
  assert.equal(isChatStreamNotAvailableMessage("chat request failed"), false);

  assert.equal(
    isChatStreamNotAvailableEvent({
      type: "error",
      message: "chat stream not available",
      conversation_id: "conversation-1",
    }),
    true,
  );
  assert.equal(
    isChatStreamNotAvailableEvent({
      type: "done",
      conversation_id: "conversation-1",
    }),
    false,
  );
  assert.equal(
    resolveChatStreamUnavailableRecoveryAction("conversation-1"),
    "refresh-history-snapshot",
  );
  assert.equal(
    resolveChatStreamUnavailableRecoveryAction("__local_draft__:conversation-1"),
    "reload-history",
  );

  assert.equal(
    shouldHydrateRestoredConversationSnapshot({
      currentEntries: [{ id: "local-user", kind: "user", text: "hello", attachments: [] }],
      liveEntries: [{ id: "live-assistant", kind: "assistant", text: "partial", round: 1 }],
      historyEntries: [
        { id: "history-user", kind: "user", text: "hello", attachments: [] },
        { id: "history-assistant", kind: "assistant", text: "partial and final", round: 1 },
      ],
    }),
    true,
  );

  assert.equal(
    shouldHydrateRestoredConversationSnapshot({
      currentEntries: [{ id: "local-user", kind: "user", text: "hello", attachments: [] }],
      historyEntries: [{ id: "history-user", kind: "user", text: "hello", attachments: [] }],
    }),
    false,
  );

  assert.equal(
    shouldHydrateRestoredConversationSnapshot({
      currentEntries: [{ id: "local-user", kind: "user", text: "hello", attachments: [] }],
      liveEntries: [
        { id: "live-assistant", kind: "assistant", text: "partial text that is newer", round: 1 },
      ],
      historyEntries: [
        { id: "history-user", kind: "user", text: "hello", attachments: [] },
        { id: "history-assistant", kind: "assistant", text: "partial", round: 1 },
      ],
    }),
    false,
  );
});
