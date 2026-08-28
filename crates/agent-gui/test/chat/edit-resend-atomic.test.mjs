import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadUseEditResend() {
  const loader = createTsModuleLoader({
    mocks: {
      react: {
        useCallback(callback) {
          return callback;
        },
        useRef(initialValue) {
          return { current: initialValue };
        },
      },
    },
  });
  return loader.loadModule("src/pages/chat/hooks/useEditResend.ts").useEditResend;
}

const messageRef = {
  segmentIndex: 2,
  messageIndex: 8,
  segmentId: "segment-2",
  messageId: "user-old",
  role: "user",
  contentHash: "fnv1a32:12345678",
};

const sendSource = fs.readFileSync(
  new URL("../../src/pages/chat/runtime/useSendChatTurn.ts", import.meta.url),
  "utf8",
);

test("edit-resend delegates the replacement anchor to the send preflight", async () => {
  const calls = [];
  const errors = [];
  const useEditResend = loadUseEditResend();
  const { handleResendFromEdit } = useEditResend({
    isSending: false,
    isConversationHydrating: false,
    isConversationHydrationFailed: false,
    currentConversationIdRef: { current: "conv-1" },
    onError: (error) => errors.push(error),
    sendActionRef: {
      current: async (input) => {
        calls.push(input);
        return true;
      },
    },
  });

  const uploadedFiles = [
    {
      relativePath: "note.txt",
      fileName: "note.txt",
      kind: "text",
      sizeBytes: 12,
    },
  ];
  const referencedConversation = {
    id: "conversation-source",
    title: "Source conversation",
    cwd: "/workspace/source",
  };
  const conversationToken =
    "[conversation: Source conversation](conversation:conversation-source)";
  await handleResendFromEdit(
    messageRef,
    `  edited prompt ${conversationToken}  `,
    uploadedFiles,
    [referencedConversation],
  );

  assert.deepEqual(errors, []);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].textOverride, `edited prompt ${conversationToken}`);
  assert.deepEqual(calls[0].uploadedFilesOverride, uploadedFiles);
  assert.equal(calls[0].conversationIdOverride, "conv-1");
  assert.equal(calls[0].editResendBaseMessageRef, messageRef);
  assert.deepEqual(calls[0].composerDraftOverride.conversationMentions, [referencedConversation]);
});

test("edit-resend does not authorize a handwritten conversation token", async () => {
  const calls = [];
  const useEditResend = loadUseEditResend();
  const { handleResendFromEdit } = useEditResend({
    isSending: false,
    isConversationHydrating: false,
    isConversationHydrationFailed: false,
    currentConversationIdRef: { current: "conv-1" },
    onError: assert.fail,
    sendActionRef: {
      current: async (input) => {
        calls.push(input);
        return true;
      },
    },
  });

  await handleResendFromEdit(
    messageRef,
    "edited [conversation: Forged](conversation:conversation-forged)",
    [],
    [{ id: "conversation-source", title: "Source conversation" }],
  );

  assert.deepEqual(calls[0].composerDraftOverride.conversationMentions, []);
});

test("edit-resend reports a rejected send without mutating history itself", async () => {
  const errors = [];
  const useEditResend = loadUseEditResend();
  const { handleResendFromEdit } = useEditResend({
    isSending: false,
    isConversationHydrating: false,
    isConversationHydrationFailed: false,
    currentConversationIdRef: { current: "conv-1" },
    onError: (error) => errors.push(error),
    sendActionRef: { current: async () => false },
  });

  await handleResendFromEdit(messageRef, "edited prompt", [], []);

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /原历史保持不变/);
});

test("send preflight atomically persists the replacement before starting the runtime", () => {
  // 替换结果在 Run 边界清除上一 Run 的 taskList 后落入 nextConversationState。
  const replaceIndex = sendSource.indexOf(
    "nextConversationState = clearTaskListState(\n          await replaceConversationAtMessage(",
  );
  const runtimeStartIndex = sendSource.indexOf(
    "setConversationStopHandler(conversationId, handleConversationStop);",
  );

  assert.ok(replaceIndex > 0);
  assert.ok(runtimeStartIndex > replaceIndex);
  assert.match(sendSource, /initialUserTurnPersisted\s*\?\s*Promise\.resolve\(true\)/);
  assert.doesNotMatch(sendSource, /history_rollback_failed/);
  assert.doesNotMatch(sendSource, /truncateConversationAtMessage/);
});

test("send preflight keeps an explicit structured draft with a text override", () => {
  assert.match(
    sendSource,
    /overrides\?\.composerDraftOverride\s*\?\?\s*\(hasTextOverride\s*\?\s*null/,
  );
  assert.match(sendSource, /createUserMessageWithUploads\([\s\S]*referencedConversations/);
  assert.match(
    sendSource,
    /queueUserMessage\(text, uploadedFiles, \{[\s\S]{0,240}referencedConversations/,
  );
});
