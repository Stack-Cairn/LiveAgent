import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n";
import { cn } from "@/lib/shared/utils";
import { AlertTriangle, ImageIcon, ImageOff, Loader2, RefreshCw, X } from "../icons";

export type WorkspaceImagePreviewOpenRequest = {
  id: number;
  projectPathKey: string;
  workdir: string;
  path: string;
};

type ReadWorkspaceImageResponse = {
  path: string;
  mimeType: string;
  data: string;
  sizeBytes: number;
};

type WorkspaceImagePreviewOverlayProps = {
  openRequest: WorkspaceImagePreviewOpenRequest | null;
  isOpen: boolean;
  onRequestClose: () => void;
  onClose: () => void;
};

const IMAGE_PREVIEW_OVERLAY_ANIMATION_MS = 180;

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

export function WorkspaceImagePreviewOverlay(props: WorkspaceImagePreviewOverlayProps) {
  const { openRequest, isOpen, onRequestClose, onClose } = props;
  const { t } = useLocale();
  const closeAnimationTimeoutRef = useRef<number | null>(null);
  const loadSequenceRef = useRef(0);
  const [image, setImage] = useState<ReadWorkspaceImageResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

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
    }, IMAGE_PREVIEW_OVERLAY_ANIMATION_MS);
  }, [isOpen, onClose]);

  useEffect(
    () => () => {
      if (closeAnimationTimeoutRef.current !== null) {
        window.clearTimeout(closeAnimationTimeoutRef.current);
      }
    },
    [],
  );

  const loadImage = useCallback(
    async (request: WorkspaceImagePreviewOpenRequest) => {
      const sequence = loadSequenceRef.current + 1;
      loadSequenceRef.current = sequence;
      setLoading(true);
      setError(null);
      setImage(null);
      try {
        const response = await invoke<ReadWorkspaceImageResponse>("fs_read_workspace_image", {
          workdir: request.workdir,
          path: request.path,
        });
        if (loadSequenceRef.current !== sequence) return;
        setImage(response);
      } catch (loadError) {
        if (loadSequenceRef.current !== sequence) return;
        setImage(null);
        setError(toMessage(loadError, t("workspaceImagePreview.openFailed")));
      } finally {
        if (loadSequenceRef.current === sequence) {
          setLoading(false);
        }
      }
    },
    [t],
  );

  useEffect(() => {
    if (!openRequest) return;
    void loadImage(openRequest);
  }, [loadImage, openRequest]);

  const source = image ? `data:${image.mimeType};base64,${image.data}` : "";
  const activePath = image?.path ?? openRequest?.path ?? "";

  return (
    <div
      className={cn(
        "workspace-image-preview-overlay absolute inset-0 z-40 flex min-h-0 min-w-0 transform-gpu flex-col overflow-hidden border-r border-border bg-background transition-[opacity,transform,box-shadow] duration-200 ease-out motion-reduce:transition-none",
        isVisible
          ? "pointer-events-auto translate-x-0 opacity-100 shadow-2xl"
          : "pointer-events-none -translate-x-2 opacity-0 shadow-lg",
      )}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-muted/45 px-3">
        <ImageIcon className="h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold leading-tight">
            {t("workspaceImagePreview.title")}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{activePath}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-45"
            title={t("workspaceImagePreview.reload")}
            aria-label={t("workspaceImagePreview.reload")}
            disabled={!openRequest || loading}
            onClick={() => openRequest && void loadImage(openRequest)}
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </button>
          <button
            type="button"
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={t("workspaceImagePreview.close")}
            aria-label={t("workspaceImagePreview.close")}
            onClick={onRequestClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="min-w-0 flex-1 truncate">{error}</div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/25 p-4 sm:p-6">
        {loading ? (
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        ) : source ? (
          <img
            className="max-h-full max-w-full object-contain"
            src={source}
            alt={basename(activePath)}
          />
        ) : (
          <div className="flex flex-col items-center gap-3 text-center text-sm text-muted-foreground">
            <ImageOff className="h-7 w-7" />
            <span>{t("workspaceImagePreview.empty")}</span>
          </div>
        )}
      </div>

      <div className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border bg-muted/35 px-3 text-[11px] text-muted-foreground">
        <span className="min-w-0 truncate">{activePath}</span>
        {image ? (
          <span className="shrink-0">
            {image.mimeType} · {formatBytes(image.sizeBytes)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
