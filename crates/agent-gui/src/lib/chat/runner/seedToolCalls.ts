import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createUuid } from "@liveagent/ui/lib/shared/id";

const SEED_TOOL_CALL_DISPLAY_PATTERN = /<seed:tool_call>[\s\S]*?(?:<\/seed:tool_call>|$)/gi;
const FUNCTION_PATTERN = /<function\b([^>]*)>([\s\S]*?)(?:<\/function>|$)/i;
const PARAMETER_PATTERN =
  /<parameter\b([^>]*)>([\s\S]*?)(?:<\/parameter>|(?=<parameter\b|<\/function>|$))/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g;

function parseAttributes(raw: string) {
  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = ATTRIBUTE_PATTERN.exec(raw);
  while (match !== null) {
    const key = match[1]?.trim().toLowerCase();
    if (!key) {
      match = ATTRIBUTE_PATTERN.exec(raw);
      continue;
    }
    attributes.set(key, decodeXmlEntities(match[2] ?? ""));
    match = ATTRIBUTE_PATTERN.exec(raw);
  }
  return attributes;
}

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cleanRecoveredText(value: string) {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanIfChanged(original: string, next: string) {
  return next !== original ? cleanRecoveredText(next) : original;
}

function stableStringifyComparable(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
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

/** 工具调用的稳定比较键（名称 + 规范序参数），用于结构化调用与文本恢复调用去重。 */
export function comparableToolCall(toolCall: ToolCall) {
  return `${toolCall.name}:${stableStringifyComparable(toolCall.arguments ?? {})}`;
}

function coerceSeedParameterValue(value: string, attributes: Map<string, string>) {
  const decoded = decodeXmlEntities(value).trim();
  if ((attributes.get("string") ?? "").toLowerCase() === "true") {
    return decoded;
  }
  if (/^-?\d+$/.test(decoded)) {
    return Number(decoded);
  }
  if (/^-?\d+\.\d+$/.test(decoded)) {
    return Number(decoded);
  }
  if (/^(true|false)$/i.test(decoded)) {
    return decoded.toLowerCase() === "true";
  }
  if (/^null$/i.test(decoded)) {
    return null;
  }
  if (/^[[{][\s\S]*[\]}]$/.test(decoded)) {
    try {
      return JSON.parse(decoded);
    } catch {
      return decoded;
    }
  }
  return decoded;
}

function parseSeedToolCallMarkup(markup: string): ToolCall | null {
  const functionMatch = FUNCTION_PATTERN.exec(markup);
  if (!functionMatch) {
    return null;
  }

  const functionAttributes = parseAttributes(functionMatch[1] ?? "");
  const toolName = functionAttributes.get("name")?.trim() ?? "";
  if (!toolName) {
    return null;
  }

  const args: Record<string, unknown> = {};
  const paramsBody = functionMatch[2] ?? "";
  PARAMETER_PATTERN.lastIndex = 0;
  let paramMatch = PARAMETER_PATTERN.exec(paramsBody);
  while (paramMatch !== null) {
    const paramAttributes = parseAttributes(paramMatch[1] ?? "");
    const paramName = paramAttributes.get("name")?.trim() ?? "";
    if (!paramName) {
      paramMatch = PARAMETER_PATTERN.exec(paramsBody);
      continue;
    }
    args[paramName] = coerceSeedParameterValue(paramMatch[2] ?? "", paramAttributes);
    paramMatch = PARAMETER_PATTERN.exec(paramsBody);
  }

  return {
    type: "toolCall",
    id: `seed-tool-call-${createUuid()}`,
    name: toolName,
    arguments: args,
  };
}

function hasRecoverableToolCallMarkup(text: string) {
  return text.includes("<seed:tool_call>");
}

function recoverToolCallsFromBlockText(text: string) {
  if (!hasRecoverableToolCallMarkup(text)) {
    return {
      cleanedText: text,
      toolCalls: [] as ToolCall[],
    };
  }
  const toolCalls: ToolCall[] = [];
  const cleanedText = text.replace(SEED_TOOL_CALL_DISPLAY_PATTERN, (markup) => {
    const toolCall = parseSeedToolCallMarkup(markup);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
    return "";
  });

  return {
    cleanedText: cleanIfChanged(text, cleanedText),
    toolCalls,
  };
}

export function stripSeedToolCallMarkup(text: string) {
  if (!hasRecoverableToolCallMarkup(text)) {
    return text;
  }
  return cleanIfChanged(text, text.replace(SEED_TOOL_CALL_DISPLAY_PATTERN, ""));
}

export function recoverAssistantSeedToolCalls(
  assistant: AssistantMessage,
): { assistant: AssistantMessage; toolCalls: ToolCall[] } | null {
  const existingStructuredToolCalls = assistant.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
  const recoveredToolCalls: ToolCall[] = [];
  const nextContent: AssistantMessage["content"] = [];
  const seenComparableToolCalls = new Set(existingStructuredToolCalls.map(comparableToolCall));
  let changed = false;

  for (const block of assistant.content) {
    if (block.type === "thinking") {
      // Anthropic thinking is signed protocol state. Never strip markup or
      // re-order blocks inside a signed (or redacted) thinking block: either
      // change makes the next request fail with "thinking blocks cannot be
      // modified". Unsigned thinking from compatibility models can still use
      // the legacy seed-call recovery below.
      if (block.thinkingSignature || block.redacted) {
        nextContent.push(block);
        continue;
      }
      const recovered = recoverToolCallsFromBlockText(block.thinking);
      if (recovered.cleanedText !== block.thinking) {
        changed = true;
      }
      if (recovered.cleanedText !== "") {
        nextContent.push({
          ...block,
          thinking: recovered.cleanedText,
        });
      }
      for (const toolCall of recovered.toolCalls) {
        const comparable = comparableToolCall(toolCall);
        if (seenComparableToolCalls.has(comparable)) {
          continue;
        }
        seenComparableToolCalls.add(comparable);
        nextContent.push(toolCall);
        recoveredToolCalls.push(toolCall);
        changed = true;
      }
      continue;
    }

    if (block.type === "text") {
      const recovered = recoverToolCallsFromBlockText(block.text);
      if (recovered.cleanedText !== block.text) {
        changed = true;
      }
      if (recovered.cleanedText !== "") {
        nextContent.push({
          ...block,
          text: recovered.cleanedText,
        });
      }
      for (const toolCall of recovered.toolCalls) {
        const comparable = comparableToolCall(toolCall);
        if (seenComparableToolCalls.has(comparable)) {
          continue;
        }
        seenComparableToolCalls.add(comparable);
        nextContent.push(toolCall);
        recoveredToolCalls.push(toolCall);
        changed = true;
      }
      continue;
    }

    nextContent.push(block);
  }

  if (!changed) {
    return null;
  }

  return {
    assistant: {
      ...assistant,
      content: nextContent,
      stopReason: recoveredToolCalls.length > 0 ? "toolUse" : assistant.stopReason,
    },
    toolCalls: recoveredToolCalls,
  };
}
