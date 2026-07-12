// Context menu for the right-dock file tree panel.
//
// MIRROR NOTICE: every file under components/project-tools/file-tree/ exists
// byte-for-byte in both frontends (crates/agent-gui/src and
// crates/agent-gateway/web/src). Keep changes in sync on both ends; only
// relative, npm-package, or @tauri-apps/* imports are allowed here.
// Desktop-only entries are gated at runtime via FILE_TREE_HAS_OS_INTEGRATION.

import {
  type MouseEvent as ReactMouseEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useLocale } from "../../../i18n";
import {
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  FilePenLine,
  Folder,
  FolderOpen,
  Plus,
  RefreshCw,
  Trash2,
} from "../../icons";
import {
  isWorkspaceEditablePreviewPath,
  isWorkspacePreviewPath,
} from "../../workspace-editor/workspaceImagePreview";
import { FILE_TREE_HAS_OS_INTEGRATION, type FileTreeKind } from "./model";

const COPY_FEEDBACK_MS = 1200;

const MENU_ITEM_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-45";

const MENU_ITEM_DESTRUCTIVE_CLASS =
  "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-destructive transition-colors hover:bg-destructive/10 disabled:pointer-events-none disabled:opacity-45";

// Legacy fallback for environments where the async clipboard API is missing
// or rejects (insecure context, denied permission).
function fallbackCopyToClipboard(text: string): boolean {
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

export type FileTreeContextMenuProps = {
  // Anchor relative to the panel (containerRef) coordinate space.
  anchor: { x: number; y: number };
  containerRef: RefObject<HTMLDivElement | null>;
  path: string;
  kind: FileTreeKind;
  canMutate: boolean;
  canOpenFile: boolean;
  canInsertMention: boolean;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenExternal: (path: string) => void;
  onOpenContainingDirectory: (path: string) => void;
  onStartAction: (action: "file" | "folder" | "rename", path: string) => void;
  onDelete: (path: string) => void;
  onInsertMention: (path: string) => void;
  onRefresh: (path: string, kind: FileTreeKind) => void;
  onActionError: (message: string) => void;
};

export function FileTreeContextMenu(props: FileTreeContextMenuProps) {
  const {
    anchor,
    containerRef,
    path,
    kind,
    canMutate,
    canOpenFile,
    canInsertMention,
    onClose,
    onOpenFile,
    onOpenExternal,
    onOpenContainingDirectory,
    onStartAction,
    onDelete,
    onInsertMention,
    onRefresh,
    onActionError,
  } = props;
  const { t } = useLocale();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  const hasPathAction = Boolean(path);

  // Measured clamp: the menu is positioned from its rendered size instead of
  // the old hardcoded per-kind height tables, which drifted between the two
  // frontends whenever entries were added or removed. The panel remounts this
  // component per open (keyed on the anchor), so measuring once is enough.
  useLayoutEffect(() => {
    if (position) return;
    const menu = menuRef.current;
    if (!menu) return;
    const menuRect = menu.getBoundingClientRect();
    const bounds = containerRef.current?.getBoundingClientRect();
    const width = bounds?.width ?? window.innerWidth;
    const height = bounds?.height ?? window.innerHeight;
    const maxX = Math.max(8, width - menuRect.width - 8);
    const maxY = Math.max(8, height - menuRect.height - 8);
    setPosition({
      x: Math.max(8, Math.min(anchor.x, maxX)),
      y: Math.max(8, Math.min(anchor.y, maxY)),
    });
  }, [anchor.x, anchor.y, containerRef, position]);

  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(
    async (event: ReactMouseEvent) => {
      // Keep the menu open so the "copied" feedback is actually visible (the
      // global click listener would close it otherwise).
      event.stopPropagation();
      if (!path) return;
      let copiedOk = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(path);
          copiedOk = true;
        }
      } catch {
        copiedOk = false;
      }
      if (!copiedOk) copiedOk = fallbackCopyToClipboard(path);
      if (!copiedOk) {
        onActionError(t("projectTools.fileTree.copyFailed"));
        onClose();
        return;
      }
      setCopied(true);
      // The pending reset is always cancelled before a new one is armed so
      // rapid copies cannot leave a stale timer clearing fresh feedback.
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copyTimerRef.current = null;
      }, COPY_FEEDBACK_MS);
    },
    [onActionError, onClose, path, t],
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      className="editor-context-menu absolute z-[80] min-w-52 select-none overflow-hidden rounded-xl border border-border/60 bg-popover/80 p-1 text-xs text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]"
      style={{
        left: (position ?? anchor).x,
        top: (position ?? anchor).y,
        visibility: position ? undefined : "hidden",
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      {kind === "file" ? (
        <>
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM_CLASS}
            disabled={!canOpenFile}
            onClick={() => {
              onOpenFile(path);
              onClose();
            }}
          >
            {isWorkspacePreviewPath(path) ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <FilePenLine className="h-3.5 w-3.5" />
            )}
            {t(
              isWorkspacePreviewPath(path)
                ? "projectTools.fileTree.previewFile"
                : "projectTools.fileTree.openFile",
            )}
          </button>
          {FILE_TREE_HAS_OS_INTEGRATION && !isWorkspaceEditablePreviewPath(path) ? (
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM_CLASS}
              disabled={!hasPathAction}
              onClick={() => {
                onOpenExternal(path);
                onClose();
              }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t("projectTools.fileTree.openExternal")}
            </button>
          ) : null}
          <div className="mx-1 my-1 h-px bg-border/60" />
        </>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        disabled={!canMutate}
        onClick={() => {
          onStartAction("file", path);
          onClose();
        }}
      >
        <Plus className="h-3.5 w-3.5" />
        {t("projectTools.fileTree.newFile")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        disabled={!canMutate}
        onClick={() => {
          onStartAction("folder", path);
          onClose();
        }}
      >
        <Folder className="h-3.5 w-3.5" />
        {t("projectTools.fileTree.newFolder")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        disabled={!canMutate || !hasPathAction}
        onClick={() => {
          onStartAction("rename", path);
          onClose();
        }}
      >
        <Edit3 className="h-3.5 w-3.5" />
        {t("projectTools.fileTree.rename")}
      </button>
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_DESTRUCTIVE_CLASS}
        disabled={!canMutate || !hasPathAction}
        onClick={() => {
          onDelete(path);
          onClose();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {t("projectTools.fileTree.delete")}
      </button>
      <div className="mx-1 my-1 h-px bg-border/60" />
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        disabled={!hasPathAction}
        onClick={(event) => void handleCopy(event)}
      >
        <Copy className="h-3.5 w-3.5" />
        {copied ? t("projectTools.fileTree.copiedPath") : t("projectTools.fileTree.copyPath")}
      </button>
      {FILE_TREE_HAS_OS_INTEGRATION ? (
        <button
          type="button"
          role="menuitem"
          className={MENU_ITEM_CLASS}
          disabled={!hasPathAction}
          onClick={() => {
            onOpenContainingDirectory(path);
            onClose();
          }}
        >
          <FolderOpen className="h-3.5 w-3.5" />
          {t("projectTools.fileTree.openContainingDirectory")}
        </button>
      ) : null}
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        disabled={!hasPathAction || !canInsertMention}
        onClick={() => {
          onInsertMention(path);
          onClose();
        }}
      >
        <span className="flex h-3.5 w-3.5 items-center justify-center text-[calc(11px*var(--zone-font-scale,1))] font-semibold">
          @
        </span>
        {t("projectTools.fileTree.insertReference")}
      </button>
      <div className="mx-1 my-1 h-px bg-border/60" />
      <button
        type="button"
        role="menuitem"
        className={MENU_ITEM_CLASS}
        onClick={() => {
          onRefresh(path, kind);
          onClose();
        }}
      >
        <RefreshCw className="h-3.5 w-3.5" />
        {t("projectTools.fileTree.refresh")}
      </button>
    </div>
  );
}
