import type { CacheRetention } from "@earendil-works/pi-ai";
import type { ProviderId } from "../../settings";
import { isRecord } from "./common";
import type { StreamOptionsEx } from "./types";

function buildAnthropicAutomaticCacheControl(
  baseUrl: string,
  cacheRetention?: CacheRetention,
): Record<string, unknown> | undefined {
  if (!cacheRetention || cacheRetention === "none") return undefined;

  return {
    type: "ephemeral",
    ...(cacheRetention === "long" && baseUrl.includes("api.anthropic.com") ? { ttl: "1h" } : {}),
  };
}

function stripNestedAnthropicCacheControl(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const stripped = stripNestedAnthropicCacheControl(item);
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

    const stripped = stripNestedAnthropicCacheControl(nested);
    if (stripped !== nested) changed = true;
    next[key] = stripped;
  }

  return changed ? next : value;
}

function normalizeAnthropicMessagesForCaching(messages: unknown): unknown {
  if (!Array.isArray(messages)) return messages;

  let changed = false;
  const next = messages.map((message) => {
    if (!isRecord(message) || typeof message.content !== "string") {
      return message;
    }

    changed = true;
    return {
      ...message,
      content: [
        {
          type: "text",
          text: message.content,
        },
      ],
    };
  });

  return changed ? next : messages;
}

function markLastCacheableAnthropicBlock(
  blocks: unknown,
  cacheControl: Record<string, unknown>,
): unknown {
  if (!Array.isArray(blocks)) return blocks;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (!isRecord(block)) continue;

    if (block.type === "thinking") continue;
    if (block.type === "text" && typeof block.text === "string" && !block.text.trim()) continue;

    const next = blocks.slice();
    next[index] = {
      ...block,
      cache_control: cacheControl,
    };
    return next;
  }

  return blocks;
}

function applyAnthropicExplicitCacheBreakpoint(
  payload: Record<string, unknown>,
  cacheControl: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedMessages = normalizeAnthropicMessagesForCaching(payload.messages);

  if (Array.isArray(normalizedMessages)) {
    for (let messageIndex = normalizedMessages.length - 1; messageIndex >= 0; messageIndex -= 1) {
      const message = normalizedMessages[messageIndex];
      if (!isRecord(message)) continue;

      const markedContent = markLastCacheableAnthropicBlock(message.content, cacheControl);
      if (markedContent === message.content) continue;

      const nextMessages = normalizedMessages.slice();
      nextMessages[messageIndex] = {
        ...message,
        content: markedContent,
      };

      return {
        ...payload,
        messages: nextMessages,
      };
    }
  }

  const markedSystem = markLastCacheableAnthropicBlock(payload.system, cacheControl);
  if (markedSystem !== payload.system) {
    return {
      ...payload,
      system: markedSystem,
    };
  }

  const markedTools = markLastCacheableAnthropicBlock(payload.tools, cacheControl);
  if (markedTools !== payload.tools) {
    return {
      ...payload,
      tools: markedTools,
    };
  }

  return normalizedMessages === payload.messages
    ? payload
    : {
        ...payload,
        messages: normalizedMessages,
      };
}

function supportsAnthropicTopLevelAutomaticCaching(baseUrl: string) {
  const normalized = baseUrl.trim().toLowerCase();
  return normalized.includes("api.anthropic.com");
}

function normalizeAnthropicPayloadMessages(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const normalizedMessages = normalizeAnthropicMessagesForCaching(payload.messages);
  return normalizedMessages === payload.messages
    ? payload
    : {
        ...payload,
        messages: normalizedMessages,
      };
}

export function attachAnthropicAutomaticCaching(
  providerId: ProviderId,
  baseUrl: string,
  options: StreamOptionsEx,
): StreamOptionsEx {
  const cacheControl = buildAnthropicAutomaticCacheControl(baseUrl, options.cacheRetention);
  const previousOnPayload = options.onPayload;

  if (providerId !== "claude_code" || !cacheControl) {
    return options;
  }

  return {
    ...options,
    onPayload: async (payload, model) => {
      let nextPayload = payload;

      if (model.api === "anthropic-messages" && isRecord(nextPayload)) {
        // Keep Anthropic payloads in a stable shape for exact-prefix matching.
        // For Anthropic-compatible proxies that ignore top-level automatic caching,
        // fall back to an explicit breakpoint on the last cacheable block.
        const sanitizedPayload = stripNestedAnthropicCacheControl(nextPayload) as Record<
          string,
          unknown
        >;
        nextPayload = supportsAnthropicTopLevelAutomaticCaching(baseUrl)
          ? {
              ...normalizeAnthropicPayloadMessages(sanitizedPayload),
              cache_control: cacheControl,
            }
          : applyAnthropicExplicitCacheBreakpoint(sanitizedPayload, cacheControl);
      }

      if (previousOnPayload) {
        const overridden = await previousOnPayload(nextPayload, model);
        if (overridden !== undefined) {
          nextPayload = overridden;
        }
      }

      return nextPayload;
    },
  };
}
