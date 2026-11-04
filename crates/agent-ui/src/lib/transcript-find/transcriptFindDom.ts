import {
  findOccurrenceOffsets,
  foldTranscriptFindText,
  normalizeTranscriptFindQuery,
} from "./transcriptFind";

/** Chrome inside a row that is not message text (action bars, icons, hidden helpers). */
const SKIPPED_SUBTREES =
  'button, svg, script, style, textarea, input, [hidden], [aria-hidden="true"], [data-transcript-find-skip]';

export function findTranscriptRowElement(root: ParentNode, rowKey: string): HTMLElement | null {
  for (const element of root.querySelectorAll<HTMLElement>("[data-row-key]")) {
    if (element.dataset.rowKey === rowKey) return element;
  }
  return null;
}

/**
 * DOM ranges of every case-insensitive occurrence of `query` in the rendered
 * text of `element`. Text is joined across nodes first, so a match that spans
 * inline formatting (`foo <strong>bar</strong>`) is still one range.
 */
export function findTextRangesInElement(element: Element, query: string): Range[] {
  const needle = normalizeTranscriptFindQuery(query);
  const doc = element.ownerDocument;
  if (!needle || !doc) return [];
  const view = doc.defaultView;
  const nodeFilter = view?.NodeFilter ?? globalThis.NodeFilter;
  const walker = doc.createTreeWalker(element, nodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      const skipped = parent?.closest(SKIPPED_SUBTREES);
      return skipped && element.contains(skipped)
        ? nodeFilter.FILTER_REJECT
        : nodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    if (!value) continue;
    nodes.push(node as Text);
    starts.push(text.length);
    text += value;
  }
  const offsets = findOccurrenceOffsets(foldTranscriptFindText(text), needle);
  if (offsets.length === 0) return [];

  // Offsets ascend, so one forward cursor maps every boundary to its node.
  let cursor = 0;
  const locate = (offset: number, isEnd: boolean) => {
    while (cursor < nodes.length - 1) {
      const nextStart = starts[cursor + 1] ?? Number.POSITIVE_INFINITY;
      if (isEnd ? offset <= nextStart : offset < nextStart) break;
      cursor += 1;
    }
    return { node: nodes[cursor] as Text, offset: offset - (starts[cursor] ?? 0) };
  };
  return offsets.map((start) => {
    const range = doc.createRange();
    const from = locate(start, false);
    range.setStart(from.node, from.offset);
    const to = locate(start + needle.length, true);
    range.setEnd(to.node, to.offset);
    return range;
  });
}

export const TRANSCRIPT_FIND_MATCH_HIGHLIGHT = "transcript-find-match";
export const TRANSCRIPT_FIND_ACTIVE_HIGHLIGHT = "transcript-find-active";

type HighlightRegistryLike = {
  set(name: string, highlight: unknown): unknown;
  delete(name: string): unknown;
};

type HighlightConstructor = new (...ranges: Range[]) => unknown;

function highlightApi(): {
  registry: HighlightRegistryLike;
  Highlight: HighlightConstructor;
} | null {
  const scope = globalThis as unknown as {
    CSS?: { highlights?: HighlightRegistryLike };
    Highlight?: HighlightConstructor;
  };
  const registry = scope.CSS?.highlights;
  if (!registry || typeof registry.set !== "function" || typeof scope.Highlight !== "function") {
    return null;
  }
  return { registry, Highlight: scope.Highlight };
}

/** The CSS Custom Highlight API paints without touching the row DOM; without it nothing is painted. */
export function supportsTranscriptFindHighlights() {
  return highlightApi() !== null;
}

// The highlight names are document-global, so one find session paints at a
// time; a newer session revokes the previous one (another pane's find bar).
let highlightOwner: object | null = null;
let revokeHighlightOwner: (() => void) | null = null;

export function claimTranscriptFindHighlights(owner: object, onRevoke: () => void) {
  if (highlightOwner === owner) {
    revokeHighlightOwner = onRevoke;
    return;
  }
  const revokePrevious = revokeHighlightOwner;
  highlightOwner = owner;
  revokeHighlightOwner = onRevoke;
  revokePrevious?.();
}

export function paintTranscriptFindHighlights(
  owner: object,
  ranges: readonly Range[],
  activeRange: Range | null,
) {
  if (highlightOwner !== owner) return;
  const api = highlightApi();
  if (!api) return;
  const passive = activeRange ? ranges.filter((range) => range !== activeRange) : ranges;
  api.registry.set(TRANSCRIPT_FIND_MATCH_HIGHLIGHT, new api.Highlight(...passive));
  if (activeRange) {
    api.registry.set(TRANSCRIPT_FIND_ACTIVE_HIGHLIGHT, new api.Highlight(activeRange));
  } else {
    api.registry.delete(TRANSCRIPT_FIND_ACTIVE_HIGHLIGHT);
  }
}

export function releaseTranscriptFindHighlights(owner: object) {
  if (highlightOwner !== owner) return;
  highlightOwner = null;
  revokeHighlightOwner = null;
  const api = highlightApi();
  api?.registry.delete(TRANSCRIPT_FIND_MATCH_HIGHLIGHT);
  api?.registry.delete(TRANSCRIPT_FIND_ACTIVE_HIGHLIGHT);
}
