import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useLocale } from "@/i18n";
import type { SftpClient, SftpEntry, SftpSide, SftpTransfer } from "@/lib/sftp/types";
import { cn } from "@/lib/shared/utils";
import type { TerminalSession } from "@/lib/terminal/types";
import { getFileTypeIcon } from "../chat/fileTypeIcons";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Copy,
  Download,
  FolderTree,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
} from "../icons";
import { useConfirmDialog } from "../ui/confirm-dialog";

type WorkspaceSftpPanelProps = {
  session: TerminalSession;
  client: SftpClient;
  isActive: boolean;
  onError?: (error: string | null) => void;
};

type PaneState = {
  path: string;
  entries: SftpEntry[];
  loading: boolean;
  error: string | null;
  selectedPaths: string[];
};

type ContextMenuState = {
  x: number;
  y: number;
  side: SftpSide;
  path: string;
  kind: string;
  isEntry: boolean;
  items: DragPayloadItem[];
};

type DragPayloadItem = {
  path: string;
  kind: string;
};

type DragPayload = DragPayloadItem & {
  side: SftpSide;
  items?: DragPayloadItem[];
};

type DragPreviewState = {
  source: DragPayload;
  x: number;
  y: number;
};

type PointerDragState = {
  pointerId: number;
  source: DragPayload;
  startX: number;
  startY: number;
  active: boolean;
};

type CreateFolderDialogState = {
  side: SftpSide;
  basePath: string;
};

type RenameEntryDialogState = {
  side: SftpSide;
  path: string;
  currentName: string;
};

const SFTP_DRAG_MIME = "application/x-liveagent-sftp";
const SFTP_DRAG_TEXT_PREFIX = "liveagent-sftp:";
const INITIAL_LOCAL_PATH = "";
const INITIAL_REMOTE_PATH = ".";
const TERMINAL_TRANSFER_STATUSES = new Set(["completed", "failed", "cancelled"]);
const POINTER_DRAG_THRESHOLD_PX = 6;
const FILE_ICON_CLASS = "h-4 w-4 shrink-0";
const FOLDER_ICON_CLASS = "h-4 w-4 shrink-0";
const REMOTE_PATH_SUGGESTION_LIMIT = 8;
const REMOTE_PATH_SUGGESTION_DELAY_MS = 180;

function initialPane(path: string): PaneState {
  return {
    path,
    entries: [],
    loading: false,
    error: null,
    selectedPaths: [],
  };
}

function parentPath(path: string, side: SftpSide) {
  const normalized = normalizePath(path, side);
  if (!normalized || normalized === "." || normalized === "/") return side === "remote" ? "." : "";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  if (side === "remote" && normalized.startsWith("/")) {
    return parts.length ? `/${parts.join("/")}` : "/";
  }
  return parts.join("/") || (side === "remote" ? "." : "");
}

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? normalized;
}

function normalizePath(path: string, side: SftpSide) {
  const normalized = path.trim().replace(/\\/g, "/");
  if (side === "remote") {
    if (!normalized || normalized === ".") return ".";
    return normalized.replace(/\/+/g, "/");
  }
  return normalized.replace(/^\/+/, "").replace(/\/+/g, "/");
}

function isAbsoluteLocalPath(path: string) {
  const value = path.trim();
  return (
    value.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\/.test(value) ||
    /^\/\/[^/\\]+[\\/][^/\\]+/.test(value)
  );
}

function localPathSeparator(root: string) {
  return root.includes("\\") && !root.includes("/") ? "\\" : "/";
}

function localAbsolutePathForCopy(workdir: string, path: string) {
  const rawPath = path.trim();
  if (isAbsoluteLocalPath(rawPath)) return rawPath;

  const base = workdir.trim();
  const relativePath = normalizePath(rawPath, "local");
  if (!relativePath || relativePath === ".") return base;

  const separator = localPathSeparator(base);
  const normalizedRelativePath = relativePath.replace(/\//g, separator);
  const trimmedBase = base.replace(/[\\/]+$/, "");
  if (!trimmedBase) return `${separator}${normalizedRelativePath}`;

  return `${trimmedBase}${separator}${normalizedRelativePath}`;
}

function remoteAbsolutePathForCopy(path: string) {
  const normalized = normalizePath(path, "remote");
  if (!normalized || normalized === ".") return "/";
  if (normalized.startsWith("/")) return normalized;
  return `/${normalized.replace(/^\/+/, "")}`;
}

function absolutePathForCopy(side: SftpSide, path: string, workdir: string) {
  return side === "local"
    ? localAbsolutePathForCopy(workdir, path)
    : remoteAbsolutePathForCopy(path);
}

function joinPath(parent: string, child: string, side: SftpSide) {
  const name = child
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!name) return normalizePath(parent, side);
  const base = normalizePath(parent, side);
  if (side === "remote") {
    if (base === "/") return `/${name}`;
    if (!base || base === ".") return name;
  }
  if (!base) return name;
  return `${base.replace(/\/+$/, "")}/${name}`;
}

