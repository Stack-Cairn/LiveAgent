import type { ToolCall } from "@earendil-works/pi-ai";
import { createUuid } from "../../shared/id";

const FLATTENED_TOOL_REQUEST_LABELS = [
  "Previous assistant tool request:",
  "Historical assistant tool request (read-only context; do not repeat):",
  "Historical tool call (read-only, not repeating):",
] as const;

type TextRange = {
  start: number;
  end: number;
};

export type ParsedFlattenedToolRequest = {
  toolCall: ToolCall;
  end: number;
  hasExplicitId: boolean;
};

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const FLATTENED_TOOL_REQUEST_LABEL_PATTERN =
  FLATTENED_TOOL_REQUEST_LABELS.map(escapeRegExp).join("|");

const FLATTENED_TOOL_REQUEST_HEADER_PATTERN = new RegExp(
  String.raw`^\s*(?:(?:${FLATTENED_TOOL_REQUEST_LABEL_PATTERN})\s*)?(?:tool_call_id:\s*([^\n]+)\s*)?tool_name:\s*([^\n]+)\s*arguments:\s*`,
  "i",
);

const LABELED_FLATTENED_TOOL_REQUEST_HEADER_PATTERN = new RegExp(
  String.raw`^\s*(?:${FLATTENED_TOOL_REQUEST_LABEL_PATTERN})\s*(?:tool_call_id:\s*[^\n]+\s*)?tool_name:\s*[^\n]+\s*arguments:\s*`,
  "i",
);

const BARE_FLATTENED_TOOL_REQUEST_START_PATTERN =
  /(?:^|\n)[ \t]*(?:tool_call_id:\s*[^\n]+\s*)?tool_name:\s*[^\n]+\s*arguments:\s*/i;

