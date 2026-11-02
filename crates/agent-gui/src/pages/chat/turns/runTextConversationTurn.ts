import type { AssistantMessage, Context } from "@liveagent/app/lib/agentTypes";
import type { Locale } from "../../../i18n/config";
import type { ProviderRuntimeConfig } from "../../../lib/chat/compaction/types";
import type { ConversationViewState } from "../../../lib/chat/conversation/conversationState";
import type {
  LiveTranscriptStore,
  RetryAttemptRecord,
} from "../../../lib/chat/conversation/liveTranscriptStore";
import type {
  ConversationHookLifecycle,
  GatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import type { TurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import type { LiveRound } from "../../../lib/chat/messages/uiMessages";
import type { StreamDebugLogger } from "../../../lib/debug/agentDebug";
import type { ProviderId } from "../../../lib/settings";
import type { TrajectoryRecorder } from "../../../lib/trajectory/recorder";
import { runKBrainConversationTurn } from "./runKBrainConversationTurn";

export type RuntimeModel = {
  api: AssistantMessage["api"];
  provider: AssistantMessage["provider"];
  id: string;
};

export type PersistConversationParams = {
  conversationId: string;
  sessionId: string;
  providerId: string;
  model: string;
  cwd?: string;
  state: ConversationViewState;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
};

export type RunTextConversationTurnParams = {
  locale?: Locale;
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimeModel: RuntimeModel;
  selectedModel: { customProviderId: string; model: string };
  sessionId: string;
  clientRequestId?: string;
  conversationId: string;
  conversationCwd?: string;
  historyCwd?: string;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: GatewayBridgeEventController;
  hookLifecycle: ConversationHookLifecycle;
  conversationDebugLogger: StreamDebugLogger;
  recoveryDebugLogger: StreamDebugLogger;
  getNextConversationState: () => ConversationViewState;
  applyConversationState: (state: ConversationViewState) => void;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: {
      includeAbortedMessages?: boolean;
      includeUploadedFilesMetadata?: boolean;
    },
  ) => Context;
  cancellation: TurnCancellation;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  settleLiveTranscript: (store: LiveTranscriptStore) => void;
  appendDraftAssistantText: (delta: string, store: LiveTranscriptStore) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
  ) => void;
  updateGatewayBridgeToolStatus: (status: string | null, isCompaction?: boolean) => void;
  updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) => void;
  commitVisibleAbortedConversation: () => boolean;
  freezeGatewayFinalProjection: (state: ConversationViewState, contentComplete?: boolean) => void;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  trajectory?: TrajectoryRecorder;
  trajectoryTurn?: number;
  trajectoryMessageIndex?: number;
  trajectoryMessageId?: string;
  readTrajectorySlots?: () => { base?: string; agent?: string; skills?: string; memory?: string };
};

export async function runTextConversationTurn(params: RunTextConversationTurnParams) {
  return runKBrainConversationTurn(params);
}
