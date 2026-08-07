import type {
  Api,
  Model,
  OpenAICompletionsCompat,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { isOnlyDsmlOrphanCloseTags, stripDsmlToolCallMarkup } from "../chat/runner/deepSeekDsml";
import type { ProviderId } from "../settings";

type PayloadHook = (payload: unknown, model: Model<Api>) => unknown | Promise<unknown>;

type DeepSeekStreamOptionsLike = SimpleStreamOptions & {
  onPayload?: PayloadHook;
  deepSeekDsmlToolCallRepair?: boolean;
  deepSeekProviderAdapter?: boolean;
};

export const DEEPSEEK_THINKING_LEVEL_MAP: Model<"openai-completions">["thinkingLevelMap"] = {
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  max: "max",
  xhigh: "max",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBaseUrl(value: string | undefined) {
  return value?.trim().replace(/\/+$/, "").toLowerCase() ?? "";
}

function hasDeepSeekSignal(value: string | undefined) {
  return normalizeBaseUrl(value).includes("deepseek");
}

export function isDeepSeekTarget(params: {
  baseUrl?: string;
  upstreamBaseUrl?: string;
  modelId?: string;
}) {
  const modelId = params.modelId?.trim().toLowerCase() ?? "";
  return (
    hasDeepSeekSignal(params.baseUrl) ||
    hasDeepSeekSignal(params.upstreamBaseUrl) ||
    modelId.includes("deepseek")
  );
}

export function isDeepSeekCodexTarget(params: {
  providerId: ProviderId;
  baseUrl?: string;
  upstreamBaseUrl?: string;
  modelId?: string;
}) {
  return params.providerId === "codex" && isDeepSeekTarget(params);
}

export function isDeepSeekAnthropicTarget(params: {
  providerId?: ProviderId;
  api?: string;
  baseUrl?: string;
  upstreamBaseUrl?: string;
  modelId?: string;
}) {
  if (params.providerId && params.providerId !== "claude_code") return false;
  if (params.api && params.api !== "anthropic-messages") return false;
  return isDeepSeekTarget(params);
}

export function resolveDeepSeekOpenAICompletionsOverrides(): {
  compat: OpenAICompletionsCompat;
  thinkingLevelMap: Model<"openai-completions">["thinkingLevelMap"];
} {
  return {
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
      supportsStrictMode: false,
      supportsLongCacheRetention: false,
    },
    thinkingLevelMap: DEEPSEEK_THINKING_LEVEL_MAP,
  };
}

export function applyDeepSeekModelDefaults<T extends Model<Api>>(
  model: T,
  params: {
    providerId: ProviderId;
    baseUrl?: string;
    upstreamBaseUrl?: string;
    modelId?: string;
  },
): T {
  if (isDeepSeekCodexTarget(params) && model.api === "openai-completions") {
    const overrides = resolveDeepSeekOpenAICompletionsOverrides();
    // wire 值只补到模型已支持的档位上（pi-ai 语义：base 档缺省=支持、null=不支持，
    // xhigh/max 必须显式存在才支持）：可用性裁决完全归 modelThinking 目录，
    // 此处不得复活目录裁掉的档。
    const thinkingLevelMap = { ...(model.thinkingLevelMap ?? {}) };
    for (const [level, wire] of Object.entries(overrides.thinkingLevelMap ?? {})) {
      const key = level as keyof typeof thinkingLevelMap;
      const existing = thinkingLevelMap[key];
      const optIn = level === "xhigh" || level === "max";
      const supported = optIn ? typeof existing === "string" : existing !== null;
      if (supported && existing === undefined) {
        thinkingLevelMap[key] = wire;
      }
    }
    return {
      ...model,
      compat: {
        ...(model.compat ?? {}),
        ...overrides.compat,
      },
      thinkingLevelMap,
    } as T;
  }

  if (
    isDeepSeekAnthropicTarget({
      providerId: params.providerId,
      api: model.api,
      baseUrl: params.baseUrl,
      upstreamBaseUrl: params.upstreamBaseUrl,
      modelId: params.modelId,
    }) &&
    model.api === "anthropic-messages"
  ) {
    return {
      ...model,
      compat: {
        ...(model.compat ?? {}),
        allowEmptySignature: true,
        supportsCacheControlOnTools: false,
        supportsLongCacheRetention: false,
      },
    } as T;
  }

  return model;
}

export function mapDeepSeekReasoningEffort(
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
) {
  if (!reasoning) return undefined;
  return reasoning === "xhigh" || reasoning === "max" ? "max" : "high";
}

function sanitizeTextValue(value: string) {
  const stripped = stripDsmlToolCallMarkup(value);
  return isOnlyDsmlOrphanCloseTags(stripped) ? "" : stripped;
}

function sanitizeContentValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeTextValue(value);
  }
  if (!Array.isArray(value)) return value;

  let changed = false;
  const next = value.flatMap((block) => {
    if (!isRecord(block)) return [block];

    if (typeof block.text === "string") {
      const text = sanitizeTextValue(block.text);
      if (text !== block.text) changed = true;
      if (!text.trim() && block.type === "text") return [];
      return [{ ...block, text }];
    }

    if (typeof block.thinking === "string") {
      const thinking = sanitizeTextValue(block.thinking);
      if (thinking !== block.thinking) changed = true;
      if (!thinking.trim() && block.type === "thinking" && !block.signature) return [];
      return [{ ...block, thinking }];
    }

    if (block.type === "tool_result") {
      const content = sanitizeContentValue(block.content);
      if (content !== block.content) changed = true;
      return [{ ...block, content }];
    }

    return [block];
  });

  return changed ? next : value;
}

