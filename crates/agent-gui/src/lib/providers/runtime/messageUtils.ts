import {
  sanitizeCitationText,
  stripProviderCitationMarkers,
} from "@liveagent/ui/lib/providerCitationMarkers";

export { stripProviderCitationMarkers } from "@liveagent/ui/lib/providerCitationMarkers";
export { assistantMessageToText } from "@liveagent/ui/lib/providers/errorMessage";

function createProviderCitationStreamSanitizer() {
  let pending = "";

  return {
    append(text: string) {
      const result = sanitizeCitationText(pending + text, true);
      pending = result.pending;
      return result.visible;
    },
    finish(text: string) {
      pending = "";
      return stripProviderCitationMarkers(text);
    },
  };
}

export function sanitizeAssistantMessage<T extends { content: unknown[] }>(message: T): T {
  let changed = false;
  const content = message.content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return block;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type !== "text" || typeof candidate.text !== "string") return block;
    const text = stripProviderCitationMarkers(candidate.text);
    if (text === candidate.text) return block;
    changed = true;
    return { ...candidate, text };
  });
  return changed ? { ...message, content } : message;
}

export function createStreamingTextReconciler() {
  const emittedTextByKey = new Map<string, string>();
  const citationSanitizersByKey = new Map<
    string,
    ReturnType<typeof createProviderCitationStreamSanitizer>
  >();

  const sanitizerFor = (key: string) => {
    const existing = citationSanitizersByKey.get(key);
    if (existing) return existing;
    const sanitizer = createProviderCitationStreamSanitizer();
    citationSanitizersByKey.set(key, sanitizer);
    return sanitizer;
  };

  return {
    appendDelta(key: string, delta: string) {
      if (!delta) return "";
      const sanitizedDelta = sanitizerFor(key).append(delta);
      if (!sanitizedDelta) return "";
      const previous = emittedTextByKey.get(key) ?? "";
      emittedTextByKey.set(key, previous + sanitizedDelta);
      return sanitizedDelta;
    },
    reconcileFinalText(key: string, finalText: string) {
      if (!finalText) return "";

      const previous = emittedTextByKey.get(key) ?? "";
      const sanitizedFinalText = sanitizerFor(key).finish(finalText);
      emittedTextByKey.set(key, sanitizedFinalText);

      if (!previous) {
        return sanitizedFinalText;
      }
      if (sanitizedFinalText.startsWith(previous)) {
        return sanitizedFinalText.slice(previous.length);
      }
      return "";
    },
  };
}
