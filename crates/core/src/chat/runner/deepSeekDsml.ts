import type { ToolCall } from "@earendil-works/pi-ai";

export const DSML_TAG_PREFIX = String.raw`(?:\uFF5C{2}|\|{2})\s*DSML\s*(?:\uFF5C{2}|\|{2})`;

const ATTRIBUTE_PATTERN = /([a-zA-Z_][\w:-]*)\s*=\s*"([^"]*)"/g;
const DSML_TOOL_CALL_DISPLAY_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>[\s\S]*?(?:<\/\s*${DSML_TAG_PREFIX}\s*tool_calls\s*>|$)`,
  "gi",
);
const DSML_INVOKE_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*invoke\b([^>]*)>([\s\S]*?)(?:<\/\s*${DSML_TAG_PREFIX}\s*invoke\s*>|$)`,
  "gi",
);
const DSML_PARAMETER_PATTERN = new RegExp(
  String.raw`<\s*${DSML_TAG_PREFIX}\s*parameter\b([^>]*)>([\s\S]*?)(?:<\/\s*${DSML_TAG_PREFIX}\s*parameter\s*>|(?=<\s*${DSML_TAG_PREFIX}\s*parameter\b|<\/\s*${DSML_TAG_PREFIX}\s*invoke\s*>|$))`,
  "gi",
);
const DSML_ORPHAN_CLOSE_TAGS_PATTERN = new RegExp(
  String.raw`^\s*(?:<\/\s*${DSML_TAG_PREFIX}\s*(?:parameter|invoke|tool_calls)\s*>\s*)+$`,
  "i",
);

type ParseDsmlToolCallMarkupOptions = {
  sourceKey?: string;
};

function decodeXmlEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export function parseMarkupAttributes(raw: string) {
  const attributes = new Map<string, string>();
  ATTRIBUTE_PATTERN.lastIndex = 0;
  let match = ATTRIBUTE_PATTERN.exec(raw);
  while (match !== null) {
    const key = match[1]?.trim().toLowerCase();
    if (key) {
      attributes.set(key, decodeXmlEntities(match[2] ?? ""));
    }
    match = ATTRIBUTE_PATTERN.exec(raw);
  }
  return attributes;
}

function coerceDsmlParameterValue(value: string, attributes: Map<string, string>) {
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

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  return `{${entries
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function hashString(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, "0");
}

function buildStableDsmlToolCallId(params: {
  sourceKey: string;
  index: number;
  name: string;
  args: Record<string, unknown>;
}) {
  return `dsml-tool-call-${hashString(
    [params.sourceKey, params.index, params.name, stableStringify(params.args)].join("\n"),
  )}`;
}

export function parseDsmlToolCallMarkup(
  markup: string,
  options?: ParseDsmlToolCallMarkupOptions,
): ToolCall[] {
  const toolCalls: ToolCall[] = [];
  const sourceKey = options?.sourceKey ?? hashString(markup);
  DSML_INVOKE_PATTERN.lastIndex = 0;
  let invokeMatch = DSML_INVOKE_PATTERN.exec(markup);

  while (invokeMatch !== null) {
    const invokeAttributes = parseMarkupAttributes(invokeMatch[1] ?? "");
    const toolName = invokeAttributes.get("name")?.trim() ?? "";
    if (!toolName) {
      invokeMatch = DSML_INVOKE_PATTERN.exec(markup);
      continue;
    }

    const args: Record<string, unknown> = {};
    const paramsBody = invokeMatch[2] ?? "";
    DSML_PARAMETER_PATTERN.lastIndex = 0;
    let paramMatch = DSML_PARAMETER_PATTERN.exec(paramsBody);
    while (paramMatch !== null) {
      const paramAttributes = parseMarkupAttributes(paramMatch[1] ?? "");
      const paramName = paramAttributes.get("name")?.trim() ?? "";
      if (paramName) {
        args[paramName] = coerceDsmlParameterValue(paramMatch[2] ?? "", paramAttributes);
      }
      paramMatch = DSML_PARAMETER_PATTERN.exec(paramsBody);
    }

    toolCalls.push({
      type: "toolCall",
      id: buildStableDsmlToolCallId({
        sourceKey,
        index: toolCalls.length,
        name: toolName,
        args,
      }),
      name: toolName,
      arguments: args,
    });
    invokeMatch = DSML_INVOKE_PATTERN.exec(markup);
  }

  return toolCalls;
}

export function hasDsmlToolCallMarkup(text: string) {
  return text.includes("DSML") && text.includes("tool_calls");
}

export function stripDsmlToolCallMarkup(text: string) {
  if (!hasDsmlToolCallMarkup(text)) return text;
  return text.replace(DSML_TOOL_CALL_DISPLAY_PATTERN, "");
}

export function recoverDsmlToolCallsFromText(
  text: string,
  options?: ParseDsmlToolCallMarkupOptions,
) {
  const toolCalls: ToolCall[] = [];
  const cleanedText = text.replace(DSML_TOOL_CALL_DISPLAY_PATTERN, (markup) => {
    toolCalls.push(...parseDsmlToolCallMarkup(markup, options));
    return "";
  });
  return {
    cleanedText,
    toolCalls,
  };
}

export function isOnlyDsmlOrphanCloseTags(text: string) {
  return DSML_ORPHAN_CLOSE_TAGS_PATTERN.test(text);
}