function sanitizePayloadMessages(payload: Record<string, unknown>) {
  if (!Array.isArray(payload.messages)) return payload;

  let changed = false;
  const messages = payload.messages.map((message) => {
    if (!isRecord(message)) return message;

    let nextMessage = message;
    if ("content" in message) {
      const content = sanitizeContentValue(message.content);
      if (content !== message.content) {
        changed = true;
        nextMessage = { ...nextMessage, content };
      }
    }
    if (typeof nextMessage.reasoning_content === "string") {
      const reasoningContent = sanitizeTextValue(nextMessage.reasoning_content);
      if (reasoningContent !== nextMessage.reasoning_content) {
        changed = true;
        nextMessage = { ...nextMessage, reasoning_content: reasoningContent };
      }
    }

    return nextMessage;
  });

  return changed ? { ...payload, messages } : payload;
}

function normalizeDeepSeekOpenAIPayload(
  payload: Record<string, unknown>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
) {
  let nextPayload = sanitizePayloadMessages(payload);

  const effort = mapDeepSeekReasoningEffort(reasoning);
  nextPayload = {
    ...nextPayload,
    thinking: { type: effort ? "enabled" : "disabled" },
  };
  if (effort) {
    nextPayload.reasoning_effort = effort;
  } else {
    delete nextPayload.reasoning_effort;
  }

  if (Array.isArray(nextPayload.messages)) {
    let changed = false;
    const messages = nextPayload.messages.map((message) => {
      if (
        !isRecord(message) ||
        message.role !== "assistant" ||
        !Array.isArray(message.tool_calls) ||
        message.tool_calls.length === 0 ||
        message.reasoning_content !== undefined
      ) {
        return message;
      }
      changed = true;
      return { ...message, reasoning_content: "" };
    });
    if (changed) {
      nextPayload = { ...nextPayload, messages };
    }
  }

  return nextPayload;
}

function stripNestedCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripNestedCacheControl(item);
      if (stripped !== item) changed = true;
      return stripped;
    });
    return changed ? next : value;
  }

  if (!isRecord(value)) return value;

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "cache_control") {
      changed = true;
      continue;
    }
    const stripped = stripNestedCacheControl(nested);
    if (stripped !== nested) changed = true;
    next[key] = stripped;
  }
  return changed ? next : value;
}

