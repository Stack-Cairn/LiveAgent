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
  await handleResendFromEdit(messageRef, "  edited prompt  ", uploadedFiles);

  assert.deepEqual(errors, []);
  assert.deepEqual(calls, [
    {
      textOverride: "edited prompt",
      uploadedFilesOverride: uploadedFiles,
      conversationIdOverride: "conv-1",
      editResendBaseMessageRef: messageRef,
    },
  ]);
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

  await handleResendFromEdit(messageRef, "edited prompt", []);

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /原历史保持不变/);
});

test("send preflight atomically persists the replacement before starting the runtime", () => {
  const replaceIndex = sendSource.indexOf(
    "nextConversationState = await replaceConversationAtMessage(",
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
