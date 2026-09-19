import { openUrl } from "@liveagent/app/shims/tauriOpener";
import { getFileTypeIcon } from "@liveagent/ui/components/chat/fileTypeIcons";
import {
  AppWindow,
  ArrowLeft,
  Blend,
  ChevronRight,
  MessageSquareText,
  Paperclip,
} from "@liveagent/ui/components/IconSet";
import { useLocale } from "@liveagent/ui/i18n/index";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type RefObject, useEffect, useRef } from "react";
import { Popover, PopoverContent } from "../ui/popover";
import { PreviewCard, PreviewCardContent } from "../ui/preview-card";
import {
  formatLargePasteCount,
  type MentionComposerCommitMention,
  type MentionContext,
  type MentionMenuMode,
  type MentionSuggestion,
} from "./MentionComposerModel";

function conversationUpdatedAtLabel(value: number | undefined, locale: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const unit =
    Math.abs(deltaSeconds) >= 86_400
      ? ({ name: "day", seconds: 86_400 } as const)
      : Math.abs(deltaSeconds) >= 3_600
        ? ({ name: "hour", seconds: 3_600 } as const)
        : ({ name: "minute", seconds: 60 } as const);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    Math.round(deltaSeconds / unit.seconds),
    unit.name,
  );
}

export function Popup({
  anchorRef,
  trigger,
  mode,
  suggestions,
  highlightIndex,
  isLoading,
  error,
  showEmpty,
  emptyLabel,
  onBack,
  onClose,
  onSelect,
  onHighlight,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  trigger: MentionContext["trigger"];
  mode: MentionMenuMode;
  suggestions: MentionSuggestion[];
  highlightIndex: number;
  isLoading: boolean;
  error: string | null;
  showEmpty: boolean;
  emptyLabel: string;
  onBack: () => void;
  onClose: () => void;
  onSelect: (suggestion: MentionSuggestion) => void;
  onHighlight: (index: number) => void;
}) {
  const { locale, t } = useLocale();

  const listRef = useRef<HTMLDivElement>(null);
  const hlRef = useRef<HTMLButtonElement>(null);
  // Pointer-driven highlight changes must not scroll: the row is already under
  // the cursor, and scrolling it would slide the list out from under the mouse.
  const skipScrollRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: highlightIndex is the trigger — hlRef points at a different row after each keyboard move, and the scroll must follow it.
  useEffect(() => {
    if (skipScrollRef.current) {
      skipScrollRef.current = false;
      return;
    }
    hlRef.current?.scrollIntoView({ block: "nearest" });
  }, [highlightIndex]);

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverContent
        anchor={() =>
          anchorRef.current?.closest<HTMLElement>(".composer-glass-card") ?? anchorRef.current
        }
        positionMethod="fixed"
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        className="flex max-h-(--available-height) w-(--anchor-width) max-w-(--available-width) min-w-0 flex-col overflow-hidden p-1"
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
        <div className="mb-0.5 shrink-0">
          {trigger === "skill" || mode === "root" ? (
            <div
              className={cn(
                "flex h-6 items-center gap-1.5 px-2",
                "text-tiny font-medium text-muted-foreground",
              )}
            >
              <span className="min-w-0 truncate">
                {trigger === "skill" ? "Skills" : t("chat.composer.add")}
              </span>
            </div>
          ) : (
            <button
              type="button"
              className={cn(
                "flex h-6 w-full items-center gap-1.5 rounded-md px-2",
                "text-tiny font-medium text-muted-foreground transition-colors",
                "hover:bg-foreground/[0.05] hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              )}
              onMouseDown={(event) => {
                event.preventDefault();
                onBack();
              }}
            >
              <ArrowLeft className="size-3 shrink-0" />
              <span className="min-w-0 truncate">
                {mode === "apps"
                  ? t("chat.composer.mentionGroupApps")
                  : mode === "files"
                    ? t("chat.composer.filesAndFolders")
                    : t("chat.composer.conversations")}
              </span>
            </button>
          )}
        </div>
        <div
          ref={listRef}
          role="listbox"
          aria-label={
            trigger === "skill"
              ? "Skills"
              : mode === "root"
                ? t("chat.composer.add")
                : mode === "apps"
                  ? t("chat.composer.mentionGroupApps")
                  : mode === "files"
                    ? t("chat.composer.filesAndFolders")
                    : t("chat.composer.conversations")
          }
          className={cn(
            "relative flex min-h-0 max-h-60 flex-col gap-0.5 overflow-y-auto overscroll-contain",
            "[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden [&::-webkit-scrollbar]:size-0",
          )}
        >
          {isLoading && (
            <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
              {mode === "conversations"
                ? t("chat.composer.searchingConversations")
                : t("chat.composer.indexingFiles")}
            </div>
          )}
          {error && !isLoading && (
            <div className="flex h-8 items-center px-2 text-xs text-destructive">{error}</div>
          )}
          {suggestions.map((suggestion, i) => {
            const isCategory = suggestion.type === "category";
            const isSkill = suggestion.type === "skill";
            const conversation =
              suggestion.type === "conversation" ? suggestion.conversation : null;
            const isApp = suggestion.type === "app";
            const entry = suggestion.type === "file" ? suggestion.entry : null;
            const skill = suggestion.type === "skill" ? suggestion.skill : null;
            const app = suggestion.type === "app" ? suggestion.app : null;
            const isDir = entry?.kind === "dir";
            const parts = entry ? entry.path.split("/") : [];
            const fileName = parts.pop() || "";
            const dirPath = parts.join("/");
            const Icon = entry ? getFileTypeIcon(entry.path, entry.kind) : null;
            const category = suggestion.type === "category" ? suggestion.category : null;
            const title =
              app?.name ??
              (category === "apps"
                ? t("chat.composer.mentionGroupApps")
                : category === "files"
                  ? t("chat.composer.filesAndFolders")
                  : category === "conversations"
                    ? t("chat.composer.conversations")
                    : (conversation?.title ?? skill?.name ?? fileName));
            const updatedAtLabel = conversationUpdatedAtLabel(conversation?.updatedAt, locale);
            const subtitle =
              category === "apps"
                ? t("chat.composer.appsHint")
                : category === "files"
                  ? t("chat.composer.filesAndFoldersHint")
                  : category === "conversations"
                    ? t("chat.composer.conversationsHint")
                    : conversation
                      ? conversation.searchPreview || (conversation.cwd ?? "")
                      : (app?.bundleId ?? skill?.description ?? (dirPath ? `${dirPath}/` : ""));
            const RowIcon =
              category === "apps"
                ? AppWindow
                : category === "files"
                  ? Paperclip
                  : category === "conversations" || conversation
                    ? MessageSquareText
                    : Icon;
            return (
              <button
                type="button"
                role="option"
                aria-selected={i === highlightIndex}
                key={
                  entry
                    ? `${entry.kind}:${entry.path}`
                    : app
                      ? `app:${app.bundleId || app.path || app.name}`
                      : conversation
                        ? `conversation:${conversation.id}`
                        : category
                          ? `category:${category}`
                          : `skill:${skill?.skillFile ?? skill?.name}`
                }
                ref={i === highlightIndex ? hlRef : undefined}
                className={cn(
                  "group flex h-8 shrink-0 cursor-pointer items-center gap-2",
                  "rounded-md px-2 text-left text-xs leading-5 transition-colors",
                  i === highlightIndex
                    ? "bg-foreground/[0.07] text-foreground"
                    : "text-foreground/85 dark:text-foreground/90",
                )}
                onMouseMove={() => {
                  if (i === highlightIndex) return;
                  skipScrollRef.current = true;
                  onHighlight(i);
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(suggestion);
                }}
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center",
                    isCategory || conversation
                      ? "text-muted-foreground"
                      : isSkill || isApp
                        ? "text-foreground/85"
                        : isDir
                          ? "text-amber-600 dark:text-amber-300"
                          : "text-muted-foreground",
                  )}
                >
                  {isApp ? (
                    app?.iconDataUrl ? (
                      <img src={app.iconDataUrl} alt="" className="size-4 rounded-sm" />
                    ) : (
                      <AppWindow className="size-4" />
                    )
                  ) : RowIcon ? (
                    <RowIcon width={16} height={16} />
                  ) : (
                    <Blend className="size-4" />
                  )}
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="shrink-0 truncate font-normal text-foreground/95">{title}</span>
                  {subtitle && (
                    <span className="min-w-0 flex-1 truncate text-tiny text-muted-foreground/75">
                      {subtitle}
                    </span>
                  )}
                </span>
                {updatedAtLabel ? (
                  <span className="shrink-0 text-tiny tabular-nums text-muted-foreground/70">
                    {updatedAtLabel}
                  </span>
                ) : null}
                {isCategory ? (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground/65" />
                ) : isSkill ? (
                  <span className="shrink-0 rounded bg-muted/60 px-1 py-px text-tiny uppercase tracking-wide text-muted-foreground">
                    skill
                  </span>
                ) : (
                  isDir && (
                    <span className="shrink-0 rounded bg-muted/60 px-1 py-px text-tiny uppercase tracking-wide text-muted-foreground">
                      dir
                    </span>
                  )
                )}
              </button>
            );
          })}
          {showEmpty && !isLoading && !error && suggestions.length === 0 && (
            <div className="flex h-8 items-center px-2 text-xs text-muted-foreground">
              {emptyLabel}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
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
  anchor,
  onClose,
  onMouseEnter,
  onMouseLeave,
}: {
  commit: MentionComposerCommitMention;
  anchor: HTMLElement;
  onClose: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { locale, t } = useLocale();

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

  return (
    <PreviewCard
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PreviewCardContent
        anchor={anchor}
        align="start"
        className="w-fit min-w-50 max-w-[min(440px,var(--available-width))] px-3 py-2.5 text-xs"
        onMouseDown={(event) => event.preventDefault()}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
      >
        <div className="flex items-start gap-2">
          <GitHubMarkIcon className="mt-0.5 size-4 shrink-0 text-foreground" />
          <div className="min-w-0">
            <div className="break-words font-medium leading-tight">{authorLabel}</div>
            {date ? (
              <div className="mt-0.5 text-xs leading-tight text-muted-foreground">
                {date.relative} ({date.absolute})
              </div>
            ) : null}
          </div>
        </div>
        <div className="mt-2 whitespace-pre-wrap break-words font-medium leading-snug">
          {subject}
        </div>
        {messageBody ? (
          <div className="mt-1.5 whitespace-pre-wrap break-words leading-snug text-muted-foreground">
            {messageBody}
          </div>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-tight">
          <span className="text-muted-foreground">{filesChangedLabel}</span>
          <span className="font-medium text-emerald-600 dark:text-emerald-400">
            {insertionsLabel}
          </span>
          <span className="font-medium text-rose-600 dark:text-rose-400">{deletionsLabel}</span>
        </div>
        <div
          className={cn(
            "mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/70",
            "pt-1.5 text-xs leading-tight text-muted-foreground",
          )}
        >
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
                <GitHubMarkIcon className="size-3" />
                {t("chat.composer.commitTooltipOpenGithub")}
              </button>
            </>
          ) : null}
        </div>
      </PreviewCardContent>
    </PreviewCard>
  );
}
