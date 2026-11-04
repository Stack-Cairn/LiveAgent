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

export function findProviderCitationRanges(text: string) {
  const ranges: { start: number; end: number; incomplete: boolean }[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf(CITATION_START, index);
    if (start < 0) {
      const prefix = longestCitationStartPrefix(text.slice(index));
      if (prefix)
        ranges.push({ start: text.length - prefix.length, end: text.length, incomplete: true });
      break;
    }
    const match = matchCitationAt(text, start);
    if (match.kind === "complete") {
      ranges.push({ start, end: match.end, incomplete: false });
      index = match.end;
    } else if (match.kind === "incomplete") {
      ranges.push({ start, end: text.length, incomplete: true });
      break;
    } else {
      index = start + CITATION_START.length;
    }
  }
  return ranges;
}

export function sanitizeCitationText(text: string, holdIncomplete: boolean) {
  let visible = "";
  let index = 0;
  for (const range of findProviderCitationRanges(text)) {
    visible += text.slice(index, range.start);
    if (range.incomplete) {
      return { visible, pending: holdIncomplete ? text.slice(range.start) : "" };
    }
    index = range.end;
  }
  return { visible: visible + text.slice(index), pending: "" };
}

/** Provider citation protocol metadata has no displayable source URL. */
export function stripProviderCitationMarkers(text: string) {
  return sanitizeCitationText(text, false).visible;
}
