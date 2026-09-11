import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import { AlertTriangle, ChevronRight, FolderTree, Loader2 } from "@liveagent/ui/components/IconSet";
import type { SftpClient, SftpEntry, SftpSide } from "@liveagent/ui/lib/sftp/types";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import { basename } from "./workspaceSftpModel";
import { joinPath, normalizePath, parentPath } from "./workspaceSftpPaths";

const REMOTE_PATH_SUGGESTION_LIMIT = 8;
const REMOTE_PATH_SUGGESTION_DELAY_MS = 180;

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
    <div
      ref={scrollRef}
      className="flex min-w-0 items-center overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        return (
          <Fragment key={crumb.path}>
            {index > 0 ? (
              <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" />
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

export function SftpPathNavigator(props: {
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
    <fieldset
      aria-label={t("workspaceSftp.pathSuggestions")}
      className={cn(
        "relative z-30 flex h-10 min-w-0 shrink-0 items-center",
        "border-x-0 border-b border-t-0 border-border/60 bg-muted/15 px-2",
      )}
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        closeEditor();
      }}
    >
      {editing ? (
        <div
          className={cn(
            "group relative flex h-8 min-w-0 flex-1 items-center",
            "rounded-lg border border-border/60 bg-background/85 shadow-sm transition-all",
            "focus-within:border-primary/40 focus-within:bg-background focus-within:ring-3px focus-within:ring-primary/10",
          )}
        >
          <FolderTree className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground/70 transition-colors group-focus-within:text-primary" />
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
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent pl-8 pr-11",
              "font-mono text-xs text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground/60",
            )}
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
          <span className="pointer-events-none absolute right-2 flex items-center gap-1 text-tiny text-muted-foreground/70">
            {loading ? <Loader2 className="size-3.5 animate-spin text-primary" /> : null}
            <kbd className="rounded-sm border border-border/70 bg-background/80 px-1 py-0.5 font-sans text-muted-foreground/80">
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
            <Loader2 className="mx-1 size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
          ) : null}
        </div>
      )}

      {editing && open ? (
        <div
          id={listboxId}
          role="listbox"
          className={cn(
            "absolute inset-x-2 top-full z-50 mt-1.5 origin-top overflow-hidden",
            "rounded-xl border border-border/50 bg-popover/85 shadow-ui-workspacesftppanel-34 ring-1 ring-black/[0.03] backdrop-blur-2xl",
            "dark:ring-white/[0.06]",
          )}
        >
          <div className="max-h-64 overflow-y-auto p-1">
            {suggestionError ? (
              <div
                className="flex items-center gap-2 rounded-lg px-2.5 py-3 text-xs text-destructive"
                title={suggestionError}
              >
                <AlertTriangle className="size-4 shrink-0" />
                <span className="truncate">{t("workspaceSftp.pathSearchFailed")}</span>
              </div>
            ) : suggestionsLoading ? (
              <div className="flex items-center justify-center gap-2 px-3 py-5 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
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
                      "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
                      "transition-colors",
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
                        "flex size-7 shrink-0 items-center justify-center rounded-md transition-colors",
                        activeIndex === index
                          ? "bg-primary/10 text-primary"
                          : "bg-foreground/[0.04] text-muted-foreground",
                      )}
                    >
                      <DirectoryIcon className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-foreground">
                        {entry.name}
                      </span>
                      <span className="block truncate font-mono text-tiny text-muted-foreground/80">
                        {entry.path}
                      </span>
                    </span>
                    <ChevronRight
                      className={cn(
                        "size-3.5 shrink-0 transition-opacity",
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

          <div className="border-t border-border/50 bg-muted/25 px-3 py-1.5 text-tiny text-muted-foreground/80">
            {t("workspaceSftp.pathKeyboardHint")}
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}
