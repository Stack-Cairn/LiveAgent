import {
  useCatalogLiveVersion,
  useThinkingLiveVersion,
} from "@liveagent/ui/lib/models/useThinkingLive";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { type MutableRefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { setChatHistoryModel } from "../../../lib/chat/history/chatHistory";
import { buildModelOptions } from "../../../lib/chat/page/chatPageHelpers";
import { toModelValue } from "../../../lib/providers/llm";
import {
  type AppSettings,
  applyConversationThinking,
  applyThinkingPatchToSelection,
  type ChatRuntimeControls,
  findProviderModelConfig,
  getChatRuntimeReasoningLevelsForProvider,
  isThinkingAlwaysOnForModel,
  normalizeChatRuntimeControlsForProvider,
  normalizeSelectedModelForProviders,
  parseSelectedModelJson,
  type SelectedModel,
  serializeSelectedModelJson,
  setSelectedModel,
  updateChatRuntimeControlsForProvider,
} from "../../../lib/settings";
import { asErrorMessage } from "../chatPageUtils";
import type { ConversationRuntimeEntry } from "./chatPageRuntime";
import { resolveActiveModelSelection } from "./modelSelection";
import { selectedModelsMatch } from "./providerRuntimeConfig";

type UseChatModelSelectionParams = {
  settings: AppSettings;
  setSettings: (updater: (prev: AppSettings) => AppSettings) => void;
  t: (key: string) => string;
  sidebarStore: SidebarStore;
  sidebarConversationsById: ReadonlyMap<string, SidebarConversation>;
  currentConversationId: string;
  currentConversationSelectedModel: SelectedModel | undefined;
  currentConversationIdRef: MutableRefObject<string>;
  conversationRuntimeCacheRef: MutableRefObject<Map<string, ConversationRuntimeEntry>>;
  updateConversationRuntimeEntry: (
    conversationId: string,
    updater: (prev: ConversationRuntimeEntry) => ConversationRuntimeEntry,
  ) => ConversationRuntimeEntry;
};

/**
 * Per-conversation model selection UI state: the model dropdown options and
 * labels, the runtime-controls (reasoning / web search) derivations for the
 * current provider, the selection handler that persists per-conversation
 * model choices, and the history-sync write-back of remotely-selected models.
 */
export function useChatModelSelection(params: UseChatModelSelectionParams) {
  const {
    settings,
    setSettings,
    t,
    sidebarStore,
    sidebarConversationsById,
    currentConversationId,
    currentConversationSelectedModel,
    currentConversationIdRef,
    conversationRuntimeCacheRef,
    updateConversationRuntimeEntry,
  } = params;

  // Serialize writes per conversation and protect local intent until persistence completes.
  const localSelectionsRef = useRef(
    new Map<string, { selection: SelectedModel; errorMessage?: string }>(),
  );
  const modelSaveQueuesRef = useRef(new Map<string, Promise<void>>());
  const persistConversationSelection = useCallback(
    (conversationId: string, selection: SelectedModel, failureMessage: string) => {
      const persistedRow = sidebarStore.peek(conversationId);
      const selectedModelJson = serializeSelectedModelJson(selection);
      if (!persistedRow || persistedRow.isPending || !selectedModelJson) return;
      const previous = localSelectionsRef.current.get(conversationId);
      const intent = { selection, errorMessage: undefined as string | undefined };
      localSelectionsRef.current.set(conversationId, intent);
      if (previous?.errorMessage) {
        updateConversationRuntimeEntry(conversationId, (prev) =>
          prev.errorMessage === previous.errorMessage ? { ...prev, errorMessage: null } : prev,
        );
      }
      const queued = (modelSaveQueuesRef.current.get(conversationId) ?? Promise.resolve())
        .then(async () => {
          try {
            const summary = await setChatHistoryModel(conversationId, selectedModelJson);
            if (localSelectionsRef.current.get(conversationId) !== intent) return;
            sidebarStore.upsertLocal({ ...summary, isPending: undefined });
            if (localSelectionsRef.current.get(conversationId) === intent) {
              localSelectionsRef.current.delete(conversationId);
            }
          } catch (error) {
            if (localSelectionsRef.current.get(conversationId) !== intent) return;
            const detail = asErrorMessage(error, failureMessage);
            const errorMessage =
              detail === failureMessage ? failureMessage : `${failureMessage} ${detail}`;
            intent.errorMessage = errorMessage;
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              errorMessage,
            }));
          }
        })
        .finally(() => {
          if (modelSaveQueuesRef.current.get(conversationId) === queued) {
            modelSaveQueuesRef.current.delete(conversationId);
          }
        });
      modelSaveQueuesRef.current.set(conversationId, queued);
    },
    [sidebarStore, updateConversationRuntimeEntry],
  );

  // 运行期模型目录只改模态/档位时设置对象不变，版本号让选择器的视觉/推理标记跟进。
  const catalogLiveVersion = useCatalogLiveVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: catalogLiveVersion 是刻意的失效信号，运行期目录到达后重建选项。
  const modelOptions = useMemo(
    () =>
      buildModelOptions(
        { customProviders: settings.customProviders },
        { floatSelectedFirst: false },
      ),
    [settings.customProviders, catalogLiveVersion],
  );
  const activeSelectedModel = resolveActiveModelSelection(
    settings,
    currentConversationSelectedModel,
  );
  const selectedValue = activeSelectedModel
    ? toModelValue(activeSelectedModel.customProviderId, activeSelectedModel.model)
    : undefined;
  const hasModels = modelOptions.length > 0;

  const currentModelLabel = (() => {
    if (!activeSelectedModel) return t("chat.selectModel");
    const opt = modelOptions.find((o) => o.value === selectedValue);
    if (opt) return `${opt.providerName} / ${opt.model}`;
    return activeSelectedModel.model;
  })();

  const currentModelContextWindow = (() => {
    if (!activeSelectedModel) return undefined;
    const provider = settings.customProviders.find(
      (item) => item.id === activeSelectedModel.customProviderId,
    );
    if (!provider) return undefined;
    return findProviderModelConfig(provider, activeSelectedModel.model).contextWindow;
  })();
  const currentChatProvider = activeSelectedModel
    ? settings.customProviders.find((item) => item.id === activeSelectedModel.customProviderId)
    : undefined;
  const currentChatModelId = activeSelectedModel?.model;

  // 跨端收敛：history-sync 带回的会话模型选择（如 WebUI 发消息后落库）
  // 写回当前会话的 runtime entry；值相等或发送中不动，无回环。
  const displayedConversationPersistedModelJson =
    sidebarConversationsById.get(currentConversationId)?.selectedModelJson;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the projection triggers synchronization; peek reads the latest committed value.
  useEffect(() => {
    const parsed = normalizeSelectedModelForProviders(
      // Read the committed store value, not a projection captured before a save completed.
      parseSelectedModelJson(sidebarStore.peek(currentConversationId)?.selectedModelJson),
      settings.customProviders,
    );
    if (!parsed) return;
    if (localSelectionsRef.current.has(currentConversationId)) return;
    const entry = conversationRuntimeCacheRef.current.get(currentConversationId);
    if (!entry || entry.isSending) return;
    if (selectedModelsMatch(entry.selectedModel, parsed)) return;
    updateConversationRuntimeEntry(currentConversationId, (prev) => ({
      ...prev,
      selectedModel: parsed,
    }));
  }, [
    conversationRuntimeCacheRef,
    currentConversationId,
    displayedConversationPersistedModelJson,
    sidebarStore,
    settings.customProviders,
    updateConversationRuntimeEntry,
  ]);

  const chatRuntimeReasoningParams = useMemo(
    () => ({
      providerId: currentChatProvider?.type,
      requestFormat: currentChatProvider?.requestFormat,
      modelId: currentChatModelId,
    }),
    [currentChatModelId, currentChatProvider?.requestFormat, currentChatProvider?.type],
  );
  // 运行期思考档位补充到达会改变档位列表/恒开判定，版本号计入依赖使 memo 跟进。
  const thinkingLiveVersion = useThinkingLiveVersion();
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重算。
  const chatRuntimeReasoningOptions = useMemo(
    () => getChatRuntimeReasoningLevelsForProvider(chatRuntimeReasoningParams),
    [chatRuntimeReasoningParams, thinkingLiveVersion],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重算。
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      isThinkingAlwaysOnForModel(currentChatProvider?.type ?? "claude_code", currentChatModelId),
    [currentChatModelId, currentChatProvider?.type, thinkingLiveVersion],
  );
  // normalizeChatRuntimeControlsForProvider 会按模型档位表钳制当前选中档：档位表
  // 随运行期补充变化时，选中档必须同步重钳，否则出现「选中档不在选项里」。
  // biome-ignore lint/correctness/useExhaustiveDependencies: thinkingLiveVersion 是刻意的失效信号，运行期档位补充到达后重钳当前档。
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(
        applyConversationThinking(settings.chatRuntimeControls, activeSelectedModel),
        chatRuntimeReasoningParams,
      ),
    [chatRuntimeReasoningParams, settings.chatRuntimeControls, thinkingLiveVersion],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      const selection = applyThinkingPatchToSelection(
        activeSelectedModel,
        chatRuntimeControlsForCurrentProvider,
        patch,
      );
      const conversationId = currentConversationIdRef.current;
      if (selection && conversationId) {
        updateConversationRuntimeEntry(conversationId, (prev) => ({
          ...prev,
          selectedModel: selection,
        }));
        persistConversationSelection(
          conversationId,
          selection,
          "保存会话思考设置失败，请重新选择重试。",
        );
      }
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(
          prev.chatRuntimeControls,
          patch,
          chatRuntimeReasoningParams,
        ),
      }));
    },
    [
      activeSelectedModel,
      chatRuntimeControlsForCurrentProvider,
      chatRuntimeReasoningParams,
      currentConversationIdRef,
      setSettings,
      persistConversationSelection,
      updateConversationRuntimeEntry,
    ],
  );

  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const conversationId = currentConversationIdRef.current;
      const currentSelection = activeSelectedModel;
      const currentControls = normalizeChatRuntimeControlsForProvider(
        applyConversationThinking(settings.chatRuntimeControls, currentSelection),
        chatRuntimeReasoningParams,
      );
      const nextSelection =
        currentSelection && !selectedModelsMatch(currentSelection, selection)
          ? (applyThinkingPatchToSelection(selection, currentControls, {
              thinkingEnabled: currentControls.thinkingEnabled,
              reasoning: currentControls.reasoning,
            }) ?? selection)
          : selection;
      updateConversationRuntimeEntry(conversationId, (prev) =>
        selectedModelsMatch(prev.selectedModel, nextSelection)
          ? prev
          : { ...prev, selectedModel: nextSelection },
      );
      persistConversationSelection(
        conversationId,
        nextSelection,
        "保存会话模型选择失败，请重新选择重试。",
      );
      // Also the default for new conversations. On K-brain this is saved as the backend
      // default model, which is what the composer restores after a restart.
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [
      activeSelectedModel,
      chatRuntimeReasoningParams,
      currentConversationIdRef,
      settings.chatRuntimeControls,
      setSettings,
      persistConversationSelection,
      updateConversationRuntimeEntry,
    ],
  );

  return {
    modelOptions,
    activeSelectedModel,
    selectedValue,
    hasModels,
    currentModelLabel,
    currentModelContextWindow,
    handleSelectModel,
    chatRuntimeReasoningOptions,
    chatRuntimeThinkingAlwaysOn,
    chatRuntimeControlsForCurrentProvider,
    handleChatRuntimeControlsChange,
  };
}
