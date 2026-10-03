import type { Api, Context, Message, Model } from "@earendil-works/pi-ai";
import { attachPinnedTailBlocks, type PinnedTailBlock } from "../../chat/context/contextTailBlock";
import { sanitizeContextForModelRequest } from "../../chat/context/requestContextSanitizer";
import type { StreamDebugLogger } from "../../debug/agentDebug";
import type { PromptCacheHintMode, ProviderId } from "../../settings";
import { createModelFromConfig } from "./modelFactory";
import { finalizeProviderStreamOptions } from "./payloadPipeline";
import { prepareProviderRequest } from "./requestOptions";
import type { StreamRetryConfig } from "./streamRetry";
import type { ProviderRuntimeConfig, StreamOptionsEx } from "./types";

// ============================================================================
// 主请求的装配原语：配方（内容 / 缓存形状）+ 现取传输 → finalize。
//
// agent 与 text 两条主循环都经 shapeRequestContext + finalizeRequest 出站，
// 配方经 onRequestPrepared 交给会话的压缩控制器保存。之后任何"与上一轮请求
// 字节一致"的派生请求只需换 messages、重取传输，同一套函数保证不漂移。
// agentRunner 的传输为复用已备好的 proxyRequest 仍内联装配，须与
// prepareTransport 同口径（model-request.test 重放锁定）。
// ============================================================================

/**
 * 配方只记决定请求体字节与缓存键的 pre-finalize 选项（白名单）。凭证与传输
 * （apiKey / headers / fetch / env / timeout / 重试 / transport）、运行期句柄
 * （signal、streamRetry、onPayload / onResponse 回调）以及 pi-agent-core 的整份
 * loop 配置（beforeToolCall、prepareNextTurn、convertToLlm、getSteeringMessages…）
 * 一律不入：前者换 key / 端点后必须现取，后者会把整张 Agent 对象图钉在会话上。
 * 注：pi-agent-core 的 `transport: "auto"` 今天无人消费（只有未注册的
 * openai-codex-responses 读它）；接入该协议时须把它补回装配链。
 */
const REQUEST_RECIPE_OPTION_KEYS = [
  "reasoning",
  "thinkingBudgets",
  "maxTokens",
  "temperature",
  "samplingParams",
  "toolChoice",
  "cacheRetention",
  "sessionId",
  "metadata",
  "deepSeekThinking",
  "workdir",
] as const satisfies readonly (keyof StreamOptionsEx)[];

export type RequestRecipeOptions = Pick<
  StreamOptionsEx,
  (typeof REQUEST_RECIPE_OPTION_KEYS)[number]
>;

export type RequestShape = "agent" | "text";

export type RequestRecipe = {
  providerId: ProviderId;
  modelId: string;
  /**
   * 服务这次请求的 failover 候选身份（failoverBreakerKey）。同 vendor 的 fallback 与
   * 主目标 providerId / modelId 完全相同，只有它能区分配方出自哪个 provider。
   */
  targetKey: string;
  /**
   * 目标模型协议，仅作身份核对；finalize 用的 model 永远来自现取的传输。重放前
   * 除 providerId / modelId 外还须核对它（同模型 responses↔completions 切换时，
   * toolChoice / reasoning / cacheRetention 是按另一协议算的）。
   */
  api: Api;
  shape: RequestShape;
  /** provider 边界最终值：agent 已拼 toolsSuffix，text 已拼 text-only 后缀。 */
  systemPrompt?: string;
  /** 请求可见工具（agent 已过 filterRequestTools），只留线上字段（toRecipeTools）。 */
  tools?: Context["tools"];
  /** agent 专属：本轮钉死锚点的尾部投递块。 */
  wireTail?: readonly PinnedTailBlock[];
  /** 本轮实际发出的 messages 引用（挂 wireTail、sanitize 之前）。 */
  messages: readonly Message[];
  options: RequestRecipeOptions;
  nativeWebSearch?: boolean;
  promptCacheHintMode?: PromptCacheHintMode;
  recordedAt: number;
};

/** shapeRequestContext 只读的配方切面：agent 在逐目标配方成形前就要成形上下文。 */
export type RequestContextShape = Pick<
  RequestRecipe,
  "shape" | "systemPrompt" | "tools" | "wireTail"
>;

