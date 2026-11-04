import {
  type RefObject,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  buildTranscriptFindMatches,
  isTranscriptFindShortcut,
  shouldTranscriptHandleFindShortcut,
  stepTranscriptFindIndex,
  type TranscriptFindMatch,
  transcriptFindMatchId,
} from "./transcriptFind";
import {
  claimTranscriptFindHighlights,
  findTextRangesInElement,
  findTranscriptRowElement,
  paintTranscriptFindHighlights,
  releaseTranscriptFindHighlights,
  revealCollapsedTranscriptRange,
  supportsTranscriptFindHighlights,
} from "./transcriptFindDom";
import type { TranscriptFindSource } from "./transcriptFindSource";

export type UseTranscriptFindOptions = {
  /** Transcript root: rows (`[data-row-key]`) render inside it. */
  root: HTMLElement | null;
  scrollViewport: HTMLElement | null;
  source: TranscriptFindSource;
  /** Virtual-list jump (mounts an off-screen row and aligns it to the top). */
  scrollToRowKey: (rowKey: string) => void;
  /** Detach bottom-follow before any programmatic scroll. */
  breakFollow?: () => void;
  /** Height covered by the floating composer at the bottom of the viewport. */
  bottomInsetPx?: number;
  /** Closing key: a new conversation closes the bar. */
  resetKey?: unknown;
  isMac: boolean;
};

export type TranscriptFindState = {
  open: boolean;
  query: string;
  setQuery: (query: string) => void;
  total: number;
  /** Zero-based; -1 when nothing is active. */
  activeIndex: number;
  next: () => void;
  previous: () => void;
  openFind: () => void;
  close: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
};

const NO_MATCHES: readonly TranscriptFindMatch[] = [];
// scrollToRowKey re-aligns its row for 6 frames; positioning the match inside
// a tall row has to wait until that settle is over.
const ROW_SETTLE_FRAMES = 8;
const MAX_REVEAL_FRAMES = 30;
const VIEWPORT_MARGIN_PX = 8;

const noopSubscribe = () => () => {};

function rangeRect(range: Range) {
  return typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : null;
}

