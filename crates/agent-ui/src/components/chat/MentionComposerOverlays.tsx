import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import { AppWindow, Blend } from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  formatLargePasteCount,
  type MentionComposerCommitMention,
  type MentionContext,
  type MentionSuggestion,
} from "./MentionComposerModel";

export function Popup({
  anchorRef,
  trigger,
  suggestions,
  highlightIndex,
  isLoading,
  error,
  showEmpty,
  emptyLabel,
  onSelect,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  trigger: MentionContext["trigger"];
  suggestions: MentionSuggestion[];
  highlightIndex: number;
  isLoading: boolean;
  error: string | null;
  showEmpty: boolean;
  emptyLabel: string;
  onSelect: (suggestion: MentionSuggestion) => void;
}) {
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: highlightIndex is the trigger — hlRef points at a different row after each keyboard move, and the scroll must follow it.
  useEffect(() => {
    hlRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!anchor || !popup) return;
    const inputSurface = anchor.closest<HTMLElement>(".composer-glass-card") ?? anchor;

    const update = () => {
      const rect = inputSurface.getBoundingClientRect();
      popup.style.left = `${rect.left}px`;
      popup.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 8)}px`;
      popup.style.width = `${rect.width}px`;
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(inputSurface);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: The popup intercepts pointer-down solely to preserve editor focus; it is not an activation target.
    <div
      ref={popupRef}
      className={cn(
        "mention-popup-enter layer-popover fixed overflow-hidden rounded-2xl",
        "border border-black/[0.075] bg-popover text-popover-foreground shadow-sm ring-0 dark:border-white/[0.15]",
      )}
      onMouseDown={(event) => {
        // Any mousedown inside the popup must not blur the editor (blur closes
        // the mention session), except on the native scrollbar strip where
        // preventDefault would break thumb dragging in some engines.
        const list = listRef.current;
        if (list) {
          const rect = list.getBoundingClientRect();
          const onScrollbar =
            event.clientX >= rect.left + list.clientLeft + list.clientWidth &&
            event.clientY >= rect.top &&
            event.clientY <= rect.bottom;
          if (onScrollbar) return;
        }
        event.preventDefault();
      }}
    >
      <div className="px-3.5 pb-1.5 pt-3 text-xs font-medium text-muted-foreground">
        {trigger === "skill"
          ? "Skills"
          : suggestions.some((suggestion) => suggestion.type === "app")
            ? "文件 / 应用"
            : "文件"}
      </div>
      <div
        ref={listRef}
        className="mention-popup-scroll relative flex max-h-[320px] flex-col overflow-y-auto px-2 pb-2"
      >
        {isLoading && (
          <div className="px-2 py-2 text-xs text-muted-foreground">Indexing files...</div>
        )}
        {error && !isLoading && <div className="px-2 py-2 text-xs text-destructive">{error}</div>}
        {suggestions.map((suggestion, i) => {
          const isSkill = suggestion.type === "skill";
          const isApp = suggestion.type === "app";
          const entry = suggestion.type === "file" ? suggestion.entry : null;
          const skill = suggestion.type === "skill" ? suggestion.skill : null;
          const app = suggestion.type === "app" ? suggestion.app : null;
          const isDir = entry?.kind === "dir";
          const parts = entry ? entry.path.split("/") : [];
          const fileName = parts.pop() || "";
          const dirPath = parts.join("/");
          const Icon = entry ? getFileTypeIcon(entry.path, entry.kind) : null;
          const title = app?.name ?? skill?.name ?? fileName;
          const subtitle = app?.bundleId ?? skill?.description ?? (dirPath ? `${dirPath}/` : "");
          return (
            <button
              type="button"
              key={
                entry
                  ? `${entry.kind}:${entry.path}`
                  : app
                    ? `app:${app.bundleId || app.path || app.name}`
                    : `skill:${skill?.skillFile ?? skill?.name}`
              }
              ref={i === highlightIndex ? hlRef : undefined}
              className={cn(
                // Rows are 38px hitboxes with 2px transparent borders so the
                // visual 34px row keeps the 4px gap while clicks in the gap
                // still land on a row instead of a dead strip. shrink-0 stops
                // the max-h flex column from compressing rows before it scrolls.
                "mention-popup-item group flex h-[38px] shrink-0 cursor-pointer items-center justify-start gap-3 rounded-lg border-y-2 border-transparent bg-clip-padding px-3 text-left text-xs leading-5 transition-colors",
                i === highlightIndex
                  ? "bg-foreground/[0.07] text-foreground"
                  : "text-foreground/85 hover:bg-foreground/[0.05] dark:text-foreground/90",
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                onSelect(suggestion);
              }}
            >
              <span
                className={cn(
                  "flex h-4 w-4 shrink-0 items-center justify-center",
                  isSkill || isApp
                    ? "text-foreground/85"
                    : isDir
                      ? "text-amber-600 dark:text-amber-300"
                      : "text-muted-foreground",
                )}
              >
                {isApp ? (
                  <AppWindow className="h-4 w-4" />
                ) : Icon ? (
                  <Icon width={16} height={16} />
                ) : (
                  <Blend className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">
                <span className="font-normal text-foreground/95">{title}</span>
                {subtitle && (
                  <span className="ml-2 text-xs text-muted-foreground/75">{subtitle}</span>
                )}
              </span>
              {isSkill ? (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  skill
                </span>
              ) : isApp ? (
                <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                  app
                </span>
              ) : (
                isDir && (
                  <span className="shrink-0 text-[10px] uppercase tracking-wider text-muted-foreground/60">
                    dir
                  </span>
                )
              )}
            </button>
          );
        })}
        {showEmpty && !isLoading && !error && suggestions.length === 0 && (
          <div className="px-2 py-2 text-xs text-muted-foreground">{emptyLabel}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export function formatCommitTooltipDate(value: string, locale: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const absolute = date.toLocaleString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const units: Array<{
    unit: "year" | "month" | "day" | "hour" | "minute" | "second";
    seconds: number;
  }> = [
    { unit: "year", seconds: 365 * 24 * 60 * 60 },
    { unit: "month", seconds: 30 * 24 * 60 * 60 },
    { unit: "day", seconds: 24 * 60 * 60 },
    { unit: "hour", seconds: 60 * 60 },
    { unit: "minute", seconds: 60 },
    { unit: "second", seconds: 1 },
  ];
  const selected = units.find(({ seconds }) => Math.abs(deltaSeconds) >= seconds) ?? {
    unit: "second",
    seconds: 1,
  };
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(deltaSeconds / selected.seconds),
    selected.unit,
  );
  return { relative, absolute };
}

export function GitHubMarkIcon({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82A7.6 7.6 0 0 1 8 3.86c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export function commitStatLabel(template: string, count: string) {
  return template.replace("{count}", count);
}

export function CommitMentionTooltip({
  commit,
  rect,
  onMouseEnter,
  onMouseLeave,
}: {
  commit: MentionComposerCommitMention;
  rect: DOMRect;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { locale, t } = useLocale();
  const maxWidth = Math.min(440, window.innerWidth - 16);
  const minWidth = Math.min(200, maxWidth);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipWidth, setTooltipWidth] = useState(minWidth);
  const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - tooltipWidth - 8));
  const availableAbove = rect.top - 16;
  const availableBelow = window.innerHeight - rect.bottom - 16;
  const placeAbove = availableAbove > 260 || availableAbove > availableBelow;
  const maxHeight = Math.max(120, Math.min(520, placeAbove ? availableAbove : availableBelow));
  const top = placeAbove
    ? Math.max(8, rect.top - 8)
    : Math.min(window.innerHeight - 8, rect.bottom + 8);
  const shortSha = commit.shortSha || commit.sha.slice(0, 7);
  const author = commit.authorName || t("chat.composer.commitTooltipUnknownAuthor");
  const date = formatCommitTooltipDate(commit.authorDate, locale);
  const fileCount = commit.filesChanged || commit.fileCount;
  const filesChangedLabel = commitStatLabel(
    t("chat.composer.commitTooltipFilesChanged"),
    formatLargePasteCount(fileCount),
  );
  const insertionsLabel = commitStatLabel(
    t("chat.composer.commitTooltipInsertions"),
    formatLargePasteCount(commit.insertions),
  );
  const deletionsLabel = commitStatLabel(
    t("chat.composer.commitTooltipDeletions"),
    formatLargePasteCount(commit.deletions),
  );
  const messageBody = commit.body.trim();
  const subject = commit.subject.trim() || shortSha;
  const authorLabel = commit.authorEmail ? `${author} <${commit.authorEmail}>` : author;

  // biome-ignore lint/correctness/useExhaustiveDependencies: commit is the trigger — the tooltip is mounted un-keyed, so hovering another chip re-renders this instance with new content that must be re-measured.
  useLayoutEffect(() => {
    const node = tooltipRef.current;
    if (!node) return;
    const measuredWidth = Math.ceil(node.getBoundingClientRect().width);
    setTooltipWidth(Math.min(maxWidth, Math.max(minWidth, measuredWidth)));
  }, [commit, maxWidth, minWidth]);

  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: Hover and pointer handlers keep this non-interactive tooltip open while the pointer crosses into it.
    <div
      ref={tooltipRef}
      className="layer-popover fixed overflow-y-auto rounded-xl border border-border bg-popover px-3 py-2.5 text-xs text-popover-foreground shadow-xl"
      style={{
        left,
        top,
        width: "fit-content",
        minWidth,
        maxWidth,
        maxHeight,
        transform: placeAbove ? "translateY(-100%)" : "none",
      }}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-start gap-2">
        <GitHubMarkIcon className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
        <div className="min-w-0">
          <div className="break-words font-medium leading-tight">{authorLabel}</div>
          {date ? (
            <div className="mt-0.5 text-[calc(11px*var(--zone-font-scale,1))] leading-tight text-muted-foreground">
              {date.relative} ({date.absolute})
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-2 whitespace-pre-wrap break-words font-medium leading-snug">{subject}</div>
      {messageBody ? (
        <div className="mt-1.5 whitespace-pre-wrap break-words leading-snug text-muted-foreground">
          {messageBody}
        </div>
      ) : null}
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[calc(11px*var(--zone-font-scale,1))] leading-tight">
        <span className="text-muted-foreground">{filesChangedLabel}</span>
        <span className="font-medium text-emerald-600 dark:text-emerald-400">
          {insertionsLabel}
        </span>
        <span className="font-medium text-rose-600 dark:text-rose-400">{deletionsLabel}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70 pt-1.5 text-[calc(11px*var(--zone-font-scale,1))] leading-tight text-muted-foreground">
        <span className="font-mono text-foreground">{shortSha}</span>
        {commit.remoteName ? <span>{commit.remoteName}</span> : null}
        {commit.githubUrl ? (
          <>
            <span className="text-border">|</span>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-primary hover:bg-primary/10"
              onClick={() => commit.githubUrl && void openUrl(commit.githubUrl)}
            >
              <GitHubMarkIcon className="h-3 w-3" />
              {t("chat.composer.commitTooltipOpenGithub")}
            </button>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
