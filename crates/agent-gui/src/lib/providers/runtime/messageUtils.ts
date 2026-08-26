export { assistantMessageToText } from "@liveagent/ui/lib/providers/errorMessage";

/** OpenAI citation markers: `\uE200cite\uE202<source>[\uE202<locator>...]\uE201`. */
const CITATION_START = "\uE200cite";
const CITATION_DELIMITER = "\uE202";
const CITATION_END = "\uE201";

type CitationMatch = { kind: "complete"; end: number } | { kind: "incomplete" } | { kind: "none" };

function matchCitationAt(text: string, from: number): CitationMatch {
  const remaining = text.slice(from);
  if (!remaining.startsWith(CITATION_START)) {
    return CITATION_START.startsWith(remaining) ? { kind: "incomplete" } : { kind: "none" };
  }

  let index = from + CITATION_START.length;
  if (index >= text.length) return { kind: "incomplete" };
  if (text[index] !== CITATION_DELIMITER) return { kind: "none" };

  while (index < text.length && text[index] === CITATION_DELIMITER) {
    index += 1;
    while (
      index < text.length &&
      text[index] !== CITATION_END &&
      text[index] !== CITATION_DELIMITER
    ) {
      index += 1;
    }
    if (index >= text.length) return { kind: "incomplete" };
  }

  if (text[index] === CITATION_END) {
    return { kind: "complete", end: index + CITATION_END.length };
  }
  return { kind: "none" };
}

function longestCitationStartPrefix(text: string) {
  for (let length = Math.min(CITATION_START.length - 1, text.length); length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (CITATION_START.startsWith(suffix)) return suffix;
  }
  return "";
}

function sanitizeCitationText(text: string, holdIncomplete: boolean) {
  let visible = "";
  let index = 0;

  while (index < text.length) {
    const start = text.indexOf(CITATION_START, index);
    if (start < 0) {
      const rest = text.slice(index);
      const prefix = longestCitationStartPrefix(rest);
      visible += rest.slice(0, rest.length - prefix.length);
      return { visible, pending: holdIncomplete ? prefix : "" };
    }

    visible += text.slice(index, start);
    const match = matchCitationAt(text, start);
    if (match.kind === "complete") {
      index = match.end;
      continue;
    }
    if (match.kind === "incomplete") {
      return { visible, pending: holdIncomplete ? text.slice(start) : "" };
    }

    visible += CITATION_START;
    index = start + CITATION_START.length;
  }

  return { visible, pending: "" };
}

/**
 * Provider-native web-search citations are sometimes returned as ChatGPT's
 * private-use text markup instead of structured citation annotations. They
 * are protocol metadata, not user-visible answer text.
 */
export function stripProviderCitationMarkers(text: string) {
  return sanitizeCitationText(text, false).visible;
}

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
