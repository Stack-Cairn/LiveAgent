import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// K-brain runs ReadTerminal and TunnelManager through the desktop host bridge. Their rows
// name what happened ("Read terminal", "Created tunnel") and a short target, live, after a
// reconnect replay and when the conversation is reopened from history.

const icons = new Proxy({}, { get: () => () => null });
const iconPath = fileURLToPath(new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url));
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": icons,
    [iconPath]: icons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/ui/components/Markdown": { Markdown: () => null },
    "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: () => null },
    "@liveagent/ui/components/chat/FileToolArgs": { FileToolArgsDisplay: () => null },
    "@liveagent/ui/components/chat/AskUserQuestionCard": { AskUserQuestionCard: () => null },
    "@liveagent/ui/components/chat/PlanModeCard": { PlanModeCard: () => null },
    "@liveagent/ui/components/chat/AssistantStatus": {
      AssistantStatus: ({ children }) => children,
    },
    "@liveagent/ui/components/chat/LazyCollapse": {
      LazyCollapse: ({ children, open }) => (open ? children() : null),
    },
    "@liveagent/adapters/assistantBubble": {
      readAskUserQuestionDeadline: () => undefined,
      useAskUserQuestionPending: () => false,
      usePlanDecisionState: () => ({ pending: false, approved: false }),
      retainRunningToolContent: false,
      submitAskUserQuestionAnswers() {},
      submitPlanDecision() {},
      usePendingToolApproval: () => false,
      usePermissionAutoResolved: () => null,
      useSubagentCard: () => null,
      deferLargeToolImages: false,
    },
  },
});
const { React, act, createRoot } = env;
const { ToolTraceGroup } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);
const { groupRoundBlocks } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils.ts",
);

const loader = createTsModuleLoader();
const { runKBrainTurn } = loader.loadModule("src/lib/kbrain/turn.ts");
const { convertMessages } = loader.loadModule("src/lib/kbrain/history.ts");
const {
  attachToolResultToRound,
  buildUiMessages,
  setToolLiveOutputInRound,
  upsertToolCallToRound,
} = loader.loadModule("src/lib/chat/messages/uiMessages.ts");

const READ_ARGS = { terminal_id: "term-2", max_bytes: 4096 };
const READ_OUTPUT =
  "terminal_id: term-2\ntitle: Terminal 2\ncwd: /repo\nshell: zsh\nrunning: true\ntruncated: false\n\nready on http://localhost:5173";
const CREATE_ARGS = { action: "create", targetUrl: "http://localhost:5173/app", ttlSeconds: 900 };
const CREATE_OUTPUT = "Tunnel created.\n- http://localhost:5173/app\n  id: tun-1";

function sse(seq, type, payload) {
  return `data: ${JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", seq, type, payload })}\n\n`;
}

const runEvents = [
  ["tool.call", { tool_call: { id: "read-1", name: "ReadTerminal", arguments: READ_ARGS } }],
  ["tool.result", { tool_result: { id: "read-1", name: "ReadTerminal", output: READ_OUTPUT } }],
  ["tool.call", { tool_call: { id: "tunnel-1", name: "TunnelManager", arguments: CREATE_ARGS } }],
  [
    "tool.result",
    { tool_result: { id: "tunnel-1", name: "TunnelManager", output: CREATE_OUTPUT } },
  ],
  ["tool.call", { tool_call: { id: "tunnel-2", name: "TunnelManager", arguments: { action: "list" } } }],
  [
    "tool.result",
    {
      tool_result: {
        id: "tunnel-2",
        name: "TunnelManager",
        output: "LiveAgent host bridge is not connected",
        failed: true,
      },
    },
  ],
  ["assistant.text.delta", { text: "done" }],
  ["run.completed", {}],
].map(([type, payload], index) => ({ seq: index + 2, type, payload }));

async function runTurn(eventStreams) {
  let streams = 0;
  const fetch = async (url) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/v1/sessions") return Response.json({ id: "s" });
    if (pathname === "/v1/health") return Response.json({});
    if (pathname.endsWith("/runs"))
      return Response.json({ version: "kbrain.agent.v1", conversation_id: "s", run_id: "r", accepted_seq: 1 });
    if (pathname.endsWith("/events")) {
      const afterSeq = Number(searchParams.get("after_seq"));
      const events = eventStreams[streams];
      streams += 1;
      if (events === undefined) throw new Error("no more event streams");
      const body = events
        .filter((event) => event.seq > afterSeq)
        .map((event) => sse(event.seq, event.type, event.payload))
        .join("");
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    throw new Error(`Unexpected request ${pathname}`);
  };

  let round = { round: 1, key: "r1", blocks: [], runningToolCallIds: [] };
  const snapshots = [];
  const update = (stage, apply) => {
    round = apply(round);
    snapshots.push({ stage, round });
  };
  const result = await runKBrainTurn({
    baseUrl: "http://fixture.test",
    fetch,
    model: { provider: "fixture", model: "test" },
    sessionId: "frontend",
    conversationId: "host-bridge-rows",
    cwd: "/repo",
    context: { messages: [] },
    prompt: "read the dev server terminal and share it",
    signal: new AbortController().signal,
    onStatus() {},
    onTextDelta() {},
    onThinkingDelta() {},
    onToolCall: (call) =>
      update(`call:${call.id}`, (target) => ({
        ...upsertToolCallToRound(target, call),
        runningToolCallIds: [...new Set([...target.runningToolCallIds, call.id])],
      })),
    onToolOutput: (id, output) =>
      update("output", (target) => setToolLiveOutputInRound(target, id, output)),
    onToolResult: (call, toolResult) =>
      update(`result:${call.id}`, (target) => ({
        ...attachToolResultToRound(target, call, toolResult),
        runningToolCallIds: target.runningToolCallIds.filter((id) => id !== call.id),
      })),
    onPermissionRequest: async () => "allow_once",
  });
  return { result, snapshots, finalRound: round };
}

