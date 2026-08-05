export type HostedSearchStatus = "searching" | "completed" | "failed";

export type HostedSearchSource = {
  url: string;
  title?: string;
  snippet?: string;
  citedText?: string;
  sourceType?: "source" | "citation";
};

export type HostedSearchBlock = {
  type: "hostedSearch";
  id: string;
  provider?: string;
  status: HostedSearchStatus;
  queries: string[];
  sources: HostedSearchSource[];
  updatedAt?: number;
};

export type HostedSearchOrderedBlock =
  | {
      kind: "text";
      text: string;
    }
  | {
      kind: "hostedSearch";
      item: HostedSearchBlock;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueTexts(values: unknown[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const text = normalizeText(value).replace(/\s+/g, " ");
    if (!text || out.includes(text)) continue;
    out.push(text);
  }
  return out;
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeSource(value: unknown): HostedSearchSource | null {
  if (!isRecord(value)) return null;
  const rawUrl = normalizeText(value.url ?? value.uri);
  if (!rawUrl || !isHttpUrl(rawUrl)) return null;

  const title = normalizeText(value.title ?? value.name);
  const snippet = normalizeText(value.snippet ?? value.description);
  const citedText = normalizeText(value.citedText ?? value.cited_text);
  const sourceType =
    value.sourceType === "citation" || value.type === "url_citation" ? "citation" : "source";

  return {
    url: rawUrl,
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
    ...(citedText ? { citedText } : {}),
    sourceType,
  };
}

function normalizeSources(values: unknown[]): HostedSearchSource[] {
  const out = new Map<string, HostedSearchSource>();
  for (const value of values) {
    const source = normalizeSource(value);
    if (!source) continue;
    const previous = out.get(source.url);
    const title = source.title || previous?.title;
    const snippet = source.snippet || previous?.snippet;
    const citedText = source.citedText || previous?.citedText;
    out.set(source.url, {
      url: source.url,
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(citedText ? { citedText } : {}),
      sourceType:
        source.sourceType === "citation" || previous?.sourceType === "citation"
          ? "citation"
          : "source",
    });
  }
  return [...out.values()];
}

const MARKDOWN_LINK_RE = /\[([^\]\n]{1,180})\]\((https?:\/\/[^)\s]+)\)/gi;
const PLAIN_URL_RE = /https?:\/\/[^\s<>"'`，。！？；：、]+/gi;

function stripTrailingUrlPunctuation(value: string) {
  return value.replace(/[)\].,!?;:，。！？；：、]+$/g, "");
}

function cleanInferredSourceTitle(value: string) {
  const title = value
    .replace(/^[\s>*\-+•\d.)、]+/g, "")
    .replace(/(?:参考|来源|source|sources|reference|references)\s*[:：-]?\s*$/i, "")
    .replace(/[:：\-–—|丨\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!title || title.length > 180) return "";
  return title;
}

function inferSourceTitleFromLine(line: string, urlStart: number) {
  const prefix = line.slice(0, urlStart);
  const colonIndex = Math.max(prefix.lastIndexOf("："), prefix.lastIndexOf(":"));
  const candidate = colonIndex >= 0 ? prefix.slice(0, colonIndex) : prefix;
  return cleanInferredSourceTitle(candidate);
}

export function inferHostedSearchSourcesFromText(text: string): HostedSearchSource[] {
  const sources = new Map<string, HostedSearchSource>();
  const normalizedText = text.replace(/\r\n/g, "\n");

  for (const match of normalizedText.matchAll(MARKDOWN_LINK_RE)) {
    const title = cleanInferredSourceTitle(match[1] ?? "");
    const url = stripTrailingUrlPunctuation(match[2] ?? "");
    if (!url || !isHttpUrl(url)) continue;
    sources.set(url, {
      url,
      ...(title ? { title } : {}),
      sourceType: "citation",
    });
  }

  for (const line of normalizedText.split("\n")) {
    for (const match of line.matchAll(PLAIN_URL_RE)) {
      const rawUrl = match[0] ?? "";
      const url = stripTrailingUrlPunctuation(rawUrl);
      if (!url || !isHttpUrl(url) || sources.has(url)) continue;
      const title = inferSourceTitleFromLine(line, match.index ?? 0);
      sources.set(url, {
        url,
        ...(title ? { title } : {}),
        sourceType: "citation",
      });
    }
  }

  return [...sources.values()];
}

