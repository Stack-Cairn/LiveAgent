import { coerceDialectForProtocol } from "@liveagent/ui/lib/providers/registry/protocols";
import {
  type CodexRequestFormat,
  getLegacyProviderChatProtocol,
  getLegacyProviderDialect,
  getProviderChatProtocolAdapter,
  PROVIDER_PROTOCOL_FAMILY,
  type ProviderChatProtocol,
  type ProviderId,
  type ProviderProtocolFamily,
  type ProviderWireDialect,
} from "../../settings";
import type { ProviderRuntimeConfig } from "./types";

/**
 * 运行时读取点共用的 (protocol, dialect) 视图。路由结果写入 ProviderRuntimeConfig
 * 后由此读出；手写的旧 runtime（缺 protocol / dialect）按 adapterProviderId 与
 * requestFormat 旧推导补齐，保证无新字段的旧配置行为不变。
 */
export type RuntimeWireRoute = {
  protocol: ProviderChatProtocol;
  dialect: ProviderWireDialect;
  family: ProviderProtocolFamily;
  /** 旧适配器家族：payload 中间件、本地反代路径与 hosted search 探针仍按它分支。 */
  adapterProviderId: ProviderId;
};

type WireRouteInput = Partial<
  Pick<
    ProviderRuntimeConfig,
    "adapterProviderId" | "chatProtocol" | "protocol" | "dialect" | "family" | "requestFormat"
  >
>;

/** 旧调用方（ProviderId + requestFormat）的 (protocol, dialect) 推导。 */
export function resolveLegacyWireRoute(
  providerId: ProviderId,
  requestFormat?: CodexRequestFormat,
): RuntimeWireRoute {
  const protocol = getLegacyProviderChatProtocol(providerId, requestFormat);
  const dialect = coerceDialectForProtocol(protocol, getLegacyProviderDialect(providerId));
  return {
    protocol,
    dialect,
    family: PROVIDER_PROTOCOL_FAMILY[protocol],
    adapterProviderId: getProviderChatProtocolAdapter(protocol, dialect),
  };
}

export function resolveRuntimeWireRoute(
  providerId: ProviderId,
  runtime: WireRouteInput,
): RuntimeWireRoute {
  const adapterProviderId = runtime.adapterProviderId ?? providerId;
  const protocol =
    runtime.protocol ??
    runtime.chatProtocol ??
    getLegacyProviderChatProtocol(adapterProviderId, runtime.requestFormat);
  const dialect = coerceDialectForProtocol(
    protocol,
    runtime.dialect ?? getLegacyProviderDialect(adapterProviderId),
  );
  return {
    protocol,
    dialect,
    family: runtime.family ?? PROVIDER_PROTOCOL_FAMILY[protocol],
    adapterProviderId:
      runtime.adapterProviderId ?? getProviderChatProtocolAdapter(protocol, dialect),
  };
}

/** 本地模型 ID：目录匹配、熔断 key 与展示都用它，绝不用远端模型名。 */
export function resolveRuntimeLocalModelId(
  runtime: Pick<ProviderRuntimeConfig, "modelId" | "modelConfig">,
  fallback: string,
): string {
  return runtime.modelId?.trim() || runtime.modelConfig?.id?.trim() || fallback;
}

/** 发给远端的模型名；缺省等于本地模型 ID。 */
export function resolveRuntimeWireModelId(
  runtime: Pick<ProviderRuntimeConfig, "wireModelId" | "modelConfig">,
  localModelId: string,
): string {
  return runtime.wireModelId?.trim() || runtime.modelConfig?.wireModelId?.trim() || localModelId;
}
