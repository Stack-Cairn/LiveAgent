// 会话标题生成：一次性小请求，引擎独占（前端不再直连 LLM）。
//
// 与主对话轮次不同，这里没有工具、没有 hook、没有事件流：backend 代理一条
// POST 过来，跑完一次 text-only 请求就把归一化后的标题同步返回。标题永远是
// 可选增强——任何失败（模型未配置、网络错、被取消）都返回 null，调用方沿用
// 已有的 fallbackTitle，绝不因为标题失败影响会话本身。

import {
  buildConversationTitlePrompt,
  buildConversationTitleSystemPrompt,
  normalizeGeneratedConversationTitle,
} from "../chat/page/chatPageHelpers";
import { resolveEffectiveChatModelSelection } from "../models/modelSelection";
import {
  assistantMessageToText,
  createProviderRuntimeConfig,
  type ProviderRuntimeConfig,
  streamAssistantMessage,
} from "../providers/llm";
import type { SelectedModel } from "../settings";
import { loadPersistedSettingsWithDefaults } from "../settings/storage";
import { resolveConversationTitleModelSelection } from "./providerRuntimeConfig";

export type ConversationTitleRequest = {
  /** 用于生成标题的原文（首轮用户输入，或附件文件名拼接）。 */
  titleSourceText: string;
  /** 会话当前选定的模型；标题模型未单独配置时以它为准。 */
  selectedModel?: SelectedModel;
};

/**
 * 标题请求的运行时档位：关思考、关缓存、关联网。标题只是一句短文本，
 * 带上这些只会让它更慢更贵。
 */
export function buildConversationTitleRuntime(
  runtime: ProviderRuntimeConfig,
): ProviderRuntimeConfig {
  return {
    ...runtime,
    reasoning: "off",
    promptCachingEnabled: false,
    nativeWebSearchEnabled: false,
  };
}

export async function generateConversationTitle(
  request: ConversationTitleRequest,
): Promise<string | null> {
  const source = request.titleSourceText.trim();
  if (!source) return null;

  const { settings } = await loadPersistedSettingsWithDefaults();
  const selection = resolveConversationTitleModelSelection(
    settings,
    resolveEffectiveChatModelSelection({
      settings,
      conversationSelectedModel: request.selectedModel,
    }),
  );

  const runtime = buildConversationTitleRuntime(
    createProviderRuntimeConfig(
      selection.provider,
      selection.model,
      settings.chatRuntimeControls,
    ),
  );

  const assistant = await streamAssistantMessage({
    providerId: selection.providerId,
    model: selection.model,
    runtime,
    cacheRetention: "none",
    nativeWebSearch: false,
    context: {
      systemPrompt: buildConversationTitleSystemPrompt(settings.locale),
      messages: [
        {
          role: "user",
          content: buildConversationTitlePrompt(source, settings.locale),
          timestamp: Date.now(),
        },
      ],
    },
    onTextDelta: () => {},
  });

  return normalizeGeneratedConversationTitle(assistantMessageToText(assistant)) || null;
}
