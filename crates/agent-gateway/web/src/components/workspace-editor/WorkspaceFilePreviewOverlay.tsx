import { invoke } from "@tauri-apps/api/core";
import { renderAsync } from "docx-preview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { read, utils } from "xlsx";
import { useLocale } from "@/i18n";
import { cn } from "@/lib/shared/utils";
import type { IconComponent } from "../icons";
import {
  AlertTriangle,
  FilePenLine,
  FileText,
  FileTypeAudio,
  FileTypeExcel,
  FileTypeHtml,
  FileTypeMarkdown,
  FileTypePdf,
  FileTypeVideo,
  FileTypeWord,
  ImageIcon,
  Loader2,
  RefreshCw,
  X,
} from "../icons";
import { Markdown } from "@/components/Markdown";
import {
  getWorkspacePreviewKind,
  isWorkspaceEditablePreviewPath,
  type WorkspacePreviewKind,
} from "./workspaceImagePreview";

export type WorkspaceFilePreviewOpenRequest = {
  id: number;
  projectPathKey: string;
  workdir: string;
  path: string;
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

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function getPreviewIcon(kind: WorkspacePreviewKind): IconComponent {
  switch (kind) {
    case "audio":
      return FileTypeAudio;
    case "document":
      return FileTypeWord;
    case "html":
      return FileTypeHtml;
    case "image":
      return ImageIcon;
    case "markdown":
      return FileTypeMarkdown;
    case "pdf":
      return FileTypePdf;
    case "spreadsheet":
      return FileTypeExcel;
    case "video":
      return FileTypeVideo;
    case "text":
      return FileText;
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
  const [preview, setPreview] = useState<LoadedPreview | null>(null);
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
    setActiveSheetName("");
    setPreview(next);
  }, []);

  useEffect(
    () => () => {
      if (previewBlobUrlRef.current) {
        URL.revokeObjectURL(previewBlobUrlRef.current);
        previewBlobUrlRef.current = null;
      }
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
    async (request: WorkspaceFilePreviewOpenRequest) => {
      const sequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = sequence;
      setLoading(true);
      setError(null);
      setRenderError(null);
      replacePreview(null);
      try {
        const response = await invoke<ReadWorkspacePreviewResponse>("fs_read_workspace_image", {
          workdir: request.workdir,
          path: request.path,
        });
        if (loadSequenceRef.current !== sequence) return;
        const bytes = base64ToBytes(response.data);
        const kind = resolvePreviewKind(response.path || request.path, response.mimeType);
        const blob = new Blob([bytesToArrayBuffer(bytes)], { type: response.mimeType });
        const loaded: LoadedPreview = {
          ...response,
          blobUrl: URL.createObjectURL(blob),
          bytes,
          kind,
          text: isTextPreviewKind(kind) ? decodePreviewText(bytes) : null,
        };
        replacePreview(loaded);
      } catch (loadError) {
        if (loadSequenceRef.current !== sequence) return;
        replacePreview(null);
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
    if (!openRequest) return;
    void loadPreview(openRequest);
  }, [loadPreview, openRequest]);

  const spreadsheet = useMemo(
    () => buildSpreadsheetTable(preview, activeSheetName, t("workspaceFilePreview.renderFailed")),
    [activeSheetName, preview, t],
  );

  useEffect(() => {
    if (!spreadsheet?.activeSheetName) return;
    setActiveSheetName((current) => current || spreadsheet.activeSheetName);
  }, [spreadsheet?.activeSheetName]);

  const activePath = preview?.path ?? openRequest?.path ?? "";
  const kind = preview?.kind ?? (activePath ? getWorkspacePreviewKind(activePath) : null) ?? "text";
  const PreviewIcon = getPreviewIcon(kind);
  const canOpenEditor = Boolean(openRequest && isWorkspaceEditablePreviewPath(activePath));

  return (
    <div
      className={cn(
        "workspace-file-preview-overlay absolute inset-0 z-40 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/45 px-3">
        <PreviewIcon className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceFilePreview.title")}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{activePath}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {canOpenEditor && openRequest ? (
            <button
              type="button"
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title={t("workspaceFilePreview.edit")}
              aria-label={t("workspaceFilePreview.edit")}
              onClick={() => onOpenEditor({ ...openRequest, path: activePath || openRequest.path })}
            >
              <FilePenLine className="h-4 w-4" />
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
            title={t("workspaceFilePreview.reload")}
            aria-label={t("workspaceFilePreview.reload")}
            disabled={!openRequest || loading}
            onClick={() => openRequest && void loadPreview(openRequest)}
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
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : preview ? (
          <PreviewBody
            preview={preview}
            spreadsheet={spreadsheet}
            activeSheetName={activeSheetName}
            onActiveSheetNameChange={setActiveSheetName}
            onRenderError={setRenderError}
          />
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
  spreadsheet: SpreadsheetTable | null;
  activeSheetName: string;
  onActiveSheetNameChange: (sheetName: string) => void;
  onRenderError: (message: string | null) => void;
}) {
  const { preview, spreadsheet, activeSheetName, onActiveSheetNameChange, onRenderError } = props;
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
      <div className="flex h-full items-center justify-center overflow-auto p-4 sm:p-6">
        <img
          className="max-h-full max-w-full object-contain"
          src={preview.blobUrl}
          alt={basename(preview.path)}
        />
      </div>
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
        <Markdown content={preview.text ?? ""} className="text-sm leading-6" readOnly />
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
