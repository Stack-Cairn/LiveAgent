// Memoized virtual-list rows for the right-dock file tree panel.
//
// MIRROR NOTICE: every file under components/project-tools/file-tree/ exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative, npm-package, or @tauri-apps/* imports are allowed here.

import { memo, type MouseEvent as ReactMouseEvent } from "react";
import { useLocale } from "../../../i18n";
import { cn } from "../../../lib/shared/utils";
import { getFileTypeIcon } from "../../chat/fileTypeIcons";
import { ChevronRight, Loader2 } from "../../icons";
import { FILE_TREE_ROW_HEIGHT, type FileTreeKind } from "./model";

export type FileTreeRowProps = {
  path: string;
  name: string;
  kind: FileTreeKind;
  depth: number;
  expanded: boolean;
  selected: boolean;
  loading: boolean;
  title: string;
  // All callbacks are identity-stable in the panel so memoization holds and
  // an unchanged row never re-renders.
  onToggle: (path: string, expanded: boolean) => void;
  onSelect: (path: string) => void;
  onOpen: (path: string) => void;
  onContextMenu: (event: ReactMouseEvent, path: string) => void;
};

export const FileTreeRow = memo(function FileTreeRow(props: FileTreeRowProps) {
  const {
    path,
    name,
    kind,
    depth,
    expanded,
    selected,
    loading,
    title,
    onToggle,
    onSelect,
    onOpen,
    onContextMenu,
  } = props;
  const { t } = useLocale();
  const TypeIcon = getFileTypeIcon(path, kind, { expanded });
  return (
    <div
      role="treeitem"
      aria-selected={selected}
      aria-expanded={kind === "dir" ? expanded : undefined}
      tabIndex={-1}
      className={cn(
        "group flex select-none items-center gap-1 rounded-md pr-2 text-xs leading-5 text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        selected && "bg-muted text-foreground",
      )}
      style={{ height: FILE_TREE_ROW_HEIGHT, paddingLeft: 6 + depth * 14 }}
      onContextMenu={(event) => onContextMenu(event, path)}
    >
      {kind === "dir" ? (
        <button
          type="button"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-background"
          onClick={() => onToggle(path, expanded)}
          title={expanded ? t("projectTools.fileTree.collapse") : t("projectTools.fileTree.expand")}
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ChevronRight
              className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-90")}
            />
          )}
        </button>
      ) : (
        <span className="h-5 w-5 shrink-0" />
      )}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5 bg-transparent p-0 text-left text-inherit leading-5"
        title={title}
        onClick={() => onSelect(path)}
        onDoubleClick={() => {
          if (kind === "dir") {
            onToggle(path, expanded);
            return;
          }
          onOpen(path);
        }}
      >
        <TypeIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="min-w-0 truncate">{name}</span>
      </button>
    </div>
  );
});

export type FileTreeErrorRowProps = {
  depth: number;
  message: string;
};

// Per-directory error/notice line rendered as its own (measured) virtual row.
export const FileTreeErrorRow = memo(function FileTreeErrorRow(props: FileTreeErrorRowProps) {
  const { depth, message } = props;
  return (
    <div
      className="break-all px-3 py-1 text-[calc(11px*var(--zone-font-scale,1))] text-amber-600"
      style={{ paddingLeft: 12 + depth * 14 }}
    >
      {message}
    </div>
  );
});
