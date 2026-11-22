import { type DiffLine, DiffLineType, generateDiffFile } from "@git-diff-view/file";
import { ChevronDown, ChevronUp } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import { parseDiffRowsText } from "../../lib/chat/diffRows";
import { isElementInUse, useNearViewport } from "../../lib/shared/useNearViewport";
import { cn } from "../../lib/shared/utils";

type DiffPiece = {
  key: "whole" | "before" | "change" | "after";
  text: string;
  change?: "add" | "del";
};

type DiffRow = {
  key: string;
  lineNumber: number | null;
  /** note: a line the backend added to the diff, such as "… +12 more lines". */
  type: "ctx" | "add" | "del" | "note";
  pieces: DiffPiece[];
};

const CODE_KEYWORDS = new Set([
  "import",
  "from",
  "export",
  "default",
  "async",
  "function",
  "const",
  "let",
  "var",
  "await",
  "return",
  "if",
  "else",
  "for",
  "while",
  "new",
  "throw",
  "try",
  "catch",
  "null",
  "true",
  "false",
  "undefined",
]);

const CODE_TOKEN =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\b\d+(?:\.\d+)?\b|\b(?:import|from|export|default|async|function|const|let|var|await|return|if|else|for|while|new|throw|try|catch|null|true|false|undefined)\b|[A-Za-z_$][\w$]*(?=\s*\())/g;

function guessLangFromPath(filePath?: string): string {
  if (!filePath) return "txt";
  const ext = filePath.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    py: "python",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    rb: "ruby",
    swift: "swift",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    css: "css",
    scss: "scss",
    html: "html",
    vue: "vue",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    sql: "sql",
    sh: "bash",
    zsh: "bash",
    bash: "bash",
    dockerfile: "dockerfile",
    lua: "lua",
    php: "php",
    dart: "dart",
  };
  return (ext && map[ext]) || "txt";
}

function trimLineEnding(value: string) {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n") || value.endsWith("\r")) return value.slice(0, -1);
  return value;
}

function buildPieces(text: string, diff: DiffLine | undefined, type: DiffRow["type"]): DiffPiece[] {
  const range = diff?.changes?.range;
  if (type === "ctx" || !range || range.length <= 0) return [{ key: "whole", text }];

  const start = Math.min(Math.max(0, range.location), text.length);
  const end = Math.min(text.length, start + range.length);
  const pieces: DiffPiece[] = [];
  if (start > 0) pieces.push({ key: "before", text: text.slice(0, start) });
  if (end > start) {
    pieces.push({
      key: "change",
      text: text.slice(start, end),
      change: type === "add" ? "add" : "del",
    });
  }
  if (end < text.length) pieces.push({ key: "after", text: text.slice(end) });
  return pieces;
}