// Renders the round's tool batches expanded and returns each row's header text.
function renderRows(round) {
  const groups = groupRoundBlocks(round.blocks);
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() =>
    root.render(
      React.createElement(
        React.Fragment,
        null,
        groups.map((group) =>
          React.createElement(ToolTraceGroup, {
            key: group.key,
            items: group.items,
            runningToolCallIds: round.runningToolCallIds ?? [],
            showTurnStatus: true,
          }),
        ),
      ),
    ),
  );
  const header = host.querySelector("button[aria-expanded]");
  const collapsedHeader =
    header.getAttribute("aria-expanded") === "true" ? null : header.textContent;
  if (header.getAttribute("aria-expanded") !== "true") {
    act(() => header.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  }
  const rows = [...host.querySelectorAll("[data-tool-trace-scroll] > *")].map((row) =>
    row.textContent.replace(/\s+/g, " ").trim(),
  );
  const expandedHeader = host.querySelector("button[aria-expanded]").textContent;
  act(() => root.unmount());
  host.remove();
  return { rows, collapsedHeader, expandedHeader };
}

function assertFinishedRows(rows, label) {
  assert.equal(rows.length, 3, `${label}: one row per call`);
  assert.match(rows[0], /^chat\.tool\.activity\.terminal\.completed\s*term-2/, label);
  assert.doesNotMatch(rows[0], /maxBytes|terminal_id=|chat\.tool\.activity\.read\./, label);
  assert.match(rows[1], /^chat\.tool\.tunnel\.create\.completed\s*localhost:5173\/app/, label);
  assert.doesNotMatch(rows[1], /action=|TunnelManager/, label);
  assert.match(rows[2], /^chat\.tool\.tunnel\.list\.failed/, label);
}

test.after(() => env.cleanup());

test("live K-brain host bridge calls get concise, action-specific rows", async () => {
  const { result, snapshots, finalRound } = await runTurn([runEvents]);
  assert.equal(result.stopReason, "stop");

  const readRunning = snapshots.find((snapshot) => snapshot.stage === "call:read-1").round;
  const running = renderRows(readRunning);
  assert.match(running.rows[0], /^chat\.tool\.activity\.terminal\.running\s*term-2/);
  assert.equal(running.expandedHeader, "chat.tool.batch.terminal.running");

  const createRunning = snapshots.find((snapshot) => snapshot.stage === "call:tunnel-1").round;
  const creating = renderRows(createRunning);
  assert.match(creating.rows[1], /^chat\.tool\.tunnel\.create\.running\s*localhost:5173\/app/);

  const finished = renderRows(finalRound);
  assertFinishedRows(finished.rows, "live");
  // A finished batch names both kinds of work, not "Read files".
  assert.match(finished.expandedHeader, /chat\.tool\.batch\.terminal/);
  assert.match(finished.expandedHeader, /chat\.tool\.batch\.tunnel/);
  assert.doesNotMatch(finished.expandedHeader, /chat\.tool\.batch\.read\b/);
});

test("a reconnect replay renders the same rows", async () => {
  // The first stream drops after the first result; the replay resumes from after_seq.
  const { finalRound } = await runTurn([runEvents.slice(0, 2), runEvents]);
  assertFinishedRows(renderRows(finalRound).rows, "replay");
});

test("history renders the same rows", () => {
  const messages = convertMessages(
    [
      { id: "u1", role: "user", content: [{ type: "text", text: "share the dev server" }] },
      {
        id: "a1",
        role: "assistant",
        content: [],
        tool_calls: [
          { id: "read-1", name: "ReadTerminal", arguments: READ_ARGS },
          { id: "tunnel-1", name: "TunnelManager", arguments: CREATE_ARGS },
          { id: "tunnel-2", name: "TunnelManager", arguments: { action: "list" } },
        ],
      },
      { id: "t1", role: "tool", tool_call_id: "read-1", name: "ReadTerminal", content: [{ type: "text", text: READ_OUTPUT }] },
      { id: "t2", role: "tool", tool_call_id: "tunnel-1", name: "TunnelManager", content: [{ type: "text", text: CREATE_OUTPUT }] },
      {
        id: "t3",
        role: "tool",
        tool_call_id: "tunnel-2",
        name: "TunnelManager",
        content: [{ type: "text", text: "LiveAgent host bridge is not connected" }],
        stop_reason: "error",
      },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "done" }] },
    ],
    0,
    "/repo",
  );
  const rounds = buildUiMessages(messages).flatMap((message) => message.rounds ?? []);
  const round = rounds.find((candidate) => candidate.blocks.some((block) => block.kind === "tool"));
  const { rows } = renderRows({ ...round, runningToolCallIds: [] });
  assert.equal(rows.length, 3);
  assert.match(rows[0], /^chat\.tool\.activity\.terminal\.completed\s*term-2/);
  assert.match(rows[1], /^chat\.tool\.tunnel\.create\.completed\s*localhost:5173\/app/);
  assert.match(rows[2], /^chat\.tool\.tunnel\.list\.failed/);
});
