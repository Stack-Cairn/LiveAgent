export { assistantMessageToText } from "@liveagent/ui/lib/providers/errorMessage";

const PROVIDER_CITATION_START = "\uE200cite";
const PROVIDER_CITATION_END = "\uE201";
const PROVIDER_CITATION_PATTERN = /\uE200cite(?:\uE202[^\uE201]*)+\uE201/g;

/**
 * Provider-native web-search citations are sometimes returned as ChatGPT's
 * private-use text markup instead of structured citation annotations. They
 * are protocol metadata, not user-visible answer text.
 */
export function stripProviderCitationMarkers(text: string) {
  return text.replace(PROVIDER_CITATION_PATTERN, "");
}

function longestCitationPrefixSuffix(text: string) {
  for (
    let length = Math.min(PROVIDER_CITATION_START.length - 1, text.length);
    length > 0;
    length -= 1
  ) {
    const suffix = text.slice(-length);
    if (PROVIDER_CITATION_START.startsWith(suffix)) return suffix;
  }
  return "";
}

function createProviderCitationStreamSanitizer() {
  let pending = "";

  return {
    append(text: string) {
      let input = pending + text;
      pending = "";
      let output = "";

      while (input) {
        const start = input.indexOf(PROVIDER_CITATION_START);
        if (start < 0) {
          const suffix = longestCitationPrefixSuffix(input);
          output += input.slice(0, input.length - suffix.length);
          pending = suffix;
          break;
        }

        output += input.slice(0, start);
        const end = input.indexOf(PROVIDER_CITATION_END, start + PROVIDER_CITATION_START.length);
        if (end < 0) {
          pending = input.slice(start);
          break;
        }
        input = input.slice(end + PROVIDER_CITATION_END.length);
      }

      return output;
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