function highlightCode(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;

  for (const match of text.matchAll(CODE_TOKEN)) {
    const index = match.index ?? 0;
    const token = match[0];
    if (index > last) {
      nodes.push(<span key={`plain-${key++}`}>{text.slice(last, index)}</span>);
    }

    const isLiteral = /^["'`]/.test(token) || /^\d/.test(token);
    const isKeyword = CODE_KEYWORDS.has(token);
    nodes.push(
      <span
        key={`token-${key++}`}
        className={cn(
          isLiteral && "text-amber-700 dark:text-amber-300",
          isKeyword && "text-violet-700 dark:text-violet-300",
          !isLiteral && !isKeyword && "font-medium text-foreground",
        )}
      >
        {token}
      </span>,
    );
    last = index + token.length;
  }

  if (last < text.length) {
    nodes.push(<span key={`plain-${key}`}>{text.slice(last)}</span>);
  }
  return nodes;
}

function DiffPieces({ pieces }: { pieces: DiffPiece[] }) {
  return (
    <>
      {pieces.map((piece) => {
        if (!piece.change) {
          return <span key={piece.key}>{highlightCode(piece.text)}</span>;
        }
        const added = piece.change === "add";
        return (
          <span
            key={piece.key}
            className={cn(
              "rounded-xs px-0.5 [box-decoration-break:clone] [-webkit-box-decoration-break:clone]",
              added ? "bg-emerald-500/20" : "bg-red-500/20",
            )}
          >
            {highlightCode(piece.text)}
          </span>
        );
      })}
    </>
  );
}

function CodeFileIcon() {
  return (
    <svg
      aria-hidden="true"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0 text-muted-foreground"
    >
      <path d="M17.25 6.75 22.5 12l-5.25 5.25m-10.5 0L1.5 12l5.25-5.25m7.5-3-4.5 16.5" />
    </svg>
  );
}

function buildDiffRows(beforeText: string, afterText: string, filePath?: string) {
  const lang = guessLangFromPath(filePath);
  const diffFile = generateDiffFile(
    filePath ?? "old",
    beforeText,
    filePath ?? "new",
    afterText,
    lang,
    lang,
  );
  // The component owns its lightweight syntax coloring, so only build the raw
  // line model instead of initializing the library highlighter as well.
  diffFile.initRaw();
  diffFile.buildUnifiedDiffLines();

  const rows: DiffRow[] = [];
  let widestLineNumber = 0;
  for (let index = 0; index < diffFile.unifiedLineLength; index += 1) {
    const line = diffFile.getUnifiedLine(index);
    if (!line || line.isHidden || line.value === undefined) continue;

    const type: DiffRow["type"] =
      line.diff?.type === DiffLineType.Add
        ? "add"
        : line.diff?.type === DiffLineType.Delete
          ? "del"
          : "ctx";
    const lineNumber = type === "del" ? line.oldLineNumber : line.newLineNumber;
    const text = trimLineEnding(line.value);
    if (lineNumber && lineNumber > widestLineNumber) widestLineNumber = lineNumber;
    rows.push({
      key: `${type}-${line.oldLineNumber ?? ""}-${line.newLineNumber ?? ""}-${index}`,
      lineNumber: lineNumber ?? null,
      type,
      pieces: buildPieces(text, line.diff, type),
    });
  }

  return {
    added: diffFile.additionLength,
    removed: diffFile.deletionLength,
    // Two digits keep the familiar narrow gutter; wider files grow it so a
    // four-digit line number cannot spill under the code column.
    gutterDigits: Math.max(2, String(widestLineNumber).length),
    rows,
  };
}

/** Rows from a diff the backend already computed (K-brain's "<line> <mark> <text>" form). */
function buildTextDiffRows(diffText: string) {
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let widestLineNumber = 0;
  parseDiffRowsText(diffText).forEach((row, index) => {
    if (row.type === "add") added += 1;
    if (row.type === "del") removed += 1;
    if (row.lineNumber && row.lineNumber > widestLineNumber) widestLineNumber = row.lineNumber;
    rows.push({
      key: `${row.type}-${row.lineNumber ?? ""}-${index}`,
      lineNumber: row.lineNumber,
      type: row.type,
      pieces: [{ key: "whole", text: row.text }],
    });
  });
  if (rows.length === 0) return null;
  return { added, removed, gutterDigits: Math.max(2, String(widestLineNumber).length), rows };
}

type DiffModel = NonNullable<ReturnType<typeof buildTextDiffRows>>;

type DiffInput = {
  beforeText: string;
  afterText: string;
  filePath?: string;
  diffText?: string;
};

function computeDiff(input: DiffInput): DiffModel | null {
  const { beforeText, afterText, filePath, diffText } = input;
  if (diffText !== undefined) return buildTextDiffRows(diffText);
  return beforeText || afterText ? buildDiffRows(beforeText, afterText, filePath) : null;
}

function sameDiffInput(a: DiffInput, b: DiffInput) {
  return (
    a.beforeText === b.beforeText &&
    a.afterText === b.afterText &&
    a.filePath === b.filePath &&
    a.diffText === b.diffText
  );
}

/** Diffs that cost less than this are recomputed on every change. */
const CHEAP_DIFF_MS = 4;

/** Minimum time between two recomputations of an expensive diff. */
function diffThrottleMs(costMs: number) {
  return Math.min(1000, Math.max(100, costMs * 10));
}

type ComputedDiff = { input: DiffInput; diff: DiffModel | null; at: number; cost: number };

/**
 * The diff for the latest input, recomputed at most every few frames when it
 * is expensive: an Edit whose arguments are still streaming changes its text
 * on every delta, and re-diffing a large file each time kept the main thread
 * busy. The last input is always diffed once the changes pause.
 */
function useThrottledDiff(input: DiffInput) {
  const cache = useRef<ComputedDiff | null>(null);
  const [, wake] = useReducer((count: number) => count + 1, 0);
  let shown = cache.current;
  if (!shown || !sameDiffInput(shown.input, input)) {
    const started = performance.now();
    if (!shown || shown.cost < CHEAP_DIFF_MS || started - shown.at >= diffThrottleMs(shown.cost)) {
      const diff = computeDiff(input);
      const at = performance.now();
      shown = { input, diff, at, cost: at - started };
      // A cache keyed by its input: a render React discards leaves it valid.
      cache.current = shown;
    }
  }
  const stale = !sameDiffInput(shown.input, input);
  useEffect(() => {
    if (!stale) return undefined;
    // Depends on the shown result, not the input: later deltas must not push
    // the recomputation back while a stream keeps changing the text.
    const wait = Math.max(0, shown.at + diffThrottleMs(shown.cost) - performance.now());
    const timer = setTimeout(wake, wait);
    return () => clearTimeout(timer);
  }, [shown, stale]);
  return shown.diff;
}

/** Longer diffs show their first COLLAPSED_ROWS lines until expanded. */
const COLLAPSE_AFTER_ROWS = 360;
const COLLAPSED_ROWS = 300;
/** Expanded rows past the preview mount in groups, only near the viewport. */
const ROW_GROUP_SIZE = 200;
/** text-xs at leading-1p65: the height of one unwrapped row. */
const ESTIMATED_ROW_PX = 20;

const DiffRowView = memo(function DiffRowView({ row }: { row: DiffRow }) {
  if (row.type === "note") {
    return (
      <div
        className="grid grid-cols-[var(--diff-gutter)_minmax(0,1fr)] items-start"
        data-diff-note=""
      >
        <span aria-hidden="true" />
        <span className="pl-1 pr-3 text-muted-foreground">{row.pieces[0]?.text}</span>
      </div>
    );
  }
  const added = row.type === "add";
  const deleted = row.type === "del";
  return (
    <div
      className={cn(
        "relative grid grid-cols-[var(--diff-gutter)_minmax(0,1fr)] items-start",
        added && "bg-emerald-500/[0.09]",
        deleted && "bg-red-500/[0.09]",
      )}
    >
      {added || deleted ? (
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-0 left-0 w-3px",
            added && "bg-emerald-600",
            deleted && "bg-diff-deleted",
          )}
        />
      ) : null}
      <span
        aria-hidden="true"
        className={cn(
          "select-none text-center text-xs tabular-nums",
          added
            ? "text-emerald-700 dark:text-emerald-300"
            : deleted
              ? "text-red-700 dark:text-red-300"
              : "text-muted-foreground",
        )}
      >
        {row.lineNumber ?? ""}
      </span>
      <code className="break-words whitespace-pre-wrap pl-1 pr-3">
        <DiffPieces pieces={row.pieces} />
      </code>
    </div>
  );
});

