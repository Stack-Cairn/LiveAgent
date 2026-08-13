// Headless folder picker dialog (international-style directory selector).
//
// Used when running as a plain browser against the headless server: the
// desktop runtime gets a native folder dialog, but in headless mode there is
// no OS dialog, so this component offers a Finder/Explorer/VS Code style
// directory browser instead of a bare text input:
//
//   - breadcrumb navigation (click any path segment to jump)
//   - current-directory listing via fs_list_dirs (double-click to enter)
//   - sidebar quick locations via fs_roots (root "/", home "~")
//   - "up one level" button
//   - editable path input (Enter to jump)
//   - keyboard navigation (↑/↓ move, → enter, ← up, Enter confirm, Esc cancel)
//   - hidden-directory toggle
//
// The imperative API mirrors `system_pick_folder`: call openFolderPicker()
// and await the chosen absolute path (or null when cancelled).

import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderTree,
  House,
  Info,
  Loader2,
  X,
} from "@liveagent/ui/components/IconSet";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { invokeFs } from "@liveagent/ui/lib/tools/fsBackend";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { DEFAULT_LOCALE, type Locale, t as translate } from "../../../i18n/config";

type FsDirEntry = {
  path: string;
  name: string;
};

type FsListDirsResponse = {
  path: string;
  entries: FsDirEntry[];
  truncated: boolean;
};

type FsRoot = {
  id: string;
  path: string;
  kind: "home" | "root" | "drive";
  label: string;
};

type FsRootsResponse = {
  roots: FsRoot[];
};

type OpenFolderPickerOptions = {
  title?: string;
  initialPath?: string;
};

const UI_SETTINGS_STORAGE_KEY = "liveagent.ui-settings.v1";

function detectLocale(): Locale {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { locale?: unknown };
      const value = typeof parsed.locale === "string" ? parsed.locale : "";
      if (value === "zh-CN" || value === "en-US") return value;
    }
  } catch {
    // fall through to default locale
  }
  return DEFAULT_LOCALE;
}

const LIST_DIRS_LIMIT = 2000;

/** Absolute parent of an absolute path; null when already at a filesystem root. */
function parentPath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\/$/.test(normalized)) return null; // "C:\" drive root
  if (normalized === "/") return null;
  const trimmed = normalized.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) {
    return /^[A-Za-z]:$/.test(trimmed) ? `${trimmed}/` : "/";
  }
  return `${trimmed.slice(0, idx)}/`;
}

/** Breadcrumb segments: [{label, path}] from filesystem root down to `path`. */
function breadcrumbSegments(path: string): Array<{ label: string; path: string }> {
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized)) {
    const drive = normalized.slice(0, 2); // "C:"
    const rest = normalized
      .slice(2)
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);
    const segments = [{ label: drive, path: `${drive}/` }];
    let acc = `${drive}/`;
    for (const part of rest) {
      acc += `${part}/`;
      segments.push({ label: part, path: acc });
    }
    return segments;
  }
  if (!normalized.startsWith("/")) {
    return [{ label: normalized || "/", path: normalized }];
  }
  const parts = normalized.split("/").filter(Boolean);
  const segments = [{ label: "/", path: "/" }];
  let acc = "/";
  for (const part of parts) {
    acc += `${part}/`;
    segments.push({ label: part, path: acc });
  }
  return segments;
}