/** 每次请求现取的传输：反代 model、凭证、代理 / 鉴权 / 自定义头。绝不入配方。 */
export type PreparedTransport = {
  model: Model<Api>;
  apiKey: string;
  headers: NonNullable<StreamOptionsEx["headers"]>;
  /** 用户配置的上游 baseUrl（非反代地址）：finalize 拦截器据此判定官方 / 中转。 */
  baseUrl: string;
};

export type FinalizeRequestExtra = {
  signal?: AbortSignal;
  streamRetry?: StreamRetryConfig;
  /** 追加在传输头之后的逐次请求头（如 hosted-search 探针），不入配方。 */
  headers?: StreamOptionsEx["headers"];
  debugLogger?: StreamDebugLogger;
  round?: number;
};

/** 按白名单摘出有定义的配方选项。 */
export function pickRequestRecipeOptions(
  options: StreamOptionsEx | undefined,
): RequestRecipeOptions {
  const picked: Record<string, unknown> = {};
  for (const key of REQUEST_RECIPE_OPTION_KEYS) {
    if (options?.[key] !== undefined) picked[key] = options[key];
  }
  return picked as RequestRecipeOptions;
}

/**
 * 配方只留工具的线上字段（pi-ai 只读这四个）：AgentTool 的 execute 闭包会把整个
 * runner 作用域（Agent、回合回调、hosted-search 映射…）钉在会话控制器上。
 */
export function toRecipeTools(tools: Context["tools"]): Context["tools"] {
  return tools?.map(({ name, description, parameters, constrainedSampling }) => ({
    name,
    description,
    parameters,
    ...(constrainedSampling === undefined ? {} : { constrainedSampling }),
  }));
}

/** 与 agent / text 主循环同口径的传输装配：内置头 → 自定义头 → 反代，再按反代地址建 model。 */
export async function prepareTransport(
  providerId: ProviderId,
  modelId: string,
  runtime: ProviderRuntimeConfig,
  options?: { sessionId?: string },
): Promise<PreparedTransport> {
  const proxyRequest = await prepareProviderRequest(providerId, runtime, {
    sessionId: options?.sessionId,
  });
  return {
    model: createModelFromConfig(
      providerId,
      modelId,
      proxyRequest.baseUrl,
      runtime.requestFormat,
      runtime.modelConfig,
      runtime.baseUrl.trim(),
    ),
    apiKey: runtime.apiKey,
    headers: proxyRequest.headers,
    baseUrl: runtime.baseUrl,
  };
}

/**
 * 出站上下文成形。text：原样（system / tools 已是边界最终值）；agent：尾部
 * 投递逐请求重挂到各自钉死的锚点（agent.state.messages 永不含它），再统一
 * sanitize。
 */
export function shapeRequestContext(recipe: RequestContextShape, messages: Message[]): Context {
  if (recipe.shape === "text") {
    return {
      systemPrompt: recipe.systemPrompt,
      messages,
      ...(recipe.tools ? { tools: recipe.tools } : {}),
    };
  }
  return sanitizeContextForModelRequest({
    systemPrompt: recipe.systemPrompt,
    messages: recipe.wireTail?.length
      ? attachPinnedTailBlocks(messages.slice(), recipe.wireTail)
      : messages.slice(),
    tools: recipe.tools,
  });
}

/**
 * 配方 + 传输 + 逐次参数 → llm.stream 请求。finalize 每次现跑：payload 拦截器
 * 读 context，配方里只存 pre-finalize 选项，重复 finalize 会二次注入。
 */
export function finalizeRequest(
  recipe: RequestRecipe,
  context: Context,
  transport: PreparedTransport,
  extra: FinalizeRequestExtra = {},
): { model: Model<Api>; context: Context; options: StreamOptionsEx } {
  // extra 只合并有定义的键：显式 undefined 不得抹掉配方或传输里的同名字段。
  const options: StreamOptionsEx = {
    ...recipe.options,
    apiKey: transport.apiKey,
    headers: { ...transport.headers, ...extra.headers },
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.streamRetry ? { streamRetry: extra.streamRetry } : {}),
  };
  return {
    model: transport.model,
    context,
    options: finalizeProviderStreamOptions({
      providerId: recipe.providerId,
      baseUrl: transport.baseUrl,
      options,
      context,
      model: transport.model,
      workdir: recipe.options.workdir,
      nativeWebSearch: recipe.nativeWebSearch,
      promptCacheHintMode: recipe.promptCacheHintMode,
      debugLogger: extra.debugLogger,
      extra: { round: extra.round, sessionId: recipe.options.sessionId },
    }),
  };
}