/**
 * A run of rows that is only in the DOM near the viewport; elsewhere it is a
 * spacer of its last measured height (estimated before it first rendered).
 */
function DiffRowGroup({ rows }: { rows: DiffRow[] }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [height, setHeight] = useState<number | null>(null);
  const near = useNearViewport(ref, {
    beforeLeave: () => {
      const element = ref.current;
      if (!element) return true;
      if (isElementInUse(element)) return false;
      setHeight(element.getBoundingClientRect().height);
      return true;
    },
  });
  return (
    <div ref={ref} data-diff-row-group={near ? "mounted" : "placeholder"}>
      {near ? (
        rows.map((row) => <DiffRowView key={row.key} row={row} />)
      ) : (
        <div aria-hidden="true" style={{ height: height ?? rows.length * ESTIMATED_ROW_PX }} />
      )}
    </div>
  );
}

function DiffRows({ rows, expanded }: { rows: DiffRow[]; expanded: boolean }) {
  if (rows.length <= COLLAPSE_AFTER_ROWS) {
    return rows.map((row) => <DiffRowView key={row.key} row={row} />);
  }
  const preview = rows.slice(0, COLLAPSED_ROWS);
  const groups: DiffRow[][] = [];
  if (expanded) {
    for (let start = COLLAPSED_ROWS; start < rows.length; start += ROW_GROUP_SIZE) {
      groups.push(rows.slice(start, start + ROW_GROUP_SIZE));
    }
  }
  return (
    <>
      {preview.map((row) => (
        <DiffRowView key={row.key} row={row} />
      ))}
      {groups.map((group) => (
        <DiffRowGroup key={group[0]?.key} rows={group} />
      ))}
    </>
  );
}

