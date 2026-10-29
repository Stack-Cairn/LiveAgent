import type { AssistantMessage, Context } from "@liveagent/app/lib/agentTypes";
import type { ComposerTurnCommand } from "@liveagent/ui/lib/chat/composerCommands";
import type { ConversationMentionReference } from "@liveagent/ui/lib/chat/mentionReferences";
import type { Locale } from "../../../i18n/config";
import type { ProviderRuntimeConfig } from "../../../lib/chat/compaction/types";
import type { SuppressedToolTraceSnapshot } from "../../../lib/chat/conversation/chatAbort";
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
import type { KBrainGoalState } from "../../../lib/kbrain/types";
import type { AppSettings, McpSettingsOp, ProviderId, SshHostConfig } from "../../../lib/settings";
import type { SubagentConversationStore } from "../../../lib/subagents";
import type { AdditionalProjectRoot } from "../../../lib/tools/additionalProjectRoots";
import type { SkillAccessPolicy } from "../../../lib/tools/skillAccessPolicy";
import type { SshManagerSessionChange } from "../../../lib/tools/sshManagerTools";
import type { TaskStateStore } from "../../../lib/tools/taskTools";
import type { TunnelManagerChange } from "../../../lib/tools/tunnelManagerTools";
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

export type RunAgentConversationTurnParams = {
  locale?: Locale;
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimeModel: RuntimeModel;
  selectedModel: { customProviderId: string; model: string };
  effectiveWorkdir: string;
  additionalRoots?: readonly AdditionalProjectRoot[];
  effectiveSkillsEnabled: boolean;
  skillsRootDir?: string;
  skillAccessPolicy?: SkillAccessPolicy;
  onManagedSkillsChanged?: (change: {
    action: "install" | "create" | "delete";
    names: string[];
    baseDirs: string[];
  }) => void | Promise<void>;
  agentTemplates: AppSettings["agents"];
  getMcpSettings: () => AppSettings["mcp"];
  getToolPolicies?: () => AppSettings["system"]["toolPolicies"];
  getCuaAllowSelfTargeting?: () => boolean;
  commandSafetyMode?: AppSettings["system"]["commandSafetyMode"];
  planModeEnabled?: boolean;
  applyMcpOps?: (ops: McpSettingsOp[]) => void;
  remoteWebTunnelsEnabled?: boolean;
  tunnelPublicBaseUrl?: string;
  onTunnelsChanged?: (change: TunnelManagerChange) => void;
  sshHosts?: SshHostConfig[];
  associatedSshHostIds?: string[];
  sshManagerRemoteAllowed?: boolean;
  onSshSessionsChanged?: (change: SshManagerSessionChange) => void;
  sessionId: string;
  clientRequestId?: string;
  /** 输入框“/”指令带来的单轮语义：经 goal 接口开始，或作为提示词指令由后端展开。 */
  composerCommand?: ComposerTurnCommand;
  /** 目标状态变化（达成、暂停、续跑）；由调用方提示用户。 */
  onGoalUpdate?: (state: KBrainGoalState) => void;
  taskStateStore: TaskStateStore;
  conversationId: string;
  referencedConversations?: readonly ConversationMentionReference[];
  checkpointTurnId?: string;
  conversationCwd?: string;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: GatewayBridgeEventController;
  hookLifecycle: ConversationHookLifecycle;
  conversationDebugLogger: StreamDebugLogger;
  subagentStore?: SubagentConversationStore;
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
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
  ) => void;
  updateToolStatus: (status: string | null, store: LiveTranscriptStore) => void;
  updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) => void;
  updatePersistableAgentProgress: (progress: {
    completedThroughRound: number;
    suppressedToolTrace: SuppressedToolTraceSnapshot[];
  }) => void;
  commitVisibleAbortedConversation: () => boolean;
  freezeGatewayFinalProjection: (state: ConversationViewState, contentComplete?: boolean) => void;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  trajectory?: TrajectoryRecorder;
  trajectoryTurn?: number;
  trajectoryMessageIndex?: number;
  trajectoryMessageId?: string;
  readTrajectorySlots?: () => { base?: string; agent?: string; skills?: string; memory?: string };
};

export async function runAgentConversationTurn(params: RunAgentConversationTurnParams) {
  return runKBrainConversationTurn(params);
}
