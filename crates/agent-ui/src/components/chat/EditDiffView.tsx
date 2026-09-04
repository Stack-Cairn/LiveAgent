import { type DiffLine, DiffLineType, generateDiffFile } from "@git-diff-view/file";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { cn } from "../../lib/shared/utils";

type DiffPiece = {
  key: "whole" | "before" | "change" | "after";
  text: string;
  change?: "add" | "del";
};

type DiffRow = {
  key: string;
  lineNumber: number | null;
  type: "ctx" | "add" | "del";
  pieces: DiffPiece[];
};

const DELETE_HATCH =
  "repeating-linear-gradient(45deg, hsl(var(--chat-error)) 0, hsl(var(--chat-error)) 1.5px, transparent 1.5px, transparent 3px)";

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

export function EditDiffView(props: { beforeText: string; afterText: string; filePath?: string }) {
  const { beforeText, afterText, filePath } = props;
  const diff = useMemo(
    () => (beforeText || afterText ? buildDiffRows(beforeText, afterText, filePath) : null),
    [afterText, beforeText, filePath],
  );

  if (!diff) return null;

  const displayPath = filePath?.trim() || "changed file";
  return (
    <figure
      className="edit-tool-diff-view w-full max-w-[420px] overflow-hidden rounded-xl border border-border/65 bg-card/85 shadow-[0_5px_18px_-14px_hsl(var(--foreground)/0.28)]"
      aria-label={`Diff for ${displayPath}`}
      data-chat-code-diff=""
    >
      <figcaption className="flex h-11 items-center gap-2 border-b border-border/60 px-4 text-[12.5px]">
        <span className="inline-flex min-w-0 items-center gap-[7px]">
          <CodeFileIcon />
          <span className="truncate font-mono leading-none text-foreground">{displayPath}</span>
        </span>
        <span className="ml-auto inline-flex items-center gap-2 font-mono text-xs leading-none tabular-nums">
          <span className="text-emerald-700 dark:text-emerald-300">+{diff.added}</span>
          <span className="text-red-700 dark:text-red-300">-{diff.removed}</span>
        </span>
      </figcaption>

      <div
        className="py-3 font-mono text-[12.5px] leading-[1.65] text-foreground/78"
        style={{ "--diff-gutter": `calc(${diff.gutterDigits}ch + 4px)` } as CSSProperties}
      >
        <div className="relative">
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-[var(--diff-gutter)] w-px bg-border/70"
          />
          {diff.rows.map((row) => {
            const added = row.type === "add";
            const deleted = row.type === "del";
            return (
              <div
                key={row.key}
                className={cn(
                  "relative grid grid-cols-[var(--diff-gutter)_minmax(0,1fr)] items-start",
                  added && "bg-emerald-500/[0.09]",
                  deleted && "bg-red-500/[0.09]",
                )}
              >
                {added || deleted ? (
                  <span
                    aria-hidden="true"
                    className={cn("absolute inset-y-0 left-0 w-[3px]", added && "bg-emerald-600")}
                    style={deleted ? { background: DELETE_HATCH } : undefined}
                  />
                ) : null}
                <span
                  aria-hidden="true"
                  className={cn(
                    "select-none text-center text-[11px] tabular-nums",
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
          })}
        </div>
      </div>
    </figure>
  );
}