function createFlattenedToolRequestScanPattern() {
  return new RegExp(
    String.raw`(?:(?:${FLATTENED_TOOL_REQUEST_LABEL_PATTERN})\s*|(?:^|\n)[ \t]*)(?:tool_call_id:\s*([^\n]+)\s*)?tool_name:\s*([^\n]+)\s*arguments:\s*`,
    "gi",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function removeTextRanges(text: string, ranges: TextRange[]) {
  if (ranges.length === 0) return text;
  let next = text;
  for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, range.start)}${next.slice(range.end)}`;
  }
  return next;
}

function stableStringifyComparable(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyComparable(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyComparable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

export function comparableToolCall(toolCall: ToolCall) {
  return `${toolCall.name}:${stableStringifyComparable(toolCall.arguments ?? {})}`;
}

function findJsonValueEnd(text: string, startIndex: number): number | null {
  let index = startIndex;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }

  const open = text[index];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = index; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) {
      depth += 1;
      continue;
    }
    if (char === close) {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }

  return null;
}

function findPrettyJsonValueEnd(text: string, startIndex: number): number | null {
  let index = startIndex;
  while (index < text.length && /\s/.test(text[index] ?? "")) {
    index += 1;
  }

  const open = text[index];
  const close = open === "{" ? "}" : open === "[" ? "]" : "";
  if (!close) return null;

  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  const baseIndent = /^[ \t]*/.exec(text.slice(lineStart, index))?.[0] ?? "";
  const closeLinePattern = new RegExp(
    String.raw`(?:^|\n)${escapeRegExp(baseIndent)}${escapeRegExp(close)}[ \t]*(?=\n|$)`,
    "g",
  );
  closeLinePattern.lastIndex = index + 1;
  const match = closeLinePattern.exec(text);
  if (!match) return null;
  return match.index + match[0].length;
}

export function parseFlattenedToolRequestAtStart(value: string): ParsedFlattenedToolRequest | null {
  const match = FLATTENED_TOOL_REQUEST_HEADER_PATTERN.exec(value);
  if (!match) return null;

  const jsonStart = match[0].length;
  const jsonEnd = findJsonValueEnd(value, jsonStart);
  if (jsonEnd === null) return null;

  const toolName = (match[2] ?? "").trim();
  if (!toolName || toolName === "unknown") return null;

  const parsed = JSON.parse(value.slice(jsonStart, jsonEnd));
  if (!isRecord(parsed)) return null;

  return {
    toolCall: {
      type: "toolCall",
      id: (match[1] ?? "").trim() || `flattened-context-tool-call-${createUuid()}`,
      name: toolName,
      arguments: parsed,
    },
    end: jsonEnd,
    hasExplicitId: Boolean((match[1] ?? "").trim()),
  };
}

export function findMalformedLabeledFlattenedToolRequestEndAtStart(value: string): number | null {
  const match = LABELED_FLATTENED_TOOL_REQUEST_HEADER_PATTERN.exec(value);
  if (!match) return null;

  const jsonStart = match[0].length;
  const strictJsonEnd = findJsonValueEnd(value, jsonStart);
  if (strictJsonEnd !== null) {
    try {
      JSON.parse(value.slice(jsonStart, strictJsonEnd));
      return null;
    } catch {
      return strictJsonEnd;
    }
  }
  return findPrettyJsonValueEnd(value, jsonStart);
}

export function recoverFlattenedToolRequests(text: string) {
  const toolCalls: ToolCall[] = [];
  const ranges: TextRange[] = [];
  const pattern = createFlattenedToolRequestScanPattern();
  let match = pattern.exec(text);

  while (match !== null) {
    try {
      const parsed = parseFlattenedToolRequestAtStart(text.slice(match.index));
      if (parsed) {
        toolCalls.push(parsed.toolCall);
        ranges.push({
          start: match.index,
          end: match.index + parsed.end,
        });
        pattern.lastIndex = match.index + parsed.end;
      } else {
        const malformedEnd = findMalformedLabeledFlattenedToolRequestEndAtStart(
          text.slice(match.index),
        );
        if (malformedEnd !== null) {
          ranges.push({
            start: match.index,
            end: match.index + malformedEnd,
          });
          pattern.lastIndex = match.index + malformedEnd;
        }
      }
    } catch {
      const malformedEnd = findMalformedLabeledFlattenedToolRequestEndAtStart(
        text.slice(match.index),
      );
      if (malformedEnd !== null) {
        ranges.push({
          start: match.index,
          end: match.index + malformedEnd,
        });
        pattern.lastIndex = match.index + malformedEnd;
      }
    }
    match = pattern.exec(text);
  }

  return {
    text: removeTextRanges(text, ranges),
    toolCalls,
  };
}

export function hasFlattenedToolRequestText(text: string) {
  return (
    FLATTENED_TOOL_REQUEST_LABELS.some((label) => text.includes(label)) ||
    BARE_FLATTENED_TOOL_REQUEST_START_PATTERN.test(text)
  );
}

export function findFlattenedToolRequestOpenStart(value: string) {
  let bestIndex = -1;
  for (const label of FLATTENED_TOOL_REQUEST_LABELS) {
    const index = value.indexOf(label);
    if (index >= 0 && (bestIndex < 0 || index < bestIndex)) {
      bestIndex = index;
    }
  }
  const bareIndex = findBareFlattenedToolRequestOpenStart(value);
  if (bareIndex >= 0 && (bestIndex < 0 || bareIndex < bestIndex)) {
    bestIndex = bareIndex;
  }
  return bestIndex;
}

export function findPotentialFlattenedToolRequestOpenStart(value: string) {
  let bestIndex = -1;
  for (const label of FLATTENED_TOOL_REQUEST_LABELS) {
    const max = Math.min(label.length - 1, value.length);
    for (let length = max; length > 0; length -= 1) {
      const suffix = value.slice(value.length - length);
      if (label.startsWith(suffix)) {
        const index = value.length - length;
        if (bestIndex < 0 || index < bestIndex) {
          bestIndex = index;
        }
        break;
      }
    }
  }

  const bareIndex = findPotentialBareFlattenedToolRequestOpenStart(value);
  if (bareIndex >= 0 && (bestIndex < 0 || bareIndex < bestIndex)) {
    bestIndex = bareIndex;
  }
  return bestIndex;
}

function findBareFlattenedToolRequestOpenStart(value: string) {
  const match = /(^|\n)[ \t]*(?:tool_call_id:[^\n]*\n[ \t]*)?tool_name:/i.exec(value);
  if (!match) return -1;
  return match.index + (match[1]?.length ?? 0);
}

function findPotentialBareFlattenedToolRequestOpenStart(value: string) {
  const lineStart = value.lastIndexOf("\n") + 1;
  const line = value.slice(lineStart);
  const leadingWhitespace = /^[ \t]*/.exec(line)?.[0].length ?? 0;
  const token = line.slice(leadingWhitespace).toLowerCase();
  if (!token) return -1;
  if ("tool_name:".startsWith(token) || "tool_call_id:".startsWith(token)) {
    return lineStart;
  }
  return -1;
}
