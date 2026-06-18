import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import {
  type CompactionThrottleState,
  noteCompactionRound,
  type ProviderRuntimeConfig,
  shouldProtectionCompactConversation,
} from "../../../lib/chat/compaction/contextCompaction";
import {
  appendMessagesToConversation,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import type { LiveTranscriptStore } from "../../../lib/chat/conversation/liveTranscriptStore";
import type {
  ConversationHookLifecycle,
  GatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import type { HostedSearchBlock } from "../../../lib/chat/messages/hostedSearch";
import {
  appendTextDeltaToRound,
  collapseThinking,
  type LiveRound,
  updateLiveRound,
  upsertHostedSearchToRound,
} from "../../../lib/chat/messages/uiMessages";
import { isAbortLikeError } from "../../../lib/chat/page/chatPageHelpers";
import {
  createDeferredProviderNativeWebSearchStatus,
  resolveProviderNativeWebSearchStatus,
} from "../../../lib/chat/search/providerNativeSearchStatus";
import type { StreamDebugLogger } from "../../../lib/debug/agentDebug";
import { assistantMessageToText, streamAssistantMessage } from "../../../lib/providers/llm";
import type { ProviderId } from "../../../lib/settings";
import {
  recordSilentMemoryTurnBoundary,
  type SilentMemoryExtractionModelConfig,
} from "../memory/silentMemoryExtraction";
import { runSilentMemoryExtractionWithFallback } from "../memory/silentMemoryExtractionFallback";
import {
  buildPartialAssistantMessage,
  type ConversationRuntimeEntry,
} from "../runtime/chatPageRuntime";
import { buildProtectionCompactionStatus } from "../runtime/compactionStatusText";

export type RuntimeModel = {
  api: AssistantMessage["api"];
  provider: AssistantMessage["provider"];
  id: string;
};

export type CompactDuringRun = (params: {
  trigger: "mid-stream" | "post-tool";
  state: ConversationViewState;
  requestContext: Context;
  budgetContext: Context;
  statusText: string;
  tools?: Context["tools"];
  includeAbortedMessages?: boolean;
  includeUploadedFilesMetadata?: boolean;
}) => Promise<Context | null>;

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
  providerId: ProviderId;
  model: string;
  runtime: ProviderRuntimeConfig;
  runtimeModel: RuntimeModel;
  selectedModel: {
    customProviderId: string;
    model: string;
  };
  sessionId: string;
  conversationId: string;
  conversationCwd?: string;
  fallbackTitle: string;
  createdAt: number;
  titlePromise: Promise<string | null> | null;
  transcriptStore: LiveTranscriptStore;
  gatewayBridgeEvents: GatewayBridgeEventController;
  hookLifecycle: ConversationHookLifecycle;
  conversationThrottleState: CompactionThrottleState;
  conversationDebugLogger: StreamDebugLogger;
  recoveryDebugLogger: StreamDebugLogger;
  compactionDebugLogger: StreamDebugLogger;
  getNextConversationState: () => ConversationViewState;
  applyConversationState: (state: ConversationViewState) => void;
  buildCompactionContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ) => Context;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ) => Context;
  maybeApplyPreCompaction: (params: {
    requestContext: Context;
    budgetContext: Context;
    tools?: Context["tools"];
    includeUploadedFilesMetadata?: boolean;
  }) => Promise<boolean>;
  compactDuringRun: CompactDuringRun;
  getRequestController: () => AbortController;
  renewRequestController: () => AbortController;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  appendDraftAssistantText: (
    delta: string,
    store: LiveTranscriptStore,
    shouldAutoScroll?: boolean,
  ) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
    shouldAutoScroll?: boolean,
  ) => void;
  updateGatewayBridgeToolStatus: (
    status: string | null,
    visible: boolean,
    isCompaction?: boolean,
  ) => void;
  isConversationVisible: () => boolean;
  commitVisibleAbortedConversation: () => boolean;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => ConversationRuntimeEntry;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  memoryExtractionModel?: SilentMemoryExtractionModelConfig;
  onMemoryExtractionModelFailure?: (model: SilentMemoryExtractionModelConfig) => void;
};