export function enrichHostedSearchBlockWithText(
  block: HostedSearchBlock,
  text: string,
): HostedSearchBlock {
  const inferredSources = inferHostedSearchSourcesFromText(text);
  if (inferredSources.length === 0) return block;
  return mergeHostedSearchBlocks(block, {
    type: "hostedSearch",
    id: block.id,
    provider: block.provider,
    status: block.status,
    queries: [],
    sources: inferredSources,
    updatedAt: block.updatedAt,
  });
}

export function normalizeHostedSearchStatus(value: unknown): HostedSearchStatus {
  return value === "completed" || value === "failed" || value === "searching" ? value : "searching";
}

export function normalizeHostedSearchBlock(value: unknown): HostedSearchBlock | null {
  if (!isRecord(value)) return null;
  if (value.type !== "hostedSearch") return null;
  const id = normalizeText(value.id);
  if (!id) return null;
  const provider = normalizeText(value.provider);
  const queries = uniqueTexts(Array.isArray(value.queries) ? value.queries : [value.query]);
  const sources = normalizeSources(Array.isArray(value.sources) ? value.sources : []);
  const updatedAt =
    typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
      ? value.updatedAt
      : undefined;
  return {
    type: "hostedSearch",
    id,
    ...(provider ? { provider } : {}),
    status: normalizeHostedSearchStatus(value.status),
    queries,
    sources,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

function statusRank(status: HostedSearchStatus) {
  switch (status) {
    case "failed":
      return 3;
    case "completed":
      return 2;
    case "searching":
    default:
      return 1;
  }
}

export function mergeHostedSearchBlocks(
  previous: HostedSearchBlock | undefined,
  incoming: HostedSearchBlock,
): HostedSearchBlock {
  if (!previous) return incoming;
  const status =
    statusRank(incoming.status) >= statusRank(previous.status) ? incoming.status : previous.status;
  return {
    type: "hostedSearch",
    id: incoming.id || previous.id,
    provider: incoming.provider || previous.provider,
    status,
    queries: uniqueTexts([...previous.queries, ...incoming.queries]),
    sources: normalizeSources([...previous.sources, ...incoming.sources]),
    updatedAt: Math.max(previous.updatedAt ?? 0, incoming.updatedAt ?? 0) || undefined,
  };
}

function isTextContentBlock(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function removeHostedSearchContent(content: unknown[]) {
  return content.filter((block) => !normalizeHostedSearchBlock(block));
}

function collectTextContent(content: unknown[], startIndex: number, endIndex: number) {
  let text = "";
  for (let index = startIndex; index < endIndex; index += 1) {
    const block = content[index];
    if (isTextContentBlock(block)) text += block.text;
  }
  return text;
}

export function enrichHostedSearchContentWithText(content: unknown[]) {
  const allText = collectTextContent(content, 0, content.length);
  if (!allText) return content;

  let changed = false;
  const nextContent = content.slice();
  for (let index = 0; index < nextContent.length; index += 1) {
    const block = normalizeHostedSearchBlock(nextContent[index]);
    if (!block || block.sources.length > 0) continue;

    let nextSearchIndex = nextContent.length;
    for (let probe = index + 1; probe < nextContent.length; probe += 1) {
      if (normalizeHostedSearchBlock(nextContent[probe])) {
        nextSearchIndex = probe;
        break;
      }
    }

    const nearbyText = collectTextContent(nextContent, index + 1, nextSearchIndex) || allText;
    const enriched = enrichHostedSearchBlockWithText(block, nearbyText);
    if (enriched.sources.length === block.sources.length) continue;
    nextContent[index] = enriched;
    changed = true;
  }

  return changed ? nextContent : content;
}

function sentenceEndAfter(text: string, index: number) {
  for (let offset = index; offset < text.length; offset += 1) {
    const char = text[offset];
    if (char === "\n") return offset + 1;
    if (isSentenceTerminatorAt(text, offset)) {
      return extendSentenceBoundary(text, offset + 1);
    }
  }
  return index;
}

function sentenceAround(text: string, index: number) {
  let start = 0;
  for (let offset = index - 1; offset >= 0; offset -= 1) {
    const char = text[offset];
    if (char && /[。！？!?；;\n]/.test(char)) {
      start = offset + 1;
      break;
    }
  }
  return text.slice(start, sentenceEndAfter(text, index));
}

function hostedSearchAnchorCandidates(block: HostedSearchBlock) {
  const out: string[] = [];
  for (const query of block.queries) {
    const normalized = query.trim().replace(/\s+/g, " ");
    if (!normalized) continue;
    out.push(normalized);
    for (const token of normalized.split(/[\s,，。.!?？;；:："'“”‘’()[\]{}<>《》/\\|-]+/)) {
      const text = token.trim();
      if (text.length >= 3 || /[\u4e00-\u9fff]{2,}/.test(text)) {
        out.push(text);
      }
    }
  }
  return [...new Set(out)].sort((a, b) => b.length - a.length);
}

function findHostedSearchTextSplitIndex(text: string, block: HostedSearchBlock) {
  const candidates = hostedSearchAnchorCandidates(block);
  if (candidates.length === 0) return null;

  const lowerText = text.toLocaleLowerCase();
  let best: { score: number; end: number } | null = null;

  for (const candidate of candidates) {
    const lowerCandidate = candidate.toLocaleLowerCase();
    let fromIndex = 0;
    while (fromIndex < lowerText.length) {
      const index = lowerText.indexOf(lowerCandidate, fromIndex);
      if (index < 0) break;
      const sentence = sentenceAround(text, index);
      const hasSearchAction =
        /联网|搜索|搜寻|检索|查询|查找|查阅|搜索中|search|searching|searched|lookup|look up/i.test(
          sentence,
        );
      const end = sentenceEndAfter(text, index + candidate.length);
      const score = index - (hasSearchAction ? 100_000 : 0) - candidate.length;
      if (!best || score < best.score) {
        best = { score, end };
      }
      fromIndex = index + Math.max(1, lowerCandidate.length);
    }
  }

  if (!best || best.end <= 0 || best.end >= text.length) return null;
  return best.end;
}

export function splitTextAroundHostedSearch(
  text: string,
  block: HostedSearchBlock,
): { before: string; after: string } | null {
  const splitIndex = findHostedSearchTextSplitIndex(text, block);
  if (splitIndex === null) return null;
  return {
    before: text.slice(0, splitIndex),
    after: text.slice(splitIndex),
  };
}

function isClosingSentenceChar(char: string | undefined) {
  return Boolean(char && /["'”’）)\]}》」』】〕〉]/.test(char));
}

function isAsciiPeriodSentenceTerminator(text: string, index: number) {
  if (text[index] !== ".") return false;
  const previous = text[index - 1] ?? "";
  const next = text[index + 1] ?? "";
  if (/\d/.test(previous) && /\d/.test(next)) return false;
  return !next || /\s/.test(next) || isClosingSentenceChar(next);
}

function isSentenceTerminatorAt(text: string, index: number) {
  const char = text[index];
  if (!char) return false;
  return /[。！？!?；;]/.test(char) || isAsciiPeriodSentenceTerminator(text, index);
}

function extendSentenceBoundary(text: string, offset: number) {
  let nextOffset = offset;
  while (nextOffset < text.length && isClosingSentenceChar(text[nextOffset])) {
    nextOffset += 1;
  }
  while (nextOffset < text.length && /[ \t]/.test(text[nextOffset] ?? "")) {
    nextOffset += 1;
  }
  return nextOffset;
}

function isNaturalHostedSearchBoundary(text: string, offset: number) {
  if (offset <= 0 || offset >= text.length) return true;

  let index = offset - 1;
  while (index >= 0 && /[ \t]/.test(text[index] ?? "")) {
    index -= 1;
  }
  if (index < 0) return true;
  if (text[index] === "\n") return true;

  while (index >= 0 && isClosingSentenceChar(text[index])) {
    index -= 1;
  }
  if (index < 0) return true;
  return text[index] === "\n" || isSentenceTerminatorAt(text, index);
}

export function resolveHostedSearchTextBoundary(text: string, offset: number) {
  const boundedOffset = Math.max(0, Math.min(text.length, offset));
  if (isNaturalHostedSearchBoundary(text, boundedOffset)) return boundedOffset;

  for (let index = boundedOffset; index < text.length; index += 1) {
    if (text[index] === "\n") return index + 1;
    if (isSentenceTerminatorAt(text, index)) {
      return extendSentenceBoundary(text, index + 1);
    }
  }
  return text.length;
}

function insertHostedSearchesByTextOffset(content: unknown[], orderedContent: unknown[]) {
  const fullText = content
    .filter(isTextContentBlock)
    .map((block) => block.text)
    .join("");
  const placements: { hostedSearch: HostedSearchBlock; offset: number; order: number }[] = [];
  let orderedTextOffset = 0;
  for (const block of orderedContent) {
    if (isTextContentBlock(block)) {
      orderedTextOffset += block.text.length;
      continue;
    }
    const hostedSearch = normalizeHostedSearchBlock(block);
    if (!hostedSearch) continue;
    placements.push({
      hostedSearch,
      offset: resolveHostedSearchTextBoundary(fullText, orderedTextOffset),
      order: placements.length,
    });
  }

  if (placements.length === 0) return content;

  const pending = placements.slice().sort((a, b) => a.offset - b.offset || a.order - b.order);
  const out: unknown[] = [];
  let textOffset = 0;

  for (const block of content) {
    if (!isTextContentBlock(block)) {
      out.push(block);
      continue;
    }

    const text = block.text;
    let cursor = 0;
    const textEndOffset = textOffset + text.length;

    while (pending.length > 0 && pending[0].offset <= textEndOffset) {
      const placement = pending.shift();
      if (!placement) break;
      const splitAt = Math.max(0, Math.min(text.length, placement.offset - textOffset));
      if (splitAt > cursor) {
        out.push({ ...block, text: text.slice(cursor, splitAt) });
      }
      out.push(placement.hostedSearch);
      cursor = splitAt;
    }

    if (cursor < text.length) {
      out.push({ ...block, text: text.slice(cursor) });
    }
    textOffset = textEndOffset;
  }

  for (const placement of pending) {
    out.push(placement.hostedSearch);
  }

  return out;
}

export function applyHostedSearchOrderToAssistant<TMessage extends { content: unknown[] }>(
  message: TMessage,
  orderedBlocks: HostedSearchOrderedBlock[] | undefined,
): TMessage {
  if (!orderedBlocks || orderedBlocks.length === 0) return message;

  const hostedSearchById = new Map<string, HostedSearchBlock>();
  for (const block of message.content) {
    const hostedSearch = normalizeHostedSearchBlock(block);
    if (hostedSearch) {
      hostedSearchById.set(hostedSearch.id, hostedSearch);
    }
  }
  if (hostedSearchById.size === 0) return message;

  const usedHostedSearchIds = new Set<string>();
  const nextContent: unknown[] = [];
  for (const block of orderedBlocks) {
    if (block.kind === "text") {
      if (block.text) nextContent.push({ type: "text", text: block.text });
      continue;
    }

    const hostedSearch =
      hostedSearchById.get(block.item.id) ?? normalizeHostedSearchBlock(block.item);
    if (!hostedSearch || usedHostedSearchIds.has(hostedSearch.id)) continue;
    usedHostedSearchIds.add(hostedSearch.id);
    const previous = nextContent[nextContent.length - 1];
    if (isTextContentBlock(previous)) {
      const split = splitTextAroundHostedSearch(previous.text, hostedSearch);
      if (split) {
        nextContent[nextContent.length - 1] = { type: "text", text: split.before };
        nextContent.push(hostedSearch);
        if (split.after) nextContent.push({ type: "text", text: split.after });
        continue;
      }
    }
    nextContent.push(hostedSearch);
  }

  for (const hostedSearch of hostedSearchById.values()) {
    if (usedHostedSearchIds.has(hostedSearch.id)) continue;
    nextContent.push(hostedSearch);
  }

  const orderedContent = nextContent;
  if (orderedContent.length === 0) return message;
  const originalContent = removeHostedSearchContent(message.content);
  const content = insertHostedSearchesByTextOffset(originalContent, orderedContent);
  return {
    ...message,
    content: enrichHostedSearchContentWithText(content),
  };
}

export function appendHostedSearchBlocksToAssistant<TMessage extends { content: unknown[] }>(
  message: TMessage,
  blocks: HostedSearchBlock[],
  options?: { orderedBlocks?: HostedSearchOrderedBlock[] },
): TMessage {
  if (blocks.length === 0) return message;

  const nextContent = message.content.slice();
  for (const incoming of blocks) {
    const idx = nextContent.findIndex((block) => {
      const normalized = normalizeHostedSearchBlock(block);
      return normalized?.id === incoming.id;
    });
    if (idx >= 0) {
      const existing = normalizeHostedSearchBlock(nextContent[idx]);
      nextContent[idx] = existing ? mergeHostedSearchBlocks(existing, incoming) : incoming;
    } else {
      nextContent.push(incoming);
    }
  }

  const nextMessage = {
    ...message,
    content: nextContent,
  };
  return applyHostedSearchOrderToAssistant(nextMessage, options?.orderedBlocks);
}