function pathCrumbs(path: string, side: SftpSide, projectLabel: string) {
  const normalized = normalizePath(path, side);
  const root = side === "remote" ? (normalized.startsWith("/") ? "/" : ".") : "";
  const parts =
    normalized === "." || normalized === "/" ? [] : normalized.split("/").filter(Boolean);
  const crumbs = [{ label: side === "remote" ? root : projectLabel, path: root }];
  let current = root;
  for (const part of parts) {
    current = joinPath(current, part, side);
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function pathSuggestionTarget(value: string, currentPath: string, side: SftpSide) {
  const rawValue = value.trim().replace(/\\/g, "/");
  const normalizedValue = normalizePath(rawValue, side);
  if (normalizedValue === normalizePath(currentPath, side)) {
    return { directoryPath: normalizedValue, prefix: "" };
  }
  if (!rawValue || rawValue === "." || rawValue === "/" || rawValue.endsWith("/")) {
    return { directoryPath: normalizedValue, prefix: "" };
  }
  return {
    directoryPath: parentPath(normalizedValue, side),
    prefix: basename(normalizedValue),
  };
}

function PathCrumbRow(props: {
  crumbs: { label: string; path: string }[];
  fallbackLabel?: string;
  onNavigate: (path: string) => void;
}) {
  const { crumbs, fallbackLabel, onNavigate } = props;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element && crumbs.length) element.scrollLeft = element.scrollWidth;
  }, [crumbs]);

  return (
    <div ref={scrollRef} className="sftp-path-scroll flex min-w-0 items-center overflow-x-auto">
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <Fragment key={`${crumb.path}-${index}`}>
            {index > 0 ? (
              <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/40" />
            ) : null}
            <button
              type="button"
              className={cn(
                "shrink-0 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-foreground/[0.05]",
                isLast
                  ? "font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              title={crumb.path || crumb.label}
              onClick={() => onNavigate(crumb.path)}
            >
              {crumb.label || fallbackLabel || crumb.path}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function PathNavigator(props: {
  side: SftpSide;
  path: string;
  loading: boolean;
  client: SftpClient;
  sessionId: string;
  projectPathKey: string;
  workdir: string;
  rootLabel: string;
  onNavigate: (path: string) => void;
  t: (key: string) => string;
}) {
  const {
    side,
    path,
    loading,
    client,
    sessionId,
    projectPathKey,
    workdir,
    rootLabel,
    onNavigate,
    t,
  } = props;
  const listboxId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const requestIdRef = useRef(0);
  const suggestionRefs = useRef(new Map<number, HTMLButtonElement>());
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<SftpEntry[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(-1);

  const crumbs = useMemo(
    () =>
      pathCrumbs(path, side, rootLabel).map((crumb, index) =>
        side === "remote" && index === 0 && crumb.label === "." ? { ...crumb, label: "~" } : crumb,
      ),
    [path, rootLabel, side],
  );

  useEffect(() => {
    if (!open) {
      setValue(path);
    }
  }, [open, path]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, [editing]);

  useEffect(() => {
    if (!open) return;
    const requestId = ++requestIdRef.current;
    const { directoryPath, prefix } = pathSuggestionTarget(value, path, side);
    setSuggestions([]);
    setSuggestionsLoading(true);
    setSuggestionError(null);
    setActiveIndex(-1);

    const timer = window.setTimeout(() => {
      void client
        .list({
          sessionId,
          projectPathKey,
          workdir,
          side,
          path: directoryPath,
        })
        .then((response) => {
          if (requestIdRef.current !== requestId) return;
          const normalizedPrefix = prefix.toLocaleLowerCase();
          const directories = response.entries
            .filter(
              (entry) =>
                entry.kind === "directory" &&
                (!normalizedPrefix || entry.name.toLocaleLowerCase().startsWith(normalizedPrefix)),
            )
            .sort((left, right) => left.name.localeCompare(right.name))
            .slice(0, REMOTE_PATH_SUGGESTION_LIMIT);
          setSuggestions(directories);
          setSuggestionsLoading(false);
          setActiveIndex(-1);
        })
        .catch((error) => {
          if (requestIdRef.current !== requestId) return;
          setSuggestions([]);
          setSuggestionsLoading(false);
          setSuggestionError(error instanceof Error ? error.message : String(error));
          setActiveIndex(-1);
        });
    }, REMOTE_PATH_SUGGESTION_DELAY_MS);

    return () => {
      window.clearTimeout(timer);
      if (requestIdRef.current === requestId) {
        requestIdRef.current += 1;
      }
    };
  }, [client, open, path, projectPathKey, sessionId, side, value, workdir]);

  useEffect(() => {
    if (activeIndex < 0) return;
    suggestionRefs.current.get(activeIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const beginEdit = () => {
    setValue(path);
    setEditing(true);
    setOpen(true);
  };

  const closeEditor = () => {
    setOpen(false);
    setEditing(false);
    setValue(path);
  };

  const navigate = (nextPath: string) => {
    const normalizedPath = normalizePath(nextPath, side);
    setValue(normalizedPath);
    setOpen(false);
    setEditing(false);
    inputRef.current?.blur();
    onNavigate(normalizedPath);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        suggestions.length ? (current + 1 + suggestions.length) % suggestions.length : -1,
      );
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((current) =>
        suggestions.length
          ? current < 0
            ? suggestions.length - 1
            : (current - 1 + suggestions.length) % suggestions.length
          : -1,
      );
      return;
    }
    if (event.key === "Tab" && open && activeIndex >= 0) {
      event.preventDefault();
      setValue(suggestions[activeIndex]?.path ?? value);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      navigate(open && activeIndex >= 0 ? (suggestions[activeIndex]?.path ?? value) : value);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      inputRef.current?.blur();
      closeEditor();
    }
  };

  return (
    <div
      role="group"
      aria-label={t("workspaceSftp.pathSuggestions")}
      className="relative z-30 flex h-10 shrink-0 items-center border-b border-border/60 bg-muted/15 px-2"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        closeEditor();
      }}
    >
      {editing ? (
        <div className="group relative flex h-8 min-w-0 flex-1 items-center rounded-lg border border-border/60 bg-background/85 shadow-sm transition-all focus-within:border-primary/40 focus-within:bg-background focus-within:ring-[3px] focus-within:ring-primary/10">
          <FolderTree className="pointer-events-none absolute left-2.5 h-4 w-4 text-muted-foreground/70 transition-colors group-focus-within:text-primary" />
          <input
            ref={inputRef}
            value={value}
            type="text"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listboxId}
            aria-activedescendant={
              open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined
            }
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            className="h-full min-w-0 flex-1 bg-transparent pl-8 pr-11 font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground/60"
            placeholder={t(
              side === "remote"
                ? "workspaceSftp.pathPlaceholder"
                : "workspaceSftp.pathPlaceholderLocal",
            )}
            onFocus={() => setOpen(true)}
            onChange={(event) => {
              setValue(event.target.value);
              setOpen(true);
            }}
            onKeyDown={handleKeyDown}
          />
          <span className="pointer-events-none absolute right-2 flex items-center gap-1 text-[10px] text-muted-foreground/70">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" /> : null}
            <kbd className="rounded-[5px] border border-border/70 bg-background/80 px-1 py-0.5 font-sans text-muted-foreground/80">
              ↵
            </kbd>
          </span>
        </div>
      ) : (
        <div className="flex h-8 min-w-0 flex-1 items-center rounded-lg px-0.5">
          <PathCrumbRow crumbs={crumbs} onNavigate={navigate} />
          <button
            type="button"
            className="h-full min-w-4 flex-1 cursor-text"
            aria-label={t("workspaceSftp.pathEdit")}
            onMouseDown={(event) => event.preventDefault()}
            onClick={beginEdit}
          />
          {loading ? (
            <Loader2 className="mx-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground/70" />
          ) : null}
        </div>
      )}

      {editing && open ? (
        <div
          id={listboxId}
          role="listbox"
          className="sftp-path-popover-enter absolute inset-x-2 top-full z-50 mt-1.5 overflow-hidden rounded-xl border border-border/50 bg-popover/85 shadow-[0_18px_44px_-14px_rgba(0,0,0,0.28),0_2px_10px_rgba(0,0,0,0.06)] ring-1 ring-black/[0.03] backdrop-blur-2xl dark:ring-white/[0.06]"
        >
          <div className="max-h-64 overflow-y-auto p-1">
            {suggestionError ? (
              <div
                className="flex items-center gap-2 rounded-lg px-2.5 py-3 text-xs text-destructive"
                title={suggestionError}
              >
                <AlertTriangle className="h-4 w-4 shrink-0" />
                <span className="truncate">{t("workspaceSftp.pathSearchFailed")}</span>
              </div>
            ) : suggestionsLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("workspaceSftp.pathSearching")}
              </div>
            ) : suggestions.length ? (
              suggestions.map((entry, index) => {
                const DirectoryIcon = getFileTypeIcon(entry.name || entry.path, "dir", {
                  expanded: true,
                });
                return (
                  <button
                    key={entry.path}
                    ref={(element) => {
                      if (element) suggestionRefs.current.set(index, element);
                      else suggestionRefs.current.delete(index);
                    }}
                    id={`${listboxId}-option-${index}`}
                    type="button"
                    role="option"
                    aria-selected={activeIndex === index}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors",
                      activeIndex === index
                        ? "bg-primary/[0.08] text-foreground"
                        : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground",
                    )}
                    title={entry.path}
                    onMouseEnter={() => setActiveIndex(index)}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => navigate(entry.path)}
                  >
                    <span
                      className={cn(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors",
                        activeIndex === index
                          ? "bg-primary/10 text-primary"
                          : "bg-foreground/[0.04] text-muted-foreground",
                      )}
                    >
                      <DirectoryIcon className="h-4 w-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {entry.name}
                      </span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground/80">
                        {entry.path}
                      </span>
                    </span>
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 shrink-0 transition-opacity",
                        activeIndex === index ? "opacity-60" : "opacity-30",
                      )}
                    />
                  </button>
                );
              })
            ) : (
              <div className="px-3 py-5 text-center text-xs text-muted-foreground">
                {t("workspaceSftp.pathNoMatches")}
              </div>
            )}
          </div>

          <div className="border-t border-border/50 bg-muted/25 px-3 py-1.5 text-[10px] text-muted-foreground/80">
            {t("workspaceSftp.pathKeyboardHint")}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 || unit === 0 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

function entryTypeLabel(entry: SftpEntry, t: (key: string) => string) {
  if (entry.kind === "directory") return t("workspaceSftp.entry.folder");
  const extension = basename(entry.name).split(".").pop();
  if (extension && extension !== entry.name) return extension;
  if (entry.kind === "file" || !entry.kind) return t("workspaceSftp.entry.file");
  return entry.kind;
}

function entryIcon(entry: SftpEntry, className?: string) {
  if (entry.kind === "directory") {
    const FolderIcon = getFileTypeIcon(entry.name || entry.path, "dir");
    return <FolderIcon className={className ?? FOLDER_ICON_CLASS} />;
  }
  const FileIcon = getFileTypeIcon(entry.name || entry.path, "file");
  return <FileIcon className={className ?? FILE_ICON_CLASS} />;
}

function transferProgress(transfer: SftpTransfer | null) {
  if (!transfer) return 0;
  if (transfer.status === "completed") return 100;
  if (transfer.bytesTotal > 0) {
    return Math.min(100, Math.max(0, Math.round((transfer.bytesDone / transfer.bytesTotal) * 100)));
  }
  if (transfer.filesTotal > 0) {
    return Math.min(100, Math.max(0, Math.round((transfer.filesDone / transfer.filesTotal) * 100)));
  }
  return transfer.status === "running" ? 8 : 0;
}

