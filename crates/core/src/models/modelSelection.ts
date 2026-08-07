// 自桌面版 pages/chat/runtime/modelSelection.ts 移植。
// 砍掉了 gatewaySelectedModel 分支:那是旧 Go 中继携带模型覆写的路径,
// 新架构里前端把 selectedModel 直接放进 chat_send 请求体。

import type { AppSettings, ProviderId, SelectedModel } from "../settings";

// 结构化选择失败原因。message 保持原中文文案不变:它经 chat_send 响应/终态事件
// 原样回到前端渲染,改文案即破坏 userspace。前端适配 code 后再由前端本地化。
export type ChatModelSelectionErrorCode =
  | "no_model_selected"
  | "provider_missing"
  | "model_not_enabled";

export class ChatModelSelectionError extends Error {
  readonly code: ChatModelSelectionErrorCode;

  constructor(code: ChatModelSelectionErrorCode, message: string) {
    super(message);
    this.name = "ChatModelSelectionError";
    this.code = code;
  }
}

export type EffectiveChatModelSelection = {
  selectedModel: SelectedModel;
  provider: AppSettings["customProviders"][number];
  providerId: ProviderId;
  model: string;
};

export function resolveEffectiveChatModelSelection(params: {
  settings: AppSettings;
  conversationSelectedModel?: SelectedModel;
}): EffectiveChatModelSelection {
  const { settings, conversationSelectedModel } = params;
  const activeSelectedModel = conversationSelectedModel ?? settings.selectedModel;
  if (!activeSelectedModel) {
    throw new ChatModelSelectionError(
      "no_model_selected",
      "请先在左上角选择一个模型（或先去设置添加模型）。",
    );
  }

  const { customProviderId, model } = activeSelectedModel;
  const provider = settings.customProviders.find((item) => item.id === customProviderId);
  if (!provider) {
    throw new ChatModelSelectionError("provider_missing", "所选供应商不存在，请重新选择模型。");
  }
  if (!provider.activeModels.includes(model)) {
    throw new ChatModelSelectionError("model_not_enabled", "所选模型未启用，请重新选择模型。");
  }

  return {
    selectedModel: activeSelectedModel,
    provider,
    providerId: provider.type,
    model,
  };
}
