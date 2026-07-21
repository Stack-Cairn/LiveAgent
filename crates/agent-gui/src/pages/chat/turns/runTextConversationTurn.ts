import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { CompactionController } from "../../../lib/chat/compaction/controller";
import { estimateTextTokenUnits } from "../../../lib/chat/compaction/tokenLedger";
import type { ProviderRuntimeConfig } from "../../../lib/chat/compaction/types";
import {
  appendMessagesToConversation,
  type ConversationViewState,
} from "../../../lib/chat/conversation/conversationState";
import type {
  LiveTranscriptStore,
  RetryAttemptRecord,
} from "../../../lib/chat/conversation/liveTranscriptStore";
import type {
  ConversationHookLifecycle,
  GatewayBridgeEventController,
} from "../../../lib/chat/conversation/run";
import type { TurnCancellation } from "../../../lib/chat/conversation/turnCancellation";
import { memoryExtraction } from "../../../lib/chat/memory/extractionController";
import type {
  MemoryExtractionModelConfig,
  MemoryExtractionStatusText,
} from "../../../lib/chat/memory/extractionEngine";
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
  buildPartialAssistantMessage,
  type ConversationRuntimeEntry,
} from "../runtime/chatPageRuntime";

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
  conversationDebugLogger: StreamDebugLogger;
  recoveryDebugLogger: StreamDebugLogger;
  getNextConversationState: () => ConversationViewState;
  applyConversationState: (state: ConversationViewState) => void;
  buildPreparedContext: (
    state: ConversationViewState,
    tools?: Context["tools"],
    options?: { includeAbortedMessages?: boolean; includeUploadedFilesMetadata?: boolean },
  ) => Context;
  compaction: CompactionController;
  cancellation: TurnCancellation;
  resetLiveTranscript: (store: LiveTranscriptStore) => void;
  appendDraftAssistantText: (delta: string, store: LiveTranscriptStore) => void;
  batchLiveRoundsUpdate: (
    updater: (prev: LiveRound[]) => LiveRound[],
    store: LiveTranscriptStore,
  ) => void;
  updateGatewayBridgeToolStatus: (status: string | null, isCompaction?: boolean) => void;
  updateRetryAttempts: (attempts: RetryAttemptRecord[], store: LiveTranscriptStore) => void;
  commitVisibleAbortedConversation: () => boolean;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => ConversationRuntimeEntry;
  persistConversationWithHistorySync: (params: PersistConversationParams) => Promise<boolean>;
  memoryExtractionModel?: MemoryExtractionModelConfig;
  onMemoryExtractionModelFailure?: (model: MemoryExtractionModelConfig) => void;
  memoryExtractionStatusText?: MemoryExtractionStatusText;
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
    conversationDebugLogger,
    recoveryDebugLogger,
    getNextConversationState,
    applyConversationState,
    buildPreparedContext,
    compaction,
    cancellation,
    resetLiveTranscript,
    appendDraftAssistantText,
    batchLiveRoundsUpdate,
    updateGatewayBridgeToolStatus,
    updateRetryAttempts,
    commitVisibleAbortedConversation,
    updateConversationRuntimeEntry,
    persistConversationWithHistorySync,
    memoryExtractionModel,
    onMemoryExtractionModelFailure,
    memoryExtractionStatusText,
  } = params;

  // Reset per-turn dedup state so <already-written-this-turn> reflects only
  // this turn. In-flight extraction from the previous turn keeps running.
  memoryExtraction.noteTurnBoundary(conversationId);

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
    );
  }

  let textModeUsesLiveRounds = false;

  function ensureTextLiveRound(round: number) {
    textModeUsesLiveRounds = true;
    batchLiveRoundsUpdate((prev) => {
      if (prev.some((item) => item.round === round)) return prev;
      return [
        ...prev,
        {
          key: `r${round}`,
          round,
          blocks: [],
          runningToolCallIds: [],
          thinkingOpen: false,
        },
      ];
    }, transcriptStore);
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
    );
  }

  await compaction.maybeCompactPreSend({
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
    compaction.beginRequest(contextWithSkills, getNextConversationState());
    hookLifecycle.startTurn(textRound);
    textModeUsesLiveRounds = false;

    let streamedAssistantText = "";
    let streamedAssistantTokenUnits = 0;
    let protectionCheckChars = 0;
    let compactionRequested = false;
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
      const scope = cancellation.deriveScope();
      const nativeWebSearchStatusController = createDeferredProviderNativeWebSearchStatus({
        status: nativeWebSearchStatus,
        onStatus: (status) => updateGatewayBridgeToolStatus(status),
      });
      const retryAttemptsForAttempt: RetryAttemptRecord[] = [];
      updateRetryAttempts(retryAttemptsForAttempt, transcriptStore);
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
            if (textModeUsesLiveRounds) {
              batchLiveRoundsUpdate(
                (prev) =>
                  updateLiveRound(prev, textRound, (target) =>
                    appendTextDeltaToRound(collapseThinking(target), delta),
                  ),
                transcriptStore,
              );
            } else {
              appendDraftAssistantText(delta, transcriptStore);
            }
            streamedAssistantText += delta;
            streamedAssistantTokenUnits += estimateTextTokenUnits(delta);
            protectionCheckChars += delta.length;
            if (compactionRequested || protectionCompactionDisabled || protectionCheckChars < 160) {
              return;
            }
            protectionCheckChars = 0;
            if (!compaction.shouldProtectMidStream(streamedAssistantTokenUnits)) return;
            compactionRequested = true;
            scope.controller.abort();
          },
          onHostedSearch: (hostedSearch) => {
            if (hostedSearch.status === "searching") {
              nativeWebSearchStatusController.schedule();
            } else {
              nativeWebSearchStatusController.pause();
            }
            updateHostedSearch(hostedSearch, textRound, streamedAssistantText);
          },
          signal: scope.controller.signal,
          debugLogger: streamAttempt === 0 ? conversationDebugLogger : recoveryDebugLogger,
          onRetryStatus: (attempt, maxAttempts, errorMessage) => {
            updateGatewayBridgeToolStatus(`连接已断开，正在重试 (${attempt}/${maxAttempts})...`);
            retryAttemptsForAttempt.push({ attempt, maxAttempts, errorMessage });
            updateRetryAttempts(retryAttemptsForAttempt.slice(), transcriptStore);
          },
          onRetryRecovered: () => {
            updateGatewayBridgeToolStatus(null);
          },
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

          const compactionResult = await compaction.compactDuringRun({
            trigger: "mid-stream",
            state: getNextConversationState(),
            includeAbortedMessages: true,
            includeUploadedFilesMetadata: true,
          });

          if (!compactionResult.context) {
            throw new Error("Mid-stream compaction did not provide a continuation context.");
          }
          pendingTextContext = compactionResult.context;
          if (compactionResult.shouldDisableProtection) {
            protectionCompactionDisabled = true;
          }
          textRound += 1;
          continue textResponseLoop;
        }

        if (cancellation.userStop.signal.aborted || isAbortLikeError(streamErr)) {
          if (commitVisibleAbortedConversation()) {
            return;
          }
          throw streamErr;
        }

        if (streamAttempt < 1) {
          streamAttempt += 1;
          streamedAssistantText = "";
          streamedAssistantTokenUnits = 0;
          protectionCheckChars = 0;
          resetLiveTranscript(transcriptStore);
          textModeUsesLiveRounds = false;
          continue;
        }

        throw streamErr;
      } finally {
        scope.release();
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
    const currentMemoryExtractionModel: MemoryExtractionModelConfig = {
      providerId,
      model,
      runtime,
      selectedModel,
    };
    // Fire-and-forget; the controller owns lifecycle/abort, detached from the
    // chat request signal.
    void memoryExtraction.requestExtraction({
      primary: memoryExtractionModel ?? currentMemoryExtractionModel,
      fallback: memoryExtractionModel ? currentMemoryExtractionModel : undefined,
      onPrimaryFailure: memoryExtractionModel ? onMemoryExtractionModelFailure : undefined,
      sessionId,
      conversationId,
      workdir: conversationCwd,
      messages: buildPreparedContext(finalState).messages,
      statusText: memoryExtractionStatusText,
      debugLogger: conversationDebugLogger,
    });
  }
}
