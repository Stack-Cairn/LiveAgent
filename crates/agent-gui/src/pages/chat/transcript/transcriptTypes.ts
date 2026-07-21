import type { MutableRefObject } from "react";

import type {
  HistoryMessageRef,
  RenderTimelineItem,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type { PendingUploadedFile } from "../../../lib/chat/messages/uploadedFiles";
import type { ScrollFollowHandle } from "../../../lib/chat-scroll/useScrollFollow";
import type { GitClient } from "../../../lib/git/types";
import type { WorkModeDefinition } from "../../../lib/settings";
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
  isHistorySwitching: boolean;
  isSending: boolean;
  isAgentMode: boolean;
  showUsage: boolean;
  usageContextWindow?: number;
  liveTranscriptStore: LiveTranscriptStore;
  isCompactionRunning: boolean;
  bottomReservePx?: number;
  onResendFromEdit: (
    messageRef: HistoryMessageRef,
    text: string,
    attachments: PendingUploadedFile[],
  ) => void;
  onBranchConversation?: (messageRef: HistoryMessageRef) => void;
  // Anchor messageId of the branch request in flight; the matching row shows
  // a spinner and every branch button disables until it settles.
  branchPendingMessageId?: string | null;
  onOpenSettings: (section?: SectionId) => void;
  onSuggestionSelect?: (text: string) => void;
  suggestionsDisabled?: boolean;
  /** 当前工作模式：驱动空态问候语、建议卡片与光晕色。 */
  workMode?: WorkModeDefinition;
};
