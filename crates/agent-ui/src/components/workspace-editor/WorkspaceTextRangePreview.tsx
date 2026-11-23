import "@liveagent/ui/i18n/namespaces/projectTools";
import { Button } from "@liveagent/ui/components/ui/button";
import { useLocale } from "@liveagent/ui/i18n/index";
import { copyTextToClipboard } from "@liveagent/ui/lib/shared/clipboard";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { WORKSPACE_TEXT_PAGE_BYTES, type WorkspaceTextRange } from "./workspaceTextRange";

const RANGE_LINE_HEIGHT = 20;
const RANGE_PADDING = 12;
const RANGE_OVERSCAN = 8;
const TAB_SIZE = 8;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

type PreviewLayout = { height: number; width: number; characterWidth: number; font: string };

function wrapPreviewLines(lines: string[], layout: PreviewLayout, gutterColumns: number) {
  const width = layout.width - gutterColumns * layout.characterWidth - 2 * RANGE_PADDING;
  const columns = Math.max(1, Math.floor(width / layout.characterWidth));
  const rows: string[] = [];
  const lineNumbers: number[] = [];
  const addRow = (text: string, lineNumber: number) => {
    rows.push(text);
    lineNumbers.push(lineNumber);
  };
  let segmenter: Intl.Segmenter | undefined;
  let context: CanvasRenderingContext2D | null | undefined;
  const glyphWidths = new Map<string, number>();

  for (const [lineIndex, line] of lines.entries()) {
    const lineNumber = lineIndex + 1;
    if (PRINTABLE_ASCII.test(line)) {
      if (line.length <= columns) addRow(line, lineNumber);
      else {
        for (let offset = 0; offset < line.length; offset += columns) {
          addRow(line.slice(offset, offset + columns), offset === 0 ? lineNumber : 0);
        }
      }
      continue;
    }

    // Segment only non-ASCII text, so combining marks and emoji stay whole.
    segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let start = 0;
    let used = 0;
    for (const { segment, index } of segmenter.segment(line)) {
      let glyphWidth = layout.characterWidth;
      if (segment === "\t") {
        const tabWidth = TAB_SIZE * layout.characterWidth;
        glyphWidth = tabWidth - (used % tabWidth);
      } else if (!PRINTABLE_ASCII.test(segment)) {
        if (context === undefined) {
          context = document.createElement("canvas").getContext("2d");
          if (context) context.font = layout.font;
        }
        glyphWidth =
          glyphWidths.get(segment) ??
          context?.measureText(segment).width ??
          2 * layout.characterWidth;
        if (glyphWidths.size < 256) glyphWidths.set(segment, glyphWidth);
      }
      if (index > start && used + glyphWidth > width) {
        addRow(line.slice(start, index), start === 0 ? lineNumber : 0);
        start = index;
        used = 0;
        if (segment === "\t") glyphWidth = TAB_SIZE * layout.characterWidth;
      }
      used += glyphWidth;
    }
    addRow(line.slice(start), start === 0 ? lineNumber : 0);
  }
  return { rows, lineNumbers };
}