/** Best-effort "display name" of the last path segment (used in shortcuts). */
function pathBaseName(path: string): string {
  const trimmed = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function FolderPickerDialog({
  title,
  initialPath,
  locale,
  onResolve,
}: {
  title: string;
  initialPath: string;
  locale: Locale;
  onResolve: (path: string | null) => void;
}) {
  const t = useMemo(() => (key: string) => translate(key, locale), [locale]);

  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FsDirEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [roots, setRoots] = useState<FsRoot[]>([]);
  const [showHidden, setShowHidden] = useState(false);
  const [pathInput, setPathInput] = useState(initialPath);
  const [inputError, setInputError] = useState("");
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestIdRef = useRef(0);

  // Quick locations: fs_roots + the initial path (so the user can jump back).
  useEffect(() => {
    let cancelled = false;
    void invokeFs<FsRootsResponse>("fs_roots", {})
      .then((response) => {
        if (!cancelled) setRoots(response.roots ?? []);
      })
      .catch(() => {
        // fs_roots is best-effort; fall back to only the initial shortcut.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the directory listing whenever the current path changes.
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    setSelectedPath(null);
    setInputError("");
    setPathInput(currentPath);
    void invokeFs<FsListDirsResponse>("fs_list_dirs", {
      path: currentPath,
      max_results: LIST_DIRS_LIMIT,
    })
      .then((response) => {
        if (requestId !== requestIdRef.current) return;
        setEntries(response.entries ?? []);
        setTruncated(response.truncated === true);
      })
      .catch((reason) => {
        if (requestId !== requestIdRef.current) return;
        setEntries([]);
        setTruncated(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, [currentPath]);

  const visibleEntries = useMemo(
    () => (showHidden ? entries : entries.filter((entry) => !entry.name.startsWith("."))),
    [entries, showHidden],
  );

  const selectedIndex = useMemo(() => {
    const idx = visibleEntries.findIndex((entry) => entry.path === selectedPath);
    return idx;
  }, [selectedPath, visibleEntries]);

  const confirmSelection = useCallback(() => {
    // A highlighted entry wins (like Finder's "Choose" button); otherwise the
    // current directory itself is selected.
    if (selectedPath) {
      onResolve(selectedPath);
    } else {
      onResolve(currentPath);
    }
  }, [currentPath, onResolve, selectedPath]);

  const enterDirectory = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  const goUp = useCallback(() => {
    const parent = parentPath(currentPath);
    if (parent) setCurrentPath(parent);
  }, [currentPath]);

  const jumpTo = useCallback((path: string) => {
    setCurrentPath(path);
  }, []);

  // Keyboard navigation: ↑/↓ move, → enter, ← up, Enter confirm, Esc cancel.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onResolve(null);
        return;
      }
      if (loading) return;
      if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        if (visibleEntries.length === 0) return;
        const delta = event.key === "ArrowUp" ? -1 : 1;
        const nextIndex =
          selectedIndex < 0
            ? delta > 0
              ? 0
              : visibleEntries.length - 1
            : (selectedIndex + delta + visibleEntries.length) % visibleEntries.length;
        setSelectedPath(visibleEntries[nextIndex]?.path ?? null);
        listRef.current
          ?.querySelector(`[data-path="${CSS.escape(visibleEntries[nextIndex]?.path ?? "")}"]`)
          ?.scrollIntoView({ block: "nearest" });
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        const selected = visibleEntries[selectedIndex];
        if (selected) enterDirectory(selected.path);
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goUp();
        return;
      }
      if (event.key === "Enter" && document.activeElement !== inputRef.current) {
        event.preventDefault();
        confirmSelection();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmSelection, enterDirectory, goUp, loading, onResolve, selectedIndex, visibleEntries]);

  // Focus the dialog on mount so keyboard shortcuts work immediately.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const navigateToInputPath = useCallback(() => {
    const next = pathInput.trim();
    if (!next) return;
    setCurrentPath(next);
  }, [pathInput]);

  const rootsList = useMemo(() => {
    const items = roots.map((root) => ({
      key: root.id,
      path: root.path,
      icon: root.kind === "home" ? House : FolderTree,
      label:
        root.kind === "home"
          ? `${t("folderPicker.home")} (~)`
          : root.kind === "drive"
            ? root.label
            : root.label || root.path,
    }));

    const existingPaths = new Set(items.map((item) => item.path));

    // Docker / headless deployment common workspace
    const workspaceDir = "/workspace";
    if (!existingPaths.has(workspaceDir)) {
      items.push({
        key: `common:${workspaceDir}`,
        path: workspaceDir,
        icon: Folder,
        label: "/workspace",
      });
      existingPaths.add(workspaceDir);
    }

    const hasInitial = items.some((item) => item.path === initialPath);
    if (!hasInitial && initialPath.trim()) {
      items.unshift({
        key: `initial:${initialPath}`,
        path: initialPath,
        icon: FolderOpen,
        label: pathBaseName(initialPath) || initialPath,
      });
    }
    return items;
  }, [initialPath, roots, t]);

  const breadcrumbs = useMemo(() => breadcrumbSegments(currentPath), [currentPath]);
  const canGoUp = parentPath(currentPath) !== null;

  return createPortal(
    <div
      data-state="open"
      className="settings-modal-overlay fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="folder-picker-title"
    >
      <button
        type="button"
        className="absolute inset-0 cursor-default bg-black/25 backdrop-blur-md dark:bg-black/50"
        onClick={() => onResolve(null)}
        aria-label={t("settings.cancel")}
      />
      <div
        data-state="open"
        className="settings-modal-panel relative z-10 flex w-full max-w-3xl flex-col overflow-hidden rounded-[28px] border border-black/[0.07] bg-white/[0.93] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_32px_80px_-24px_rgba(0,0,0,0.35)] backdrop-blur-2xl backdrop-saturate-150 dark:border-white/10 dark:bg-background/[0.93] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_32px_80px_-24px_rgba(0,0,0,0.7)]"
      >
        {/* Header */}
        <div className="settings-modal-header flex items-center gap-3 border-b border-black/[0.06] px-6 py-4 dark:border-white/[0.08]">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl border border-black/[0.06] bg-white/80 text-foreground/70 shadow-sm dark:border-white/10 dark:bg-white/[0.07] dark:text-foreground/80">
            <FolderOpen className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="folder-picker-title" className="text-base font-semibold">
              {title}
            </h2>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {t("folderPicker.description")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onResolve(null)}
            aria-label={t("settings.cancel")}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Breadcrumb + up button */}
        <div className="flex items-center gap-2 border-b border-black/[0.06] px-5 py-2.5 dark:border-white/[0.08]">
          <nav
            className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
            aria-label={t("folderPicker.breadcrumb")}
          >
            {breadcrumbs.map((segment, index) => (
              <span key={`${segment.path}:${index}`} className="flex shrink-0 items-center">
                {index > 0 ? (
                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
                ) : null}
                <button
                  type="button"
                  onClick={() => jumpTo(segment.path)}
                  className={cn(
                    "max-w-40 truncate rounded-md px-1.5 py-0.5 text-xs transition-colors",
                    index === breadcrumbs.length - 1
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:hover:bg-white/10",
                  )}
                  title={segment.path}
                >
                  {segment.label}
                </button>
              </span>
            ))}
          </nav>
          <button
            type="button"
            onClick={goUp}
            disabled={!canGoUp}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-black/[0.06] text-muted-foreground transition-colors hover:bg-black/[0.05] hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent dark:border-white/10 dark:hover:bg-white/10"
            aria-label={t("folderPicker.up")}
            title={t("folderPicker.up")}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setShowHidden((value) => !value)}
            className={cn(
              "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors",
              showHidden
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-black/[0.06] text-muted-foreground hover:bg-black/[0.05] hover:text-foreground dark:border-white/10 dark:hover:bg-white/10",
            )}
            aria-label={t("folderPicker.toggleHidden")}
            title={t("folderPicker.toggleHidden")}
          >
            {showHidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
        </div>

        {/* Body: quick locations + directory listing */}
        <div className="flex min-h-0 flex-1">
          {/* Quick locations */}
          <aside className="w-44 shrink-0 space-y-1 overflow-y-auto border-r border-black/[0.06] bg-muted/20 p-3 dark:border-white/[0.08]">
            <p className="px-1.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("folderPicker.places")}
            </p>
            {rootsList.map((item) => {
              const active = item.path === currentPath;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => jumpTo(item.path)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-foreground/80 hover:bg-black/[0.05] dark:hover:bg-white/10",
                  )}
                  title={item.path}
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </aside>

          {/* Directory listing */}
          <div className="relative min-w-0 flex-1 p-3">
            {loading ? (
              <div className="flex h-full min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("folderPicker.loading")}
              </div>
            ) : error ? (
              <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 px-4 text-center">
                <Info className="h-6 w-6 text-destructive/70" />
                <p className="text-xs text-destructive">{error}</p>
              </div>
            ) : visibleEntries.length === 0 ? (
              <div className="flex h-full min-h-40 items-center justify-center text-xs text-muted-foreground">
                {t("folderPicker.empty")}
              </div>
            ) : (
              <ul ref={listRef} className="max-h-72 space-y-0.5 overflow-y-auto pr-1">
                {visibleEntries.map((entry, index) => {
                  const selected = entry.path === selectedPath;
                  return (
                    <li
                      key={entry.path}
                      data-path={entry.path}
                      className={cn(
                        "flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors",
                        selected
                          ? "bg-primary/10 text-primary"
                          : "text-foreground/85 hover:bg-black/[0.05] dark:hover:bg-white/10",
                      )}
                      onClick={() => setSelectedPath(entry.path)}
                      onDoubleClick={() => enterDirectory(entry.path)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") enterDirectory(entry.path);
                      }}
                      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: folder-picker rows use the standard ARIA listbox/option pattern
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                    >
                      <Folder
                        className={cn(
                          "h-4 w-4 shrink-0",
                          selected ? "text-primary" : "text-sky-500/80 dark:text-sky-400/80",
                        )}
                      />
                      <span className="truncate">{entry.name}</span>
                      {index === selectedIndex ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">↵</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
            {truncated ? (
              <p className="mt-1 text-[10px] text-muted-foreground">
                {t("folderPicker.truncated")}
              </p>
            ) : null}
          </div>
        </div>

        {/* Footer: path input + actions */}
        <div className="flex items-center gap-3 border-t border-black/[0.06] px-5 py-3.5 dark:border-white/[0.08]">
          <div className="relative min-w-0 flex-1">
            <input
              ref={inputRef}
              type="text"
              value={pathInput}
              onChange={(event) => {
                setPathInput(event.currentTarget.value);
                setInputError("");
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  navigateToInputPath();
                }
              }}
              placeholder={t("folderPicker.pathPlaceholder")}
              aria-label={t("folderPicker.pathPlaceholder")}
              spellCheck={false}
              className="h-9 w-full rounded-lg border border-black/[0.08] bg-white/70 px-3 font-mono text-xs outline-none transition-colors focus:border-primary/50 focus:ring-2 focus:ring-primary/20 dark:border-white/10 dark:bg-white/[0.05]"
            />
            {inputError ? <p className="mt-1 text-[10px] text-destructive">{inputError}</p> : null}
          </div>
          <button
            type="button"
            onClick={() => onResolve(null)}
            className="h-9 shrink-0 rounded-lg border border-black/[0.08] px-4 text-xs font-medium text-foreground/80 transition-colors hover:bg-black/[0.05] dark:border-white/10 dark:hover:bg-white/10"
          >
            {t("settings.cancel")}
          </button>
          <button
            type="button"
            onClick={confirmSelection}
            className="h-9 shrink-0 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
          >
            {selectedPath ? t("folderPicker.chooseSelected") : t("folderPicker.chooseThis")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

type PendingRequest = {
  resolve: (path: string | null) => void;
};

let activeRoot: Root | null = null;
let activeContainer: HTMLDivElement | null = null;
const pendingRequests = new Set<PendingRequest>();

function resolveAll(path: string | null) {
  for (const request of pendingRequests) {
    request.resolve(path);
  }
  pendingRequests.clear();
  activeRoot?.unmount();
  activeRoot = null;
  activeContainer?.remove();
  activeContainer = null;
}

/**
 * Open the headless folder picker. Resolves to the chosen absolute path, or
 * null when cancelled. Only one dialog can be open at a time; opening a new
 * one cancels the previous.
 */
export function openFolderPicker(options: OpenFolderPickerOptions = {}): Promise<string | null> {
  const title = options.title?.trim() || "选择目录";
  const initialPath = options.initialPath?.trim() || "/";
  const locale = detectLocale();

  return new Promise<string | null>((resolve) => {
    resolveAll(null);

    const container = document.createElement("div");
    container.setAttribute("data-folder-picker-root", "true");
    document.body.appendChild(container);
    const root = createRoot(container);
    activeRoot = root;
    activeContainer = container;

    const request: PendingRequest = { resolve };
    pendingRequests.add(request);

    root.render(
      <FolderPickerDialog
        title={title}
        initialPath={initialPath}
        locale={locale}
        onResolve={(path) => resolveAll(path)}
      />,
    );
  });
}
