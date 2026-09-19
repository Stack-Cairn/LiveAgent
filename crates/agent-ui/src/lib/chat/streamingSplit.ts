// Boundary-advance logic for StreamingSplitMarkdown: freezes completed
// paragraphs of a streaming markdown text into reference-stable segments so
// only the live tail is re-parsed per flush. Pure string/state logic with no
// React or markdown dependencies — unit-tested directly.
//
// Correctness rules for a boundary (never split mid-construct):
//   - only at a blank line ("\n\n"), with code-fence and $$-math parity even
//     up to the cut, so a fence/math block never spans two instances;
//   - the line after the cut must be plain paragraph text (not a list item,
//     blockquote, heading, fence, table row, math block or indented
//     continuation), so numbering/nesting stay within one instance and the
//     container's paragraph gap matches;
//   - document-wide syntax (footnotes, reference-style link definitions)
//     disables splitting for the whole text: definitions must live in the
//     same instance as their references;
//   - if no safe boundary exists the tail simply keeps growing (falls back to
//     exactly the old behaviour, correctness first).

const SEGMENT_TARGET_CHARS = 8_192;
const TAIL_KEEP_CHARS = 2_048;
const MIN_SEGMENT_CHARS = 512;
export const GUARD_SAMPLE_CHARS = 32;
const MAX_BOUNDARY_CANDIDATES = 8;

// Line starts that must NOT open a new instance. Beyond list/quote/indent
// continuations this also rejects headings, fences, tables and math blocks:
// their vertical rhythm partly relies on in-instance context selectors
// (`p + p`, `heading:first-child`), so a boundary is only taken where the
// next line is plain paragraph text and the container's `[&>div+div]:mt-2.5`
// reproduces exactly the paragraph gap.
const UNSAFE_LINE_START = /^(?:[-*+>=#|`$\s]|\d{1,3}[.)](?:\s|$))/;

// Syntax resolved document-wide by remark: footnote references/definitions
// (`[^id]`, `[^id]: ...`) and reference-style link definitions (`[id]: url`).
// A reference in one Streamdown instance cannot see a definition in another,
// so once any of these shows up the text is never split again and every
// previously frozen segment is unfrozen (see `advanceBoundary`). Scanned
// incrementally over appended text only.
const DOCUMENT_WIDE_SYNTAX = /\[\^[\w-]{1,200}\]|^[ \t]{0,3}\[[^\]\n]+\]:[ \t]/m;

export type SplitState = {
  segments: string[];
  boundary: number;
  guard: string;
  // Marker parity carried up to `boundary` ("```" / "$$" occurrences).
  fenceCount: number;
  mathCount: number;
  // Incremental DOCUMENT_WIDE_SYNTAX scan: text below `scannedTo` is known
  // clean; `unsplittable` latches once a match is found.
  scannedTo: number;
  unsplittable: boolean;
};

export function createSplitState(): SplitState {
  return {
    segments: [],
    boundary: 0,
    guard: "",
    fenceCount: 0,
    mathCount: 0,
    scannedTo: 0,
    unsplittable: false,
  };
}

// Re-scan from one line before `scannedTo` so a definition marker that
// straddles the previous scan edge (`[id]` arrived, `: url` arrives later) is
// still caught. Returns true once the text holds document-wide syntax.
function detectDocumentWideSyntax(state: SplitState, text: string): boolean {
  if (state.unsplittable) return true;
  if (text.length <= state.scannedTo) return false;
  const from = Math.max(0, text.lastIndexOf("\n", state.scannedTo));
  if (DOCUMENT_WIDE_SYNTAX.test(from === 0 ? text : text.slice(from))) {
    state.unsplittable = true;
    return true;
  }
  state.scannedTo = text.length;
  return false;
}

function countMarkers(text: string, marker: string, from: number, to: number): number[] {
  const positions: number[] = [];
  for (let index = text.indexOf(marker, from); index !== -1 && index < to; ) {
    positions.push(index);
    index = text.indexOf(marker, index + marker.length);
  }
  return positions;
}

function countBelow(positions: number[], limit: number): number {
  let count = 0;
  while (count < positions.length && (positions[count] as number) < limit) count += 1;
  return count;
}

// Advances the frozen boundary when the live tail outgrew its budget. Mutates
// `state` (a ref cell); idempotent for a given `text`, so StrictMode's double
// render settles on the same boundary. Exported for tests.
export function advanceBoundary(state: SplitState, text: string) {
  if (detectDocumentWideSyntax(state, text)) {
    // Unfreeze: one instance sees the whole document again (same cost as
    // the pre-split behaviour). References that were already frozen apart
    // from their definitions re-resolve on this render.
    if (state.boundary !== 0) {
      state.segments = [];
      state.boundary = 0;
      state.guard = "";
      state.fenceCount = 0;
      state.mathCount = 0;
    }
    return;
  }
  while (text.length - state.boundary > SEGMENT_TARGET_CHARS + TAIL_KEEP_CHARS) {
    const searchEnd = text.length - TAIL_KEEP_CHARS;
    const fencePositions = countMarkers(text, "```", state.boundary, searchEnd);
    const mathPositions = countMarkers(text, "$$", state.boundary, searchEnd);
    let candidate = text.lastIndexOf("\n\n", searchEnd);
    let accepted = -1;
    for (
      let attempt = 0;
      attempt < MAX_BOUNDARY_CANDIDATES && candidate >= state.boundary + MIN_SEGMENT_CHARS;
      attempt += 1
    ) {
      const cut = candidate + 2;
      const fenceParityEven = (state.fenceCount + countBelow(fencePositions, candidate)) % 2 === 0;
      const mathParityEven = (state.mathCount + countBelow(mathPositions, candidate)) % 2 === 0;
      const nextLine = text.slice(cut, cut + 8);
      if (fenceParityEven && mathParityEven && !UNSAFE_LINE_START.test(nextLine)) {
        accepted = cut;
        break;
      }
      candidate = text.lastIndexOf("\n\n", candidate - 1);
    }
    if (accepted === -1) return;
    state.segments = [...state.segments, text.slice(state.boundary, accepted)];
    state.fenceCount += countBelow(fencePositions, accepted);
    state.mathCount += countBelow(mathPositions, accepted);
    state.boundary = accepted;
    state.guard = text.slice(accepted - GUARD_SAMPLE_CHARS, accepted);
  }
}
