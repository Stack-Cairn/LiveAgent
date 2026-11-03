import { fromHtml } from "hast-util-from-html";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import remend from "remend";
import { normalizeHtmlIndentation } from "streamdown";
import { findProviderCitationRanges } from "./providerCitationMarkers";

type SourcePosition = { start: { offset?: number }; end: { offset?: number } };
type SourceNode = {
  type: string;
  position?: SourcePosition;
  children?: SourceNode[];
};
type HtmlRoot = ReturnType<typeof fromHtml>;
type HtmlNode = HtmlRoot | HtmlRoot["children"][number];
type SourceRange = { start: number; end: number };

const inlineCodeCompletion = {
  bold: false,
  boldItalic: false,
  comparisonOperators: false,
  htmlTags: false,
  images: false,
  inlineCode: true,
  inlineKatex: false,
  italic: false,
  katex: false,
  links: false,
  setextHeadings: false,
  singleTilde: false,
  strikethrough: false,
};

function protectMarkdown(node: SourceNode, ranges: SourceRange[], htmlRanges: SourceRange[]) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    if (["code", "inlineCode", "image", "imageReference", "definition"].includes(node.type)) {
      ranges.push({ start, end });
      return;
    }
    if (node.type === "html") htmlRanges.push({ start, end });
    if (node.type === "link") {
      const first = node.children?.[0]?.position?.start.offset ?? end;
      const last = node.children?.at(-1)?.position?.end.offset ?? end;
      ranges.push({ start, end: first }, { start: last, end });
    }
  }
  for (const child of node.children ?? []) protectMarkdown(child, ranges, htmlRanges);
}

function protectHtml(node: HtmlNode, ranges: SourceRange[]) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start !== undefined && end !== undefined) {
    if (
      node.type === "comment" ||
      (node.type === "element" &&
        ["code", "pre", "script", "style", "img", "video", "audio"].includes(node.tagName))
    ) {
      ranges.push({ start, end });
      return;
    }
    if (node.type === "element") {
      for (const property of Object.values(node.data?.position?.properties ?? {})) {
        if (property?.start.offset !== undefined && property?.end.offset !== undefined) {
          ranges.push({ start: property.start.offset, end: property.end.offset });
        }
      }
    }
  }
  if ("children" in node) {
    for (const child of node.children) protectHtml(child, ranges);
  }
}

function originalOffset(content: string, normalized: string) {
  if (content === normalized) return (offset: number) => Math.min(offset, content.length);
  const originalLines = content.split("\n");
  const lines: { start: number; shift: number }[] = [];
  let start = 0;
  let originalStart = 0;
  for (const [index, line] of normalized.split("\n").entries()) {
    const originalLength = originalLines[index].length;
    lines.push({ start, shift: originalStart - start + originalLength - line.length });
    start += line.length + 1;
    originalStart += originalLength + 1;
  }
  return (offset: number) => {
    if (offset >= normalized.length) return content.length;
    let low = 0;
    let high = lines.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (lines[middle].start <= offset) low = middle;
      else high = middle - 1;
    }
    return offset + lines[low].shift;
  };
}

/** Code and destinations are barriers: an unfinished example cannot consume later prose. */
export function findMarkdownCitationRanges(content: string, documentEnd = true, streaming = false) {
  if (findProviderCitationRanges(content).length === 0) return [];
  const normalized = normalizeHtmlIndentation(content);
  const completed = streaming ? remend(normalized, inlineCodeCompletion) : normalized;
  const protectedRanges: SourceRange[] = [];
  const htmlRanges: SourceRange[] = [];
  protectMarkdown(
    fromMarkdown(completed, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }),
    protectedRanges,
    htmlRanges,
  );
  const mask = (value: string) => value.replace(/[^\r\n]/g, " ");
  let htmlSource = "";
  let maskedTo = 0;
  for (const range of htmlRanges) {
    htmlSource += mask(completed.slice(maskedTo, range.start));
    htmlSource += completed.slice(range.start, range.end);
    maskedTo = range.end;
  }
  htmlSource += mask(completed.slice(maskedTo));
  protectHtml(fromHtml(htmlSource, { fragment: true, verbose: true }), protectedRanges);
  const offset = originalOffset(content, normalized);
  const barriers = protectedRanges
    .map((range) => ({ start: offset(range.start), end: offset(range.end) }))
    .sort((a, b) => a.start - b.start);

  const citations: ReturnType<typeof findProviderCitationRanges> = [];
  const scan = (from: number, to: number) => {
    for (const range of findProviderCitationRanges(content.slice(from, to))) {
      if (!range.incomplete || (documentEnd && to === content.length)) {
        citations.push({ ...range, start: range.start + from, end: range.end + from });
      }
    }
  };
  let from = 0;
  for (const barrier of barriers) {
    if (barrier.start > from) scan(from, barrier.start);
    from = Math.max(from, barrier.end);
  }
  scan(from, content.length);
  return citations;
}

export function stripMarkdownCitationMarkers(
  content: string,
  documentEnd = true,
  streaming = false,
) {
  let visible = "";
  let from = 0;
  for (const citation of findMarkdownCitationRanges(content, documentEnd, streaming)) {
    visible += content.slice(from, citation.start);
    from = citation.end;
  }
  return visible + content.slice(from);
}