export async function runTextConversationTurn(params: RunTextConversationTurnParams) {
  const {
    providerId,
    model,
    runtime,
    runtimeModel,
    selectedModel,
    sessionId,
    conversationId,
    conversationCwd,
    fallbackTitle,
    createdAt,
    titlePromise,
    transcriptStore,
    gatewayBridgeEvents,
    hookLifecycle,
    conversationThrottleState,
    conversationDebugLogger,
    recoveryDebugLogger,
    compactionDebugLogger,
    getNextConversationState,
    applyConversationState,
    buildCompactionContext,
    buildPreparedContext,
    maybeApplyPreCompaction,
    compactDuringRun,
    getRequestController,
    renewRequestController,
    resetLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateGatewayBridgeToolStatus,
    isConversationVisible,
    commitVisibleAbortedConversation,
    updateConversationRuntimeEntry,
    persistConversationWithHistorySync,
    memoryExtractionModel,
    onMemoryExtractionModelFailure,
  } = params;

  // Reset per-conversation slug tracker so the silent extraction round's
  // <already-written-this-turn> block only reflects writes from this turn.
  recordSilentMemoryTurnBoundary(conversationId);

  let finalAssistant: AssistantMessage | null = null;
  let contextWithSkills = buildPreparedContext(getNextConversationState());
  let pendingTextContext: Context | null = null;
  let textRound = 1;
  let protectionCompactionDisabled = false;

  function commitAssistantRoundMeta(assistant: AssistantMessage, round: number) {
    gatewayBridgeEvents.queueToken("", {
      round,
      provider: assistant.provider,
      model: assistant.model,
      api: assistant.api,
      stopReason: assistant.stopReason,
      usage: assistant.usage,
    });
    batchLiveRoundsUpdate(
      (prev) =>
        updateLiveRound(prev, round, (target) => ({
          ...collapseThinking(target),
          meta: {
            provider: String(assistant.provider ?? ""),
            model: String(assistant.model ?? ""),
            api: String(assistant.api ?? ""),
            stopReason: String(assistant.stopReason ?? ""),
            usage: assistant.usage,
            usageTotalTokens: assistant.usage?.totalTokens,
          },
        })),
      transcriptStore,
      isConversationVisible(),
    );
  }

  let textModeUsesLiveRounds = false;

  function ensureTextLiveRound(round: number) {
    textModeUsesLiveRounds = true;
    batchLiveRoundsUpdate(
      (prev) => {
        if (prev.some((item) => item.round === round)) return prev;
        return [
          ...prev,
          {
            key: `${Date.now()}-${round}`,
            round,
            blocks: [],
            runningToolCallIds: [],
            thinkingOpen: false,
          },
        ];
      },
      transcriptStore,
      isConversationVisible(),
    );
  }

  function updateHostedSearch(hostedSearch: HostedSearchBlock, round: number, existingText = "") {
    const shouldSeedExistingText = !textModeUsesLiveRounds && existingText.length > 0;
    ensureTextLiveRound(round);
    gatewayBridgeEvents.queueEvent({
      type: "hosted_search",
      id: hostedSearch.id,
      provider: hostedSearch.provider,
      status: hostedSearch.status,
      queries: hostedSearch.queries,
      sources: hostedSearch.sources,
      updatedAt: hostedSearch.updatedAt,
      round,
      conversation_id: conversationId,
    });
    batchLiveRoundsUpdate(
      (prev) =>
        updateLiveRound(prev, round, (target) =>
          upsertHostedSearchToRound(
            shouldSeedExistingText
              ? appendTextDeltaToRound(collapseThinking(target), existingText)
              : collapseThinking(target),
            hostedSearch,
          ),
        ),
      transcriptStore,
      isConversationVisible(),
    );
  }

  await maybeApplyPreCompaction({
    requestContext: buildCompactionContext(getNextConversationState(), undefined, {
      includeUploadedFilesMetadata: true,
    }),
    budgetContext: buildPreparedContext(getNextConversationState(), undefined, {
      includeUploadedFilesMetadata: true,
    }),
    includeUploadedFilesMetadata: true,
  });
  hookLifecycle.startAgent();

  textResponseLoop: while (!finalAssistant) {
    contextWithSkills =
      pendingTextContext ??
      buildPreparedContext(getNextConversationState(), undefined, {
        includeUploadedFilesMetadata: true,
      });
    pendingTextContext = null;
    hookLifecycle.startTurn(textRound);
    textModeUsesLiveRounds = false;

    let streamedAssistantText = "";
    let protectionCheckChars = 0;
    let compactionRequested = false;
    let protectionCompactionStatusText: string | null = null;
    let streamAttempt = 0;
    const nativeWebSearchEnabled = runtime.nativeWebSearchEnabled !== false;
    const nativeWebSearchStatus = resolveProviderNativeWebSearchStatus({
      providerId,
      api: runtimeModel.api,
      enabled: nativeWebSearchEnabled,
      baseUrl: runtime.baseUrl,
      modelId: model,
    });

    while (!finalAssistant) {
      const nativeWebSearchStatusController = createDeferredProviderNativeWebSearchStatus({
        status: nativeWebSearchStatus,
        onStatus: (status) => updateGatewayBridgeToolStatus(status, isConversationVisible()),
      });
      try {
        finalAssistant = await streamAssistantMessage({
          providerId,
          model,
          runtime,
          context: contextWithSkills,
          workdir: conversationCwd,
          sessionId,
          nativeWebSearch: nativeWebSearchEnabled,
          onTextDelta: (delta) => {
            nativeWebSearchStatusController.noteVisibleActivity();
            gatewayBridgeEvents.queueToken(delta, { round: textRound });
            hookLifecycle.messageUpdated();
            if (textModeUsesLiveRounds) {
              batchLiveRoundsUpdate(
                (prev) =>
                  updateLiveRound(prev, textRound, (target) =>
                    appendTextDeltaToRound(collapseThinking(target), delta),
                  ),
                transcriptStore,
                isConversationVisible(),
              );
            } else {
              appendDraftAssistantText(delta, transcriptStore, isConversationVisible());
            }
            streamedAssistantText += delta;
            protectionCheckChars += delta.length;
            if (compactionRequested || protectionCompactionDisabled || protectionCheckChars < 160) {
              return;
            }
            protectionCheckChars = 0;
            const partialAssistant = buildPartialAssistantMessage({
              model: runtimeModel,
              text: streamedAssistantText,
              stopReason: "aborted",
            });
            if (!partialAssistant) return;
            const tempState = appendMessagesToConversation(getNextConversationState(), [
              partialAssistant,
            ]);
            const tempContext = buildPreparedContext(tempState, undefined, {
              includeAbortedMessages: true,
              includeUploadedFilesMetadata: true,
            });
            const decision = shouldProtectionCompactConversation({
              providerId,
              state: tempState,
              requestContext: tempContext,
              modelConfig: runtime.modelConfig,
              throttleState: conversationThrottleState,
              debugLogger: compactionDebugLogger,
            });
            if (!decision.shouldCompact) return;
            compactionRequested = true;
            protectionCompactionStatusText = buildProtectionCompactionStatus(decision);
            updateGatewayBridgeToolStatus(
              protectionCompactionStatusText,
              isConversationVisible(),
              true,
            );
            getRequestController().abort();
          },
          onHostedSearch: (hostedSearch) => {
            if (hostedSearch.status === "searching") {
              nativeWebSearchStatusController.schedule();
            } else {
              nativeWebSearchStatusController.pause();
            }
            hookLifecycle.messageUpdated();
            updateHostedSearch(hostedSearch, textRound, streamedAssistantText);
          },
          signal: getRequestController().signal,
          debugLogger: streamAttempt === 0 ? conversationDebugLogger : recoveryDebugLogger,
        });
        nativeWebSearchStatusController.finish();
      } catch (streamErr) {
        nativeWebSearchStatusController.finish();
        if (compactionRequested) {
          hookLifecycle.ensureMessageEnded();
          hookLifecycle.endTurn(textRound);
          resetLiveTranscript(transcriptStore);
          textModeUsesLiveRounds = false;

          const partialAssistant = buildPartialAssistantMessage({
            model: runtimeModel,
            text: streamedAssistantText,
            stopReason: "aborted",
          });
          if (partialAssistant) {
            applyConversationState(
              appendMessagesToConversation(getNextConversationState(), [partialAssistant]),
            );
          }
          renewRequestController();

          const compactedContext = await compactDuringRun({
            trigger: "mid-stream",
            state: getNextConversationState(),
            requestContext: buildCompactionContext(getNextConversationState(), undefined, {
              includeAbortedMessages: true,
              includeUploadedFilesMetadata: true,
            }),
            budgetContext: buildPreparedContext(getNextConversationState(), undefined, {
              includeAbortedMessages: true,
              includeUploadedFilesMetadata: true,
            }),
            statusText: protectionCompactionStatusText ?? "正在压缩上下文...",
            includeAbortedMessages: true,
            includeUploadedFilesMetadata: true,
          });

          if (compactedContext) {
            pendingTextContext = compactedContext;
            textRound += 1;
            continue textResponseLoop;
          }

          protectionCompactionDisabled = true;
          pendingTextContext = buildPreparedContext(getNextConversationState(), undefined, {
            includeAbortedMessages: true,
            includeUploadedFilesMetadata: true,
          });
          textRound += 1;
          continue textResponseLoop;
        }

        if (getRequestController().signal.aborted || isAbortLikeError(streamErr)) {
          if (commitVisibleAbortedConversation()) {
            return;
          }
          throw streamErr;
        }

        if (streamAttempt < 1) {
          streamAttempt += 1;
          streamedAssistantText = "";
          protectionCheckChars = 0;
          resetLiveTranscript(transcriptStore);
          textModeUsesLiveRounds = false;
          renewRequestController();
          continue;
        }

        throw streamErr;
      }
    }

    hookLifecycle.ensureMessageEnded();
    hookLifecycle.endTurn(textRound);
  }

  const gatewayAssistantText = assistantMessageToText(finalAssistant);
  if (!gatewayBridgeEvents.hasForwardedText() && gatewayAssistantText.length > 0) {
    gatewayBridgeEvents.queueToken(gatewayAssistantText, { round: textRound });
  }
  const finalState = appendMessagesToConversation(getNextConversationState(), [finalAssistant]);
  noteCompactionRound(conversationThrottleState);
  const shouldRunMemoryExtraction =
    finalAssistant.stopReason !== "error" && finalAssistant.stopReason !== "aborted";
  commitAssistantRoundMeta(finalAssistant, textRound);
  resetLiveTranscript(transcriptStore);
  updateConversationRuntimeEntry(conversationId, (prev) => ({
    ...prev,
    state: finalState,
  }));
  hookLifecycle.ensureMessageEnded();
  hookLifecycle.endAgent();
  void persistConversationWithHistorySync({
    conversationId,
    sessionId,
    providerId,
    model,
    cwd: conversationCwd,
    state: finalState,
    fallbackTitle,
    createdAt,
    titlePromise,
  });
  gatewayBridgeEvents.queueEvent({
    type: "done",
    conversation_id: conversationId,
  });
  gatewayBridgeEvents.close();
  if (shouldRunMemoryExtraction) {
    const currentMemoryExtractionModel: SilentMemoryExtractionModelConfig = {
      providerId,
      model,
      runtime,
      selectedModel,
    };
    void runSilentMemoryExtractionWithFallback({
      primary: memoryExtractionModel ?? currentMemoryExtractionModel,
      fallback: memoryExtractionModel ? currentMemoryExtractionModel : undefined,
      onPrimaryFailure: memoryExtractionModel ? onMemoryExtractionModelFailure : undefined,
      sessionId,
      conversationId,
      workdir: conversationCwd,
      buildContext: (tools) => buildPreparedContext(finalState, tools),
      signal: getRequestController().signal,
      debugLogger: conversationDebugLogger,
    });
  }
}
