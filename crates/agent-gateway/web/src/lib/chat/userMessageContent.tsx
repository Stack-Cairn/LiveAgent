import { openUrl } from "@tauri-apps/plugin-opener";
import {
  type FocusEvent,
  type MouseEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { getFileTypeIcon } from "../../components/chat/fileTypeIcons";
import { SkillIcon } from "../../components/icons";
import { useLocale } from "../../i18n";

import {
  type CodeMentionReference,
  codeMentionDisplayName,
  codeMentionLineLabel,
  codeMentionTitle,
  parseMarkdownCodeMentionReference,
} from "./mentionReferences";
import {
  type PastedTextDisplayReference,
  type PendingUploadedFile,
  parsePastedTextDisplayReferences,
} from "./uploadedFiles";

export function isMentionToken(token: string) {
  return /^@[^\s@][^\s]*$/.test(token);
}

const COMMON_SKILL_MENTION_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
]);

function isSkillMentionName(value: string) {
  return /^[A-Za-z0-9_:-]+$/.test(value);
}

function isCommonSkillMentionEnvVar(name: string) {
  const upper = name.toUpperCase();
  return (
    COMMON_SKILL_MENTION_ENV_VARS.has(upper) ||
    (upper.endsWith(":") && COMMON_SKILL_MENTION_ENV_VARS.has(upper.slice(0, -1)))
  );
}

export function isSkillMentionToken(token: string) {
  if (!token.startsWith("$")) return false;
  const name = token.slice(1);
  return Boolean(name) && isSkillMentionName(name) && !isCommonSkillMentionEnvVar(name);
}

type UserMessageSegment =
  | { type: "text"; value: string }
  | { type: "mention"; path: string; isDir: boolean }
  | { type: "skill"; name: string }
  | { type: "commit"; commit: CommitDisplayReference }
  | { type: "gitFile"; file: GitFileDisplayReference }
  | { type: "codeRef"; reference: CodeMentionReference }
  | {
      type: "pastedText";
      reference: PastedTextDisplayReference;
      file: PendingUploadedFile;
    };

export type CommitDisplayReference = {
  sha: string;
  shortSha: string;
  subject: string;
  body?: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: string;
  fileCount?: number;
  filesChanged?: number;
  insertions?: number;
  deletions?: number;
  stat?: string;
  remoteName?: string;
  remoteUrl?: string;
  githubUrl?: string;
};

export type GitFileDisplayReference = {
  path: string;
  oldPath?: string;
  status?: string;
  commitSha: string;
  shortSha: string;
  refName: string;
  remoteName?: string;
  remoteUrl?: string;
  githubUrl?: string;
};

export type CommitDetailsLoader = (
  commit: CommitDisplayReference,
) => Promise<CommitDisplayReference | null | undefined>;

function pushTextSegment(segments: UserMessageSegment[], value: string) {
  if (!value) return;
  const last = segments[segments.length - 1];
  if (last?.type === "text") {
    last.value += value;
    return;
  }
  segments.push({ type: "text", value });
}

function appendSegments(segments: UserMessageSegment[], incoming: UserMessageSegment[]) {
  for (const segment of incoming) {
    if (segment.type === "text") {
      pushTextSegment(segments, segment.value);
    } else {
      segments.push(segment);
    }
  }
}

function unescapeMarkdown(value: string) {
  return value.replace(/\\([\\[\]()])/g, "$1");
}

function normalizeMarkdownDestination(value: string) {
  const trimmed = value.trim();
  const inner = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  return unescapeMarkdown(inner).replace(/%3C/gi, "<").replace(/%3E/gi, ">");
}

function normalizeReferencePath(value: string) {
  return value.trim().replace(/\\/g, "/");
}

function buildFileReference(rawPath: string) {
  const normalized = normalizeReferencePath(rawPath);
  const isDir = normalized.endsWith("/");
  const path = normalized.replace(/\/+$/, "");
  if (!path || path.startsWith("/") || path.startsWith("#")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) {
    return null;
  }
  return { path, isDir };
}