function hasAnthropicToolUse(content: unknown) {
  return (
    Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "tool_use")
  );
}

function hasAnthropicThinkingBlock(content: unknown) {
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        isRecord(block) && (block.type === "thinking" || block.type === "redacted_thinking"),
    )
  );
}

function normalizeDeepSeekAnthropicPayload(
  payload: Record<string, unknown>,
  reasoning: SimpleStreamOptions["reasoning"] | undefined,
) {
  let nextPayload = stripNestedCacheControl(sanitizePayloadMessages(payload)) as Record<
    string,
    unknown
  >;

  const effort = mapDeepSeekReasoningEffort(reasoning);
  nextPayload = {
    ...nextPayload,
    thinking: { type: effort ? "enabled" : "disabled" },
  };
  if (effort) {
    nextPayload.output_config = {
      ...(isRecord(nextPayload.output_config) ? nextPayload.output_config : {}),
      effort,
    };
  } else if (isRecord(nextPayload.output_config)) {
    const { effort: _effort, ...outputConfig } = nextPayload.output_config;
    nextPayload =
      Object.keys(outputConfig).length > 0
        ? { ...nextPayload, output_config: outputConfig }
        : Object.fromEntries(
            Object.entries(nextPayload).filter(([key]) => key !== "output_config"),
          );
  }

  if (Array.isArray(nextPayload.messages)) {
    let changed = false;
    const messages = nextPayload.messages.map((message) => {
      if (
        !isRecord(message) ||
        message.role !== "assistant" ||
        !hasAnthropicToolUse(message.content) ||
        hasAnthropicThinkingBlock(message.content)
      ) {
        return message;
      }
      changed = true;
      return {
        ...message,
        content: [
          {
            type: "thinking",
            thinking: "",
            signature: "",
          },
          ...(Array.isArray(message.content) ? message.content : []),
        ],
      };
    });
    if (changed) {
      nextPayload = { ...nextPayload, messages };
    }
  }

  return nextPayload;
}

export function attachDeepSeekProviderPayloadAdapter<TOptions extends DeepSeekStreamOptionsLike>(
  options: TOptions,
  params: {
    providerId: ProviderId;
    baseUrl?: string;
    upstreamBaseUrl?: string;
    model?: Model<Api>;
  },
): TOptions {
  const model = params.model;
  // DeepSeek adapter 只服务实际选中的 chat/anthropic 协议；Responses 由用户配置决定。
  if (params.providerId === "codex" && model && model.api !== "openai-completions") return options;
  const isDeepSeek =
    params.providerId === "codex"
      ? isDeepSeekCodexTarget({
          providerId: params.providerId,
          baseUrl: params.baseUrl,
          upstreamBaseUrl: params.upstreamBaseUrl,
          modelId: model?.id,
        })
      : isDeepSeekAnthropicTarget({
          providerId: params.providerId,
          api: model?.api,
          baseUrl: params.baseUrl,
          upstreamBaseUrl: params.upstreamBaseUrl,
          modelId: model?.id,
        });

  if (!isDeepSeek || options.deepSeekProviderAdapter) return options;

  const previousOnPayload = options.onPayload;
  return {
    ...options,
    deepSeekDsmlToolCallRepair: true,
    deepSeekProviderAdapter: true,
    onPayload: async (payload, payloadModel) => {
      let nextPayload = payload;
      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, payloadModel);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      if (!isRecord(nextPayload)) return nextPayload;

      if (params.providerId === "codex" && payloadModel.api === "openai-completions") {
        return normalizeDeepSeekOpenAIPayload(nextPayload, options.reasoning);
      }
      if (params.providerId === "claude_code" && payloadModel.api === "anthropic-messages") {
        return normalizeDeepSeekAnthropicPayload(nextPayload, options.reasoning);
      }
      return sanitizePayloadMessages(nextPayload);
    },
  } as TOptions;
}
