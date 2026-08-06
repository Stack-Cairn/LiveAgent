import type { AssistantMessage } from "@earendil-works/pi-ai";
import { normalizeErrorMessage } from "../providers/llm";

function createEmptyAssistantUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

export function buildErrorAssistantMessage(params: {
  model: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    id: string;
  };
  errorMessage: string;
  timestamp?: number;
}): AssistantMessage {
  const errorMessage = normalizeErrorMessage(params.errorMessage, "Request failed");
  const displayText =
    errorMessage === "Request failed" ||
    errorMessage.startsWith("Request failed:") ||
    errorMessage.startsWith("Request failed：")
      ? errorMessage
      : `Request failed: ${errorMessage}`;
  return {
    role: "assistant",
    content: [{ type: "text", text: displayText }],
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: createEmptyAssistantUsage(),
    stopReason: "error",
    errorMessage,
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function buildPartialAssistantMessage(params: {
  model: {
    api: AssistantMessage["api"];
    provider: AssistantMessage["provider"];
    id: string;
  };
  text: string;
  timestamp?: number;
  stopReason?: AssistantMessage["stopReason"];
}): AssistantMessage | null {
  const content = params.text.trim();
  if (!content) return null;
  return {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: params.model.api,
    provider: params.model.provider,
    model: params.model.id,
    usage: createEmptyAssistantUsage(),
    stopReason: params.stopReason ?? "aborted",
    timestamp: params.timestamp ?? Date.now(),
  };
}

export function appendSystemPrompt(base: string | undefined, suffix: string) {
  const head = (base || "").trim();
  const tail = (suffix || "").trim();
  if (!tail) return head;
  if (!head) return tail;
  return `${head}\n\n${tail}`;
}
