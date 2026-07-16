import {
  type AppSettings,
  isAutoModelSelection,
  type ProviderId,
  type SelectedModel,
} from "../../../lib/settings";
import {
  type GatewaySelectedModelEvent,
  normalizeGatewayProviderType,
} from "../gateway/gatewayBridgeTypes";
import { type AutoRoutingDecision, type AutoRoutingInput, routeAutoModel } from "./autoModelRouter";

export type EffectiveChatModelSelection = {
  selectedModel: SelectedModel;
  provider: AppSettings["customProviders"][number];
  providerId: ProviderId;
  model: string;
  autoRouting?: Pick<AutoRoutingDecision, "requestedTier" | "selectedTier" | "reasons">;
};

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
  routingInput?: AutoRoutingInput;
}): EffectiveChatModelSelection {
  const { settings, conversationSelectedModel, gatewaySelectedModel, routingInput } = params;
  const resolveLocalSelection = (): EffectiveChatModelSelection => {
    const activeSelectedModel = resolveActiveModelSelection(settings, conversationSelectedModel);
    if (!activeSelectedModel) {
      throw new Error("请先在左上角选择一个模型（或先去设置添加模型）。");
    }

    if (isAutoModelSelection(activeSelectedModel)) {
      if (!routingInput) {
        throw new Error("Auto 模式需要当前消息才能选择模型。");
      }
      const routed = routeAutoModel(settings, routingInput);
      return {
        selectedModel: activeSelectedModel,
        provider: routed.provider,
        providerId: routed.provider.type,
        model: routed.model,
        autoRouting: {
          requestedTier: routed.requestedTier,
          selectedTier: routed.selectedTier,
          reasons: routed.reasons,
        },
      };
    }

    const { customProviderId, model } = activeSelectedModel;
    const provider = settings.customProviders.find((item) => item.id === customProviderId);
    if (!provider) {
      throw new Error("所选供应商不存在，请重新选择模型。");
    }
    if (!provider.activeModels.includes(model)) {
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
  if (!provider.activeModels.includes(model)) {
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