export function WorkspaceTextRangePreview({
  initialPage,
  wordWrap = false,
  editable = false,
  readPage,
}: {
  initialPage: WorkspaceTextRange;
  wordWrap?: boolean;
  editable?: boolean;
  readPage?: (offset: number) => Promise<WorkspaceTextRange | null>;
}) {
  const { locale, t } = useLocale();
  const [page, setPage] = useState(initialPage);
  const [jumpOffset, setJumpOffset] = useState(String(initialPage.offset));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const inFlightRef = useRef(false);
  const previousOffsets = useRef<number[]>([]);
  const viewportRef = useRef<HTMLElement>(null);
  const glyphRef = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<PreviewLayout | null>(null);
  const [topLine, setTopLine] = useState(0);
  const numberFormat = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const hasMore = page.nextOffset < page.sizeBytes;
  const lines = useMemo(() => {
    if (!page.content) return [];
    const currentLines = page.content.split(/\r\n|\n|\r/);
    if (hasMore && currentLines.at(-1) === "") currentLines.pop();
    return currentLines;
  }, [hasMore, page.content]);
  const gutterColumns = Math.max(4, String(lines.length).length + 2);
  const wholeFile = page.offset === 0 && !hasMore;
  const lineCount = t(
    wholeFile ? "workspaceFilePreview.lineCount" : "workspaceFilePreview.rangeLineCount",
  ).replace("{count}", numberFormat.format(lines.length));
  const wrapped = useMemo(
    () =>
      wordWrap && layout?.width && layout.characterWidth
        ? wrapPreviewLines(lines, layout, gutterColumns)
        : null,
    [gutterColumns, layout, lines, wordWrap],
  );
  const rows = wrapped?.rows ?? lines;
  const firstLine = Math.max(0, Math.min(topLine, rows.length - 1) - RANGE_OVERSCAN);
  const lastLine =
    firstLine + Math.ceil((layout?.height ?? 0) / RANGE_LINE_HEIGHT) + 2 * RANGE_OVERSCAN;

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const glyph = glyphRef.current;
    if (!glyph) return;
    const measure = () => {
      const style = getComputedStyle(viewport);
      const next = {
        height: viewport.clientHeight,
        width: viewport.clientWidth,
        characterWidth: glyph.getBoundingClientRect().width,
        font: [style.fontSize, style.fontFamily].join(" "),
      };
      setLayout((current) =>
        current?.height === next.height &&
        current.width === next.width &&
        current.characterWidth === next.characterWidth &&
        current.font === next.font
          ? current
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(glyph);
    measure();
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (wordWrap && viewportRef.current) viewportRef.current.scrollLeft = 0;
  }, [wordWrap]);

  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    [],
  );

  async function navigate(requestedOffset: number, direction: "previous" | "next" | "jump") {
    if (!readPage || inFlightRef.current || requestedOffset === page.offset) return;
    inFlightRef.current = true;
    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await readPage(requestedOffset);
      if (request !== requestRef.current) return;
      if (!next) {
        setError(t("workspaceFilePreview.rangeUnavailable"));
        return;
      }
      if (next.sizeBytes !== page.sizeBytes || next.mtimeMs !== page.mtimeMs) {
        setError(t("workspaceFilePreview.rangeChanged"));
        return;
      }
      if (direction === "next") {
        // Keep exact UTF-8 page boundaries for recent back navigation.
        if (previousOffsets.current.length === 64) previousOffsets.current.shift();
        previousOffsets.current.push(page.offset);
      } else if (direction === "previous") {
        previousOffsets.current.pop();
      } else {
        previousOffsets.current = [];
      }
      setPage(next);
      setJumpOffset(String(next.offset));
      viewportRef.current?.scrollTo(0, 0);
      setTopLine(0);
    } catch (cause) {
      if (request === requestRef.current) {
        setError(cause instanceof Error ? cause.message : t("workspaceFilePreview.openFailed"));
      }
    } finally {
      if (request === requestRef.current) {
        inFlightRef.current = false;
        setLoading(false);
      }
    }
  }

  async function copyPage() {
    const copied = await copyTextToClipboard(page.content, { restoreFocus: viewportRef.current });
    if (!copied) setError(t("workspaceFilePreview.rangeCopyFailed"));
  }

  const jump = Number(jumpOffset);
  const canJump =
    jumpOffset.trim() !== "" && Number.isSafeInteger(jump) && jump >= 0 && jump < page.sizeBytes;
  const previousOffset =
    previousOffsets.current.at(-1) ?? Math.max(0, page.offset - WORKSPACE_TEXT_PAGE_BYTES);

  return (
    <div className="flex h-full min-h-0 flex-col" aria-busy={loading}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
        <span role="status" className="text-muted-foreground">
          {readPage ? (
            <>
              {t("workspaceFilePreview.rangeStatus")
                .replace("{start}", numberFormat.format(page.offset))
                .replace("{end}", numberFormat.format(page.nextOffset))
                .replace("{total}", numberFormat.format(page.sizeBytes))}
              {editable ? null : <> · {t("workspaceFilePreview.rangeReadOnly")}</>}
              {" · "}
            </>
          ) : null}
          {lineCount}
        </span>
        {readPage ? (
          <div className="flex flex-wrap gap-1 sm:ml-auto">
            <Button
              size="sm"
              variant="outline"
              disabled={!page.content || loading}
              onClick={() => void copyPage()}
            >
              {t("workspaceFilePreview.rangeCopy")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={loading || page.offset === 0}
              onClick={() => void navigate(previousOffset, "previous")}
            >
              {t("workspaceFilePreview.rangePrevious")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={
                loading || page.nextOffset <= page.offset || page.nextOffset >= page.sizeBytes
              }
              onClick={() => void navigate(page.nextOffset, "next")}
            >
              {t("workspaceFilePreview.rangeNext")}
            </Button>
            <form
              className="flex gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (canJump) void navigate(jump, "jump");
              }}
            >
              <input
                aria-label={t("workspaceFilePreview.rangeOffset")}
                inputMode="numeric"
                className="h-8 w-28 rounded-md border border-input bg-background px-2"
                value={jumpOffset}
                onChange={(event) => setJumpOffset(event.target.value)}
              />
              <Button size="sm" variant="outline" type="submit" disabled={loading || !canJump}>
                {t("workspaceFilePreview.rangeJump")}
              </Button>
            </form>
          </div>
        ) : null}
      </div>
      {error ? (
        <div role="alert" className="px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <section
        ref={viewportRef}
        aria-label={t("workspaceFilePreview.rangeContent")}
        data-workspace-text-range
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the preview.
        tabIndex={0}
        onScroll={(event) => {
          setTopLine(
            Math.max(
              0,
              Math.floor((event.currentTarget.scrollTop - RANGE_PADDING) / RANGE_LINE_HEIGHT),
            ),
          );
        }}
        className="relative min-h-0 flex-1 overflow-y-auto bg-background font-mono text-xs text-foreground [font-variant-ligatures:none] [overflow-anchor:none] [scrollbar-gutter:stable]"
        style={{ overflowX: wordWrap ? "hidden" : "auto", tabSize: TAB_SIZE }}
      >
        <div
          className="relative"
          style={{ height: rows.length * RANGE_LINE_HEIGHT + 2 * RANGE_PADDING }}
        >
          {rows.slice(firstLine, lastLine).map((row, index) => {
            const lineIndex = firstLine + index;
            const lineNumber = wrapped ? wrapped.lineNumbers[lineIndex] : lineIndex + 1;
            return (
              <div
                key={lineIndex}
                className="absolute left-0 flex w-max min-w-full whitespace-pre leading-5"
                style={{ top: RANGE_PADDING + lineIndex * RANGE_LINE_HEIGHT }}
              >
                <span
                  aria-hidden="true"
                  className="sticky left-0 z-10 shrink-0 select-none border-r border-border bg-background pr-[1ch] text-right text-muted-foreground"
                  style={{ width: `${gutterColumns}ch` }}
                >
                  {lineNumber || ""}
                </span>
                <span className="shrink-0 px-3">{row}</span>
              </div>
            );
          })}
        </div>
        <span
          ref={glyphRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-0 w-[1ch]"
        />
      </section>
    </div>
  );
}
