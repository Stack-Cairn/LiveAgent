// Renders nothing: watches run / approval / question state and raises system
// notifications, unread marks and the Dock badge for conversations that need
// the user while they are looking elsewhere. Kept as its own component so
// these subscriptions never re-render ChatPage.

import { useLocale } from "@liveagent/ui/i18n/index";
import {
  selectConversations,
  selectRunningConversationIds,
} from "@liveagent/ui/lib/sidebar/selectors";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { useEffect, useRef, useSyncExternalStore } from "react";
import {
  diffRunAttention,
  type RunAttentionKind,
  type RunAttentionState,
  resolveRunAttention,
  runAttentionBadgeCount,
  type UnreadConversationStore,
} from "../../../lib/notifications/runAttention";
import { invoke } from "../../../shims/tauriCore";
import {
  type PendingConversationStore,
  useBlockedConversationIds,
} from "../conversations/useBlockedConversationIds";

type RunAttentionNotifierProps = {
  sidebarStore: SidebarStore;
  approvalStore: PendingConversationStore;
  questionStore: PendingConversationStore;
  unreadStore: UnreadConversationStore;
  /** Conversation shown in the chat view; empty while another view is open. */
  visibleConversationId: string;
  enabled: boolean;
};

const NOTIFICATION_TITLE_KEYS: Record<RunAttentionKind, string> = {
  completed: "chat.runNotification.completedTitle",
  approval: "chat.runNotification.approvalTitle",
  question: "chat.runNotification.questionTitle",
};

function isWindowFocused(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && document.hasFocus();
}

export function RunAttentionNotifier(props: RunAttentionNotifierProps) {
  const {
    sidebarStore,
    approvalStore,
    questionStore,
    unreadStore,
    visibleConversationId,
    enabled,
  } = props;
  const { t } = useLocale();
  const conversations = useSidebarSelector(sidebarStore, selectConversations);
  const running = useSidebarSelector(sidebarStore, selectRunningConversationIds);
  const approvals = useBlockedConversationIds(conversations, approvalStore);
  const questions = useBlockedConversationIds(conversations, questionStore);
  const unread = useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot);

  const latestRef = useRef({ conversations, visibleConversationId, enabled, t });
  latestRef.current = { conversations, visibleConversationId, enabled, t };
  const previousRef = useRef<RunAttentionState | null>(null);

  useEffect(() => {
    const next: RunAttentionState = { running, approvals, questions };
    const previous = previousRef.current;
    previousRef.current = next;
    // The first snapshot is the baseline: nothing changed while we watched.
    if (!previous) return;
    const latest = latestRef.current;
    if (!latest.enabled) return;
    const windowFocused = isWindowFocused();
    for (const event of diffRunAttention(previous, next)) {
      const action = resolveRunAttention(event, {
        visibleConversationId: latest.visibleConversationId,
        windowFocused,
      });
      if (action.markUnread) unreadStore.mark(event.conversationId);
      if (!action.notify) continue;
      const title =
        latest.conversations.find((item) => item.id === event.conversationId)?.title.trim() ||
        latest.t("chat.runNotification.untitled");
      invoke("chat_notification_deliver", {
        conversationId: event.conversationId,
        title: latest.t(NOTIFICATION_TITLE_KEYS[event.kind]),
        body: title,
      }).catch((error: unknown) => {
        // Unbundled dev builds and denied permissions land here; the sidebar
        // still carries the state, so a missing banner is not an error.
        console.debug("[run-attention] notification not delivered:", error);
      });
    }
  }, [running, approvals, questions, unreadStore]);

  // Looking at a conversation (focused window, chat view) reads it.
  useEffect(() => {
    const clearVisible = () => {
      if (visibleConversationId && isWindowFocused()) unreadStore.clear(visibleConversationId);
    };
    clearVisible();
    window.addEventListener("focus", clearVisible);
    document.addEventListener("visibilitychange", clearVisible);
    return () => {
      window.removeEventListener("focus", clearVisible);
      document.removeEventListener("visibilitychange", clearVisible);
    };
  }, [visibleConversationId, unreadStore]);

  const badgeCount = enabled ? runAttentionBadgeCount(unread, approvals, questions) : 0;
  useEffect(() => {
    invoke("app_set_badge_count", { count: badgeCount > 0 ? badgeCount : null }).catch(() => {
      // Platforms without badge support (and the browser shim) ignore this.
    });
  }, [badgeCount]);

  return null;
}
