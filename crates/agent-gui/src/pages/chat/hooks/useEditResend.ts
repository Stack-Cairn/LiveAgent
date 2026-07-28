import { type MutableRefObject, useCallback, useRef } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { SendChatAction } from "../gateway/gatewayBridgeTypes";

type UseEditResendParams = {
  isSending: boolean;
  isConversationHydrating: boolean;
  isConversationHydrationFailed: boolean;
  currentConversationIdRef: MutableRefObject<string>;
  onError: (error: unknown) => void;
  sendActionRef: MutableRefObject<SendChatAction>;
};

export function useEditResend(params: UseEditResendParams) {
  const {
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    currentConversationIdRef,
    onError,
    sendActionRef,
  } = params;
  const editResendInFlightRef = useRef(false);

  const handleResendFromEdit = useCallback(
    async (messageRef: HistoryMessageRef, text: string, uploadedFiles: PendingUploadedFile[]) => {
      if (
        editResendInFlightRef.current ||
        isSending ||
        isConversationHydrating ||
        isConversationHydrationFailed
      ) {
        return;
      }
      const normalized = text.trim();
      if (!normalized && uploadedFiles.length === 0) return;

      const conversationId = currentConversationIdRef.current.trim();
      if (!conversationId) return;
      editResendInFlightRef.current = true;
      try {
        const accepted = await sendActionRef.current({
          textOverride: normalized,
          uploadedFilesOverride: uploadedFiles,
          conversationIdOverride: conversationId,
          editResendBaseMessageRef: messageRef,
        });
        if (!accepted) throw new Error("编辑重发未启动，原历史保持不变。");
      } catch (error) {
        onError(error);
      } finally {
        editResendInFlightRef.current = false;
      }
    },
    [
      currentConversationIdRef,
      isConversationHydrationFailed,
      isConversationHydrating,
      isSending,
      onError,
      sendActionRef,
    ],
  );

  return { handleResendFromEdit };
}
