import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import { createUuid } from "../../shared/id";
import {
  hasDsmlToolCallMarkup,
  isOnlyDsmlOrphanCloseTags,
  recoverDsmlToolCallsFromText,
  stripDsmlToolCallMarkup,
} from "./deepSeekDsml";
import {
  comparableToolCall,
  hasFlattenedToolRequestText,
  recoverFlattenedToolRequests,
} from "./flattenedToolCallText";

const SEED_TOOL_CALL_DISPLAY_PATTERN = /<seed:tool_call>[\s\S]*?(?:<\/seed:tool_call>|$)/gi;
const FUNCTION_PATTERN = /<function\b([^>]*)>([\s\S]*?)(?:<\/function>|$)/i;
const PARAMETER_PATTERN =
  /<parameter\b([^>]*)>([\s\S]*?)(?:<\/parameter>|(?=<parameter\b|<\/function>|$))/gi;
const ATTRIBUTE_PATTERN = /([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g;

export { parseDsmlToolCallMarkup } from "./deepSeekDsml";

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

function shouldRecoverDeepSeekFlattenedText(assistant: AssistantMessage) {
  const metadata = [
    (assistant as { model?: unknown }).model,
    (assistant as { provider?: unknown }).provider,
    (assistant as { baseUrl?: unknown }).baseUrl,
  ]
    .map((value) => (typeof value === "string" ? value.toLowerCase() : ""))
    .join(" ");
  return metadata.includes("deepseek");
}

function buildAssistantBlockRecoverySourceKey(assistant: AssistantMessage, blockIndex: number) {
  return [
    "assistant",
    (assistant as { model?: unknown }).model,
    (assistant as { provider?: unknown }).provider,
    assistant.timestamp,
    blockIndex,
  ]
    .map((value) => String(value ?? ""))
    .join(":");
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

function hasRecoverableToolCallMarkup(
  text: string,
  options?: { recoverFlattenedText?: boolean; stripDsmlOrphanCloseTags?: boolean },
) {
  return (
    text.includes("<seed:tool_call>") ||
    hasDsmlToolCallMarkup(text) ||
    Boolean(options?.recoverFlattenedText && hasFlattenedToolRequestText(text)) ||
    Boolean(options?.stripDsmlOrphanCloseTags && isOnlyDsmlOrphanCloseTags(text))
  );
}

function recoverToolCallsFromBlockText(
  text: string,
  options?: {
    recoverFlattenedText?: boolean;
    stripDsmlOrphanCloseTags?: boolean;
    sourceKey?: string;
  },
) {
  if (!hasRecoverableToolCallMarkup(text, options)) {
    return {
      cleanedText: text,
      toolCalls: [] as ToolCall[],
    };
  }
  const toolCalls: ToolCall[] = [];
  let cleanedText = text.replace(SEED_TOOL_CALL_DISPLAY_PATTERN, (markup) => {
    const toolCall = parseSeedToolCallMarkup(markup);
    if (toolCall) {
      toolCalls.push(toolCall);
    }
    return "";
  });
  const recoveredDsml = recoverDsmlToolCallsFromText(cleanedText, {
    sourceKey: options?.sourceKey,
  });
  cleanedText = recoveredDsml.cleanedText;
  toolCalls.push(...recoveredDsml.toolCalls);
  if (options?.recoverFlattenedText) {
    const flattened = recoverFlattenedToolRequests(cleanedText);
    cleanedText = flattened.text;
    toolCalls.push(...flattened.toolCalls);
  }
  if (options?.stripDsmlOrphanCloseTags && isOnlyDsmlOrphanCloseTags(cleanedText)) {
    cleanedText = "";
  }

  return {
    cleanedText: cleanIfChanged(text, cleanedText),
    toolCalls,
  };
}

export function stripSeedToolCallMarkup(
  text: string,
  options?: { recoverFlattenedText?: boolean },
) {
  if (!hasRecoverableToolCallMarkup(text, options)) {
    return text;
  }
  const strippedMarkupText = text.replace(SEED_TOOL_CALL_DISPLAY_PATTERN, "");
  const strippedDsmlText = stripDsmlToolCallMarkup(strippedMarkupText);
  const nextText = options?.recoverFlattenedText
    ? recoverFlattenedToolRequests(strippedDsmlText).text
    : strippedDsmlText;
  return cleanIfChanged(text, nextText);
}

export function recoverAssistantSeedToolCalls(
  assistant: AssistantMessage,
): { assistant: AssistantMessage; toolCalls: ToolCall[] } | null {
  const recoverFlattenedText = shouldRecoverDeepSeekFlattenedText(assistant);
  const existingStructuredToolCalls = assistant.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
  const stripDsmlOrphanCloseTags = recoverFlattenedText && existingStructuredToolCalls.length > 0;
  const recoveredToolCalls: ToolCall[] = [];
  const nextContent: AssistantMessage["content"] = [];
  const seenComparableToolCalls = new Set(existingStructuredToolCalls.map(comparableToolCall));
  let changed = false;

  for (const [blockIndex, block] of assistant.content.entries()) {
    if (block.type === "thinking") {
      const recovered = recoverToolCallsFromBlockText(block.thinking, {
        recoverFlattenedText,
        stripDsmlOrphanCloseTags,
        sourceKey: buildAssistantBlockRecoverySourceKey(assistant, blockIndex),
      });
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
      const recovered = recoverToolCallsFromBlockText(block.text, {
        recoverFlattenedText,
        stripDsmlOrphanCloseTags,
        sourceKey: buildAssistantBlockRecoverySourceKey(assistant, blockIndex),
      });
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
