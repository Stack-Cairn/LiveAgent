import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import { type MutableRefObject, useCallback, useRef } from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { createTextComposerDraft } from "../composer/composerDraftText";
import type { SendChatAction } from "../gateway/gatewayBridgeTypes";

type UseEditResendParams = {
  isSending: boolean;
  isConversationHydrating: boolean;
  isConversationHydrationFailed: boolean;
  currentConversationIdRef: MutableRefObject<string>;
  onError: (error: unknown) => void;
  sendActionRef: MutableRefObject<SendChatAction>;
  prepareEditResend?: (
    conversationId: string,
    messageRef: HistoryMessageRef,
    options?: { activate?: boolean },
  ) => Promise<{ conversationId: string; messageRef: HistoryMessageRef }>;
};

export function useEditResend(params: UseEditResendParams) {
  const {
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    currentConversationIdRef,
    onError,
    sendActionRef,
    prepareEditResend,
  } = params;
  const editResendInFlightRef = useRef(false);

  const handleResendFromEdit = useCallback(
    async (
      messageRef: HistoryMessageRef,
      text: string,
      uploadedFiles: PendingUploadedFile[],
      referencedConversations: ConversationMentionReference[],
    ) => {
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
        const prepared = prepareEditResend
          ? await prepareEditResend(conversationId, messageRef)
          : { conversationId, messageRef };
        const accepted = await sendActionRef.current({
          textOverride: normalized,
          composerDraftOverride: createTextComposerDraft(normalized, referencedConversations),
          uploadedFilesOverride: uploadedFiles,
          conversationIdOverride: prepared.conversationId,
          editResendBaseMessageRef: prepared.messageRef,
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
      prepareEditResend,
      sendActionRef,
    ],
  );

  return { handleResendFromEdit };
}
