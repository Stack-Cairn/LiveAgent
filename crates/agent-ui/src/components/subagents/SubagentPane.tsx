import { AssistantBubble } from "@liveagent/ui/components/chat/AssistantBubble";
import {
  SubagentStatusText,
  subagentLatestToolText,
  subagentMetaParts,
  useTickingNow,
} from "@liveagent/ui/components/chat/assistant-bubble/SubagentToolCard";
import { BackgroundNoticeMessage } from "@liveagent/ui/components/chat/BackgroundNoticeMessage";
import { UserMessageBubbleBody } from "@liveagent/ui/components/chat/UserMessageBubbleBody";
import type { SubagentView } from "@liveagent/ui/contracts/subagentPane";
import { useLocale } from "@liveagent/ui/i18n/index";
import type { ChatFileLink } from "@liveagent/ui/lib/chat/chatFileLinks";
import type { UiMessage } from "@liveagent/ui/lib/chat/uiMessages";
import { cn } from "@liveagent/ui/lib/shared/utils";
import { type ReactNode, useCallback, useLayoutEffect, useRef, useState } from "react";
import { Bot, List, PanelRightClose, Square, X } from "../IconSet";

export type SubagentDirectoryView = {
  running: readonly SubagentView[];
  ended: readonly SubagentView[];
  endedTotal: number;
  hasMoreEnded: boolean;
};

export type SubagentTranscriptView = {
  status: "loading" | "ready" | "error";
  error?: string;
  items: readonly (UiMessage & {
    rounds?: (NonNullable<UiMessage["rounds"]>[number] & { runningToolCallIds?: string[] })[];
  })[];
};

const ICON_BUTTON = cn(
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/50",
  "transition-colors hover:bg-foreground/[0.06] hover:text-foreground/80",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
);

function statusDotClass(status: SubagentView["status"]) {
  switch (status) {
    case "running":
      return "animate-pulse bg-[hsl(var(--chat-running))]";
    case "error":
      return "bg-[hsl(var(--chat-error))]";
    case "cancelled":
      return "bg-foreground/30";
    default:
      return "bg-[hsl(var(--chat-success))]";
  }
}

function StatusDot({ status }: { status: SubagentView["status"] }) {
  return (
    <span
      aria-hidden="true"
      className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(status))}
    />
  );
}