export function useTranscriptFind(options: UseTranscriptFindOptions): TranscriptFindState {
  const { root, scrollViewport, source, resetKey, isMac } = options;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [revealToken, setRevealToken] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [owner] = useState(() => ({}));
  const deferredQuery = useDeferredValue(query);

  const version = useSyncExternalStore(
    open ? source.subscribe : noopSubscribe,
    source.getVersion,
    source.getVersion,
  );
  const matches = useMemo(
    () =>
      open && version >= 0
        ? buildTranscriptFindMatches(source.getEntries(), deferredQuery)
        : NO_MATCHES,
    [open, deferredQuery, version, source],
  );
  const activeIndex = activeId
    ? matches.findIndex((match) => transcriptFindMatchId(match) === activeId)
    : -1;

  const latest = useRef({ options, matches, activeIndex, query: deferredQuery });
  latest.current = { options, matches, activeIndex, query: deferredQuery };

  const isRangeVisible = useCallback((range: Range) => {
    const viewport = latest.current.options.scrollViewport;
    const rect = rangeRect(range);
    if (!viewport || !rect) return false;
    const bounds = viewport.getBoundingClientRect();
    const inset = latest.current.options.bottomInsetPx ?? 0;
    return (
      rect.height > 0 &&
      rect.top >= bounds.top + VIEWPORT_MARGIN_PX &&
      rect.bottom <= bounds.bottom - inset - VIEWPORT_MARGIN_PX
    );
  }, []);

  const scrollRangeIntoView = useCallback((range: Range) => {
    const { scrollViewport: viewport, bottomInsetPx = 0, breakFollow } = latest.current.options;
    const rect = rangeRect(range);
    if (!viewport || !rect) return;
    const bounds = viewport.getBoundingClientRect();
    const visibleHeight = Math.max(0, bounds.height - bottomInsetPx);
    breakFollow?.();
    viewport.scrollTop += rect.top - (bounds.top + visibleHeight / 3);
  }, []);

  /** Ranges of every match in the mounted rows, plus the active one. */
  const collectRanges = useCallback(() => {
    const { options: current, matches: currentMatches, activeIndex: index, query } = latest.current;
    const rootElement = current.root;
    const ranges: Range[] = [];
    let activeRange: Range | null = null;
    if (!rootElement || currentMatches.length === 0) return { ranges, activeRange };
    const active = currentMatches[index] ?? null;
    const matchedRows = new Set(currentMatches.map((match) => match.rowKey));
    for (const row of rootElement.querySelectorAll<HTMLElement>("[data-row-key]")) {
      const rowKey = row.dataset.rowKey ?? "";
      if (!matchedRows.has(rowKey)) continue;
      const rowRanges = findTextRangesInElement(row, query);
      ranges.push(...rowRanges);
      if (active && active.rowKey === rowKey && rowRanges.length > 0) {
        activeRange = rowRanges[Math.min(active.occurrence, rowRanges.length - 1)] ?? null;
      }
    }
    return { ranges, activeRange };
  }, []);

  const paint = useCallback(() => {
    // Without the Highlight API there is nothing to paint (counts and
    // navigation still work), so skip the DOM walk entirely.
    if (!supportsTranscriptFindHighlights()) return;
    const { ranges, activeRange } = collectRanges();
    paintTranscriptFindHighlights(owner, ranges, activeRange);
  }, [collectRanges, owner]);

  const dismiss = useCallback(
    (restoreFocus: boolean) => {
      setOpen(false);
      setActiveId(null);
      releaseTranscriptFindHighlights(owner);
      const restore = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (restoreFocus && restore?.isConnected) restore.focus({ preventScroll: true });
    },
    [owner],
  );
  const close = useCallback(() => dismiss(true), [dismiss]);
  // Another pane's find took over the highlights: close quietly, focus stays there.
  const revoke = useCallback(() => dismiss(false), [dismiss]);

  const focusInput = useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  }, []);

  const openFind = useCallback(() => {
    const doc = latest.current.options.root?.ownerDocument;
    const active = doc?.activeElement as HTMLElement | null | undefined;
    if (active && active !== doc?.body && active !== inputRef.current) {
      restoreFocusRef.current = active;
    }
    // A short single-line selection inside the transcript seeds the query.
    const selection = doc?.getSelection?.()?.toString().trim() ?? "";
    const anchor = doc?.getSelection?.()?.anchorNode ?? null;
    if (
      selection &&
      selection.length <= 200 &&
      !selection.includes("\n") &&
      anchor &&
      latest.current.options.root?.contains(anchor)
    ) {
      setQuery(selection);
    }
    setOpen(true);
    claimTranscriptFindHighlights(owner, revoke);
    focusInput();
  }, [focusInput, owner, revoke]);

  // The input mounts with the bar; focus it once it exists.
  useEffect(() => {
    if (open) focusInput();
  }, [focusInput, open]);

  // Cmd/Ctrl+F. Window bubble phase: editors that own the key handle it first,
  // and shouldTranscriptHandleFindShortcut routes it to exactly one transcript.
  useEffect(() => {
    if (!root) return;
    const view = root.ownerDocument?.defaultView;
    if (!view) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isTranscriptFindShortcut(event, isMac)) return;
      if (!shouldTranscriptHandleFindShortcut(event.target, root)) return;
      event.preventDefault();
      openFind();
    };
    view.addEventListener("keydown", onKeyDown);
    return () => view.removeEventListener("keydown", onKeyDown);
  }, [isMac, openFind, root]);

  // A different conversation closes the bar.
  const resetKeyRef = useRef(resetKey);
  useEffect(() => {
    if (Object.is(resetKeyRef.current, resetKey)) return;
    resetKeyRef.current = resetKey;
    revoke();
  }, [resetKey, revoke]);

  useEffect(() => () => releaseTranscriptFindHighlights(owner), [owner]);

  // Pick the active match. A new query starts at the first match on screen
  // (or the newest one) and scrolls to it; streamed content only keeps the
  // active match valid without moving the viewport.
  const lastQueryRef = useRef<string | null>(null);
  const lastIndexRef = useRef(-1);
  if (activeIndex >= 0) lastIndexRef.current = activeIndex;
  useEffect(() => {
    if (!open) {
      lastQueryRef.current = null;
      return;
    }
    const queryChanged = lastQueryRef.current !== deferredQuery;
    lastQueryRef.current = deferredQuery;
    if (matches.length === 0) {
      setActiveId(null);
      return;
    }
    if (queryChanged) {
      let index = matches.length - 1;
      const viewport = latest.current.options.scrollViewport;
      const rootElement = latest.current.options.root;
      if (viewport && rootElement) {
        const bounds = viewport.getBoundingClientRect();
        const visible = matches.findIndex((match) => {
          const row = findTranscriptRowElement(rootElement, match.rowKey);
          if (!row) return false;
          const rect = row.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
        });
        if (visible >= 0) index = visible;
      }
      setActiveId(transcriptFindMatchId(matches[index] as TranscriptFindMatch));
      setRevealToken((token) => token + 1);
      return;
    }
    if (activeIndex < 0) {
      const index = Math.min(Math.max(lastIndexRef.current, 0), matches.length - 1);
      setActiveId(transcriptFindMatchId(matches[index] as TranscriptFindMatch));
    }
  }, [activeIndex, deferredQuery, matches, open]);

  const step = useCallback((direction: 1 | -1) => {
    const { matches: currentMatches, activeIndex: index } = latest.current;
    const nextIndex = stepTranscriptFindIndex(index, currentMatches.length, direction);
    const match = currentMatches[nextIndex];
    if (!match) return;
    setActiveId(transcriptFindMatchId(match));
    setRevealToken((token) => token + 1);
  }, []);
  const next = useCallback(() => step(1), [step]);
  const previous = useCallback(() => step(-1), [step]);

  // Reveal: an on-screen match only repaints; a mounted row scrolls the
  // match itself into view; an unmounted row is first brought in by the
  // virtual list, then the match inside it is positioned.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealToken is the trigger; everything else is read from `latest`.
  useEffect(() => {
    if (revealToken === 0) return;
    const { matches: currentMatches, activeIndex: index, options: current } = latest.current;
    const match = currentMatches[index];
    const rootElement = current.root;
    if (!match || !rootElement) return;
    let frame: number | null = null;
    let cancelled = false;
    const locate = () => {
      const row = findTranscriptRowElement(rootElement, match.rowKey);
      if (!row) return null;
      const ranges = findTextRangesInElement(row, latest.current.query);
      return ranges[Math.min(match.occurrence, ranges.length - 1)] ?? null;
    };
    const run = (attempt: number) => {
      frame = null;
      if (cancelled) return;
      const range = locate();
      // A match inside a collapsed block (a clamped user message) expands it
      // first; the match is positioned once the taller row has settled.
      const revealing = range !== null && revealCollapsedTranscriptRange(range);
      if (attempt === 0 && range && !revealing) {
        if (!isRangeVisible(range)) scrollRangeIntoView(range);
        paint();
        return;
      }
      if (attempt === 0 && !range) {
        current.breakFollow?.();
        current.scrollToRowKey(match.rowKey);
      } else if (range && !revealing && attempt >= ROW_SETTLE_FRAMES) {
        if (!isRangeVisible(range)) scrollRangeIntoView(range);
        paint();
        return;
      }
      if (attempt >= MAX_REVEAL_FRAMES) {
        paint();
        return;
      }
      frame = requestAnimationFrame(() => run(attempt + 1));
    };
    run(0);
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [revealToken]);

  // Repaint when matches or the active match change, and while scrolling
  // mounts new rows.
  // biome-ignore lint/correctness/useExhaustiveDependencies: matches/activeId changes must repaint even though paint reads them from `latest`.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
  }, [open, matches, activeId, paint]);

  useEffect(() => {
    if (!open || !scrollViewport) return;
    let frame: number | null = null;
    const onScroll = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        paint();
      });
    };
    scrollViewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollViewport.removeEventListener("scroll", onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [open, paint, scrollViewport]);

  return {
    open,
    query,
    setQuery,
    total: matches.length,
    activeIndex,
    next,
    previous,
    openFind,
    close,
    inputRef,
  };
}
