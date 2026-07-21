// Reply-footer changed-files card: lists every file the assistant reply
// wrote/edited/deleted with per-file +N/-N stats, and wires the three
// file-reference actions (open editor / reveal in file tree / view diff).
// Rendered only after the reply settles (never mid-stream). Actions arrive
// through context so transcript row props stay memo-stable; without a
// provider (shared read-only views) the card renders as plain data.
import { createContext, memo, useContext, useMemo } from "react";
import { useLocale } from "../../i18n";
import type { ChangedFileEntry, ChangedFilesSummary } from "../../lib/chat/changedFiles";
import { cn } from "../../lib/shared/utils";
import { FilePenLine, FolderTree, GitCommitHorizontal } from "../icons";
import { FileChangeBadge } from "./FileChangeBadge";
import { getFileTypeIcon } from "./fileTypeIcons";

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

// 移动端（< md）隐藏行内两个动作按钮：opacity-0 的按钮在触屏上仍可被误触，
// 且没有 hover 可以显形；此时点按文件名默认用代码编辑器打开。
const ROW_ACTION_CLASS =
  "hidden h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-all hover:bg-foreground/[0.07] hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/changed-file:opacity-100 md:flex";

const ChangedFileRow = memo(function ChangedFileRow({ file }: { file: ChangedFileEntry }) {
  const { t } = useLocale();
  const actions = useChangedFilesActions();
  const { dir, base } = splitPath(file.path);
  const canOpen = Boolean(actions?.onOpenFile) && !file.deleted;
  const FileTypeIcon = getFileTypeIcon(file.path, "file");

  const pathLabel = (
    <span className="flex min-w-0 flex-1 items-baseline font-mono text-[calc(11.5px*var(--zone-font-scale,1))] leading-[1.6]">
      {dir ? <span className="truncate text-muted-foreground/70">{dir}</span> : null}
      <span
        className={cn(
          "shrink-0 text-foreground/90",
          file.deleted && "text-muted-foreground line-through",
        )}
      >
        {base}
      </span>
    </span>
  );

  return (
    <div className="group/changed-file flex min-w-0 items-center gap-1.5 rounded-lg px-2 py-1 transition-colors hover:bg-foreground/[0.04]">
      <FileTypeIcon
        className={cn("h-3.5 w-3.5 shrink-0", file.deleted && "opacity-50 saturate-0")}
      />
      {canOpen ? (
        <button
          type="button"
          onClick={() => actions?.onOpenFile?.(file.path)}
          title={t("chat.changedFiles.open")}
          className="flex min-w-0 flex-1 items-center text-left focus-visible:outline-none"
        >
          {pathLabel}
        </button>
      ) : (
        <span className="flex min-w-0 flex-1 items-center">{pathLabel}</span>
      )}
      {file.deleted ? (
        <span className="shrink-0 rounded-full bg-muted/70 px-1.5 py-0.5 text-[calc(10px*var(--zone-font-scale,1))] leading-none text-muted-foreground">
          {t("chat.changedFiles.deleted")}
        </span>
      ) : (
        <FileChangeBadge added={file.added} removed={file.removed} />
      )}
      {actions?.onRevealInFileTree ? (
        <button
          type="button"
          onClick={() => actions.onRevealInFileTree?.(file.path)}
          title={t("chat.changedFiles.reveal")}
          aria-label={t("chat.changedFiles.reveal")}
          className={ROW_ACTION_CLASS}
        >
          <FolderTree className="h-3.5 w-3.5" />
        </button>
      ) : null}
      {actions?.onOpenDiff ? (
        <button
          type="button"
          onClick={() => actions.onOpenDiff?.(file.path)}
          title={t("chat.changedFiles.diff")}
          aria-label={t("chat.changedFiles.diff")}
          className={ROW_ACTION_CLASS}
        >
          <GitCommitHorizontal className="h-3.5 w-3.5" />
        </button>
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
  const title = useMemo(() => {
    const key =
      summary.files.length === 1 ? "chat.changedFiles.titleOne" : "chat.changedFiles.title";
    return t(key).replace("{count}", String(summary.files.length));
  }, [summary.files.length, t]);

  return (
    <div className="changed-files-card overflow-hidden rounded-xl border border-border/45 bg-background/60 backdrop-blur-sm dark:border-white/[0.07] dark:bg-white/[0.03]">
      <div className="flex items-center gap-2.5 px-2.5 py-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/45 bg-background/75 text-foreground/70 shadow-[0_1px_0_rgba(255,255,255,0.5)_inset] dark:border-white/[0.08] dark:bg-white/[0.05] dark:shadow-[0_1px_0_rgba(255,255,255,0.05)_inset]">
          <FilePenLine className="h-4 w-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[calc(12px*var(--zone-font-scale,1))] font-medium leading-tight text-foreground/85">
            {title}
          </span>
          <FileChangeBadge added={summary.totalAdded} removed={summary.totalRemoved} />
        </div>
        {actions?.onOpenDiff ? (
          <button
            type="button"
            onClick={() => actions.onOpenDiff?.(null)}
            className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[calc(11px*var(--zone-font-scale,1))] font-medium leading-none text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:bg-foreground/[0.06] focus-visible:outline-none"
          >
            <GitCommitHorizontal className="h-3.5 w-3.5" />
            {t("chat.changedFiles.review")}
          </button>
        ) : null}
      </div>
      {/* 最多露出 5 行，更多文件走内部滚动条。 */}
      <div className="flex max-h-[calc(150px*var(--zone-font-scale,1))] flex-col gap-0.5 overflow-y-auto overscroll-contain border-t border-border/35 px-1 py-1 dark:border-white/[0.05]">
        {summary.files.map((file) => (
          <ChangedFileRow key={file.lastToolCallId || file.path} file={file} />
        ))}
      </div>
    </div>
  );
});
