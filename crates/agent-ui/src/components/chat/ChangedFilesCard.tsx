// Reply-footer changed-files card: lists every file the assistant reply
// wrote/edited/deleted with per-file +N/-N stats, and wires the three
// file-reference actions (open editor / reveal in file tree / view diff).
// Rendered only after the reply settles (never mid-stream). Actions arrive
// through context so transcript row props stay memo-stable; without a
// provider (shared read-only views) the card renders as plain data.

import { FileChangeBadge } from "@liveagent/ui/components/chat/FileChangeBadge";
import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  ChevronDown,
  FilePenLine,
  FolderTree,
  GitCommitHorizontal,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ChangedFileEntry, ChangedFilesSummary } from "@liveagent/ui/lib/chat/changedFiles";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { isSkillPath } from "@liveagent/ui/lib/skills/skillPaths";
import { createContext, memo, useContext, useMemo, useState } from "react";

export type ChangedFilesActions = {
  onOpenFile?: (path: string) => void;
  onRevealInFileTree?: (path: string) => void;
  /** null = open the review panel without focusing a specific file. */
  onOpenDiff?: (path: string | null) => void;
};

const ChangedFilesActionsContext = createContext<ChangedFilesActions | null>(null);

export const ChangedFilesActionsProvider = ChangedFilesActionsContext.Provider;

export function useChangedFilesActions(): ChangedFilesActions | null {
  return useContext(ChangedFilesActionsContext);
}

function splitPath(path: string): { dir: string; base: string } {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  if (index < 0) return { dir: "", base: normalized };
  return { dir: normalized.slice(0, index + 1), base: normalized.slice(index + 1) };
}

const ROW_ACTION_CLASS =
  "changed-file-row-action flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:bg-foreground/[0.08] focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
const MAX_VISIBLE_FILES = 5;

