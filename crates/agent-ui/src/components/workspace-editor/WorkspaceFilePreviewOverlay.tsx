import {
  copyWorkspacePreviewImage,
  saveWorkspacePreviewImage,
  supportsExternalWorkspaceOpen,
  WorkspaceOverlayTitleBar,
  workspaceOverlayStackClassName,
} from "@liveagent/adapters/workspacePreview";
import {
  type FileTypeIconComponent,
  getFileTypeIcon,
} from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  AlertTriangle,
  ChevronRight,
  Copy,
  Download,
  ExternalLink,
  FilePenLine,
  FileText,
  Info,
  Loader2,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  RotateCwSquare,
  X,
} from "@liveagent/ui/components/IconSet";
import { WorkspaceMarkdownPreview } from "@liveagent/ui/components/workspace-editor/WorkspaceMarkdownPreview";
import {
  getWorkspacePreviewKind,
  isWorkspaceEditablePreviewPath,
  type WorkspacePreviewKind,
} from "@liveagent/ui/components/workspace-editor/workspaceImagePreview";
import {
  clampImageViewerPan,
  clampImageViewerState,
  fitImageViewerSize,
  IMAGE_VIEWER_MAX_SCALE,
  IMAGE_VIEWER_MIN_SCALE,
  type ImageViewerSize,
  type ImageViewerState,
  imageViewerScaleAfterStep,
  imageViewerScaleAfterWheelDelta,
  resetImageViewerState,
  workspaceImageAbsolutePathForCopy,
  workspaceImageRelativePathForCopy,
  zoomImageViewerAtPoint,
} from "@liveagent/ui/components/workspace-editor/workspaceImageViewer";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import { renderAsync } from "docx-preview";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { read, utils } from "xlsx";

export type WorkspaceFilePreviewOpenRequest = {
  id: number;
  projectPathKey: string;
  workdir: string;
  path: string;
  imagePaths?: string[];
};

type ReadWorkspacePreviewResponse = {
  path: string;
  mimeType: string;
  data: string;
  sizeBytes: number;
  mtimeMs: number;
  contentHash: string;
};

type WorkspaceFilePreviewOverlayProps = {
  openRequest: WorkspaceFilePreviewOpenRequest | null;
  isOpen: boolean;
  onOpenEditor: (request: WorkspaceFilePreviewOpenRequest) => void;
  onRequestClose: () => void;
  onClose: () => void;
};

type LoadedPreview = ReadWorkspacePreviewResponse & {
  blobUrl: string;
  bytes: Uint8Array;
  kind: WorkspacePreviewKind;
  text: string | null;
};

type SpreadsheetTable = {
  sheetNames: string[];
  rows: Array<{
    id: string;
    cells: Array<{ id: string; value: string }>;
  }>;
  activeSheetName: string;
  truncatedRows: boolean;
  truncatedColumns: boolean;
  error: string | null;
};

const FILE_PREVIEW_OVERLAY_ANIMATION_MS = 180;
const SPREADSHEET_MAX_ROWS = 250;
const SPREADSHEET_MAX_COLUMNS = 80;
type ImagePreviewTransitionDirection = -1 | 0 | 1;

function basename(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const index = normalized.lastIndexOf("/");
  return index >= 0 ? normalized.slice(index + 1) : normalized;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function toMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  const text = String(error ?? "").trim();
  return text || fallback;
}

function base64ToBytes(data: string) {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function isTextPreviewKind(kind: WorkspacePreviewKind) {
  return kind === "html" || kind === "markdown" || kind === "text";
}

function kindFromMimeType(mimeType: string): WorkspacePreviewKind | null {
  const mime = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/html") return "html";
  if (mime === "text/markdown" || mime === "text/x-markdown") return "markdown";
  if (
    mime === "text/csv" ||
    mime === "text/tab-separated-values" ||
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "application/vnd.oasis.opendocument.spreadsheet"
  ) {
    return "spreadsheet";
  }
  if (mime.includes("wordprocessingml")) return "document";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("text/")) return "text";
  return null;
}

function resolvePreviewKind(path: string, mimeType: string): WorkspacePreviewKind {
  const mimeKind = kindFromMimeType(mimeType);
  if (mimeKind === "html" || mimeKind === "markdown" || mimeKind === "text") return mimeKind;
  return getWorkspacePreviewKind(path) ?? mimeKind ?? "text";
}

function decodePreviewText(bytes: Uint8Array) {
  return new TextDecoder("utf-8").decode(bytes);
}

function normalizeImagePaths(paths: string[] | undefined, activePath: string) {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const path of paths ?? []) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  if (activePath && !seen.has(activePath)) {
    normalized.push(activePath);
  }
  return normalized;
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

