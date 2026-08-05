import type { AssistantMessage } from "@earendil-works/pi-ai";
import { formatErrorDisplayText } from "./errors";

export function assistantMessageToText(message: AssistantMessage) {
  let text = "";
  for (const block of message.content) {
    if (block.type === "text") text += block.text;
  }
  if (text.trim()) return text;
  if (message.stopReason === "error") {
    return formatErrorDisplayText(message.errorMessage, "Request failed");
  }
  if (message.stopReason === "aborted") {
    return formatErrorDisplayText(message.errorMessage, "Cancelled");
  }
  return text;
}

export function createStreamingTextReconciler() {
  const emittedTextByKey = new Map<string, string>();

  return {
    appendDelta(key: string, delta: string) {
      if (!delta) return "";
      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, previous + delta);
      return delta;
    },
    reconcileFinalText(key: string, finalText: string) {
      if (!finalText) return "";

      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, finalText);

      if (!previous) {
        return finalText;
      }
      if (finalText.startsWith(previous)) {
        return finalText.slice(previous.length);
      }
      return "";
    },
  };
}
