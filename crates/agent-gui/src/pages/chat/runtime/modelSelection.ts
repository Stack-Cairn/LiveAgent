import { isImageGenerationModel } from "@liveagent/ui/lib/models/modelType";
import type { AppSettings, ProviderId, SelectedModel } from "../../../lib/settings";
import {
  type GatewaySelectedModelEvent,
  normalizeGatewayProviderType,
} from "../gateway/gatewayBridgeTypes";

export type EffectiveChatModelSelection = {
  selectedModel: SelectedModel;
  provider: AppSettings["customProviders"][number];
  providerId: ProviderId;
  model: string;
};

/**
 * 模型可用 = 供应商未停用且模型在启用列表内；两种失效对调用方同一处理。
 * 生图模型（modelType === "image"）不能进聊天：它们走 generate_image 工具的
 * 图像生成接口，聊天流拿不到图片输出。
 */
export function isProviderModelAvailable(
  provider: Pick<
    AppSettings["customProviders"][number],
    "enabled" | "activeModels" | "type" | "presetId" | "models"
  >,
  model: string,
): boolean {
  if (provider.enabled === false || !provider.activeModels.includes(model)) return false;
  // --- image generation (begin) ---------------------------------------------
  return !isImageGenerationModel(provider, model);
  // --- image generation (end) -----------------------------------------------
}

export function resolveActiveModelSelection(
  settings: AppSettings,
  conversationSelectedModel: SelectedModel | undefined,
): SelectedModel | undefined {
  return conversationSelectedModel ?? settings.selectedModel;
}

export function resolvePersistedConversationModelSelection(params: {
  runtimeSelectedModel?: SelectedModel;
  turnSelectedModel?: SelectedModel;
}): SelectedModel | undefined {
  return params.runtimeSelectedModel ?? params.turnSelectedModel;
}

export function resolveEffectiveChatModelSelection(params: {
  settings: AppSettings;
  conversationSelectedModel?: SelectedModel;
  gatewaySelectedModel?: GatewaySelectedModelEvent;
}): EffectiveChatModelSelection {
  const { settings, conversationSelectedModel, gatewaySelectedModel } = params;
  const resolveLocalSelection = (): EffectiveChatModelSelection => {
    const activeSelectedModel = resolveActiveModelSelection(settings, conversationSelectedModel);
    if (!activeSelectedModel) {
      throw new Error("请先在输入框左下角选择一个模型（或先去设置添加模型）。");
    }

    const { customProviderId, model } = activeSelectedModel;
    const provider = settings.customProviders.find((item) => item.id === customProviderId);
    if (!provider) {
      throw new Error("所选供应商不存在，请重新选择模型。");
    }
    // 供应商总开关关闭等同于模型未启用：模型列表（buildModelOptions）已不再
    // 列出它，残留的会话 / 全局选择也不能绕过开关继续发请求。
    if (!isProviderModelAvailable(provider, model)) {
      throw new Error("所选模型未启用，请重新选择模型。");
    }

    return {
      selectedModel: activeSelectedModel,
      provider,
      providerId: provider.type,
      model,
    };
  };

  if (!gatewaySelectedModel) {
    return resolveLocalSelection();
  }

  const customProviderId = gatewaySelectedModel.customProviderId.trim();
  const model = gatewaySelectedModel.model.trim();
  const providerType = normalizeGatewayProviderType(gatewaySelectedModel.providerType);
  if (!customProviderId || !model || !providerType) {
    throw new Error("远程请求携带的模型配置无效，请在 WebUI 重新选择模型后重试。");
  }

  const provider = settings.customProviders.find((item) => item.id === customProviderId);
  if (!provider) {
    throw new Error(
      "远程请求所选模型对应的供应商不存在，请同步桌面端设置后在 WebUI 重新选择模型。",
    );
  }
  if (provider.type !== providerType) {
    throw new Error(
      "远程请求所选模型的供应商类型与桌面端配置不一致，请同步桌面端设置后在 WebUI 重新选择模型。",
    );
  }
  if (!isProviderModelAvailable(provider, model)) {
    throw new Error("远程请求所选模型未在桌面端启用，请同步桌面端设置后在 WebUI 重新选择模型。");
  }

  return {
    selectedModel: {
      customProviderId: provider.id,
      model,
    },
    provider,
    providerId: provider.type,
    model,
  };
}