const SANDBOXED_HTML_PREVIEW_BOOTSTRAP = [
  "<script data-liveagent-html-preview-bootstrap>",
  "(() => {",
  "  function createStorage() {",
  "    const values = new Map();",
  "    const storage = {",
  "      get length() { return values.size; },",
  "      key(index) { return Array.from(values.keys())[Number(index)] ?? null; },",
  "      getItem(key) { key = String(key); return values.has(key) ? values.get(key) : null; },",
  "      setItem(key, value) { values.set(String(key), String(value)); },",
  "      removeItem(key) { values.delete(String(key)); },",
  "      clear() { values.clear(); }",
  "    };",
  "    return new Proxy(storage, {",
  "      get(target, key, receiver) {",
  "        if (typeof key !== 'string' || key in target) return Reflect.get(target, key, receiver);",
  "        return target.getItem(key);",
  "      },",
  "      set(target, key, value, receiver) {",
  "        if (typeof key !== 'string' || key in target) return Reflect.set(target, key, value, receiver);",
  "        target.setItem(key, value);",
  "        return true;",
  "      },",
  "      deleteProperty(target, key) {",
  "        if (typeof key === 'string') { target.removeItem(key); return true; }",
  "        return Reflect.deleteProperty(target, key);",
  "      }",
  "    });",
  "  }",
  "  for (const name of ['localStorage', 'sessionStorage']) {",
  "    try {",
  "      Object.defineProperty(window, name, { value: createStorage(), configurable: true });",
  "    } catch {}",
  "  }",
  "})();",
  "</" + "script>",
].join("");

function buildSandboxedHtmlPreviewSource(html: string) {
  const source = html.startsWith("\uFEFF") ? html.slice(1) : html;
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(source);
  if (headMatch) {
    const insertionIndex = headMatch.index + headMatch[0].length;
    return `${source.slice(0, insertionIndex)}${SANDBOXED_HTML_PREVIEW_BOOTSTRAP}${source.slice(
      insertionIndex,
    )}`;
  }

  const doctypeMatch = /^\s*<!doctype[^>]*>\s*/i.exec(source);
  const insertionIndex = doctypeMatch ? doctypeMatch[0].length : 0;
  return `${source.slice(0, insertionIndex)}${SANDBOXED_HTML_PREVIEW_BOOTSTRAP}${source.slice(
    insertionIndex,
  )}`;
}

function getPreviewIcon(kind: WorkspacePreviewKind): FileTypeIconComponent {
  switch (kind) {
    case "audio":
      return getFileTypeIcon("preview.mp3", "file");
    case "document":
      return getFileTypeIcon("preview.docx", "file");
    case "html":
      return getFileTypeIcon("preview.html", "file");
    case "image":
      return getFileTypeIcon("preview.png", "file");
    case "markdown":
      return getFileTypeIcon("preview.md", "file");
    case "pdf":
      return getFileTypeIcon("preview.pdf", "file");
    case "spreadsheet":
      return getFileTypeIcon("preview.xlsx", "file");
    case "video":
      return getFileTypeIcon("preview.mp4", "file");
    case "text":
      return getFileTypeIcon("preview.txt", "file");
  }
}

function buildSpreadsheetTable(
  preview: LoadedPreview | null,
  activeSheetName: string,
  fallbackError: string,
): SpreadsheetTable | null {
  if (!preview || preview.kind !== "spreadsheet") return null;
  try {
    const workbook = read(preview.bytes, { type: "array", cellDates: true });
    const sheetNames = workbook.SheetNames;
    const selectedSheetName =
      sheetNames.find((name) => name === activeSheetName) ?? sheetNames[0] ?? "";
    const sheet = selectedSheetName ? workbook.Sheets[selectedSheetName] : null;
    if (!sheet) {
      return {
        sheetNames,
        rows: [],
        activeSheetName: selectedSheetName,
        truncatedRows: false,
        truncatedColumns: false,
        error: null,
      };
    }
    const rawRows = utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    });
    const maxColumns = rawRows.reduce(
      (max, row) => Math.max(max, Array.isArray(row) ? row.length : 0),
      0,
    );
    const rows = rawRows.slice(0, SPREADSHEET_MAX_ROWS).map((row, rowIndex) => {
      const cells = Array.from(
        { length: Math.min(maxColumns, SPREADSHEET_MAX_COLUMNS) },
        (_, index) => ({
          id: `c${index}`,
          value: String(Array.isArray(row) ? (row[index] ?? "") : ""),
        }),
      );
      return {
        id: `r${rowIndex}-${hashString(cells.map((cell) => cell.value).join("\u0000"))}`,
        cells,
      };
    });
    return {
      sheetNames,
      rows,
      activeSheetName: selectedSheetName,
      truncatedRows: rawRows.length > SPREADSHEET_MAX_ROWS,
      truncatedColumns: maxColumns > SPREADSHEET_MAX_COLUMNS,
      error: null,
    };
  } catch (error) {
    return {
      sheetNames: [],
      rows: [],
      activeSheetName: "",
      truncatedRows: false,
      truncatedColumns: false,
      error: toMessage(error, fallbackError),
    };
  }
}

