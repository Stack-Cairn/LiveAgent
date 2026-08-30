import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { PendingUploadedFile } from "@liveagent/ui/lib/chat/uploadedFiles";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import type { GitClient } from "@liveagent/ui/lib/git/types";
import type { MutableRefObject } from "react";
import type {
  HistoryMessageRef,
  RenderTimelineItem,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { SectionId } from "../../settings/types";

export type ChatTranscriptProps = {
  conversationId: string;
  workspaceRoot?: string;
  gitClient?: GitClient | null;
  // ChatPage reaches the transcript's scroll-follow engine through this
  // handle (force-follow on conversation reset / run start).
  followRef: MutableRefObject<ScrollFollowHandle | null>;
  hasModels: boolean;
  historyItems: RenderTimelineItem[];
  hasMoreHistory: boolean;
  onLoadEarlierHistory: () => Promise<void>;
  isHistorySwitching: boolean;
  isSending: boolean;
  isAgentMode: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  liveTranscriptStore: LiveTranscriptStore;
  isCompactionRunning: boolean;
  bottomReservePx?: number;
  contentWidth: number;
  onContentWidthChange: (width: number) => void;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
    referencedConversations: ConversationMentionReference[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  // Anchor messageId of the branch request in flight; the matching row shows
  // a spinner and every branch button disables until it settles.
  branchPendingMessageId?: string | null;
  onOpenSettings: (section?: SectionId) => void;
  onSuggestionSelect?: (text: string) => void;
  suggestionsDisabled?: boolean;
};
