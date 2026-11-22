// Transcript performance harness page. Mounts the real desktop transcript
// (ChatTranscript + live transcript controller), the Edit tool diff and the
// git-review diff with synthetic data, and exposes `window.__perf` for the
// CDP driver in ./run.mjs. Built with React's profiling renderer so a
// <Profiler> can count commits.

import "../src/index.css";
import "katex/dist/katex.min.css";
import "streamdown/styles.css";
import { EditDiffView } from "@liveagent/ui/components/chat/EditDiffView";
import { DiffContent } from "@liveagent/ui/components/project-tools/git-review/DiffView";
import { appendTextDeltaToRound, collapseThinking, updateLiveRound } from "@liveagent/ui/lib/chat/uiMessages";
import type { ScrollFollowHandle } from "@liveagent/ui/lib/chat-scroll/useScrollFollow";
import type { Message } from "@liveagent/ui/lib/chat/agentTypes";
import type { GitDiffResponse } from "@liveagent/ui/lib/git/types";
import { Profiler, useCallback, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  createTranscriptProjection,
  type RenderTimelineItem,
} from "../src/lib/chat/conversation/conversationState";
import type { LiveRound } from "../src/lib/chat/messages/uiMessages";
import { useLiveTranscriptController } from "../src/pages/chat/hooks/useLiveTranscriptController";
import { ChatTranscript } from "../src/pages/chat/transcript/ChatTranscript";
import { buildAgentMessages, buildMessages, editFixture, gitPatchFixture, streamingCorpus } from "./fixtures";

type CommitStats = { n: number; actual: number; max: number };

declare global {
  interface Window {
    __perf: Record<string, unknown>;
    __commits: CommitStats;
  }
}

const commits: CommitStats = { n: 0, actual: 0, max: 0 };
window.__commits = commits;
// Optional render tracing: temporary `globalThis.__rc?.("Name")` probes in
// components report into the commit they render in; `__signatures` counts
// commits by the set of probed components that rendered.
const renderedNow = new Set<string>();
const signatures: Record<string, number> = {};
Object.assign(window, {
  __rc: (name: string) => renderedNow.add(name),
  __signatures: signatures,
});
const onRender = (_id: string, _phase: string, actualDuration: number) => {
  const signature = [...renderedNow].sort().join(",") || "(none)";
  signatures[signature] = (signatures[signature] ?? 0) + 1;
  renderedNow.clear();
  commits.n += 1;
  commits.actual += actualDuration;
  commits.max = Math.max(commits.max, actualDuration);
};
const resetCommits = () => {
  for (const key of Object.keys(signatures)) delete signatures[key];
  commits.n = 0;
  commits.actual = 0;
  commits.max = 0;
};

const params = new URLSearchParams(location.search);
const mode = params.get("mode") ?? "transcript";
const noop = () => {};

// The last loaded history, so a second load can re-project the same objects.
let lastMessages: { key: string; messages: Message[] } | null = null;

type LoadOptions = { agent?: boolean; reuse?: boolean };

