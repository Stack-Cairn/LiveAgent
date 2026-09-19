import type { SimpleStreamOptions } from "@earendil-works/pi-ai";
import type {
  ResolvedModelCapabilities,
  ResolvedModelInputModalities,
} from "@liveagent/ui/lib/models/modelCapabilities";
import type { SharedModelOption } from "@liveagent/ui/lib/models/modelOptions";
import type { EndpointIdentity } from "@liveagent/ui/lib/providers/customHeaders";
import type {
  CodexRequestFormat,
  CustomProvider,
  ModelParameterOverrides,
  PromptCacheHintMode,
  ProviderChatProtocol,
  ProviderEndpointAuth,
  ProviderEndpointQuirks,
  ProviderId,
  ProviderModelConfig,
  ProviderProtocolFamily,
  ProviderRetryPolicy,
  ProviderWireDialect,
  ReasoningLevel,
} from "../../settings";
import type { StreamRetryConfig } from "./streamRetry";

export type ModelOption = SharedModelOption<ProviderId>;

declare const PROVIDER_RUNTIME_CONFIG_BRAND: unique symbol;

/**
 * 供应商请求运行时配置——全仓唯一定义，唯一构造点是
 * createProviderRuntimeConfig()（见 ./providerRuntimeConfig）。
 *
 * 品牌字段让手写对象字面量一律编译不过：字段几乎全是可选的，逐字段转抄漏掉
 * customHeaders / promptCacheRetention 时 TypeScript 不会报警，而那正是自定义
 * 请求头在聊天全链路上失效的根因。需要派生请用展开（{...runtime, reasoning}），
 * 品牌随展开保留。
 */
export type ProviderRuntimeConfig = {
  readonly [PROVIDER_RUNTIME_CONFIG_BRAND]: true;
  baseUrl: string;
  isFullUrl: boolean;
  /** 路由输出：地址以 # 结尾要求原样使用，模型工厂不再补 /v1 或 /v1beta。 */
  baseUrlVerbatim?: boolean;
  /** Saved provider category remains caller identity; this is the resolved transport adapter. */
  adapterProviderId: ProviderId;
  chatProtocol: ProviderChatProtocol;
  // ---- 路由结果（设计文档 4.1）。以下字段由 resolveProviderChatRoute 一次算出；
  // 手写的旧 runtime（测试、旧调用方）可能缺省，读取点经 resolveRuntimeWireRoute
  // 按 adapterProviderId / requestFormat 旧推导补齐。
  /** 与 chatProtocol 相同；新读取点用这个名字。 */
  protocol?: ProviderChatProtocol;
  dialect?: ProviderWireDialect;
  /** 接口家族：故障转移分组依据。 */
  family?: ProviderProtocolFamily;
  /** 本地模型 ID（目录匹配、熔断 key、展示）。 */
  modelId?: string;
  /** 发给远端的模型名；缺省等于本地模型 ID。 */
  wireModelId?: string;
  /** 路由选中的凭据 ID；apiKey 即该凭据的值。 */
  credentialId?: string;
  /** 端点地址由哪个源展开（端点用 `{origin}` 占位时才有）；熔断 key 与源层故障转移据此区分。 */
  originId?: string;
  originUrl?: string;
  apiKey: string;
  /** 供应商级与端点级用户头合并后的结果（路由输出）。 */
  customHeaders?: CustomProvider["customHeaders"];
  /** 端点 quirks；映射到 pi-ai Model.compat 同名键。 */
  quirks?: ProviderEndpointQuirks;
  /** 端点鉴权头覆盖；缺省由协议头档决定。 */
  authOverride?: ProviderEndpointAuth;
  /** 端点身份模拟（路由输出）；缺省 = 只有协议头档 + 方言头档。 */
  identity?: EndpointIdentity;
  requestFormat?: CodexRequestFormat;
  reasoning?: ReasoningLevel;
  promptCachingEnabled?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  promptCacheRetention?: "short" | "long";
  nativeWebSearchEnabled?: boolean;
  useSystemProxy?: boolean;
  /** 供应商级流内重试策略；缺省 = 全局默认。failover 逐候选独立携带。 */
  retryPolicy?: ProviderRetryPolicy;
  modelConfig?: ProviderModelConfig;
  /**
   * 模型能力的有效状态与来源（用户覆盖 > 目录 > 供应商规则 / 启发式），与设置页
   * 能力芯片同一份解析。runner 按 tools 门控是否下发工具定义。
   */
  capabilities?: ResolvedModelCapabilities;
  /** 有效输入模态（用户覆盖 > 目录 > 能力反推 > 仅文本）；模型工厂据此决定 Model.input。 */
  inputModalities?: ResolvedModelInputModalities;
  // --- 设计 §6.3 新增 ---
  /**
   * 模型级请求参数覆盖，已按本次路由的接口过滤与钳制
   * （resolveModelParametersForProtocol）。agentRunner / textOnlyRuntime 装配
   * stream options 时直接应用，缺省表示本次请求不带模型级参数。
   */
  parameters?: ModelParameterOverrides;
  // --- §6.3 新增结束 ---
};

export type ToolChoice =
  | "auto"
  | "any"
  | "none"
  | {
      type: "tool";
      name: string;
    };

export type StreamOptionsEx = SimpleStreamOptions & {
  /**
   * 注意：pi-ai 的 streamSimpleAnthropic() 在内部会通过 buildBaseOptions() 丢弃 toolChoice，
   * 所以这里我们自己调用 streamAnthropic() 并把 toolChoice 显式传下去。
   */
  toolChoice?: ToolChoice;
  /** DeepSeek-only wire override for callers that must explicitly disable thinking. */
  deepSeekThinking?: "disabled";
  /** Conversation workdir used to resolve provider-native local attachments. */
  workdir?: string;
  /** Escape hatch for the unified provider stream retry in streamByApi.ts. */
  streamRetry?: StreamRetryConfig;
};
