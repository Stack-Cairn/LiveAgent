import { type MutableRefObject, useCallback, useEffect, useMemo } from "react";
import { setChatHistoryModel } from "../../../lib/chat/history/chatHistory";
import { buildModelOptions } from "../../../lib/chat/page/chatPageHelpers";
import { toModelValue } from "../../../lib/providers/llm";
import {
  type AppSettings,
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
import type { SidebarStore } from "../../../lib/sidebar/store";
import type { SidebarConversation } from "../../../lib/sidebar/types";
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

  const modelOptions = useMemo(
    () => buildModelOptions(settings, { floatSelectedFirst: false }),
    [settings],
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

  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const conversationId = currentConversationIdRef.current;
      updateConversationRuntimeEntry(conversationId, (prev) =>
        selectedModelsMatch(prev.selectedModel, selection)
          ? prev
          : { ...prev, selectedModel: selection },
      );
      const persistedRow = sidebarStore.peek(conversationId);
      const selectedModelJson = serializeSelectedModelJson(selection);
      if (persistedRow && !persistedRow.isPending && selectedModelJson) {
        void setChatHistoryModel(conversationId, selectedModelJson)
          .then((summary) => sidebarStore.upsertLocal({ ...summary, isPending: undefined }))
          .catch((error) => {
            updateConversationRuntimeEntry(conversationId, (prev) => ({
              ...prev,
              errorMessage: asErrorMessage(error, "保存会话模型选择失败。"),
            }));
          });
      }
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [currentConversationIdRef, setSettings, sidebarStore, updateConversationRuntimeEntry],
  );

  // 跨端收敛：history-sync 带回的会话模型选择（如 WebUI 发消息后落库）
  // 写回当前会话的 runtime entry；值相等或发送中不动，无回环。
  const displayedConversationPersistedModelJson =
    sidebarConversationsById.get(currentConversationId)?.selectedModelJson;
  useEffect(() => {
    const parsed = normalizeSelectedModelForProviders(
      parseSelectedModelJson(displayedConversationPersistedModelJson),
      settings.customProviders,
    );
    if (!parsed) return;
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
  const chatRuntimeReasoningOptions = useMemo(
    () => getChatRuntimeReasoningLevelsForProvider(chatRuntimeReasoningParams),
    [chatRuntimeReasoningParams],
  );
  const chatRuntimeThinkingAlwaysOn = useMemo(
    () =>
      isThinkingAlwaysOnForModel(currentChatProvider?.type ?? "claude_code", currentChatModelId),
    [currentChatModelId, currentChatProvider?.type],
  );
  const chatRuntimeControlsForCurrentProvider = useMemo(
    () =>
      normalizeChatRuntimeControlsForProvider(
        settings.chatRuntimeControls,
        chatRuntimeReasoningParams,
      ),
    [chatRuntimeReasoningParams, settings.chatRuntimeControls],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      setSettings((prev) => ({
        ...prev,
        chatRuntimeControls: updateChatRuntimeControlsForProvider(
          prev.chatRuntimeControls,
          patch,
          chatRuntimeReasoningParams,
        ),
      }));
    },
    [chatRuntimeReasoningParams, setSettings],
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