export function WorkspaceFilePreviewOverlay(props: WorkspaceFilePreviewOverlayProps) {
  const { openRequest, isOpen, onOpenEditor, onRequestClose, onClose } = props;
  const { t } = useLocale();
  const closeAnimationTimeoutRef = useRef<number | null>(null);
  const loadSequenceRef = useRef(0);
  const previewBlobUrlRef = useRef<string | null>(null);
  const previewRef = useRef<LoadedPreview | null>(null);
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
  const [activeRequest, setActiveRequest] = useState<WorkspaceFilePreviewOpenRequest | null>(null);
  const [imageTransitionDirection, setImageTransitionDirection] =
    useState<ImagePreviewTransitionDirection>(0);
  const [activeSheetName, setActiveSheetName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  const replacePreview = useCallback((next: LoadedPreview | null) => {
    if (previewBlobUrlRef.current) {
      URL.revokeObjectURL(previewBlobUrlRef.current);
    }
    previewBlobUrlRef.current = next?.blobUrl ?? null;
    previewRef.current = next;
    setActiveSheetName("");
    setPreview(next);
  }, []);

  useEffect(
    () => () => {
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = null;
      }
      previewRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (isOpen) {
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
        closeAnimationTimeoutRef.current = null;
      }
      const animationFrame = window.requestAnimationFrame(() => setIsVisible(true));
      return () => window.cancelAnimationFrame(animationFrame);
    }

    setIsVisible(false);
    closeAnimationTimeoutRef.current = window.setTimeout(() => {
      closeAnimationTimeoutRef.current = null;
      onClose();
    }, FILE_PREVIEW_OVERLAY_ANIMATION_MS);
  }, [isOpen, onClose]);

  useEffect(
    () => () => {
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
      }
    },
    [],
  );

  const loadPreview = useCallback(
    async (
      request: WorkspaceFilePreviewOpenRequest,
      transitionDirection: ImagePreviewTransitionDirection = 0,
    ) => {
      const sequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = sequence;
      const keepCurrentImagePreview =
        transitionDirection !== 0 &&
        previewRef.current?.kind === "image" &&
        getWorkspacePreviewKind(request.path) === "image";
      setImageTransitionDirection(transitionDirection);
      setLoading(true);
      setError(null);
      setRenderError(null);
      setActiveRequest(request);
      if (!keepCurrentImagePreview) {
        replacePreview(null);
      }
      try {
        const response = await invokeFs<ReadWorkspacePreviewResponse>("fs_read_workspace_image", {
          workdir: request.workdir,
          path: request.path,
        });
        if (loadSequenceRef.current !== sequence) return;
        const bytes = base64ToBytes(response.data);
        const kind = resolvePreviewKind(response.path || request.path, response.mimeType);
        const text = isTextPreviewKind(kind) ? decodePreviewText(bytes) : null;
        const blobBytes =
          kind === "html" && text !== null
            ? new TextEncoder().encode(buildSandboxedHtmlPreviewSource(text))
            : bytes;
        const blob = new Blob([bytesToArrayBuffer(blobBytes)], { type: response.mimeType });
        const loaded: LoadedPreview = {
          ...response,
          blobUrl: URL.createObjectURL(blob),
          bytes,
          kind,
          text,
        };
        replacePreview(loaded);
      } catch (loadError) {
        if (loadSequenceRef.current !== sequence) return;
        if (!keepCurrentImagePreview) {
          replacePreview(null);
        }
        setError(toMessage(loadError, t("workspaceFilePreview.openFailed")));
      } finally {
        if (loadSequenceRef.current === sequence) {
          setLoading(false);
        }
      }
    },
    [replacePreview, t],
  );

  useEffect(() => {
    if (!openRequest) {
      setActiveRequest(null);
      return;
    }
    void loadPreview(openRequest, 0);
  }, [loadPreview, openRequest]);

  const spreadsheet = useMemo(
    () => buildSpreadsheetTable(preview, activeSheetName, t("workspaceFilePreview.renderFailed")),
    [activeSheetName, preview, t],
  );

  useEffect(() => {
    if (!spreadsheet?.activeSheetName) return;
    setActiveSheetName((current) => current || spreadsheet.activeSheetName);
  }, [spreadsheet?.activeSheetName]);

  const activePreviewRequest = activeRequest ?? openRequest;
  // The request comes from the workspace file tree and retains its full logical path.
  const activePath = activePreviewRequest?.path ?? preview?.path ?? "";
  const kind = preview?.kind ?? (activePath ? getWorkspacePreviewKind(activePath) : null) ?? "text";
  const PreviewIcon = getPreviewIcon(kind);
  const imagePaths = useMemo(
    () =>
      kind === "image" ? normalizeImagePaths(activePreviewRequest?.imagePaths, activePath) : [],
    [activePath, activePreviewRequest?.imagePaths, kind],
  );
  const canOpenEditor = Boolean(activePreviewRequest && isWorkspaceEditablePreviewPath(activePath));
  const canOpenExternal = Boolean(
    supportsExternalWorkspaceOpen && activePreviewRequest && activePath,
  );
  const showHeaderOpenExternal = canOpenExternal && !canOpenEditor && kind !== "image";

  const openImagePath = useCallback(
    (path: string, transitionDirection: ImagePreviewTransitionDirection = 0) => {
      if (!activePreviewRequest || !path || path === activePath) return;
      void loadPreview({ ...activePreviewRequest, path }, transitionDirection);
    },
    [activePath, activePreviewRequest, loadPreview],
  );

  const openExternal = useCallback(async () => {
    if (!activePreviewRequest) return;
    const path = activePath || activePreviewRequest.path;
    try {
      setError(null);
      await invokeFs("fs_open_workspace_path", {
        workdir: activePreviewRequest.workdir,
        path,
        mode: "open",
      });
    } catch (openError) {
      setError(toMessage(openError, t("workspaceFilePreview.openExternalFailed")));
    }
  }, [activePath, activePreviewRequest, t]);

  return (
    <div
      className={cn(
        "workspace-file-preview-overlay absolute inset-0 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        workspaceOverlayStackClassName,
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <WorkspaceOverlayTitleBar />
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/45 px-3">
        <PreviewIcon className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceFilePreview.title")}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{activePath}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canOpenEditor && activePreviewRequest ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("workspaceFilePreview.edit")}
              aria-label={t("workspaceFilePreview.edit")}
              onClick={() =>
                onOpenEditor({
                  ...activePreviewRequest,
                  path: activePath || activePreviewRequest.path,
                })
              }
            >
              <FilePenLine className="h-4 w-4" />
            </button>
          ) : null}
          {showHeaderOpenExternal ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("workspaceFilePreview.openExternal")}
              aria-label={t("workspaceFilePreview.openExternal")}
              onClick={() => void openExternal()}
            >
              <ExternalLink className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
            title={t("workspaceFilePreview.reload")}
            aria-label={t("workspaceFilePreview.reload")}
            disabled={!activePreviewRequest || loading}
            onClick={() => activePreviewRequest && void loadPreview(activePreviewRequest, 0)}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("workspaceFilePreview.close")}
            aria-label={t("workspaceFilePreview.close")}
            onClick={onRequestClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error || renderError || spreadsheet?.error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 truncate">
            {error ?? renderError ?? spreadsheet?.error}
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden bg-muted/25">
        {preview ? (
          <PreviewBody
            preview={preview}
            workdir={activePreviewRequest?.workdir ?? ""}
            activePath={activePath}
            imagePaths={imagePaths}
            imageTransitionDirection={imageTransitionDirection}
            isSwitchingImage={loading && preview.kind === "image"}
            canOpenImageInSystemViewer={canOpenExternal}
            spreadsheet={spreadsheet}
            activeSheetName={activeSheetName}
            onOpenImageInSystemViewer={() => void openExternal()}
            onOpenImagePath={openImagePath}
            onActiveSheetNameChange={setActiveSheetName}
            onActionError={setError}
            onRenderError={setRenderError}
          />
        ) : loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <FileText className="h-7 w-7" />
            <span>{t("workspaceFilePreview.empty")}</span>
          </div>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/35 px-3 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{activePath}</span>
        {preview ? (
          <span className="shrink-0">
            {preview.mimeType} · {formatBytes(preview.sizeBytes)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function PreviewBody(props: {
  preview: LoadedPreview;
  workdir: string;
  activePath: string;
  imagePaths: string[];
  imageTransitionDirection: ImagePreviewTransitionDirection;
  isSwitchingImage: boolean;
  canOpenImageInSystemViewer: boolean;
  spreadsheet: SpreadsheetTable | null;
  activeSheetName: string;
  onOpenImageInSystemViewer: () => void;
  onOpenImagePath: (path: string, direction?: ImagePreviewTransitionDirection) => void;
  onActiveSheetNameChange: (sheetName: string) => void;
  onActionError: (message: string | null) => void;
  onRenderError: (message: string | null) => void;
}) {
  const {
    preview,
    workdir,
    activePath,
    imagePaths,
    imageTransitionDirection,
    isSwitchingImage,
    canOpenImageInSystemViewer,
    spreadsheet,
    activeSheetName,
    onOpenImageInSystemViewer,
    onOpenImagePath,
    onActiveSheetNameChange,
    onActionError,
    onRenderError,
  } = props;
  const { t } = useLocale();
  const docxContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (preview.kind !== "document") return;
    const container = docxContainerRef.current;
    if (!container) return;
    let cancelled = false;
    container.innerHTML = "";
    onRenderError(null);
    void renderAsync(bytesToArrayBuffer(preview.bytes), container, undefined, {
      className: "workspace-docx-preview",
      inWrapper: true,
      ignoreFonts: false,
      breakPages: true,
      useBase64URL: true,
    }).catch((docxError) => {
      if (!cancelled) {
        onRenderError(toMessage(docxError, t("workspaceFilePreview.renderFailed")));
      }
    });
    return () => {
      cancelled = true;
      container.innerHTML = "";
    };
  }, [onRenderError, preview, t]);

  if (preview.kind === "image") {
    return (
      <WorkspaceImagePreviewBody
        key={`${preview.path}:${preview.contentHash}`}
        activePath={activePath}
        canOpenInSystemViewer={canOpenImageInSystemViewer}
        imagePaths={imagePaths}
        transitionDirection={imageTransitionDirection}
        isSwitchingImage={isSwitchingImage}
        preview={preview}
        workdir={workdir}
        onOpenInSystemViewer={onOpenImageInSystemViewer}
        onOpenImagePath={onOpenImagePath}
        onActionError={onActionError}
      />
    );
  }

  if (preview.kind === "pdf") {
    return (
      <iframe
        className="h-full w-full border-0 bg-background"
        src={preview.blobUrl}
        title={basename(preview.path)}
      />
    );
  }

  if (preview.kind === "html") {
    return (
      <iframe
        className="h-full w-full border-0 bg-background"
        sandbox="allow-scripts allow-forms allow-modals allow-pointer-lock allow-popups"
        src={preview.blobUrl}
        title={basename(preview.path)}
      />
    );
  }

  if (preview.kind === "markdown") {
    return (
      <div className="h-full overflow-auto bg-background px-6 py-5">
        <WorkspaceMarkdownPreview
          workdir={workdir}
          markdownPath={preview.path || activePath}
          content={preview.text ?? ""}
          className="text-sm leading-6"
          onOpenWorkspacePath={(path) => onOpenImagePath(path, 0)}
        />
      </div>
    );
  }

  if (preview.kind === "document") {
    return (
      <div className="h-full overflow-auto bg-neutral-200 p-4 dark:bg-neutral-950">
        <div ref={docxContainerRef} className="workspace-file-preview-docx min-h-full" />
      </div>
    );
  }

  if (preview.kind === "spreadsheet") {
    return (
      <div className="flex h-full min-h-0 flex-col bg-background">
        {spreadsheet && spreadsheet.sheetNames.length > 1 ? (
          <div className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-muted/35 px-2">
            {spreadsheet.sheetNames.map((sheetName) => (
              <button
                key={sheetName}
                type="button"
                className={cn(
                  "h-7 max-w-48 shrink-0 truncate rounded-md px-2.5 text-xs transition-colors",
                  (activeSheetName || spreadsheet.activeSheetName) === sheetName
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
                title={sheetName}
                onClick={() => onActiveSheetNameChange(sheetName)}
              >
                {sheetName}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-auto">
          {spreadsheet?.rows.length ? (
            <table className="min-w-full border-separate border-spacing-0 text-xs">
              <tbody>
                {spreadsheet.rows.map((row, rowIndex) => (
                  <tr key={row.id} className={rowIndex === 0 ? "bg-muted/60" : ""}>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.id}
                        className={cn(
                          "max-w-80 whitespace-pre-wrap border-b border-r border-border px-2 py-1.5 align-top",
                          rowIndex === 0 && "font-semibold text-foreground",
                        )}
                      >
                        {cell.value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("workspaceFilePreview.emptySheet")}
            </div>
          )}
        </div>
        {spreadsheet?.truncatedRows || spreadsheet?.truncatedColumns ? (
          <div className="shrink-0 border-t border-border bg-muted/35 px-3 py-1.5 text-[11px] text-muted-foreground">
            {t("workspaceFilePreview.truncated")}
          </div>
        ) : null}
      </div>
    );
  }

  if (preview.kind === "audio") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {/* biome-ignore lint/a11y/useMediaCaption: Workspace media previews do not have a separate caption track available. */}
        <audio className="w-full max-w-2xl" controls src={preview.blobUrl}>
          {basename(preview.path)}
        </audio>
      </div>
    );
  }

  if (preview.kind === "video") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto p-4 sm:p-6">
        {/* biome-ignore lint/a11y/useMediaCaption: Workspace media previews do not have a separate caption track available. */}
        <video className="max-h-full max-w-full bg-black" controls src={preview.blobUrl}>
          {basename(preview.path)}
        </video>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto bg-background p-4">
      <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-foreground">
        {preview.text ?? ""}
      </pre>
    </div>
  );
}

function ImagePreviewToolButton(props: {
  label: string;
  disabled?: boolean;
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const { label, disabled, pressed, onClick, children } = props;
  return (
    <button
      type="button"
      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function imageViewerAnchor(
  event: { clientX: number; clientY: number },
  viewport: HTMLDivElement | null,
) {
  const rect = viewport?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return {
    x: event.clientX - rect.left - rect.width / 2,
    y: event.clientY - rect.top - rect.height / 2,
  };
}

function formatImageDimensions(width: number, height: number) {
  return width > 0 && height > 0 ? `${width} x ${height}` : "";
}

async function savePreviewImage(preview: LoadedPreview) {
  await saveWorkspacePreviewImage({
    data: preview.data,
    fileName: basename(preview.path) || "image",
    mimeType: preview.mimeType,
  });
}

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Text clipboard is unavailable");
}

function WorkspaceImagePreviewBody(props: {
  preview: LoadedPreview;
  workdir: string;
  activePath: string;
  imagePaths: string[];
  canOpenInSystemViewer: boolean;
  transitionDirection: ImagePreviewTransitionDirection;
  isSwitchingImage: boolean;
  onOpenInSystemViewer: () => void;
  onOpenImagePath: (path: string, direction?: ImagePreviewTransitionDirection) => void;
  onActionError: (message: string | null) => void;
}) {
  const {
    preview,
    workdir,
    activePath,
    imagePaths,
    canOpenInSystemViewer,
    transitionDirection,
    isSwitchingImage,
    onOpenInSystemViewer,
    onOpenImagePath,
    onActionError,
  } = props;
  const { t } = useLocale();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [viewerState, setViewerState] = useState<ImageViewerState>(resetImageViewerState);
  const [viewportSize, setViewportSize] = useState<ImageViewerSize>({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState<ImageViewerSize>({ width: 0, height: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [contextMenuPosition, setContextMenuPosition] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [isEntering, setIsEntering] = useState(true);

  const activeImageIndex = imagePaths.indexOf(activePath);
  const imageCount = Math.max(imagePaths.length, 1);
  const imageNumber = activeImageIndex >= 0 ? activeImageIndex + 1 : 1;
  const canOpenPrevious = activeImageIndex > 0;
  const canOpenNext = activeImageIndex >= 0 && activeImageIndex < imagePaths.length - 1;
  const canZoomOut = viewerState.scale > IMAGE_VIEWER_MIN_SCALE;
  const canZoomIn = viewerState.scale < IMAGE_VIEWER_MAX_SCALE;
  const counter = t("workspaceFilePreview.imageCounter")
    .replace("{index}", String(imageNumber))
    .replace("{total}", String(imageCount));

  const imageSize = useMemo(
    () => fitImageViewerSize(naturalSize, viewportSize, viewerState.rotation),
    [naturalSize, viewportSize, viewerState.rotation],
  );
  const viewerOptions = useMemo(() => ({ imageSize, viewportSize }), [imageSize, viewportSize]);
  const displayDimensions = formatImageDimensions(naturalSize.width, naturalSize.height);
  const maxPan = clampImageViewerPan(
    { x: 1_000_000, y: 1_000_000 },
    {
      ...viewerOptions,
      scale: viewerState.scale,
      rotation: viewerState.rotation,
    },
  );
  const canPan = maxPan.x > 0 || maxPan.y > 0;

  const openImageAt = useCallback(
    (index: number) => {
      const path = imagePaths[index];
      if (!path) return;
      onOpenImagePath(path, index > activeImageIndex ? 1 : -1);
    },
    [activeImageIndex, imagePaths, onOpenImagePath],
  );

  useEffect(() => {
    const animationFrame = window.requestAnimationFrame(() => setIsEntering(false));
    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateViewportSize = () => {
      setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    };
    updateViewportSize();
    const observer = new ResizeObserver(updateViewportSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  // A fixed menu needs its actual rendered size to avoid overflowing the
  // browser viewport near the lower-right corner.
  useLayoutEffect(() => {
    if (!contextMenu || contextMenuPosition) return;
    const menu = contextMenuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const inset = 8;
    setContextMenuPosition({
      x: Math.max(inset, Math.min(contextMenu.x, window.innerWidth - rect.width - inset)),
      y: Math.max(inset, Math.min(contextMenu.y, window.innerHeight - rect.height - inset)),
    });
  }, [contextMenu, contextMenuPosition]);

  useEffect(() => {
    setViewerState((current) => clampImageViewerState(current, viewerOptions));
  }, [viewerOptions]);

  useEffect(() => {
    if (!contextMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current?.contains(event.target as Node)) return;
      setContextMenu(null);
      setContextMenuPosition(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [contextMenu]);

  const enterTranslateX = transitionDirection > 0 ? 18 : transitionDirection < 0 ? -18 : 0;
  const enterScale = transitionDirection === 0 ? 0.985 : 0.99;

  const zoomByStep = useCallback(
    (direction: -1 | 1, anchor = { x: 0, y: 0 }) => {
      setViewerState((current) =>
        zoomImageViewerAtPoint(
          current,
          imageViewerScaleAfterStep(current.scale, direction),
          anchor,
          viewerOptions,
        ),
      );
    },
    [viewerOptions],
  );

  const zoomByWheel = useCallback(
    (deltaY: number, deltaMode: number, anchor: { x: number; y: number }) => {
      setViewerState((current) =>
        zoomImageViewerAtPoint(
          current,
          imageViewerScaleAfterWheelDelta(current.scale, deltaY, deltaMode),
          anchor,
          viewerOptions,
        ),
      );
    },
    [viewerOptions],
  );

  const rotateImage = useCallback(
    (direction: -1 | 1) => {
      setViewerState((current) =>
        clampImageViewerState(
          { ...current, rotation: current.rotation + direction * 90 },
          viewerOptions,
        ),
      );
    },
    [viewerOptions],
  );

  const handleCopyImage = useCallback(async () => {
    try {
      await copyWorkspacePreviewImage({
        data: preview.data,
        mimeType: preview.mimeType,
      });
    } catch (error) {
      onActionError(toMessage(error, t("workspaceFilePreview.copyImageFailed")));
    }
  }, [onActionError, preview, t]);

  const handleCopyAbsolutePath = useCallback(async () => {
    try {
      await copyTextToClipboard(workspaceImageAbsolutePathForCopy(workdir, activePath));
    } catch (error) {
      onActionError(toMessage(error, t("workspaceFilePreview.copyPathFailed")));
    }
  }, [activePath, onActionError, t, workdir]);

  const handleCopyRelativePath = useCallback(async () => {
    try {
      await copyTextToClipboard(workspaceImageRelativePathForCopy(workdir, activePath));
    } catch (error) {
      onActionError(toMessage(error, t("workspaceFilePreview.copyPathFailed")));
    }
  }, [activePath, onActionError, t, workdir]);

  const handleSaveImage = useCallback(async () => {
    try {
      await savePreviewImage(preview);
    } catch (error) {
      onActionError(toMessage(error, t("workspaceFilePreview.saveImageFailed")));
    }
  }, [onActionError, preview, t]);

  const handleFullscreen = useCallback(async () => {
    const viewport = viewportRef.current;
    if (!viewport?.requestFullscreen) {
      onActionError(t("workspaceFilePreview.fullscreenFailed"));
      return;
    }
    try {
      await viewport.requestFullscreen();
    } catch (error) {
      onActionError(toMessage(error, t("workspaceFilePreview.fullscreenFailed")));
    }
  }, [onActionError, t]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (contextMenu) {
        event.preventDefault();
        setContextMenu(null);
        setContextMenuPosition(null);
        return;
      }
      if (showInfo) {
        event.preventDefault();
        setShowInfo(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [contextMenu, showInfo]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-muted/25">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 overflow-x-auto border-b border-border bg-background/90 px-2">
        <div className="flex min-w-0 items-center gap-1">
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.previousImage")}
            disabled={!canOpenPrevious || isSwitchingImage}
            onClick={() => openImageAt(activeImageIndex - 1)}
          >
            <ChevronRight className="h-4 w-4 rotate-180" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.nextImage")}
            disabled={!canOpenNext || isSwitchingImage}
            onClick={() => openImageAt(activeImageIndex + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </ImagePreviewToolButton>
          <span className="ml-1 shrink-0 text-[11px] text-muted-foreground">{counter}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.zoomOut")}
            disabled={!canZoomOut}
            onClick={() => zoomByStep(-1)}
          >
            <Minus className="h-4 w-4" />
          </ImagePreviewToolButton>
          <span className="w-11 text-center text-[11px] tabular-nums text-muted-foreground">
            {Math.round(viewerState.scale * 100)}%
          </span>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.zoomIn")}
            disabled={!canZoomIn}
            onClick={() => zoomByStep(1)}
          >
            <Plus className="h-4 w-4" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.rotateLeft")}
            onClick={() => rotateImage(-1)}
          >
            <RotateCwSquare className="h-4 w-4 -scale-x-100" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.rotateRight")}
            onClick={() => rotateImage(1)}
          >
            <RotateCwSquare className="h-4 w-4" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.resetImage")}
            onClick={() => setViewerState(resetImageViewerState())}
          >
            <RefreshCw className="h-4 w-4" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.downloadImage")}
            onClick={() => void handleSaveImage()}
          >
            <Download className="h-4 w-4" />
          </ImagePreviewToolButton>
          {canOpenInSystemViewer ? (
            <ImagePreviewToolButton
              label={t("workspaceFilePreview.openInSystemImageViewer")}
              onClick={onOpenInSystemViewer}
            >
              <ExternalLink className="h-4 w-4" />
            </ImagePreviewToolButton>
          ) : null}
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.copyImage")}
            onClick={() => void handleCopyImage()}
          >
            <Copy className="h-4 w-4" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.toggleImageInfo")}
            pressed={showInfo}
            onClick={() => setShowInfo((current) => !current)}
          >
            <Info className="h-4 w-4" />
          </ImagePreviewToolButton>
          <ImagePreviewToolButton
            label={t("workspaceFilePreview.fullscreen")}
            onClick={() => void handleFullscreen()}
          >
            <Maximize2 className="h-4 w-4" />
          </ImagePreviewToolButton>
        </div>
      </div>
      <div
        ref={viewportRef}
        role="application"
        aria-label={t("workspaceFilePreview.imageViewer")}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The application-role viewport takes focus so its copy/reset shortcuts stay scoped to it instead of a window listener.
        tabIndex={0}
        className={cn(
          "relative min-h-0 flex-1 touch-none select-none overflow-hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          isDragging ? "cursor-grabbing" : canPan ? "cursor-grab" : "cursor-default",
        )}
        onKeyDown={(event) => {
          // Scoped to the focused viewport so chat/sidebar inputs keep native
          // copy and digit keys while the preview is open.
          if (event.currentTarget !== event.target || event.defaultPrevented) return;
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "c"
          ) {
            event.preventDefault();
            void handleCopyImage();
            return;
          }
          if (event.key === "0" && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault();
            setViewerState(resetImageViewerState());
          }
        }}
        onWheel={(event) => {
          if (event.deltaY === 0) return;
          event.preventDefault();
          zoomByWheel(event.deltaY, event.deltaMode, imageViewerAnchor(event, viewportRef.current));
        }}
        onPointerDown={(event) => {
          event.currentTarget.focus({ preventScroll: true });
          if (contextMenu) {
            setContextMenu(null);
            setContextMenuPosition(null);
            return;
          }
          if (event.button !== 0 || !canPan) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            originX: viewerState.x,
            originY: viewerState.y,
          };
          setIsDragging(true);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          setViewerState((current) => ({
            ...current,
            ...clampImageViewerPan(
              {
                x: drag.originX + event.clientX - drag.startX,
                y: drag.originY + event.clientY - drag.startY,
              },
              { ...viewerOptions, scale: current.scale, rotation: current.rotation },
            ),
          }));
        }}
        onPointerUp={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          dragRef.current = null;
          setIsDragging(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragRef.current = null;
          setIsDragging(false);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ x: event.clientX, y: event.clientY });
          setContextMenuPosition(null);
        }}
      >
        {isSwitchingImage ? (
          <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-background/85 text-muted-foreground shadow-sm backdrop-blur">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : null}
        <div
          className="absolute inset-0 flex items-center justify-center transition-[opacity,transform,filter] duration-200 ease-out motion-reduce:transition-none"
          style={{
            filter: isEntering ? "blur(1px)" : "blur(0px)",
            opacity: isEntering ? 0 : 1,
            transform: isEntering
              ? `translateX(${enterTranslateX}px) scale(${enterScale})`
              : "translateX(0) scale(1)",
          }}
        >
          <div
            className="relative shrink-0"
            style={{
              height: `${imageSize.height}px`,
              width: `${imageSize.width}px`,
              transform: `translate(${viewerState.x}px, ${viewerState.y}px) scale(${viewerState.scale})`,
              transformOrigin: "center",
              transition: isDragging ? "none" : "transform 120ms ease-out",
            }}
          >
            <div
              className="h-full w-full"
              style={{ transform: `rotate(${viewerState.rotation}deg)`, transformOrigin: "center" }}
            >
              <img
                className="h-full w-full select-none object-contain"
                src={preview.blobUrl}
                alt={basename(preview.path)}
                draggable={false}
                onLoad={(event) => {
                  setNaturalSize({
                    width: event.currentTarget.naturalWidth,
                    height: event.currentTarget.naturalHeight,
                  });
                }}
              />
            </div>
          </div>
        </div>
        {showInfo ? (
          <aside
            aria-label={t("workspaceFilePreview.imageInfo")}
            className="absolute right-3 top-3 z-10 w-64 border border-border bg-popover/95 p-3 text-xs text-popover-foreground shadow-xl backdrop-blur"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-sm font-semibold">{t("workspaceFilePreview.imageInfo")}</div>
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title={t("workspaceFilePreview.close")}
                aria-label={t("workspaceFilePreview.close")}
                onClick={() => setShowInfo(false)}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-muted-foreground">
              <dt>{t("workspaceFilePreview.fileName")}</dt>
              <dd className="truncate text-right text-foreground" title={basename(preview.path)}>
                {basename(preview.path)}
              </dd>
              <dt>{t("workspaceFilePreview.dimensions")}</dt>
              <dd className="text-right text-foreground">{displayDimensions || "-"}</dd>
              <dt>{t("workspaceFilePreview.fileSize")}</dt>
              <dd className="text-right text-foreground">{formatBytes(preview.sizeBytes)}</dd>
              <dt>{t("workspaceFilePreview.fileType")}</dt>
              <dd className="truncate text-right text-foreground" title={preview.mimeType}>
                {preview.mimeType}
              </dd>
            </dl>
          </aside>
        ) : null}
        {contextMenu
          ? createPortal(
              <div
                ref={contextMenuRef}
                role="menu"
                className="fixed z-[90] min-w-48 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-2xl"
                style={{
                  left: (contextMenuPosition ?? contextMenu).x,
                  top: (contextMenuPosition ?? contextMenu).y,
                  visibility: contextMenuPosition ? undefined : "hidden",
                }}
                onPointerDown={(event) => event.stopPropagation()}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    setViewerState(resetImageViewerState());
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.resetImage")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    rotateImage(-1);
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <RotateCwSquare className="h-3.5 w-3.5 -scale-x-100" />
                  {t("workspaceFilePreview.rotateLeft")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    rotateImage(1);
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <RotateCwSquare className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.rotateRight")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    void handleSaveImage();
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <Download className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.downloadImage")}
                </button>
                {canOpenInSystemViewer ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                    onClick={() => {
                      onOpenInSystemViewer();
                      setContextMenu(null);
                      setContextMenuPosition(null);
                    }}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t("workspaceFilePreview.openInSystemImageViewer")}
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    void handleCopyImage();
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.copyImage")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    void handleCopyAbsolutePath();
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.copyImageAbsolutePath")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    void handleCopyRelativePath();
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.copyImageRelativePath")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    setShowInfo(true);
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <Info className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.imageInfo")}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent"
                  onClick={() => {
                    void handleFullscreen();
                    setContextMenu(null);
                    setContextMenuPosition(null);
                  }}
                >
                  <Maximize2 className="h-3.5 w-3.5" />
                  {t("workspaceFilePreview.fullscreen")}
                </button>
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  );
}