function markdownFileReference(label: string, rawDestination: string) {
  const reference = buildFileReference(normalizeMarkdownDestination(rawDestination));
  if (!reference) return null;

  const fileName = reference.path.split("/").pop() || reference.path;
  const expectedLabel = reference.isDir ? `${fileName}/` : fileName;
  if (unescapeMarkdown(label.trim()) !== expectedLabel) return null;

  return reference;
}

function extractGitHubCommitSha(value: string) {
  try {
    const url = new URL(value);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const commitIndex = parts.findIndex((part) => part.toLowerCase() === "commit");
    const sha = commitIndex >= 0 ? (parts[commitIndex + 1] ?? "") : "";
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : "";
  } catch {
    return "";
  }
}

export function buildGitHubCommitUrl(remoteUrl: string, sha: string) {
  const value = remoteUrl.trim();
  const commitSha = sha.trim();
  if (!value || !commitSha) return "";
  const sshMatch = /^git@github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/i.exec(value);
  if (sshMatch?.[1] && sshMatch[2]) {
    return `https://github.com/${sshMatch[1]}/${sshMatch[2].replace(/\.git$/i, "")}/commit/${commitSha}`;
  }
  try {
    const url = new URL(value);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return "";
    const parts = url.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")
      .filter(Boolean);
    if (parts.length < 2) return "";
    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");
    return owner && repo ? `https://github.com/${owner}/${repo}/commit/${commitSha}` : "";
  } catch {
    return "";
  }
}

function extractGitHubFileReference(value: string) {
  try {
    const url = new URL(value);
    if (!["github.com", "www.github.com"].includes(url.hostname.toLowerCase())) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const blobIndex = parts.findIndex((part) => part.toLowerCase() === "blob");
    const ref = blobIndex >= 0 ? (parts[blobIndex + 1] ?? "") : "";
    const pathParts = blobIndex >= 0 ? parts.slice(blobIndex + 2) : [];
    if (!ref || pathParts.length === 0) return null;
    return {
      ref,
      path: pathParts.map((part) => decodeURIComponent(part)).join("/"),
    };
  } catch {
    return null;
  }
}

function markdownCommitReference(
  label: string,
  rawDestination: string,
): CommitDisplayReference | null {
  const normalizedLabel = unescapeMarkdown(label.trim());
  const match = /^commit\s+([0-9a-f]{7,40})(?::\s*(.*))?$/i.exec(normalizedLabel);
  if (!match) return null;

  const shortSha = match[1] ?? "";
  const subject = (match[2] ?? "").trim();
  const destination = normalizeMarkdownDestination(rawDestination);
  const githubSha = extractGitHubCommitSha(destination);
  return {
    sha: githubSha || shortSha,
    shortSha,
    subject,
    githubUrl: githubSha ? destination : undefined,
  };
}

function normalizeGitFileDisplayReference(file: GitFileDisplayReference): GitFileDisplayReference {
  const path = normalizeReferencePath(file.path);
  const commitSha = file.commitSha.trim();
  const shortSha = (file.shortSha || commitSha.slice(0, 7)).trim();
  return {
    path,
    oldPath: file.oldPath?.trim() || undefined,
    status: file.status ?? "",
    commitSha,
    shortSha,
    refName: file.refName?.trim() || shortSha,
    remoteName: file.remoteName ?? "",
    remoteUrl: file.remoteUrl ?? "",
    githubUrl: file.githubUrl?.trim() || undefined,
  };
}

