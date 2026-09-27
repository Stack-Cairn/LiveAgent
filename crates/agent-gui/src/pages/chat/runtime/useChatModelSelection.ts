import { useThinkingLiveVersion } from "@liveagent/ui/lib/models/useThinkingLive";
import type { SidebarStore } from "@liveagent/ui/lib/sidebar/store";
import type { SidebarConversation } from "@liveagent/ui/lib/sidebar/types";
import { type MutableRefObject, useCallback, useEffect, useMemo } from "react";
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
    () =>
      buildModelOptions(
        { customProviders: settings.customProviders },
        { floatSelectedFirst: false },
      ),
    [settings.customProviders],
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

  // 模型与思考设置作为会话选择一起保存：写入 runtime entry，并持久化到会话历史。
  const saveConversationSelection = useCallback(
    (conversationId: string, selection: SelectedModel) => {
      updateConversationRuntimeEntry(conversationId, (prev) =>
        serializeSelectedModelJson(prev.selectedModel) === serializeSelectedModelJson(selection)
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
    },
    [sidebarStore, updateConversationRuntimeEntry],
  );

  const handleSelectModel = useCallback(
    (selection: SelectedModel) => {
      const conversationId = currentConversationIdRef.current;
      // 切换模型保留会话已有的思考设置；全局默认只记录模型。
      const previous = conversationRuntimeCacheRef.current.get(conversationId)?.selectedModel;
      saveConversationSelection(conversationId, { ...previous, ...selection });
      setSettings((prev) => setSelectedModel(prev, selection));
    },
    [conversationRuntimeCacheRef, currentConversationIdRef, saveConversationSelection, setSettings],
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
    if (serializeSelectedModelJson(entry.selectedModel) === serializeSelectedModelJson(parsed)) {
      return;
    }
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
    [
      activeSelectedModel,
      chatRuntimeReasoningParams,
      settings.chatRuntimeControls,
      thinkingLiveVersion,
    ],
  );
  const handleChatRuntimeControlsChange = useCallback(
    (patch: Partial<ChatRuntimeControls>) => {
      const selection = applyThinkingPatchToSelection(
        activeSelectedModel,
        chatRuntimeControlsForCurrentProvider,
        patch,
      );
      if (selection) saveConversationSelection(currentConversationIdRef.current, selection);
      // 全局设置继续记录最近的调整，作为新会话的默认值。
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
      saveConversationSelection,
      setSettings,
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
