// Renders nothing: watches run / approval / question state and raises system
// notifications, unread marks, the Dock badge and the optional completion chime
// for conversations that need the user while they are looking elsewhere. Kept as its own component so
// these subscriptions never re-render ChatPage.

import { useLocale } from "@liveagent/ui/i18n/index";
import {
  selectConversations,
  selectRunningConversationIds,
} from "@liveagent/ui/lib/sidebar/selectors";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import { useSidebarSelector } from "@liveagent/ui/lib/sidebar/useSidebarSelector";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { completionSoundPlayer } from "../../../lib/notifications/completionSound";
import {
  diffRunAttention,
  playsCompletionSound,
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
  /** Chime when a run finishes in the background; independent of the banners. */
  completionSound?: boolean;
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
    completionSound = false,
  } = props;
  const { t } = useLocale();
  const conversations = useSidebarSelector(sidebarStore, selectConversations);
  const running = useSidebarSelector(sidebarStore, selectRunningConversationIds);
  const approvals = useBlockedConversationIds(conversations, approvalStore);
  const questions = useBlockedConversationIds(conversations, questionStore);
  const unread = useSyncExternalStore(unreadStore.subscribe, unreadStore.getSnapshot);

  const latestRef = useRef({ conversations, visibleConversationId, enabled, completionSound, t });
  latestRef.current = { conversations, visibleConversationId, enabled, completionSound, t };
  const previousRef = useRef<RunAttentionState | null>(null);

  useEffect(() => {
    const next: RunAttentionState = { running, approvals, questions };
    const previous = previousRef.current;
    previousRef.current = next;
    // The first snapshot is the baseline: nothing changed while we watched.
    if (!previous) return;
    const latest = latestRef.current;
    if (!latest.enabled && !latest.completionSound) return;
    const context = {
      visibleConversationId: latest.visibleConversationId,
      windowFocused: isWindowFocused(),
    };
    let chime = false;
    for (const event of diffRunAttention(previous, next)) {
      if (latest.completionSound && playsCompletionSound(event, context)) chime = true;
      if (!latest.enabled) continue;
      const action = resolveRunAttention(event, context);
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
    // Several runs finishing in the same update share one chime.
    if (chime) completionSoundPlayer().play();
  }, [running, approvals, questions, unreadStore]);

  // A backgrounded window gets no user gesture, so the audio context is
  // started by the last interaction while the sound is enabled.
  useEffect(() => {
    if (!completionSound) return;
    const unlock = () => completionSoundPlayer().unlock();
    window.addEventListener("pointerdown", unlock, { capture: true, passive: true });
    window.addEventListener("keydown", unlock, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointerdown", unlock, { capture: true });
      window.removeEventListener("keydown", unlock, { capture: true });
    };
  }, [completionSound]);

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