export function EditDiffView(props: {
  beforeText: string;
  afterText: string;
  filePath?: string;
  /** A diff the backend computed; when set it is shown instead of diffing the two texts. */
  diffText?: string;
}) {
  const { beforeText, afterText, filePath, diffText } = props;
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const diff = useThrottledDiff({ beforeText, afterText, filePath, diffText });

  if (!diff) return null;

  const displayPath = filePath?.trim() || "changed file";
  const collapsible = diff.rows.length > COLLAPSE_AFTER_ROWS;
  const hiddenRows = diff.rows.length - COLLAPSED_ROWS;
  return (
    <figure
      className={cn(
        "edit-tool-diff-view w-full max-w-420px overflow-hidden",
        "rounded-xl border border-border/65 bg-card/85 shadow-ui-editdiffview-5",
      )}
      aria-label={`Diff for ${displayPath}`}
      data-chat-code-diff=""
    >
      <figcaption className="flex h-11 items-center gap-2 border-b border-border/60 px-4 text-xs">
        <span className="inline-flex min-w-0 items-center gap-7px">
          <CodeFileIcon />
          <span className="truncate font-mono leading-none text-foreground">{displayPath}</span>
        </span>
        <span className="ml-auto inline-flex items-center gap-2 font-mono text-xs leading-none tabular-nums">
          <span className="text-emerald-700 dark:text-emerald-300">+{diff.added}</span>
          <span className="text-red-700 dark:text-red-300">-{diff.removed}</span>
        </span>
      </figcaption>

      <div
        className={cn(
          "font-mono text-xs leading-1p65 text-foreground/78",
          collapsible ? "pt-3" : "py-3",
        )}
        style={
          { "--diff-gutter": `calc(${diff.gutterDigits}ch + var(--spacing-4px))` } as CSSProperties
        }
      >
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[var(--diff-gutter)] w-px bg-border/70"
          />
          <DiffRows rows={diff.rows} expanded={expanded} />
        </div>
      </div>
      {collapsible ? (
        <div className="flex justify-center border-t border-border/60 py-1.5">
          <button
            type="button"
            data-diff-expand={expanded ? "expanded" : "collapsed"}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
            className={cn(
              "inline-flex items-center gap-1 rounded-md px-2 py-0.5",
              "text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground",
            )}
          >
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
            <span>
              {expanded
                ? t("chat.editDiff.collapse")
                : t("chat.editDiff.expand").replace("{count}", hiddenRows.toLocaleString())}
            </span>
          </button>
        </div>
      ) : null}
    </figure>
  );
}