function markdownGitFileReference(
  label: string,
  rawDestination: string,
): GitFileDisplayReference | null {
  const normalizedLabel = unescapeMarkdown(label.trim());
  const match = /^git file\s+(.+?):\s*(.+)$/i.exec(normalizedLabel);
  if (!match) return null;
  const refName = (match[1] ?? "").trim();
  const labelPath = normalizeReferencePath(match[2] ?? "");
  const destination = normalizeMarkdownDestination(rawDestination);
  const githubFile = extractGitHubFileReference(destination);
  if (!githubFile) return null;
  const path = labelPath || githubFile.path || "";
  if (!path || path.startsWith("/") || path.startsWith("#")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  const commitSha = githubFile.ref;
  return normalizeGitFileDisplayReference({
    path,
    commitSha,
    shortSha: /^[0-9a-f]{7,40}$/i.test(commitSha) ? commitSha.slice(0, 7) : commitSha,
    refName,
    githubUrl: destination,
  });
}

function normalizeCommitDisplayReference(commit: CommitDisplayReference): CommitDisplayReference {
  const sha = commit.sha.trim();
  const shortSha = (commit.shortSha || sha.slice(0, 7)).trim();
  return {
    sha,
    shortSha,
    subject: commit.subject ?? "",
    body: commit.body ?? "",
    authorName: commit.authorName ?? "",
    authorEmail: commit.authorEmail ?? "",
    authorDate: commit.authorDate ?? "",
    fileCount:
      typeof commit.fileCount === "number" && Number.isFinite(commit.fileCount)
        ? commit.fileCount
        : undefined,
    filesChanged:
      typeof commit.filesChanged === "number" && Number.isFinite(commit.filesChanged)
        ? commit.filesChanged
        : undefined,
    insertions:
      typeof commit.insertions === "number" && Number.isFinite(commit.insertions)
        ? commit.insertions
        : undefined,
    deletions:
      typeof commit.deletions === "number" && Number.isFinite(commit.deletions)
        ? commit.deletions
        : undefined,
    stat: commit.stat ?? "",
    remoteName: commit.remoteName ?? "",
    remoteUrl: commit.remoteUrl ?? "",
    githubUrl: commit.githubUrl?.trim() || undefined,
  };
}

function isTokenBoundary(text: string, index: number) {
  return index === 0 || /\s/.test(text[index - 1] ?? "");
}

function inlineCommitReferenceAt(text: string, index: number) {
  if (!isTokenBoundary(text, index)) return null;
  const match = /^commit\s+([0-9a-f]{7,40})(?::\s*([^\r\n]*?))?\s+\(([0-9a-f]{7,40})\)/i.exec(
    text.slice(index),
  );
  if (!match) return null;
  const shortSha = match[1] ?? "";
  const subject = (match[2] ?? "").trim();
  const sha = match[3] ?? shortSha;
  return {
    end: index + (match[0]?.length ?? 0),
    commit: { sha, shortSha, subject } satisfies CommitDisplayReference,
  };
}

function inlineGitFileReferenceAt(text: string, index: number) {
  if (!isTokenBoundary(text, index)) return null;
  const match = /^git file\s+(.+?):\s*([^\r\n]+?)\s+\(([0-9a-f]{7,40})\)/i.exec(text.slice(index));
  if (!match) return null;
  const refName = (match[1] ?? "").trim();
  const path = normalizeReferencePath(match[2] ?? "");
  const commitSha = match[3] ?? "";
  if (!path || path.startsWith("/") || path.startsWith("#")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return null;
  if (path.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return {
    end: index + (match[0]?.length ?? 0),
    file: normalizeGitFileDisplayReference({
      path,
      commitSha,
      shortSha: commitSha.slice(0, 7),
      refName,
    }),
  };
}

function tokenizeInlineMentions(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  let cursor = 0;

  for (let index = 0; index < text.length; index += 1) {
    const gitFileMatch = inlineGitFileReferenceAt(text, index);
    if (gitFileMatch) {
      if (index > cursor) {
        pushTextSegment(segments, text.slice(cursor, index));
      }
      segments.push({ type: "gitFile", file: gitFileMatch.file });
      cursor = gitFileMatch.end;
      index = gitFileMatch.end - 1;
      continue;
    }

    const commitMatch = inlineCommitReferenceAt(text, index);
    if (commitMatch) {
      if (index > cursor) {
        pushTextSegment(segments, text.slice(cursor, index));
      }
      segments.push({ type: "commit", commit: commitMatch.commit });
      cursor = commitMatch.end;
      index = commitMatch.end - 1;
      continue;
    }

    const marker = text[index];
    if ((marker !== "@" && marker !== "$") || !isTokenBoundary(text, index)) {
      continue;
    }

    if (marker === "@") {
      let tokenEnd = index + 1;
      while (tokenEnd < text.length && !/\s/.test(text[tokenEnd])) {
        tokenEnd += 1;
      }
      const token = text.slice(index, tokenEnd);
      if (!isMentionToken(token)) continue;
      const reference = buildFileReference(token.slice(1));
      if (reference) {
        if (index > cursor) {
          pushTextSegment(segments, text.slice(cursor, index));
        }
        segments.push({ type: "mention", ...reference });
        cursor = tokenEnd;
        index = tokenEnd - 1;
      }
      continue;
    }

    let nameEnd = index + 1;
    while (nameEnd < text.length && /[A-Za-z0-9_:-]/.test(text[nameEnd])) {
      nameEnd += 1;
    }
    const token = text.slice(index, nameEnd);
    if (!isSkillMentionToken(token)) continue;
    if (index > cursor) {
      pushTextSegment(segments, text.slice(cursor, index));
    }
    segments.push({ type: "skill", name: token.slice(1) });
    cursor = nameEnd;
    index = nameEnd - 1;
  }

  if (cursor < text.length) {
    pushTextSegment(segments, text.slice(cursor));
  }

  if (segments.length === 0) {
    segments.push({ type: "text", value: text });
  }

  return segments;
}

function tokenizeMentions(text: string): UserMessageSegment[] {
  const segments: UserMessageSegment[] = [];
  const markdownPattern = /\[((?:\\.|[^\]\\\r\n])+)]\((<[^>\r\n]+>|[^)\r\n]+)\)/g;
  let cursor = 0;

  for (const match of text.matchAll(markdownPattern)) {
    const raw = match[0] ?? "";
    const label = match[1] ?? "";
    const destination = match[2] ?? "";
    const matchIndex = match.index ?? 0;
    const gitFile = markdownGitFileReference(label, destination);
    const commit = gitFile ? null : markdownCommitReference(label, destination);
    const codeRef =
      gitFile || commit ? null : parseMarkdownCodeMentionReference(label, destination);
    const reference =
      gitFile || commit || codeRef ? null : markdownFileReference(label, destination);
    if (!gitFile && !commit && !codeRef && !reference) continue;

    if (matchIndex > cursor) {
      appendSegments(segments, tokenizeInlineMentions(text.slice(cursor, matchIndex)));
    }
    if (gitFile) {
      segments.push({ type: "gitFile", file: gitFile });
    } else if (commit) {
      segments.push({ type: "commit", commit });
    } else if (codeRef) {
      segments.push({ type: "codeRef", reference: codeRef });
    } else if (reference) {
      segments.push({ type: "mention", ...reference });
    }
    cursor = matchIndex + raw.length;
  }

  if (cursor < text.length) {
    appendSegments(segments, tokenizeInlineMentions(text.slice(cursor)));
  }

  return segments.length > 0 ? segments : tokenizeInlineMentions(text);
}

function tokenizeUserMessage(
  text: string,
  pastedTextFiles: PendingUploadedFile[],
): UserMessageSegment[] {
  const fileByPath = new Map(pastedTextFiles.map((file) => [file.relativePath, file]));
  const references = parsePastedTextDisplayReferences(text);
  if (references.length === 0 || fileByPath.size === 0) {
    return tokenizeMentions(text);
  }

  const segments: UserMessageSegment[] = [];
  let cursor = 0;
  for (const reference of references) {
    const file = fileByPath.get(reference.relativePath);
    if (!file) continue;
    if (reference.start > cursor) {
      appendSegments(segments, tokenizeMentions(text.slice(cursor, reference.start)));
    }
    segments.push({ type: "pastedText", reference, file });
    cursor = reference.end;
  }

  if (cursor < text.length) {
    appendSegments(segments, tokenizeMentions(text.slice(cursor)));
  }

  return segments.length > 0 ? segments : tokenizeMentions(text);
}

function formatPastedTextCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatCommitTooltipDate(value: string | undefined, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const absolute = date.toLocaleString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<{
    unit: "year" | "month" | "day" | "hour" | "minute" | "second";
    seconds: number;
  }> = [
    { unit: "year", seconds: 365 * 24 * 60 * 60 },
    { unit: "month", seconds: 30 * 24 * 60 * 60 },
    { unit: "day", seconds: 24 * 60 * 60 },
    { unit: "hour", seconds: 60 * 60 },
    { unit: "minute", seconds: 60 },
    { unit: "second", seconds: 1 },
  ];
  const selected = units.find(({ seconds }) => Math.abs(deltaSeconds) >= seconds) ?? units.at(-1)!;
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(deltaSeconds / selected.seconds),
    selected.unit,
  );
  return { relative, absolute };
}

