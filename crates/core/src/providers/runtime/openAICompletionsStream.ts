import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import type { ProviderId } from "../../settings";
import type { StreamOptionsEx } from "./types";

const MISSING_FINISH_REASON_ERROR = "Stream ended without finish_reason";

function isOfficialOpenAIBaseUrl(baseUrl: string) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function recoverMissingFinishReasonMessage(
  message: AssistantMessage,
): { message: AssistantMessage; reason: "stop" | "toolUse" } | undefined {
  if (
    message.stopReason !== "error" ||
    !message.errorMessage?.includes(MISSING_FINISH_REASON_ERROR)
  ) {
    return undefined;
  }

  const hasToolCall = message.content.some(
    (block) => block.type === "toolCall" && Boolean(block.id && block.name),
  );
  const hasText = message.content.some(
    (block) => block.type === "text" && block.text.trim().length > 0,
  );
  if (!hasToolCall && !hasText) return undefined;

  const reason = hasToolCall ? "toolUse" : "stop";
  const recovered: AssistantMessage = {
    ...message,
    stopReason: reason,
  };
  delete recovered.errorMessage;
  return { message: recovered, reason };
}

export function attachOpenAICompletionsFinishReasonCompatibility(
  options: StreamOptionsEx,
  params: {
    providerId: ProviderId;
    baseUrl: string;
    modelApi?: string;
  },
): StreamOptionsEx {
  if (
    options.recoverMissingFinishReason !== undefined ||
    params.providerId !== "codex" ||
    params.modelApi !== "openai-completions" ||
    isOfficialOpenAIBaseUrl(params.baseUrl)
  ) {
    return options;
  }
  return { ...options, recoverMissingFinishReason: true };
}

export function recoverOpenAICompletionsMissingFinishReason(
  source: AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();

  void (async () => {
    for await (const event of source) {
      if (event.type === "error") {
        const recovery = recoverMissingFinishReasonMessage(event.error);
        if (recovery) {
          output.push({ type: "done", reason: recovery.reason, message: recovery.message });
        } else {
          output.push(event);
        }
        return;
      }

      output.push(event);
      if (event.type === "done") return;
    }

    output.end(await source.result());
  })();

  return output;
}
