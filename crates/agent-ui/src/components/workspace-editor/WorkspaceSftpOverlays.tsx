import { CheckCircle2, Download, Loader2, Upload } from "@liveagent/ui/components/IconSet";
import type { SftpEntry, SftpTransfer } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  basename,
  type DragPayload,
  dragItems,
  entryIcon,
  formatBytes,
  transferProgress,
  transferTone,
} from "./workspaceSftpModel";

export function CreateFolderDialog(props: {
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

export function CopyPathDialog(props: {
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

export function CopyPathToast(props: { message: string }) {
  return (
    <div className="pointer-events-none absolute bottom-14 right-4 z-[90]">
      <div className="notify-toast-enter flex min-w-56 items-center gap-2 rounded-lg border border-emerald-500/25 bg-background/95 px-3 py-2 text-sm font-medium text-foreground shadow-2xl backdrop-blur-xl">
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-300" />
        <span>{props.message}</span>
      </div>
    </div>
  );
}

export function RenameEntryDialog(props: {
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

export function TransferToast(props: {
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

export function DragPreview(props: {
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

export function MenuItem(props: {
  icon: ReactNode;
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