function hasDetailedCommitInfo(commit: CommitDisplayReference) {
  return Boolean(
    commit.body?.trim() ||
      commit.authorName?.trim() ||
      commit.authorEmail?.trim() ||
      commit.authorDate?.trim() ||
      commit.remoteName?.trim() ||
      commit.remoteUrl?.trim() ||
      commit.stat?.trim() ||
      typeof commit.filesChanged === "number" ||
      typeof commit.fileCount === "number" ||
      typeof commit.insertions === "number" ||
      typeof commit.deletions === "number",
  );
}

function commitStatNumber(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function GitHubMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function commitStatLabel(template: string, count: string) {
  return template.replace("{count}", count);
}

function CommitReferenceTooltip({
  commit,
  rect,
  onMouseEnter,
  onMouseLeave,
}: {
  commit: CommitDisplayReference;
  rect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { locale, t } = useLocale();
  const maxWidth = Math.min(440, window.innerWidth - 16);
  const minWidth = Math.min(200, maxWidth);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipWidth, setTooltipWidth] = useState(minWidth);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - tooltipWidth - 8));
  const availableAbove = rect.top - 16;
  const availableBelow = window.innerHeight - rect.bottom - 16;
  const placeAbove = availableAbove > 260 || availableAbove > availableBelow;
  const maxHeight = Math.max(120, Math.min(520, placeAbove ? availableAbove : availableBelow));
  const top = placeAbove
    ? Math.max(8, rect.top - 8)
    : Math.min(window.innerHeight - 8, rect.bottom + 8);
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const subject = commit.subject.trim() || shortSha;
  const body = commit.body?.trim() ?? "";
  const author = commit.authorName?.trim() || t("chat.composer.commitTooltipUnknownAuthor");
  const authorLabel = commit.authorEmail?.trim()
    ? `${author} <${commit.authorEmail.trim()}>`
    : author;
  const date = formatCommitTooltipDate(commit.authorDate, locale);
  const detailed = hasDetailedCommitInfo(commit);
  const filesChanged = commitStatNumber(commit.filesChanged ?? commit.fileCount);
  const insertions = commitStatNumber(commit.insertions);
  const deletions = commitStatNumber(commit.deletions);
  const filesChangedLabel = commitStatLabel(
    t("chat.composer.commitTooltipFilesChanged"),
    formatPastedTextCount(filesChanged),
  );
  const insertionsLabel = commitStatLabel(
    t("chat.composer.commitTooltipInsertions"),
    formatPastedTextCount(insertions),
  );
  const deletionsLabel = commitStatLabel(
    t("chat.composer.commitTooltipDeletions"),
    formatPastedTextCount(deletions),
  );

  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!node) return;
    const measuredWidth = Math.ceil(node.getBoundingClientRect().width);
    setTooltipWidth(Math.min(maxWidth, Math.max(minWidth, measuredWidth)));
  }, [commit, maxWidth, minWidth]);

  return createPortal(
    <div
      ref={tooltipRef}
      className="fixed z-[10000] overflow-y-auto rounded-xl border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-xl"
      style={{
        left,
        top,
        width: "fit-content",
        minWidth,
        maxWidth,
        maxHeight,
        transform: placeAbove ? "translateY(-100%)" : "none",
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-start gap-2">
        <GitHubMarkIcon className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          {detailed ? (
            <>
              <div className="break-words font-medium leading-tight">{authorLabel}</div>
              {date ? (
                <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">
                  {date.relative} ({date.absolute})
                </div>
              ) : null}
            </>
          ) : (
            <div className="font-mono text-[11px] leading-tight text-muted-foreground">
              {shortSha}
            </div>
          )}
        </div>
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words font-medium leading-snug">{subject}</div>
      {body ? (
        <div className="mt-1.5 whitespace-pre-wrap break-words leading-snug text-muted-foreground">
          {body}
        </div>
      ) : null}
      {detailed ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] leading-tight">
          <span className="text-muted-foreground">{filesChangedLabel}</span>
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            {insertionsLabel}
          </span>
          <span className="font-medium text-rose-600 dark:text-rose-400">{deletionsLabel}</span>
        </div>
      ) : null}
      {commit.githubUrl ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-1.5 text-[11px] leading-tight text-muted-foreground">
          <span className="font-mono text-foreground">{shortSha}</span>
          {commit.remoteName ? <span>{commit.remoteName}</span> : null}
          <span className="text-border">|</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-primary hover:bg-primary/10"
            onClick={() => void openUrl(commit.githubUrl!)}
          >
            <GitHubMarkIcon className="h-3 w-3" />
            {t("chat.composer.commitTooltipOpenGithub")}
          </button>
        </div>
      ) : detailed ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-1.5 text-[11px] leading-tight text-muted-foreground">
          <span className="font-mono text-foreground">{shortSha}</span>
          {commit.remoteName ? <span>{commit.remoteName}</span> : null}
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

function PastedTextChip({
  reference,
  file,
}: {
  reference: PastedTextDisplayReference;
  file: PendingUploadedFile;
}) {
  const label = file.displayLabel || reference.label;
  const hasCounts =
    typeof file.displayCharCount === "number" &&
    Number.isFinite(file.displayCharCount) &&
    typeof file.displayLineCount === "number" &&
    Number.isFinite(file.displayLineCount);
  const chipText = hasCounts
    ? `${label} · ${formatPastedTextCount(file.displayCharCount ?? 0)} chars · ${formatPastedTextCount(file.displayLineCount ?? 0)} lines`
    : label;
  const Icon = getFileTypeIcon(file.relativePath || "pasted.txt", "file");

  return (
    <span
      title={file.relativePath}
      className="mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-emerald-500/15 px-1.5 text-emerald-700 align-baseline whitespace-nowrap dark:text-emerald-300"
    >
      <Icon className="h-3 w-3 shrink-0 self-center" />
      {chipText}
    </span>
  );
}

function MentionChip({ path, isDir }: { path: string; isDir: boolean }) {
  const fileName = path.split("/").pop() || path;
  const Icon = getFileTypeIcon(path, isDir ? "dir" : "file");
  return (
    <span
      title={isDir ? `${path}/` : path}
      className={
        isDir
          ? "mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-amber-500/15 px-1.5 text-amber-700 align-baseline whitespace-nowrap dark:text-amber-300"
          : "mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-blue-500/15 px-1.5 text-blue-700 align-baseline whitespace-nowrap dark:text-blue-300"
      }
    >
      <Icon className="h-3 w-3 shrink-0 self-center" />
      {fileName}
    </span>
  );
}

function CodeRefMentionChip({ reference }: { reference: CodeMentionReference }) {
  const Icon = getFileTypeIcon(reference.path, "file");
  const lineLabel = codeMentionLineLabel(reference);
  return (
    <span
      title={codeMentionTitle(reference)}
      className="mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-indigo-500/15 px-1.5 text-indigo-700 align-baseline whitespace-nowrap dark:text-indigo-300"
    >
      <Icon className="h-3 w-3 shrink-0 self-center" />
      <span>{`${codeMentionDisplayName(reference)}：${lineLabel}`}</span>
    </span>
  );
}

function GitFileMentionChip({ file }: { file: GitFileDisplayReference }) {
  const normalized = normalizeGitFileDisplayReference(file);
  const fileName = normalized.path.split("/").pop() || normalized.path;
  const Icon = getFileTypeIcon(normalized.path, "file");
  const refLabel = normalized.refName || normalized.shortSha || normalized.commitSha.slice(0, 7);
  const title = `${normalized.path}\n${refLabel} (${normalized.shortSha || normalized.commitSha.slice(0, 7)})`;
  const openFile = useCallback(() => {
    if (normalized.githubUrl) {
      void openUrl(normalized.githubUrl);
    }
  }, [normalized.githubUrl]);

  return (
    <span
      title={title}
      role={normalized.githubUrl ? "button" : undefined}
      tabIndex={normalized.githubUrl ? 0 : undefined}
      className={`mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-sky-500/15 px-1.5 text-sky-800 align-baseline whitespace-nowrap dark:text-sky-200 ${
        normalized.githubUrl ? "cursor-pointer hover:bg-sky-500/20" : "cursor-default"
      }`}
      onClick={openFile}
      onKeyDown={(event) => {
        if (!normalized.githubUrl || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        openFile();
      }}
    >
      <Icon className="h-3 w-3 shrink-0 self-center" />
      <span>{fileName}</span>
      <span className="max-w-[8rem] truncate text-[10px] opacity-70">@{refLabel}</span>
    </span>
  );
}

function SkillMentionChip({ name }: { name: string }) {
  return (
    <span
      title={`Skill: ${name}`}
      className="mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-violet-500/15 px-1.5 text-violet-700 align-baseline whitespace-nowrap dark:text-violet-300"
    >
      <SkillIcon className="h-3 w-3 shrink-0 self-center" />
      {name}
    </span>
  );
}

function CommitMentionChip({
  commit,
  loadCommitDetails,
}: {
  commit: CommitDisplayReference;
  loadCommitDetails?: CommitDetailsLoader;
}) {
  const [resolvedCommit, setResolvedCommit] = useState(() =>
    normalizeCommitDisplayReference(commit),
  );
  const [detailsState, setDetailsState] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [tooltipRect, setTooltipRect] = useState<DOMRect | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const label = resolvedCommit.shortSha || resolvedCommit.sha.slice(0, 7);

  useEffect(() => {
    setResolvedCommit(normalizeCommitDisplayReference(commit));
    setDetailsState("idle");
  }, [commit.githubUrl, commit.sha, commit.shortSha, commit.subject]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const maybeLoadCommitDetails = useCallback(() => {
    if (!loadCommitDetails || detailsState !== "idle") return;
    setDetailsState("loading");
    void loadCommitDetails(resolvedCommit)
      .then((details) => {
        if (!details) {
          setDetailsState("error");
          return;
        }
        setResolvedCommit((current) =>
          normalizeCommitDisplayReference({
            ...current,
            ...details,
            githubUrl: details.githubUrl || current.githubUrl,
          }),
        );
        setDetailsState("loaded");
      })
      .catch(() => {
        setDetailsState("error");
      });
  }, [detailsState, loadCommitDetails, resolvedCommit]);

  const showTooltip = useCallback(
    (target: HTMLElement) => {
      clearCloseTimer();
      setTooltipRect(target.getBoundingClientRect());
      maybeLoadCommitDetails();
    },
    [clearCloseTimer, maybeLoadCommitDetails],
  );

  const scheduleClose = useCallback(() => {
    clearCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setTooltipRect(null);
    }, 120);
  }, [clearCloseTimer]);

  const openCommit = useCallback(() => {
    if (resolvedCommit.githubUrl) {
      void openUrl(resolvedCommit.githubUrl);
    }
  }, [resolvedCommit.githubUrl]);

  const handleMouseEnter = useCallback(
    (event: MouseEvent<HTMLSpanElement>) => showTooltip(event.currentTarget),
    [showTooltip],
  );
  const handleFocus = useCallback(
    (event: FocusEvent<HTMLSpanElement>) => showTooltip(event.currentTarget),
    [showTooltip],
  );

  useEffect(() => clearCloseTimer, [clearCloseTimer]);

  return (
    <>
      <span
        aria-label={resolvedCommit.subject ? `${label}: ${resolvedCommit.subject}` : label}
        role={resolvedCommit.githubUrl ? "button" : undefined}
        tabIndex={resolvedCommit.githubUrl ? 0 : undefined}
        className={`mention-chip mx-0.5 inline-flex items-baseline gap-1 rounded bg-cyan-500/15 px-1.5 text-cyan-800 align-baseline whitespace-nowrap dark:text-cyan-200 ${
          resolvedCommit.githubUrl ? "cursor-pointer hover:bg-cyan-500/20" : "cursor-default"
        }`}
        onClick={openCommit}
        onFocus={handleFocus}
        onBlur={scheduleClose}
        onKeyDown={(event) => {
          if (!resolvedCommit.githubUrl || (event.key !== "Enter" && event.key !== " ")) return;
          event.preventDefault();
          openCommit();
        }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={scheduleClose}
      >
        <GitHubMarkIcon className="h-3 w-3 shrink-0 self-center" />
        {label}
      </span>
      {tooltipRect ? (
        <CommitReferenceTooltip
          commit={resolvedCommit}
          rect={tooltipRect}
          onMouseEnter={clearCloseTimer}
          onMouseLeave={scheduleClose}
        />
      ) : null}
    </>
  );
}

// Memoized: tokenization scans the text char by char, so virtualizer
// remounts of long user rows should be the only time it runs.
export const UserMessageContent = memo(function UserMessageContent({
  text,
  pastedTextFiles = [],
  loadCommitDetails,
}: {
  text: string;
  pastedTextFiles?: PendingUploadedFile[];
  loadCommitDetails?: CommitDetailsLoader;
}) {
  const parts = useMemo(() => tokenizeUserMessage(text, pastedTextFiles), [text, pastedTextFiles]);
  const hasChip = parts.some(
    (part) =>
      part.type === "mention" ||
      part.type === "skill" ||
      part.type === "commit" ||
      part.type === "gitFile" ||
      part.type === "codeRef" ||
      part.type === "pastedText",
  );
  if (!hasChip) return <>{text}</>;

  return (
    <>
      {parts.map((part, idx) => {
        if (part.type === "mention") {
          return <MentionChip key={idx} path={part.path} isDir={part.isDir} />;
        }
        if (part.type === "skill") {
          return <SkillMentionChip key={idx} name={part.name} />;
        }
        if (part.type === "commit") {
          return (
            <CommitMentionChip
              key={idx}
              commit={part.commit}
              loadCommitDetails={loadCommitDetails}
            />
          );
        }
        if (part.type === "gitFile") {
          return <GitFileMentionChip key={idx} file={part.file} />;
        }
        if (part.type === "codeRef") {
          return <CodeRefMentionChip key={idx} reference={part.reference} />;
        }
        if (part.type === "pastedText") {
          return <PastedTextChip key={idx} reference={part.reference} file={part.file} />;
        }
        return <span key={idx}>{part.value}</span>;
      })}
    </>
  );
});