function projectHistory(messageCount: number, assistantChars: number, options: LoadOptions) {
  const key = `${messageCount}:${assistantChars}:${options.agent === true}`;
  const messages =
    options.reuse && lastMessages?.key === key
      ? lastMessages.messages
      : options.agent
        ? buildAgentMessages(messageCount)
        : buildMessages(messageCount, assistantChars);
  lastMessages = { key, messages };
  const started = performance.now();
  const projection = createTranscriptProjection({
    segments: [
      {
        segmentIndex: 0,
        segmentId: "seg-perf",
        messages,
        startMessageIndex: 0,
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    activeSegmentIndex: 0,
    oldestMessageOffset: 0,
    hasMoreBefore: false,
    revision: null,
  });
  return { items: projection.items, projectionMs: performance.now() - started };
}

function TranscriptHarness() {
  const [historyItems, setHistoryItems] = useState<RenderTimelineItem[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [conversationId] = useState("perf-conversation");
  const followRef = useRef<ScrollFollowHandle | null>(null);
  const controller = useLiveTranscriptController({ currentConversationId: conversationId });
  const controllerRef = useRef(controller);
  controllerRef.current = controller;

  const load = useCallback((messageCount: number, assistantChars: number, options: LoadOptions = {}) => {
    const { items, projectionMs } = projectHistory(messageCount, assistantChars, options);
    flushSync(() => setHistoryItems(items));
    return { items: items.length, projectionMs };
  }, []);

  const startStream = useCallback(
    (options: { chars?: number; chunk?: number; intervalMs?: number } = {}) => {
      const chars = options.chars ?? 24_000;
      const chunk = options.chunk ?? 4;
      const intervalMs = options.intervalMs ?? 8;
      const text = streamingCorpus(chars);
      const live = controllerRef.current;
      live.resetLiveTranscript();
      flushSync(() => setIsSending(true));
      const append = (delta: string) =>
        live.batchLiveRoundsUpdate((previous: LiveRound[]) => {
          const rounds = previous.some((item) => item.round === 1)
            ? previous
            : [
                ...previous,
                { key: "r1", round: 1, blocks: [], runningToolCallIds: [], thinkingOpen: false },
              ];
          return updateLiveRound(rounds, 1, (round) =>
            appendTextDeltaToRound(collapseThinking(round), delta),
          );
        });
      return new Promise<{ wallMs: number; frames: number }>((resolve) => {
        let offset = 0;
        let frames = 0;
        let counting = true;
        const countFrame = () => {
          frames += 1;
          if (counting) requestAnimationFrame(countFrame);
        };
        requestAnimationFrame(countFrame);
        const started = performance.now();
        const timer = setInterval(() => {
          // Catch up on missed ticks the way a fast provider stream would
          // when the main thread is busy: deltas queue, they are not dropped.
          const due = Math.floor((performance.now() - started) / intervalMs) + 1;
          while (offset < text.length && offset < due * chunk) {
            append(text.slice(offset, offset + chunk));
            offset += chunk;
          }
          if (offset >= text.length) {
            clearInterval(timer);
            // Let the typewriter reveal drain before stopping the clock: done
            // once the rendered text stops growing for three polls.
            const viewport = document.querySelector("[data-scroll-viewport]");
            let lastLength = -1;
            let stable = 0;
            const waitReveal = () => {
              const length = viewport?.textContent?.length ?? 0;
              stable = length === lastLength ? stable + 1 : 0;
              lastLength = length;
              if (stable >= 3 || performance.now() - started > 600_000) {
                counting = false;
                resolve({ wallMs: performance.now() - started, frames });
              } else setTimeout(waitReveal, 200);
            };
            setTimeout(waitReveal, 200);
          }
        }, intervalMs);
      });
    },
    [],
  );

  window.__perf = {
    ...window.__perf,
    mode,
    load,
    startStream,
    resetCommits,
    setSending: (value: boolean) => flushSync(() => setIsSending(value)),
    domNodes: () => document.getElementsByTagName("*").length,
    // Markup of the live reply, for comparing two builds' streamed output.
    liveHtml: () =>
      (document.querySelector("[data-live-activity]")?.innerHTML ?? "").replace(
        / (id|aria-labelledby|aria-controls|aria-describedby)="[^"]*"/g,
        "",
      ),
  };

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Profiler id="transcript" onRender={onRender}>
        <ChatTranscript
          conversationId={conversationId}
          followRef={followRef}
          hasModels
          historyItems={historyItems}
          hasMoreHistory={false}
          onLoadEarlierHistory={async () => {}}
          isHistorySwitching={false}
          isSending={isSending}
          showUsage={false}
          liveTranscriptStore={controller.liveTranscriptStore}
          isCompactionRunning={false}
          bottomReservePx={96}
          contentWidth={768}
          onContentWidthChange={noop}
          onResendFromEdit={noop}
          onOpenSettings={noop}
        />
      </Profiler>
    </div>
  );
}

function EditDiffHarness() {
  const [state, setState] = useState<{ before: string; after: string } | null>(null);
  window.__perf = {
    ...window.__perf,
    mode,
    resetCommits,
    domNodes: () => document.getElementsByTagName("*").length,
    // Mounts a diff of `lines` lines and reports the synchronous render cost.
    mountDiff: (lines: number) => {
      const fixture = editFixture(lines);
      const started = performance.now();
      flushSync(() => setState(fixture));
      return { renderMs: performance.now() - started };
    },
    // Streams the edited text like a partial tool-call argument: the
    // after-text grows by `chunk` lines per tick and every tick re-renders.
    streamDiff: (lines: number, ticks = 200, intervalMs = 16) => {
      const fixture = editFixture(lines);
      const afterLines = fixture.after.split("\n");
      return new Promise((resolve) => {
        let tick = 0;
        const per = Math.max(1, Math.ceil(afterLines.length / ticks));
        const started = performance.now();
        let busy = 0;
        const timer = setInterval(() => {
          tick += 1;
          const visible = afterLines.slice(0, Math.min(afterLines.length, tick * per)).join("\n");
          const t0 = performance.now();
          flushSync(() => setState({ before: fixture.before, after: visible }));
          busy += performance.now() - t0;
          if (tick * per >= afterLines.length) {
            clearInterval(timer);
            setTimeout(
              () =>
                resolve({ ticks: tick, syncMsPerTick: busy / tick, wallMs: performance.now() - started }),
              500,
            );
          }
        }, intervalMs);
      });
    },
  };
  return (
    <div style={{ height: "100vh", overflow: "auto", padding: 24 }} data-scroll-viewport="">
      <Profiler id="edit-diff" onRender={onRender}>
        {state ? (
          <EditDiffView beforeText={state.before} afterText={state.after} filePath="src/perf.ts" />
        ) : null}
      </Profiler>
    </div>
  );
}

function GitDiffHarness() {
  const [diff, setDiff] = useState<GitDiffResponse | null>(null);
  window.__perf = {
    ...window.__perf,
    mode,
    resetCommits,
    domNodes: () => document.getElementsByTagName("*").length,
    mountPatch: (files: number, hunkLines: number) => {
      const fixture = gitPatchFixture(files, hunkLines);
      flushSync(() =>
        setDiff({
          baseRef: "HEAD",
          headRef: "WORKTREE",
          mode: "worktree",
          files: [],
          patch: fixture.patch,
          stat: fixture.stat,
          truncated: false,
          binaryFiles: [],
        }),
      );
    },
  };
  const content = useMemo(
    () => <DiffContent diff={diff} title="Working tree" showStat={false} />,
    [diff],
  );
  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Profiler id="git-diff" onRender={onRender}>
        {content}
      </Profiler>
    </div>
  );
}

const root = createRoot(document.getElementById("root") as HTMLElement);
root.render(
  mode === "editdiff" ? (
    <EditDiffHarness />
  ) : mode === "gitdiff" ? (
    <GitDiffHarness />
  ) : (
    <TranscriptHarness />
  ),
);
