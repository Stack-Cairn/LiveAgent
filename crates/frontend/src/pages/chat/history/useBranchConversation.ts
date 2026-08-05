import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useRef,
  useState,
} from "react";
import type { HistoryMessageRef } from "../../../lib/chat/conversation/conversationState";
import { branchChatHistory } from "../../../lib/chat/history/chatHistory";
import type { SidebarStore } from "../../../lib/sidebar/store";
import { asErrorMessage } from "../chatPageUtils";

type UseBranchConversationParams = {
  currentConversationIdRef: MutableRefObject<string>;
  isSending: boolean;
  isConversationHydrating: boolean;
  isConversationHydrationFailed: boolean;
  sidebarStore: SidebarStore;
  handleSelectConversation: (id: string) => void;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  t: (key: string) => string;
};

/**
 * Copies the conversation prefix up to (and including) the picked assistant
 * reply into a fresh "新分支" conversation, then switches to it.
 */
export function useBranchConversation(params: UseBranchConversationParams) {
  const {
    currentConversationIdRef,
    isSending,
    isConversationHydrating,
    isConversationHydrationFailed,
    sidebarStore,
    handleSelectConversation,
    setErrorMessage,
    t,
  } = params;

  const branchInFlightRef = useRef(false);
  // 驱动被点行的转圈与全行禁用；ref 仍是同步防重入的真源。
  const [branchPendingMessageId, setBranchPendingMessageId] = useState<string | null>(null);
  const handleBranchConversation = useCallback(
    async (messageRef: HistoryMessageRef) => {
      const conversationId = currentConversationIdRef.current.trim();
      if (!conversationId) return;
      if (isSending || isConversationHydrating || isConversationHydrationFailed) return;
      // 分支 invoke 会排在同会话 persist 写锁后面，期间按钮仍可点：
      // 用 ref 挡掉重复确认，避免一次点击风暴造出多份"新分支"。
      if (branchInFlightRef.current) return;
      branchInFlightRef.current = true;
      setBranchPendingMessageId(messageRef.messageId);
      try {
        const summary = await branchChatHistory(conversationId, messageRef);
        sidebarStore.upsertLocal({ ...summary, isPending: undefined });
        handleSelectConversation(summary.id);
      } catch (error) {
        setErrorMessage(asErrorMessage(error, t("chat.branchFailed")));
      } finally {
        branchInFlightRef.current = false;
        setBranchPendingMessageId(null);
      }
    },
    [
      currentConversationIdRef,
      handleSelectConversation,
      isConversationHydrating,
      isConversationHydrationFailed,
      isSending,
      sidebarStore,
      t,
    ],
  );

  return { branchPendingMessageId, handleBranchConversation };
}