function transferTone(transfer: SftpTransfer | null) {
  if (!transfer) return "bg-muted-foreground";
  if (transfer.status === "completed") return "bg-emerald-500";
  if (transfer.status === "failed") return "bg-destructive";
  if (transfer.status === "cancelled") return "bg-muted-foreground";
  return "bg-sky-500";
}

function isSftpSide(value: unknown): value is SftpSide {
  return value === "local" || value === "remote";
}

function isDragPayloadItem(value: unknown): value is DragPayloadItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<DragPayloadItem>;
  return typeof item.path === "string" && typeof item.kind === "string";
}

function isDragPayload(value: unknown): value is DragPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Partial<DragPayload>;
  return (
    isSftpSide(payload.side) &&
    typeof payload.path === "string" &&
    typeof payload.kind === "string" &&
    (payload.items === undefined ||
      (Array.isArray(payload.items) && payload.items.every(isDragPayloadItem)))
  );
}

function dragItems(payload: DragPayload): DragPayloadItem[] {
  return payload.items?.length ? payload.items : [{ path: payload.path, kind: payload.kind }];
}

function encodeDragPayload(payload: DragPayload) {
  return JSON.stringify(payload);
}

function writeDragPayload(dataTransfer: DataTransfer, payload: DragPayload) {
  const encoded = encodeDragPayload(payload);
  dataTransfer.setData(SFTP_DRAG_MIME, encoded);
  dataTransfer.setData("text/plain", `${SFTP_DRAG_TEXT_PREFIX}${encoded}`);
  dataTransfer.effectAllowed = "copy";
}

function readDragPayload(dataTransfer: DataTransfer): DragPayload | null {
  const custom = dataTransfer.getData(SFTP_DRAG_MIME);
  const text = dataTransfer.getData("text/plain");
  const raw =
    custom ||
    (text.startsWith(SFTP_DRAG_TEXT_PREFIX) ? text.slice(SFTP_DRAG_TEXT_PREFIX.length) : "");
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as unknown;
    return isDragPayload(payload) ? payload : null;
  } catch {
    return null;
  }
}

function isLeavingCurrentTarget(event: React.DragEvent) {
  const related = event.relatedTarget;
  return !related || !(related instanceof Node) || !event.currentTarget.contains(related);
}

const MOBILE_SFTP_MEDIA_QUERY = "(max-width: 820px)";

function isMobileSftpLayout() {
  if (typeof window === "undefined") {
    return false;
  }
  return window.matchMedia(MOBILE_SFTP_MEDIA_QUERY).matches;
}