function SubagentTabStrip({
  tabs,
  activeId,
  onShowDirectory,
  onSelectTab,
  onCloseTab,
  onClose,
}: {
  tabs: readonly SubagentView[];
  activeId: string | null;
  onShowDirectory: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/60 px-2">
      <button
        type="button"
        onClick={onShowDirectory}
        aria-pressed={activeId === null}
        title={t("chat.subagent.pane.directory")}
        className={cn(
          "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium",
          "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
          activeId === null
            ? "bg-foreground/[0.07] text-foreground/85"
            : "text-foreground/55 hover:bg-foreground/[0.05] hover:text-foreground/80",
        )}
      >
        <List className="size-3.5" />
        {t("chat.subagent.pane.label")}
      </button>
      <div
        role="tablist"
        aria-label={t("chat.subagent.pane.label")}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
      >
        {tabs.map((tab) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={cn(
                "group/tab flex h-7 min-w-0 max-w-160px shrink-0 items-center rounded-md pl-2",
                active
                  ? "bg-foreground/[0.07] text-foreground/85"
                  : "text-foreground/55 hover:bg-foreground/[0.05] hover:text-foreground/80",
              )}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectTab(tab.id)}
                title={tab.description}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-xs focus-visible:outline-none"
              >
                <StatusDot status={tab.status} />
                <span className="min-w-0 truncate">{tab.description}</span>
              </button>
              <button
                type="button"
                onClick={() => onCloseTab(tab.id)}
                aria-label={t("chat.subagent.pane.closeTab").replace("{name}", tab.description)}
                className={cn(
                  "ml-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded text-foreground/40",
                  "hover:bg-foreground/[0.08] hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  active
                    ? "opacity-100"
                    : "opacity-0 group-hover/tab:opacity-100 focus-visible:opacity-100",
                )}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
      <button
        type="button"
        onClick={onClose}
        aria-label={t("chat.subagent.pane.close")}
        title={t("chat.subagent.pane.close")}
        className={ICON_BUTTON}
      >
        <PanelRightClose className="size-3.5" />
      </button>
    </div>
  );
}

function DirectoryRow({ view, onOpen }: { view: SubagentView; onOpen: (id: string) => void }) {
  const { t } = useLocale();
  const now = useTickingNow(view.status === "running" && view.startedAtMs !== undefined);
  const meta = subagentMetaParts(view, now, t);
  const latestTool = view.status === "running" ? subagentLatestToolText(view) : "";
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(view.id)}
        data-subagent-row={view.id}
        className={cn(
          "flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2.5 py-2 text-left",
          "transition-colors hover:bg-foreground/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        )}
      >
        <Bot className="mt-0.5 size-3.5 shrink-0 text-foreground/50" />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="min-w-0 truncate text-sm text-foreground/85">{view.description}</span>
          {meta.length > 0 ? (
            <span className="min-w-0 truncate text-xs tabular-nums text-foreground/45">
              {meta.join(" · ")}
            </span>
          ) : null}
          {latestTool ? (
            <span className="min-w-0 truncate font-mono text-xs text-foreground/50">
              {latestTool}
            </span>
          ) : null}
        </span>
        <SubagentStatusText view={view} className="mt-0.5 shrink-0" />
      </button>
    </li>
  );
}

function SubagentDirectoryList({
  directory,
  unsupported,
  onOpen,
  onShowMore,
}: {
  directory: SubagentDirectoryView;
  unsupported: boolean;
  onOpen: (id: string) => void;
  onShowMore: () => void;
}) {
  const { t } = useLocale();
  if (directory.running.length === 0 && directory.endedTotal === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-foreground/50">
        {unsupported ? t("chat.subagent.pane.unsupported") : t("chat.subagent.pane.empty")}
      </p>
    );
  }
  return (
    <div className="space-y-4 px-2 py-3">
      {directory.running.length > 0 ? (
        <section>
          <h3 className="px-2.5 pb-1 text-xs font-medium text-foreground/50">
            {t("chat.subagent.pane.running").replace("{count}", String(directory.running.length))}
          </h3>
          <ul>
            {directory.running.map((view) => (
              <DirectoryRow key={view.id} view={view} onOpen={onOpen} />
            ))}
          </ul>
        </section>
      ) : null}
      {directory.endedTotal > 0 ? (
        <section>
          <h3 className="px-2.5 pb-1 text-xs font-medium text-foreground/50">
            {t("chat.subagent.pane.ended").replace("{count}", String(directory.endedTotal))}
          </h3>
          <ul>
            {directory.ended.map((view) => (
              <DirectoryRow key={view.id} view={view} onOpen={onOpen} />
            ))}
          </ul>
          {directory.hasMoreEnded ? (
            <button
              type="button"
              onClick={onShowMore}
              className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-xs text-foreground/55 hover:bg-foreground/[0.045] hover:text-foreground/80"
            >
              {t("chat.subagent.pane.showMore")}
            </button>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function SubagentHeader({
  view,
  onStop,
}: {
  view: SubagentView;
  onStop: (id: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const running = view.status === "running";
  const now = useTickingNow(running && view.startedAtMs !== undefined);
  const meta = subagentMetaParts(view, now, t);
  const [stopping, setStopping] = useState(false);
  const [stopFailed, setStopFailed] = useState(false);
  const stop = useCallback(() => {
    setStopping(true);
    setStopFailed(false);
    onStop(view.id)
      .catch(() => setStopFailed(true))
      .finally(() => setStopping(false));
  }, [onStop, view.id]);
  return (
    <div className="shrink-0 border-b border-border/60 px-4 py-3">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p
            className="line-clamp-2 text-sm font-medium text-foreground/90"
            title={view.description}
          >
            {view.description}
          </p>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-foreground/45">
            <SubagentStatusText view={view} />
            {view.background ? <span>{t("chat.subagent.pane.background")}</span> : null}
            {meta.length > 0 ? <span className="tabular-nums">{meta.join(" · ")}</span> : null}
          </div>
        </div>
        {running && view.external ? (
          <span
            data-subagent-external={view.id}
            className="shrink-0 pt-1 text-xs text-foreground/45"
          >
            {t("chat.subagent.pane.external")}
          </span>
        ) : running ? (
          <button
            type="button"
            onClick={stop}
            disabled={stopping}
            data-subagent-stop={view.id}
            className={cn(
              "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border/70 px-2.5 text-xs",
              "text-foreground/75 transition-colors hover:bg-foreground/[0.05] hover:text-foreground",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60",
            )}
          >
            <Square className="size-3" />
            {stopping ? t("chat.subagent.pane.stopping") : t("chat.subagent.pane.stop")}
          </button>
        ) : null}
      </div>
      {stopFailed ? (
        <p className="mt-1.5 text-xs text-[hsl(var(--chat-error))]">
          {t("chat.subagent.pane.stopFailed")}
        </p>
      ) : null}
      {view.error ? (
        <p
          className={cn(
            "mt-1.5 line-clamp-3 break-words text-xs",
            // A stop the user asked for is not a failure.
            view.status === "cancelled" ? "text-foreground/45" : "text-[hsl(var(--chat-error))]",
          )}
        >
          {view.error}
        </p>
      ) : null}
    </div>
  );
}

/** Keeps a scroller pinned to the bottom while content grows, unless the user scrolled up. */
function useFollowBottom(dependency: unknown) {
  const ref = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);
  const onScroll = useCallback(() => {
    const element = ref.current;
    if (!element) return;
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin whenever the content changes.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [dependency]);
  return { ref, onScroll };
}

function SubagentTranscriptBody({
  subagentId,
  transcript,
  live,
  workdir,
  onOpenFileLink,
  onRetry,
}: {
  subagentId: string;
  transcript: SubagentTranscriptView | undefined;
  live: boolean;
  workdir?: string;
  onOpenFileLink?: (link: ChatFileLink) => void;
  onRetry: () => void;
}) {
  const { t } = useLocale();
  const follow = useFollowBottom(transcript?.items);
  if (!transcript || transcript.status === "loading") {
    return (
      <p className="px-4 py-6 text-sm text-foreground/50">{t("chat.subagent.pane.loading")}</p>
    );
  }
  if (transcript.status === "error") {
    return (
      <div className="space-y-2 px-4 py-6 text-sm">
        <p className="text-[hsl(var(--chat-error))]">{t("chat.subagent.pane.loadFailed")}</p>
        {transcript.error ? (
          <p className="break-words text-xs text-foreground/45">{transcript.error}</p>
        ) : null}
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-border/70 px-2.5 py-1 text-xs text-foreground/75 hover:bg-foreground/[0.05]"
        >
          {t("chat.subagent.pane.retry")}
        </button>
      </div>
    );
  }
  let lastAssistant = transcript.items.length - 1;
  while (lastAssistant >= 0 && transcript.items[lastAssistant]?.role !== "assistant") {
    lastAssistant -= 1;
  }
  return (
    <div
      ref={follow.ref}
      onScroll={follow.onScroll}
      data-subagent-transcript={subagentId}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
    >
      <div className="space-y-4">
        {transcript.items.map((item, index) =>
          item.role === "user" && item.backgroundNotice ? (
            <BackgroundNoticeMessage key={item.key} text={item.text} />
          ) : item.role === "user" ? (
            <div key={item.key} className="chat-user-bubble-wrap relative ml-auto max-w-full">
              <UserMessageBubbleBody
                messageKey={`subagent-${subagentId}-${item.key}`}
                text={item.text}
                attachments={item.attachments ?? []}
                workspaceRoot={workdir}
              />
            </div>
          ) : (
            <div key={item.key} className="group/assistant min-w-0 w-full max-w-full">
              <AssistantBubble
                rounds={item.rounds ?? []}
                isLive={live && index === lastAssistant}
                isStreaming={live && index === lastAssistant}
                renderMode={live ? "streaming" : "static"}
                readOnly
                workdir={workdir}
                onOpenFileLink={onOpenFileLink}
              />
            </div>
          ),
        )}
        {transcript.items.length <= 1 && !live ? (
          <p className="text-sm text-foreground/45">{t("chat.subagent.pane.noOutput")}</p>
        ) : null}
      </div>
    </div>
  );
}

export type SubagentPaneProps = {
  tabs: readonly SubagentView[];
  activeId: string | null;
  directory: SubagentDirectoryView;
  /** The active tab's transcript; undefined until it starts loading. */
  transcript?: SubagentTranscriptView;
  unsupported?: boolean;
  workdir?: string;
  className?: string;
  onShowDirectory: () => void;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onClose: () => void;
  onShowMore: () => void;
  onStop: (id: string) => Promise<void>;
  onRetryTranscript: (id: string) => void;
  onOpenFileLink?: (link: ChatFileLink) => void;
  /** Rendered above the directory, e.g. a host notice. */
  directoryHeader?: ReactNode;
};

/**
 * The subagent side pane: a directory of every subagent of the conversation and
 * one read-only, live transcript per open tab.
 */
export function SubagentPane(props: SubagentPaneProps) {
  const { t } = useLocale();
  const active = props.activeId ? props.tabs.find((tab) => tab.id === props.activeId) : undefined;
  return (
    <aside
      aria-label={t("chat.subagent.pane.label")}
      data-subagent-pane=""
      className={cn(
        "flex h-full min-h-0 w-420px max-w-1/2 shrink-0 flex-col overflow-hidden border-l border-border/60 bg-background",
        props.className,
      )}
    >
      <SubagentTabStrip
        tabs={props.tabs}
        activeId={active ? active.id : null}
        onShowDirectory={props.onShowDirectory}
        onSelectTab={props.onSelectTab}
        onCloseTab={props.onCloseTab}
        onClose={props.onClose}
      />
      {active ? (
        <>
          <SubagentHeader key={active.id} view={active} onStop={props.onStop} />
          <SubagentTranscriptBody
            key={`transcript-${active.id}`}
            subagentId={active.id}
            transcript={props.transcript}
            live={active.status === "running"}
            workdir={props.workdir}
            onOpenFileLink={props.onOpenFileLink}
            onRetry={() => props.onRetryTranscript(active.id)}
          />
        </>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {props.directoryHeader}
          <SubagentDirectoryList
            directory={props.directory}
            unsupported={Boolean(props.unsupported)}
            onOpen={props.onSelectTab}
            onShowMore={props.onShowMore}
          />
        </div>
      )}
    </aside>
  );
}

/** "{count} running" near the composer; opens the subagent directory. */
export function SubagentRunningChip({ count, onOpen }: { count: number; onOpen: () => void }) {
  const { t } = useLocale();
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      data-subagent-running-chip=""
      aria-label={t("chat.subagent.runningCountLabel").replace("{count}", String(count))}
      className={cn(
        "pointer-events-auto flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-background/92 px-3",
        "text-xs text-muted-foreground shadow-ui-taskprogressindicator-14 outline-none backdrop-blur-xl backdrop-saturate-150",
        "transition-[background-color,box-shadow] hover:bg-background focus-visible:ring-2 focus-visible:ring-ring/55",
        "dark:shadow-ui-taskprogressindicator-15",
      )}
    >
      <Bot className="size-3.5 text-foreground/60" />
      <span className="font-medium tabular-nums text-foreground/85">
        {t("chat.subagent.runningCount").replace("{count}", String(count))}
      </span>
    </button>
  );
}