const ChangedFileRow = memo(function ChangedFileRow({ file }: { file: ChangedFileEntry }) {
  const { t } = useLocale();
  const actions = useChangedFilesActions();
  const { dir, base } = splitPath(file.path);
  // Skill files live outside the workspace, so the file tree and git review
  // cannot locate them; only the editor/preview action applies.
  const skillPath = isSkillPath(file.path);
  const canOpen = Boolean(actions?.onOpenFile) && !file.deleted;
  const canReveal = Boolean(actions?.onRevealInFileTree) && !skillPath;
  const canOpenDiff = Boolean(actions?.onOpenDiff) && !skillPath;
  const hasRowActions = canReveal || canOpenDiff;
  const FileTypeIcon = getFileTypeIcon(file.path, "file");
  const openLabel = `${t("chat.changedFiles.open")}: ${file.path}`;
  const revealLabel = `${t("chat.changedFiles.reveal")}: ${file.path}`;
  const diffLabel = `${t("chat.changedFiles.diff")}: ${file.path}`;

  const pathLabel = (
    <span title={file.path} className="flex min-w-0 flex-1 items-center overflow-hidden font-mono">
      <span
        className={cn(
          "min-w-0 truncate text-[calc(10.5px*var(--zone-font-scale,1))] leading-tight text-muted-foreground/65",
          file.deleted && "line-through",
        )}
      >
        {dir}
      </span>
      <span
        className={cn(
          "min-w-0 max-w-full truncate text-[calc(11.5px*var(--zone-font-scale,1))] font-medium leading-tight text-foreground/85",
          file.deleted && "text-muted-foreground line-through",
        )}
      >
        {base}
      </span>
    </span>
  );

  return (
    <div className="group/changed-file relative flex min-h-8 min-w-0 items-center gap-1.5 rounded-lg px-2.5 py-0.5 transition-colors hover:bg-foreground/[0.04]">
      <FileTypeIcon
        className={cn("h-3.5 w-3.5 shrink-0", file.deleted && "opacity-50 saturate-0")}
      />
      {canOpen ? (
        <button
          type="button"
          onClick={() => actions?.onOpenFile?.(file.path)}
          title={openLabel}
          aria-label={openLabel}
          className="flex min-w-0 flex-1 items-stretch text-left focus-visible:outline-none"
        >
          {pathLabel}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-stretch">{pathLabel}</span>
      )}
      {file.deleted ? (
        <span
          className={cn(
            "shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-[calc(10px*var(--zone-font-scale,1))] leading-none text-muted-foreground transition-opacity",
            hasRowActions &&
              "group-hover/changed-file:opacity-0 group-focus-within/changed-file:opacity-0",
          )}
        >
          {t("chat.changedFiles.deleted")}
        </span>
      ) : (
        <FileChangeBadge
          added={file.added}
          removed={file.removed}
          className={cn(
            "min-w-16 justify-end transition-opacity",
            hasRowActions &&
              "group-hover/changed-file:opacity-0 group-focus-within/changed-file:opacity-0",
          )}
        />
      )}
      {hasRowActions ? (
        <div className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/changed-file:pointer-events-auto group-hover/changed-file:opacity-100 group-focus-within/changed-file:pointer-events-auto group-focus-within/changed-file:opacity-100">
          {canReveal ? (
            <button
              type="button"
              onClick={() => actions?.onRevealInFileTree?.(file.path)}
              title={revealLabel}
              aria-label={revealLabel}
              className={ROW_ACTION_CLASS}
            >
              <FolderTree className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {canOpenDiff ? (
            <button
              type="button"
              onClick={() => actions?.onOpenDiff?.(file.path)}
              title={diffLabel}
              aria-label={diffLabel}
              className={ROW_ACTION_CLASS}
            >
              <GitCommitHorizontal className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export const ChangedFilesCard = memo(function ChangedFilesCard({
  summary,
}: {
  summary: ChangedFilesSummary;
}) {
  const { t } = useLocale();
  const actions = useChangedFilesActions();
  const [filesExpanded, setFilesExpanded] = useState(false);
  const title = useMemo(() => {
    const key =
      summary.files.length === 1 ? "chat.changedFiles.titleOne" : "chat.changedFiles.title";
    return t(key).replace("{count}", String(summary.files.length));
  }, [summary.files.length, t]);
  const canOpenReview =
    Boolean(actions?.onOpenDiff) && summary.files.some((file) => !isSkillPath(file.path));
  const hasCollapsedFiles = summary.files.length > MAX_VISIBLE_FILES;
  const visibleFiles =
    hasCollapsedFiles && !filesExpanded ? summary.files.slice(0, MAX_VISIBLE_FILES) : summary.files;
  const hiddenFileCount = summary.files.length - MAX_VISIBLE_FILES;

  return (
    <div className="changed-files-card overflow-hidden rounded-2xl border border-border/55 bg-background/55 backdrop-blur-sm dark:border-white/[0.09] dark:bg-white/[0.035]">
      <div className="flex items-center gap-3 px-3 py-2.5">
        <div className="flex w-8 min-h-8 shrink-0 items-center justify-center self-stretch rounded-xl border-0 bg-muted/60 text-foreground/70 shadow-none dark:bg-white/[0.07]">
          <FilePenLine className="h-4 w-4" />
        </div>
        <div className="flex min-h-8 min-w-0 flex-1 flex-col justify-center gap-0.5">
          <span className="truncate text-[calc(13px*var(--zone-font-scale,1))] font-semibold leading-tight text-foreground/90">
            {title}
          </span>
          <FileChangeBadge
            added={summary.totalAdded}
            removed={summary.totalRemoved}
            className="text-[calc(11.5px*var(--zone-font-scale,1))]"
          />
        </div>
        {canOpenReview ? (
          <button
            type="button"
            onClick={() => actions?.onOpenDiff?.(null)}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-border/55 bg-transparent px-2.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none text-muted-foreground transition-colors hover:border-border/80 hover:bg-foreground/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:border-white/[0.1] dark:hover:border-white/[0.16] dark:hover:bg-white/[0.06]"
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            {t("chat.changedFiles.review")}
          </button>
        ) : null}
      </div>
      {/* 超过 5 个文件时默认只展示前 5 个，点击后展开全部。 */}
      <div className="flex flex-col gap-0 border-t border-border/30 px-2 py-1 dark:border-white/[0.05]">
        {visibleFiles.map((file) => (
          <ChangedFileRow key={file.lastToolCallId || file.path} file={file} />
        ))}
      </div>
      {hasCollapsedFiles ? (
        <button
          type="button"
          onClick={() => setFilesExpanded((expanded) => !expanded)}
          aria-expanded={filesExpanded}
          className="flex w-full items-center gap-1 border-t border-border/20 py-2 pl-[calc(0.5rem+0.625rem)] pr-2.5 text-left text-[calc(11.5px*var(--zone-font-scale,1))] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring dark:border-white/[0.05]"
        >
          <span className="truncate">
            {filesExpanded
              ? t("chat.changedFiles.collapse")
              : t("chat.changedFiles.expand").replace("{count}", String(hiddenFileCount))}
          </span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-3.5 w-3.5 shrink-0 transition-transform",
              filesExpanded && "rotate-180",
            )}
          />
        </button>
      ) : null}
    </div>
  );
});