export function WorkspaceSftpPanel(props: WorkspaceSftpPanelProps) {
  const { session, client, isActive, onError } = props;
  const { t } = useLocale();
  const { confirm, dialog } = useConfirmDialog();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const transferChainRef = useRef<Promise<void>>(Promise.resolve());
  const transferWaitersRef = useRef(new Map<string, (transfer: SftpTransfer | null) => void>());
  const terminalTransfersRef = useRef(new Map<string, SftpTransfer>());
  const pendingTransferStartsRef = useRef(0);
  const activeTransferIdsRef = useRef(new Set<string>());
  const nativeDragPayloadRef = useRef<DragPayload | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextContextMenuRef = useRef(false);
  const copyToastTimerRef = useRef<number | null>(null);
  const panePathRef = useRef({ local: INITIAL_LOCAL_PATH, remote: INITIAL_REMOTE_PATH });
  const [localPane, setLocalPane] = useState<PaneState>(() => initialPane(INITIAL_LOCAL_PATH));
  const [remotePane, setRemotePane] = useState<PaneState>(() => initialPane(INITIAL_REMOTE_PATH));
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<{ side: SftpSide; path: string } | null>(null);
  const [activeDragSource, setActiveDragSource] = useState<DragPayload | null>(null);
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [transfer, setTransfer] = useState<SftpTransfer | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [busyMessage, setBusyMessage] = useState("");
  const [createFolderDialog, setCreateFolderDialog] = useState<CreateFolderDialogState | null>(
    null,
  );
  const [createFolderName, setCreateFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [renameEntryDialog, setRenameEntryDialog] = useState<RenameEntryDialogState | null>(null);
  const [renameEntryName, setRenameEntryName] = useState("");
  const [renamingEntry, setRenamingEntry] = useState(false);
  const [copyPathDialog, setCopyPathDialog] = useState<string | null>(null);
  const [copyToastVisible, setCopyToastVisible] = useState(false);
  const [isMobileLayout, setIsMobileLayout] = useState(isMobileSftpLayout);
  const [mobilePane, setMobilePane] = useState<SftpSide>("remote");

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const mediaQueryList = window.matchMedia(MOBILE_SFTP_MEDIA_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobileLayout(event.matches);
    };
    setIsMobileLayout(mediaQueryList.matches);
    mediaQueryList.addEventListener("change", handleChange);
    return () => {
      mediaQueryList.removeEventListener("change", handleChange);
    };
  }, []);

  const workdir = session.cwd;
  const projectPathKey = session.projectPathKey || session.cwd;
  const connected = session.running && (session.ssh?.status ?? "connected") === "connected";

  const syncQueueCount = useCallback(() => {
    setQueueCount(pendingTransferStartsRef.current + activeTransferIdsRef.current.size);
  }, []);

  useEffect(() => {
    panePathRef.current = {
      local: localPane.path,
      remote: remotePane.path,
    };
  }, [localPane.path, remotePane.path]);

  const findEntry = useCallback(
    (source: DragPayload | null) => {
      if (!source) return null;
      const entries = source.side === "local" ? localPane.entries : remotePane.entries;
      return entries.find((entry) => entry.path === source.path) ?? null;
    },
    [localPane.entries, remotePane.entries],
  );

  const loadPane = useCallback(
    async (side: SftpSide, path: string) => {
      const normalizedPath = normalizePath(path, side);
      const setPane = side === "local" ? setLocalPane : setRemotePane;
      setPane((current) => ({ ...current, path: normalizedPath, loading: true, error: null }));
      try {
        const response = await client.list({
          sessionId: session.id,
          projectPathKey,
          workdir,
          side,
          path: normalizedPath,
        });
        setPane((current) => ({
          ...current,
          path: response.path,
          entries: response.entries,
          loading: false,
          error: null,
          selectedPaths: current.selectedPaths.filter((path) =>
            response.entries.some((entry) => entry.path === path),
          ),
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPane((current) => ({ ...current, loading: false, error: message }));
        onError?.(message);
      }
    },
    [client, onError, projectPathKey, session.id, workdir],
  );

  useEffect(() => {
    if (!isActive) return;
    void loadPane("local", localPane.path || INITIAL_LOCAL_PATH);
    void loadPane("remote", remotePane.path || INITIAL_REMOTE_PATH);
    // Initial active load only; explicit path changes call loadPane directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, session.id]);

  useEffect(() => {
    return () => {
      for (const resolve of transferWaitersRef.current.values()) {
        resolve(null);
      }
      transferWaitersRef.current.clear();
      terminalTransfersRef.current.clear();
      pendingTransferStartsRef.current = 0;
      activeTransferIdsRef.current.clear();
      if (copyToastTimerRef.current !== null) {
        window.clearTimeout(copyToastTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  useEffect(() => {
    return client.subscribeTransfers((event) => {
      if (event.transfer.sessionId !== session.id) return;
      setTransfer(event.transfer);
      if (TERMINAL_TRANSFER_STATUSES.has(event.transfer.status)) {
        terminalTransfersRef.current.set(event.transfer.id, event.transfer);
        const resolve = transferWaitersRef.current.get(event.transfer.id);
        if (resolve) {
          transferWaitersRef.current.delete(event.transfer.id);
          terminalTransfersRef.current.delete(event.transfer.id);
          resolve(event.transfer);
        }
        if (event.transfer.id) {
          activeTransferIdsRef.current.delete(event.transfer.id);
          syncQueueCount();
        }
      }
      if (event.transfer.status === "completed") {
        const targetSide: SftpSide = event.transfer.direction === "upload" ? "remote" : "local";
        void loadPane(targetSide, panePathRef.current[targetSide]);
      }
    });
  }, [client, loadPane, session.id, syncQueueCount]);

  const waitForTransferDone = useCallback((transferId: string) => {
    const terminalTransfer = terminalTransfersRef.current.get(transferId);
    if (terminalTransfer) {
      terminalTransfersRef.current.delete(transferId);
      return Promise.resolve(terminalTransfer);
    }
    return new Promise<SftpTransfer | null>((resolve) => {
      transferWaitersRef.current.set(transferId, resolve);
    });
  }, []);

  const paneForSide = (side: SftpSide) => (side === "local" ? localPane : remotePane);
  const selectedItemsForSide = useCallback(
    (side: SftpSide) => {
      const pane = side === "local" ? localPane : remotePane;
      const selected = new Set(pane.selectedPaths);
      return pane.entries.filter((entry) => selected.has(entry.path));
    },
    [localPane, remotePane],
  );

  const getActionItems = useCallback(
    (side: SftpSide, path: string, kind: string, isEntry = true): DragPayloadItem[] => {
      if (!isEntry) return [{ path, kind }];
      const selected = selectedItemsForSide(side);
      if (selected.some((entry) => entry.path === path)) {
        return selected.map((entry) => ({ path: entry.path, kind: entry.kind }));
      }
      return [{ path, kind }];
    },
    [selectedItemsForSide],
  );

  const selectEntry = (side: SftpSide, path: string, additive: boolean) => {
    const setPane = side === "local" ? setLocalPane : setRemotePane;
    setPane((current) => {
      if (!additive) {
        return { ...current, selectedPaths: [path] };
      }
      const selected = new Set(current.selectedPaths);
      if (selected.has(path)) {
        selected.delete(path);
      } else {
        selected.add(path);
      }
      return { ...current, selectedPaths: [...selected] };
    });
  };

  const clearSelection = useCallback((side: SftpSide) => {
    const setPane = side === "local" ? setLocalPane : setRemotePane;
    setPane((current) =>
      current.selectedPaths.length ? { ...current, selectedPaths: [] } : current,
    );
  }, []);

  const createDragPayload = useCallback(
    (side: SftpSide, entry: SftpEntry): DragPayload => {
      const items = getActionItems(side, entry.path, entry.kind, true);
      return {
        side,
        path: entry.path,
        kind: entry.kind,
        items,
      };
    },
    [getActionItems],
  );

  const refreshPane = useCallback(
    (side: SftpSide) => {
      const pane = side === "local" ? localPane : remotePane;
      void loadPane(side, pane.path);
    },
    [loadPane, localPane, remotePane],
  );

  const openCreateFolderDialog = useCallback((side: SftpSide, basePath: string) => {
    setCreateFolderDialog({ side, basePath });
    setCreateFolderName("");
  }, []);

  const closeCreateFolderDialog = useCallback(() => {
    if (creatingFolder) return;
    setCreateFolderDialog(null);
    setCreateFolderName("");
  }, [creatingFolder]);

  const submitCreateFolder = useCallback(async () => {
    if (!createFolderDialog) return;
    const name = createFolderName.trim();
    if (!name || creatingFolder) return;
    setBusyMessage(t("workspaceSftp.creatingFolder"));
    setCreatingFolder(true);
    try {
      await client.mkdir({
        sessionId: session.id,
        projectPathKey,
        workdir,
        side: createFolderDialog.side,
        path: joinPath(createFolderDialog.basePath, name, createFolderDialog.side),
      });
      await loadPane(createFolderDialog.side, paneForSide(createFolderDialog.side).path);
      setCreateFolderDialog(null);
      setCreateFolderName("");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingFolder(false);
      setBusyMessage("");
    }
  }, [
    client,
    createFolderDialog,
    createFolderName,
    creatingFolder,
    loadPane,
    onError,
    projectPathKey,
    session.id,
    t,
    workdir,
    localPane,
    remotePane,
  ]);

  const openRenameEntryDialog = useCallback((side: SftpSide, path: string) => {
    const currentName = basename(path);
    if (!currentName) return;
    setRenameEntryDialog({ side, path, currentName });
    setRenameEntryName(currentName);
  }, []);

  const closeRenameEntryDialog = useCallback(() => {
    if (renamingEntry) return;
    setRenameEntryDialog(null);
    setRenameEntryName("");
  }, [renamingEntry]);

  const submitRenameEntry = useCallback(async () => {
    if (!renameEntryDialog) return;
    const nextName = renameEntryName.trim();
    if (!nextName || nextName === renameEntryDialog.currentName || renamingEntry) return;
    const toPath = joinPath(
      parentPath(renameEntryDialog.path, renameEntryDialog.side),
      nextName,
      renameEntryDialog.side,
    );
    setBusyMessage(t("workspaceSftp.renaming"));
    setRenamingEntry(true);
    try {
      await client.rename({
        sessionId: session.id,
        projectPathKey,
        workdir,
        side: renameEntryDialog.side,
        fromPath: renameEntryDialog.path,
        toPath,
      });
      await loadPane(renameEntryDialog.side, paneForSide(renameEntryDialog.side).path);
      setRenameEntryDialog(null);
      setRenameEntryName("");
    } catch (error) {
      onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      setRenamingEntry(false);
      setBusyMessage("");
    }
  }, [
    client,
    loadPane,
    onError,
    projectPathKey,
    renameEntryDialog,
    renameEntryName,
    renamingEntry,
    session.id,
    t,
    workdir,
    localPane,
    remotePane,
  ]);

  const deleteEntries = useCallback(
    async (side: SftpSide, items: DragPayloadItem[]) => {
      const targets = items.filter((item) => item.path !== "" && item.path !== ".");
      if (!targets.length) return;
      const hasDirectory = targets.some((item) => item.kind === "directory");
      const confirmed = await confirm({
        title: hasDirectory
          ? t("workspaceSftp.confirmDeleteDirectory")
          : t("workspaceSftp.confirmDeleteFile"),
        subtitle: hasDirectory
          ? t("workspaceSftp.confirmDeleteDirectorySubtitle")
          : t("workspaceSftp.confirmDeleteFileSubtitle"),
        detail:
          targets.length === 1 ? targets[0].path : targets.map((target) => target.path).join(", "),
        confirmLabel: t("workspaceSftp.deleteConfirm"),
        cancelLabel: t("workspaceSftp.cancel"),
        closeLabel: t("workspaceSftp.cancel"),
        tone: "destructive",
      });
      if (!confirmed) return;
      setBusyMessage(t("workspaceSftp.deleting"));
      try {
        for (const item of targets) {
          await client.delete({
            sessionId: session.id,
            projectPathKey,
            workdir,
            side,
            path: item.path,
            recursive: item.kind === "directory",
          });
        }
        await loadPane(side, paneForSide(side).path);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      } finally {
        setBusyMessage("");
      }
    },
    [
      client,
      confirm,
      loadPane,
      onError,
      projectPathKey,
      session.id,
      t,
      workdir,
      localPane,
      remotePane,
    ],
  );

  const showCopyToast = useCallback(() => {
    if (copyToastTimerRef.current !== null) {
      window.clearTimeout(copyToastTimerRef.current);
    }
    setCopyToastVisible(true);
    copyToastTimerRef.current = window.setTimeout(() => {
      setCopyToastVisible(false);
      copyToastTimerRef.current = null;
    }, 1600);
  }, []);

  const copyPath = useCallback(
    async (path: string) => {
      try {
        await navigator.clipboard.writeText(path);
        showCopyToast();
      } catch {
        setCopyPathDialog(path);
      }
    },
    [showCopyToast],
  );

  const copyPaths = useCallback(
    async (side: SftpSide, items: DragPayloadItem[]) => {
      const text = items.map((item) => absolutePathForCopy(side, item.path, workdir)).join("\n");
      if (!text) return;
      await copyPath(text);
    },
    [copyPath, workdir],
  );

  const transferSingleItem = useCallback(
    async (source: DragPayload, targetSide: SftpSide, targetPath: string) => {
      const direction = source.side === "local" && targetSide === "remote" ? "upload" : "download";
      if (source.side === targetSide) return;
      const queuedTransfer: SftpTransfer = {
        id: "",
        sessionId: session.id,
        direction,
        status: "queued",
        sourcePath: source.path,
        targetPath,
        currentPath: source.path,
        bytesDone: 0,
        bytesTotal: 0,
        filesDone: 0,
        filesTotal: 0,
        error: null,
      };
      pendingTransferStartsRef.current += 1;
      syncQueueCount();
      setTransfer(queuedTransfer);

      const runTransfer = async () => {
        try {
          const targetEntryPath = joinPath(targetPath, basename(source.path), targetSide);
          const targetStat = await client
            .stat({
              sessionId: session.id,
              projectPathKey,
              workdir,
              side: targetSide,
              path: targetEntryPath,
            })
            .catch(() => ({ exists: false }));
          let overwrite = false;
          if (targetStat.exists) {
            const confirmed = await confirm({
              title: t("workspaceSftp.confirmOverwrite"),
              subtitle: t("workspaceSftp.confirmOverwriteSubtitle"),
              detail: targetEntryPath,
              confirmLabel: t("workspaceSftp.overwrite"),
              cancelLabel: t("workspaceSftp.cancel"),
              closeLabel: t("workspaceSftp.cancel"),
              tone: "warning",
            });
            if (!confirmed) {
              pendingTransferStartsRef.current = Math.max(0, pendingTransferStartsRef.current - 1);
              syncQueueCount();
              setTransfer((current) => (current?.id ? current : null));
              return;
            }
            overwrite = true;
          }
          setTransfer({ ...queuedTransfer, status: "running" });
          const response = await client.transfer({
            sessionId: session.id,
            projectPathKey,
            workdir,
            direction,
            sourcePath: source.path,
            targetPath,
            recursive: source.kind === "directory",
            overwrite,
          });
          pendingTransferStartsRef.current = Math.max(0, pendingTransferStartsRef.current - 1);
          if (response.transfer.id && !TERMINAL_TRANSFER_STATUSES.has(response.transfer.status)) {
            activeTransferIdsRef.current.add(response.transfer.id);
          }
          syncQueueCount();
          setTransfer(response.transfer);
          if (!TERMINAL_TRANSFER_STATUSES.has(response.transfer.status)) {
            const terminalTransfer = await waitForTransferDone(response.transfer.id);
            if (terminalTransfer) {
              activeTransferIdsRef.current.delete(response.transfer.id);
              syncQueueCount();
              setTransfer(terminalTransfer);
            }
          } else {
            activeTransferIdsRef.current.delete(response.transfer.id);
            syncQueueCount();
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          setTransfer({ ...queuedTransfer, status: "failed", error: message });
          onError?.(message);
          pendingTransferStartsRef.current = Math.max(0, pendingTransferStartsRef.current - 1);
          syncQueueCount();
        }
      };

      const nextTransfer = transferChainRef.current.then(runTransfer, runTransfer);
      transferChainRef.current = nextTransfer.catch(() => undefined);
      await nextTransfer;
    },
    [
      client,
      confirm,
      onError,
      projectPathKey,
      session.id,
      syncQueueCount,
      t,
      waitForTransferDone,
      workdir,
    ],
  );

  const transferItem = useCallback(
    async (source: DragPayload, targetSide: SftpSide, targetPath: string) => {
      if (source.side === targetSide) return;
      const items = dragItems(source);
      for (const item of items) {
        await transferSingleItem(
          { side: source.side, path: item.path, kind: item.kind },
          targetSide,
          targetPath,
        );
      }
    },
    [transferSingleItem],
  );

  const readDropTargetFromPoint = useCallback((clientX: number, clientY: number) => {
    const panel = panelRef.current;
    const element = document.elementFromPoint(clientX, clientY);
    if (!panel || !element || !panel.contains(element)) return null;
    const target = element.closest<HTMLElement>("[data-sftp-drop-side]");
    if (!target || !panel.contains(target)) return null;
    const side = target.dataset.sftpDropSide;
    if (!isSftpSide(side)) return null;
    return {
      side,
      path: target.dataset.sftpDropPath ?? "",
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
      if (!drag.active && distance < POINTER_DRAG_THRESHOLD_PX) return;
      if (!drag.active) {
        drag.active = true;
        setActiveDragSource(drag.source);
      }
      setDragPreview({ source: drag.source, x: event.clientX, y: event.clientY });
      const target = readDropTargetFromPoint(event.clientX, event.clientY);
      setDropTarget(target && target.side !== drag.source.side ? target : null);
      event.preventDefault();
    };

    const finishPointerDrag = (event: PointerEvent | MouseEvent) => {
      const drag = pointerDragRef.current;
      if (!drag) return;
      if ("pointerId" in event && drag.pointerId !== event.pointerId) return;
      pointerDragRef.current = null;
      const target = readDropTargetFromPoint(event.clientX, event.clientY);
      setDropTarget(null);
      setActiveDragSource(null);
      setDragPreview(null);
      if (drag.active) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 0);
        event.preventDefault();
        event.stopPropagation();
      }
      if (drag.active && target && target.side !== drag.source.side) {
        void transferItem(drag.source, target.side, target.path);
      }
    };
    const cancelPointerDrag = () => {
      pointerDragRef.current = null;
      setDropTarget(null);
      setActiveDragSource(null);
      setDragPreview(null);
    };

    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", finishPointerDrag, { passive: false });
    window.addEventListener("pointercancel", finishPointerDrag, { passive: false });
    window.addEventListener("blur", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", finishPointerDrag);
      window.removeEventListener("blur", cancelPointerDrag);
    };
  }, [readDropTargetFromPoint, transferItem]);

  const beginPointerDrag = useCallback((event: React.PointerEvent, source: DragPayload) => {
    if (event.button !== 0 || !event.isPrimary) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      source,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  }, []);

  const handleDragOver = useCallback((event: React.DragEvent, side: SftpSide, path: string) => {
    event.preventDefault();
    event.stopPropagation();
    const payload = readDragPayload(event.dataTransfer) ?? nativeDragPayloadRef.current;
    if (!payload || payload.side === side) {
      event.dataTransfer.dropEffect = "none";
      setDropTarget(null);
      setDragPreview(null);
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    setActiveDragSource(payload);
    setDragPreview({ source: payload, x: event.clientX, y: event.clientY });
    setDropTarget({ side, path });
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent, side: SftpSide, path: string) => {
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      setActiveDragSource(null);
      setDragPreview(null);
      const payload = readDragPayload(event.dataTransfer) ?? nativeDragPayloadRef.current;
      nativeDragPayloadRef.current = null;
      if (!payload || payload.side === side) return;
      void transferItem(payload, side, path);
    },
    [transferItem],
  );

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (isLeavingCurrentTarget(event)) {
      setDropTarget(null);
      if (!pointerDragRef.current) {
        setDragPreview(null);
      }
    }
  }, []);

  const openContextMenu = useCallback(
    (event: React.MouseEvent, side: SftpSide, path: string, kind: string, isEntry = false) => {
      event.preventDefault();
      event.stopPropagation();
      const items = getActionItems(side, path, kind, isEntry);
      if (isEntry && !selectedItemsForSide(side).some((entry) => entry.path === path)) {
        selectEntry(side, path, false);
      }
      const rect = panelRef.current?.getBoundingClientRect();
      const menuWidth = 220;
      const menuHeight = 250;
      const maxX = Math.max(8, (rect?.width ?? window.innerWidth) - menuWidth - 8);
      const maxY = Math.max(8, (rect?.height ?? window.innerHeight) - menuHeight - 8);
      setContextMenu({
        x: Math.min(Math.max(8, event.clientX - (rect?.left ?? 0)), maxX),
        y: Math.min(Math.max(8, event.clientY - (rect?.top ?? 0)), maxY),
        side,
        path,
        kind,
        isEntry,
        items,
      });
    },
    [getActionItems, selectedItemsForSide],
  );

  const panes = useMemo(
    () => [
      { side: "local" as const, label: t("workspaceSftp.local"), root: workdir, pane: localPane },
      {
        side: "remote" as const,
        label: t("workspaceSftp.remote"),
        root: session.ssh ? `${session.ssh.username}@${session.ssh.host}` : session.title,
        pane: remotePane,
      },
    ],
    [localPane, remotePane, session.ssh, session.title, t, workdir],
  );

  if (!connected) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground">
        <AlertTriangle className="h-8 w-8 text-amber-500" />
        <div className="font-medium text-foreground">{t("workspaceSftp.disconnected")}</div>
        <div className="max-w-md text-xs">{t("workspaceSftp.disconnectedHint")}</div>
      </div>
    );
  }

  return (
    <div ref={panelRef} className="relative flex h-full min-h-0 flex-col bg-background">
      {isMobileLayout ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/30 p-1">
          {panes.map(({ side, label }) => (
            <button
              key={side}
              type="button"
              className={cn(
                "flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                mobilePane === side
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => setMobilePane(side)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      <div
        className={cn(
          "flex min-h-0 flex-1 overflow-y-hidden",
          isMobileLayout ? "overflow-x-hidden" : "overflow-x-auto",
        )}
      >
        <div
          className={cn(
            "grid h-full min-h-0 flex-1 divide-x divide-border",
            isMobileLayout ? "grid-cols-1" : "min-w-[860px] grid-cols-2",
          )}
        >
          {(isMobileLayout ? panes.filter((entry) => entry.side === mobilePane) : panes).map(
            ({ side, label, root, pane }) => {
              const dropMode =
                activeDragSource?.side === "local" && side === "remote"
                  ? "upload"
                  : activeDragSource?.side === "remote" && side === "local"
                    ? "download"
                    : null;
              const dropActive = dropMode !== null && dropTarget?.side === side;
              const DropIcon = dropMode === "download" ? Download : Upload;
              const dropPath = dropActive ? dropTarget?.path || pane.path : pane.path;
              const PaneFolderIcon = getFileTypeIcon(root || pane.path, "dir", { expanded: true });

              return (
                <div
                  key={side}
                  data-sftp-drop-side={side}
                  data-sftp-drop-path={pane.path}
                  className={cn(
                    "relative flex min-h-0 min-w-0 flex-col overflow-hidden transition-colors",
                    dropMode && "bg-muted/20",
                    dropActive && "bg-emerald-500/5",
                  )}
                  onDragOver={(event) => handleDragOver(event, side, pane.path)}
                  onDragLeave={handleDragLeave}
                  onDrop={(event) => handleDrop(event, side, pane.path)}
                  onContextMenu={(event) =>
                    openContextMenu(event, side, pane.path, "directory", false)
                  }
                >
                  <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-muted/30 px-3">
                    <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-background text-muted-foreground">
                      <PaneFolderIcon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-foreground">{label}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {root}
                      </div>
                    </div>
                    {pane.selectedPaths.length ? (
                      <button
                        type="button"
                        className="inline-flex h-7 max-w-[112px] shrink-0 items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
                        title={t("workspaceSftp.clearSelection")}
                        onClick={(event) => {
                          event.stopPropagation();
                          clearSelection(side);
                        }}
                      >
                        <span className="truncate">
                          {t("workspaceSftp.selectedCount").replace(
                            "{count}",
                            String(pane.selectedPaths.length),
                          )}
                        </span>
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground"
                      title={t("workspaceSftp.refresh")}
                      onClick={() => refreshPane(side)}
                    >
                      <RefreshCw className={cn("h-4 w-4", pane.loading && "animate-spin")} />
                    </button>
                  </div>

                  <PathNavigator
                    side={side}
                    path={pane.path}
                    loading={pane.loading}
                    client={client}
                    sessionId={session.id}
                    projectPathKey={projectPathKey}
                    workdir={workdir}
                    rootLabel={t("workspaceSftp.projectRoot")}
                    onNavigate={(nextPath) => void loadPane(side, nextPath)}
                    t={t}
                  />

                  {pane.error ? (
                    <div className="m-3 flex items-start gap-2 rounded-lg border border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                      <span className="min-w-0 break-words">{pane.error}</span>
                    </div>
                  ) : null}

                  <div
                    className="relative min-h-0 flex-1 overscroll-contain overflow-auto p-2"
                    onClick={(event) => {
                      const target = event.target;
                      if (target instanceof HTMLElement && target.closest("[data-sftp-entry]"))
                        return;
                      clearSelection(side);
                    }}
                  >
                    {dropMode ? (
                      <div
                        className={cn(
                          "pointer-events-none absolute inset-2 z-20 flex items-center justify-center rounded-lg bg-background/80 text-center opacity-75 shadow-inner backdrop-blur-[1px] transition-all",
                          dropActive && "bg-emerald-500/10 opacity-100",
                        )}
                      >
                        <span
                          className={cn(
                            "absolute left-0 top-0 h-14 w-14 rounded-tl-lg border-l-2 border-t-2",
                            dropActive ? "border-emerald-600" : "border-foreground/65",
                          )}
                        />
                        <span
                          className={cn(
                            "absolute right-0 top-0 h-14 w-14 rounded-tr-lg border-r-2 border-t-2",
                            dropActive ? "border-emerald-600" : "border-foreground/65",
                          )}
                        />
                        <span
                          className={cn(
                            "absolute bottom-0 left-0 h-14 w-14 rounded-bl-lg border-b-2 border-l-2",
                            dropActive ? "border-emerald-600" : "border-foreground/65",
                          )}
                        />
                        <span
                          className={cn(
                            "absolute bottom-0 right-0 h-14 w-14 rounded-br-lg border-b-2 border-r-2",
                            dropActive ? "border-emerald-600" : "border-foreground/65",
                          )}
                        />
                        <div className="flex max-w-[75%] flex-col items-center gap-3">
                          <div
                            className={cn(
                              "flex h-14 w-14 items-center justify-center rounded-xl border-2 bg-background/90 shadow-sm",
                              dropActive
                                ? "border-emerald-600 text-emerald-700 dark:text-emerald-300"
                                : "border-foreground/70 text-foreground",
                            )}
                          >
                            <DropIcon className="h-7 w-7" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold text-foreground">
                              {t("workspaceSftp.dropHere")}
                            </div>
                            <div className="mt-1 text-xs text-muted-foreground">
                              {t(
                                dropMode === "upload"
                                  ? "workspaceSftp.drop.upload"
                                  : "workspaceSftp.drop.download",
                              )}
                            </div>
                            {dropPath ? (
                              <div className="mx-auto mt-2 max-w-full truncate rounded bg-background/70 px-2 py-1 font-mono text-[11px] text-muted-foreground">
                                {normalizePath(dropPath, side)}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {pane.loading && pane.entries.length === 0 ? (
                      <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {t("workspaceSftp.loading")}
                      </div>
                    ) : pane.entries.length === 0 ? (
                      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                        {t("workspaceSftp.empty")}
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {pane.entries.map((entry) => {
                          const isSelected = pane.selectedPaths.includes(entry.path);
                          return (
                            <button
                              key={entry.path}
                              type="button"
                              draggable={false}
                              data-sftp-entry="true"
                              data-sftp-drop-side={entry.kind === "directory" ? side : undefined}
                              data-sftp-drop-path={
                                entry.kind === "directory" ? entry.path : undefined
                              }
                              aria-selected={isSelected}
                              className={cn(
                                "grid w-full cursor-default grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-3 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
                                !isMobileLayout && "touch-none",
                                isSelected &&
                                  "bg-emerald-500/10 text-foreground ring-1 ring-emerald-500/20",
                                activeDragSource?.side === side &&
                                  dragItems(activeDragSource).some(
                                    (item) => item.path === entry.path,
                                  ) &&
                                  "bg-muted text-muted-foreground opacity-70 ring-1 ring-border",
                                dropTarget?.side === side &&
                                  dropTarget.path === entry.path &&
                                  entry.kind === "directory" &&
                                  "bg-emerald-500/10 text-foreground",
                              )}
                              onClick={(event) => {
                                if (suppressNextClickRef.current) {
                                  suppressNextClickRef.current = false;
                                  event.preventDefault();
                                  event.stopPropagation();
                                  return;
                                }
                                selectEntry(side, entry.path, event.ctrlKey || event.metaKey);
                              }}
                              onDoubleClick={() => {
                                if (entry.kind === "directory") void loadPane(side, entry.path);
                              }}
                              onDragOver={(event) => {
                                if (entry.kind === "directory") {
                                  handleDragOver(event, side, entry.path);
                                }
                              }}
                              onDragLeave={(event) => {
                                if (entry.kind === "directory") {
                                  handleDragLeave(event);
                                }
                              }}
                              onDrop={(event) => {
                                if (entry.kind === "directory") {
                                  handleDrop(event, side, entry.path);
                                }
                              }}
                              onDragStart={(event) => {
                                const payload = createDragPayload(side, entry);
                                nativeDragPayloadRef.current = payload;
                                setActiveDragSource(payload);
                                writeDragPayload(event.dataTransfer, payload);
                              }}
                              onPointerDown={(event) => {
                                if (
                                  event.button === 0 &&
                                  event.isPrimary &&
                                  (event.ctrlKey || event.metaKey)
                                ) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  selectEntry(side, entry.path, true);
                                  suppressNextClickRef.current = true;
                                  suppressNextContextMenuRef.current = event.ctrlKey;
                                  window.setTimeout(() => {
                                    suppressNextContextMenuRef.current = false;
                                  }, 250);
                                  return;
                                }
                                // On mobile, leave the pointer to the browser so the list scrolls
                                // natively; transfers happen through the long-press context menu.
                                if (isMobileLayout) return;
                                try {
                                  event.currentTarget.setPointerCapture(event.pointerId);
                                } catch {
                                  // Some WebViews reject capture during synthetic pointer streams.
                                }
                                beginPointerDrag(event, createDragPayload(side, entry));
                              }}
                              onDragEnd={() => {
                                nativeDragPayloadRef.current = null;
                                setDropTarget(null);
                                setActiveDragSource(null);
                                setDragPreview(null);
                              }}
                              onContextMenu={(event) => {
                                if (suppressNextContextMenuRef.current) {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  suppressNextContextMenuRef.current = false;
                                  return;
                                }
                                openContextMenu(event, side, entry.path, entry.kind, true);
                              }}
                            >
                              <span className="flex min-w-0 items-center gap-2">
                                {entryIcon(entry)}
                                <span className="truncate">{entry.name}</span>
                              </span>
                              <span className="text-right font-mono text-[11px] text-muted-foreground">
                                {entry.kind === "directory" ? "--" : formatBytes(entry.sizeBytes)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            },
          )}
        </div>
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2 border-t border-border bg-muted/30 px-3 text-xs text-muted-foreground">
        {busyMessage ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        <span className="min-w-0 flex-1 truncate">
          {busyMessage || (transfer ? "" : t("workspaceSftp.transfer.idle"))}
        </span>
        {transfer ? (
          <TransferToast
            transfer={transfer}
            queueCount={queueCount}
            cancelLabel={t("workspaceSftp.cancel")}
            filesLabel={t("workspaceSftp.transfer.files")}
            statusLabel={t(`workspaceSftp.transfer.${transfer.status}`)}
            onCancel={
              transfer.id && transfer.status === "running"
                ? () =>
                    void client.cancelTransfer({ sessionId: session.id, transferId: transfer.id })
                : undefined
            }
          />
        ) : null}
      </div>

      {contextMenu ? (
        <div
          className="editor-context-menu absolute z-[80] w-[220px] select-none overflow-hidden rounded-xl border border-border/60 bg-popover/90 p-1 text-xs text-popover-foreground shadow-2xl ring-1 ring-black/[0.03] backdrop-blur-xl dark:ring-white/[0.06]"
          role="menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          {contextMenu.items.length > 1 ? (
            <div className="mb-1 flex items-center justify-between rounded-lg bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
              <span>
                {t("workspaceSftp.selectedCount").replace(
                  "{count}",
                  String(contextMenu.items.length),
                )}
              </span>
              <button
                type="button"
                className="rounded px-1 text-emerald-700/80 hover:bg-emerald-500/10 hover:text-emerald-800 dark:text-emerald-300/80 dark:hover:text-emerald-200"
                onClick={(event) => {
                  event.stopPropagation();
                  clearSelection(contextMenu.side);
                  setContextMenu(null);
                }}
              >
                {t("workspaceSftp.clearSelection")}
              </button>
            </div>
          ) : null}
          <MenuItem
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            label={t("workspaceSftp.refresh")}
            onClick={() => {
              setContextMenu(null);
              refreshPane(contextMenu.side);
            }}
          />
          <MenuItem
            icon={<Plus className="h-3.5 w-3.5" />}
            label={t("workspaceSftp.newFolder")}
            onClick={() => {
              setContextMenu(null);
              openCreateFolderDialog(
                contextMenu.side,
                contextMenu.kind === "directory"
                  ? contextMenu.path
                  : parentPath(contextMenu.path, contextMenu.side),
              );
            }}
          />
          <MenuItem
            icon={<Pencil className="h-3.5 w-3.5" />}
            label={t("workspaceSftp.rename")}
            disabled={
              !contextMenu.isEntry ||
              contextMenu.items.length !== 1 ||
              contextMenu.path === "" ||
              contextMenu.path === "."
            }
            onClick={() => {
              setContextMenu(null);
              openRenameEntryDialog(contextMenu.side, contextMenu.path);
            }}
          />
          <MenuItem
            icon={<Trash2 className="h-3.5 w-3.5" />}
            label={t("workspaceSftp.delete")}
            disabled={!contextMenu.isEntry || contextMenu.items.length === 0}
            destructive
            onClick={() => {
              setContextMenu(null);
              void deleteEntries(contextMenu.side, contextMenu.items);
            }}
          />
          <div className="my-1 h-px bg-border/70" />
          {contextMenu.side === "local" ? (
            <MenuItem
              icon={<Upload className="h-3.5 w-3.5" />}
              label={t("workspaceSftp.uploadToRemote")}
              disabled={!contextMenu.isEntry || contextMenu.items.length === 0}
              onClick={() => {
                setContextMenu(null);
                void transferItem(
                  {
                    side: "local",
                    path: contextMenu.path,
                    kind: contextMenu.kind,
                    items: contextMenu.items,
                  },
                  "remote",
                  remotePane.path,
                );
              }}
            />
          ) : (
            <MenuItem
              icon={<Download className="h-3.5 w-3.5" />}
              label={t("workspaceSftp.downloadToLocal")}
              disabled={!contextMenu.isEntry || contextMenu.items.length === 0}
              onClick={() => {
                setContextMenu(null);
                void transferItem(
                  {
                    side: "remote",
                    path: contextMenu.path,
                    kind: contextMenu.kind,
                    items: contextMenu.items,
                  },
                  "local",
                  localPane.path,
                );
              }}
            />
          )}
          <MenuItem
            icon={<Copy className="h-3.5 w-3.5" />}
            label={t("workspaceSftp.copyPath")}
            onClick={() => {
              setContextMenu(null);
              void copyPaths(
                contextMenu.side,
                contextMenu.items.length
                  ? contextMenu.items
                  : [{ path: contextMenu.path, kind: contextMenu.kind }],
              );
            }}
          />
        </div>
      ) : null}
      {dragPreview ? (
        <DragPreview
          entry={findEntry(dragPreview.source)}
          fallback={dragPreview.source}
          x={dragPreview.x}
          y={dragPreview.y}
          typeLabel={(entry) => entryTypeLabel(entry, t)}
        />
      ) : null}
      {createFolderDialog ? (
        <CreateFolderDialog
          title={t("workspaceSftp.newFolder")}
          prompt={t("workspaceSftp.newFolderPrompt")}
          confirmLabel={t("workspaceSftp.newFolder")}
          cancelLabel={t("workspaceSftp.cancel")}
          path={normalizePath(createFolderDialog.basePath, createFolderDialog.side)}
          value={createFolderName}
          submitting={creatingFolder}
          onChange={setCreateFolderName}
          onCancel={closeCreateFolderDialog}
          onSubmit={() => void submitCreateFolder()}
        />
      ) : null}
      {renameEntryDialog ? (
        <RenameEntryDialog
          title={t("workspaceSftp.rename")}
          prompt={t("workspaceSftp.renamePrompt")}
          confirmLabel={t("workspaceSftp.rename")}
          cancelLabel={t("workspaceSftp.cancel")}
          path={normalizePath(renameEntryDialog.path, renameEntryDialog.side)}
          originalName={renameEntryDialog.currentName}
          value={renameEntryName}
          submitting={renamingEntry}
          onChange={setRenameEntryName}
          onCancel={closeRenameEntryDialog}
          onSubmit={() => void submitRenameEntry()}
        />
      ) : null}
      {copyPathDialog ? (
        <CopyPathDialog
          title={t("workspaceSftp.copyPath")}
          prompt={t("workspaceSftp.copyPathFallback")}
          closeLabel={t("workspaceSftp.cancel")}
          text={copyPathDialog}
          onClose={() => setCopyPathDialog(null)}
        />
      ) : null}
      {copyToastVisible ? <CopyPathToast message={t("workspaceSftp.copyPathCopied")} /> : null}
      {dialog}
    </div>
  );
}

function CreateFolderDialog(props: {
  title: string;
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  path: string;
  value: string;
  submitting: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const {
    title,
    prompt,
    confirmLabel,
    cancelLabel,
    path,
    value,
    submitting,
    onChange,
    onCancel,
    onSubmit,
  } = props;
  const canSubmit = value.trim().length > 0 && !submitting;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <form
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onSubmit();
          }
        }}
      >
        <div className="border-b border-border/60 px-5 py-4">
          <div className="text-base font-semibold text-foreground">{title}</div>
          {path ? (
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{path}</div>
          ) : null}
        </div>
        <div className="space-y-2 px-5 py-5">
          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor="workspace-sftp-new-folder-name"
          >
            {prompt}
          </label>
          <input
            id="workspace-sftp-new-folder-name"
            value={value}
            autoFocus
            disabled={submitting}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60"
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
            disabled={submitting}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
            disabled={!canSubmit}
          >
            {submitting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function CopyPathDialog(props: {
  title: string;
  prompt: string;
  closeLabel: string;
  text: string;
  onClose: () => void;
}) {
  const { title, prompt, closeLabel, text, onClose } = props;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl">
        <div className="border-b border-border/60 px-5 py-4">
          <div className="text-base font-semibold text-foreground">{title}</div>
          <div className="mt-1 text-xs text-muted-foreground">{prompt}</div>
        </div>
        <div className="px-5 py-5">
          <textarea
            value={text}
            readOnly
            autoFocus
            className="min-h-28 w-full resize-none rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/20"
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
        <div className="flex justify-end border-t border-border/60 bg-muted/20 px-5 py-4">
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            onClick={onClose}
          >
            {closeLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function CopyPathToast(props: { message: string }) {
  return (
    <div className="pointer-events-none absolute bottom-14 right-4 z-[90]">
      <div className="notify-toast-enter flex min-w-56 items-center gap-2 rounded-lg border border-emerald-500/25 bg-background/95 px-3 py-2 text-sm font-medium text-foreground shadow-2xl backdrop-blur-xl">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
        <span>{props.message}</span>
      </div>
    </div>
  );
}

function RenameEntryDialog(props: {
  title: string;
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  path: string;
  originalName: string;
  value: string;
  submitting: boolean;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const {
    title,
    prompt,
    confirmLabel,
    cancelLabel,
    path,
    originalName,
    value,
    submitting,
    onChange,
    onCancel,
    onSubmit,
  } = props;
  const trimmedValue = value.trim();
  const canSubmit = trimmedValue.length > 0 && trimmedValue !== originalName && !submitting;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onCancel();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <button
        type="button"
        tabIndex={-1}
        className="absolute inset-0 cursor-default bg-black/55 backdrop-blur-sm"
        onClick={onCancel}
        aria-hidden="true"
      />
      <form
        className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-border/70 bg-background shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) {
            onSubmit();
          }
        }}
      >
        <div className="border-b border-border/60 px-5 py-4">
          <div className="text-base font-semibold text-foreground">{title}</div>
          {path ? (
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{path}</div>
          ) : null}
        </div>
        <div className="space-y-2 px-5 py-5">
          <label
            className="block text-xs font-medium text-muted-foreground"
            htmlFor="workspace-sftp-rename-entry-name"
          >
            {prompt}
          </label>
          <input
            id="workspace-sftp-rename-entry-name"
            value={value}
            autoFocus
            disabled={submitting}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring focus:ring-2 focus:ring-ring/20 disabled:cursor-not-allowed disabled:opacity-60"
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
        <div className="flex flex-col-reverse gap-2 border-t border-border/60 bg-muted/20 px-5 py-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            className="inline-flex h-9 items-center justify-center rounded-lg border border-input bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
            disabled={submitting}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="submit"
            className="inline-flex h-9 items-center justify-center rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50 sm:w-auto"
            disabled={!canSubmit}
          >
            {submitting ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

function TransferToast(props: {
  transfer: SftpTransfer;
  queueCount: number;
  cancelLabel: string;
  filesLabel: string;
  statusLabel: string;
  onCancel?: () => void;
}) {
  const { transfer, queueCount, cancelLabel, filesLabel, statusLabel, onCancel } = props;
  const progress = transferProgress(transfer);
  const TransferIcon = transfer.direction === "download" ? Download : Upload;
  const currentPath = transfer.currentPath || transfer.sourcePath || transfer.targetPath;
  const isRunning = transfer.status === "running" || transfer.status === "queued";
  const isCompleted = transfer.status === "completed";
  const isFailed = transfer.status === "failed";
  const StatusIcon = isRunning ? Loader2 : isCompleted ? CheckCircle2 : TransferIcon;
  const iconClass = isFailed
    ? "text-destructive"
    : isCompleted
      ? "text-emerald-600 dark:text-emerald-300"
      : "text-sky-600 dark:text-sky-300";

  return (
    <div className="pointer-events-auto relative ml-auto flex h-full w-[340px] max-w-[50%] shrink-0 items-center gap-2 pl-3 text-foreground before:absolute before:bottom-2 before:left-0 before:top-2 before:w-px before:bg-border/60">
      <div className="flex h-4 w-4 shrink-0 items-center justify-center">
        <StatusIcon className={cn("h-3.5 w-3.5", iconClass, isRunning && "animate-spin")} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="shrink-0 text-[11px] font-medium leading-none text-foreground">
            {statusLabel}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] leading-none text-muted-foreground/90">
            {currentPath}
          </span>
          <span className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground">
            {progress}%
          </span>
        </div>
        {transfer.error ? (
          <div className="mt-1.5 truncate text-[11px] leading-none text-destructive">
            {transfer.error}
          </div>
        ) : (
          <div className="mt-1.5 flex items-center gap-1.5">
            <div className="h-1 min-w-16 flex-1 overflow-hidden rounded-full bg-border/60">
              <div
                className={cn(
                  "h-full rounded-full transition-all duration-300",
                  transferTone(transfer),
                )}
                style={{ width: `${progress}%` }}
              />
            </div>
            <span className="shrink-0 text-[10px] leading-none text-muted-foreground">
              {transfer.filesDone}/{transfer.filesTotal || queueCount || 1} {filesLabel}
            </span>
            <span className="shrink-0 font-mono text-[10px] leading-none text-muted-foreground">
              {formatBytes(transfer.bytesDone)} / {formatBytes(transfer.bytesTotal)}
            </span>
          </div>
        )}
      </div>
      {onCancel ? (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-destructive hover:bg-destructive/10"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      ) : null}
    </div>
  );
}

function DragPreview(props: {
  entry: SftpEntry | null;
  fallback: DragPayload;
  x: number;
  y: number;
  typeLabel: (entry: SftpEntry) => string;
}) {
  const { entry, fallback, x, y, typeLabel } = props;
  const previewEntry: SftpEntry = entry ?? {
    path: fallback.path,
    name: basename(fallback.path) || fallback.path,
    kind: fallback.kind,
    sizeBytes: 0,
    mtime: 0,
  };
  const count = dragItems(fallback).length;

  return (
    <div
      className="pointer-events-none fixed z-[120] flex w-[260px] max-w-[calc(100vw-32px)] items-center gap-2 rounded-md bg-sky-500/90 px-2.5 py-2 text-xs text-white shadow-xl ring-1 ring-sky-200/50 backdrop-blur-sm"
      style={{
        left: x + 18,
        top: y + 14,
        transform: "translateY(-50%)",
      }}
    >
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-white/15 text-white">
        {entryIcon(previewEntry, "h-4 w-4 text-white")}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium leading-4">
          {previewEntry.name}
          {count > 1 ? ` +${count - 1}` : ""}
        </span>
        <span className="block truncate text-[10px] leading-3 text-white/75">
          {typeLabel(previewEntry)}
          {previewEntry.kind === "directory" ? "" : ` · ${formatBytes(previewEntry.sizeBytes)}`}
        </span>
      </span>
      {count > 1 ? (
        <span className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
          {count}
        </span>
      ) : previewEntry.kind === "directory" ? null : (
        <span className="shrink-0 rounded bg-white/15 px-1.5 py-0.5 font-mono text-[10px] text-white/90">
          {formatBytes(previewEntry.sizeBytes)}
        </span>
      )}
    </div>
  );
}

function MenuItem(props: {
  icon: React.ReactNode;
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { icon, label, destructive = false, disabled = false, onClick } = props;
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors",
        destructive
          ? "text-destructive hover:bg-destructive/10"
          : "text-popover-foreground hover:bg-accent hover:text-accent-foreground",
        disabled && "pointer-events-none opacity-45",
      )}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );
}
