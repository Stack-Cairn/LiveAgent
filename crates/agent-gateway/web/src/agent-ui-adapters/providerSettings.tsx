import { normalizeProviderModelConfigs } from "@liveagent/ui/lib/settings";
import type { ProviderModelDiscoveryInput } from "@liveagent/ui/pages/settings/providerSettingsAdapter";
import { getGatewayWebSocketClient } from "../lib/gatewaySocket";
import type { AppSettings, CustomProvider, ProviderModelConfig } from "../lib/settings";
import { loadToken } from "../lib/storage";
import type { SettingsSectionProps } from "../pages/settings/types";

export async function discoverProviderModels(
  input: ProviderModelDiscoveryInput,
): Promise<ProviderModelConfig[]> {
  const response = await getGatewayWebSocketClient(loadToken().trim()).getProviderModels(
    input.type,
    input.baseUrl,
    input.apiKey,
    input.useSystemProxy === true,
    input.modelsUrl ?? "",
    input.providerId ?? "",
    input.isFullUrl,
    input.customHeaders,
    input.requestFormat,
  );
  const models = Array.isArray(response)
    ? response
    : response && typeof response === "object"
      ? (response as { models?: unknown }).models
      : undefined;
  if (!Array.isArray(models)) throw new Error("Malformed provider model discovery response");
  return normalizeProviderModelConfigs(models, input.type);
}

/** WebUI 会脱敏 API Key，复制配置按钮仅在桌面端提供。 */
export function ProviderCopyConfigButton(_props: {
  provider: Pick<CustomProvider, "baseUrl" | "apiKey">;
}) {
  return null;
}

export function ProviderSettingsExtension(_props: {
  settings: AppSettings;
  setSettings: SettingsSectionProps["setSettings"];
  triggerClassName?: string;
}) {
  return null;
}

export const providerCredentialsRedacted = true;

/** WebUI 永不下发明文 API Key：远程端没有查看已保存密钥的入口。 */
export async function revealStoredProviderApiKey(_providerId: string): Promise<string | null> {
  return null;
}
