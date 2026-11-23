// The quiet reply progress contract: one live status row per turn, phases
// debounced so bookkeeping stages never flash, reasoning merged into the tool
// stage it belongs to, and a settled turn folded into one summary row.
//
// Assertions compare strings and numbers, never DOM nodes: a failing assert
// would try to print a whole jsdom tree.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const pure = createTsModuleLoader();
const {
  initialRunPhaseState,
  resolveRunPhaseTarget,
  stepRunPhase,
  RUN_PHASE_DEBOUNCE_MS,
  RUN_PHASE_MODEL_WAIT_MS,
} = pure.loadModule("@liveagent/ui/lib/chat/runPhase.ts");
const { encodeRunProgress } = pure.loadModule("@liveagent/ui/lib/chat/runProgress.ts");
const { buildWorkTraceItems, countWorkTraceToolCalls, trailingReplyTextLength } = pure.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/workTraceDisplay.ts",
);

const progress = (stage, extra = {}) => encodeRunProgress({ stage, ...extra });

// --- phase mapping and debounce (pure) ---

test("backend stages fold into a few phases with their own delays", () => {
  const cases = [
    ["waiting_model", "thinking", RUN_PHASE_MODEL_WAIT_MS, false],
    ["thinking", "thinking", RUN_PHASE_DEBOUNCE_MS, true],
    ["responding", "responding", RUN_PHASE_DEBOUNCE_MS, true],
    ["tool", "tool", RUN_PHASE_DEBOUNCE_MS, true],
    ["preparing", "preparing", RUN_PHASE_DEBOUNCE_MS, false],
    ["persisting", "persisting", RUN_PHASE_DEBOUNCE_MS, false],
    ["connecting", "connecting", RUN_PHASE_DEBOUNCE_MS, false],
    ["waiting_session", "waiting_session", RUN_PHASE_DEBOUNCE_MS, false],
    // Blocked states stay explicit and show at once.
    ["reconnecting", "reconnecting", 0, true],
    ["compacting", "compacting", 0, true],
  ];
  for (const [stage, phase, delayMs, showOnMount] of cases) {
    const target = resolveRunPhaseTarget(progress(stage));
    assert.deepEqual(
      { phase: target.phase, delayMs: target.delayMs, showOnMount: target.showOnMount },
      { phase, delayMs, showOnMount },
      stage,
    );
    assert.equal(target.stage, stage);
  }
  assert.equal(resolveRunPhaseTarget(null).phase, "working");
  assert.equal(resolveRunPhaseTarget(null, { hasRunningTool: true }).phase, "tool");
  const custom = resolveRunPhaseTarget("Indexing workspace");
  assert.deepEqual([custom.phase, custom.text], ["custom", "Indexing workspace"]);
});

test("a short preparing stage never reaches the screen", () => {
  let state = initialRunPhaseState(resolveRunPhaseTarget(progress("preparing")), false);
  assert.equal(state.shown, "working", "preparing does not show on mount");

  let step = stepRunPhase(state, resolveRunPhaseTarget(progress("preparing")), 0);
  assert.equal(step.state.shown, "working");
  assert.equal(step.dueAt, RUN_PHASE_DEBOUNCE_MS);

  // Preparing → persisting → responding within 800 ms each: none shows until
  // responding has held for its full delay.
  step = stepRunPhase(step.state, resolveRunPhaseTarget(progress("persisting")), 100);
  assert.equal(step.state.shown, "working");
  assert.equal(step.dueAt, 100 + RUN_PHASE_DEBOUNCE_MS);
  step = stepRunPhase(step.state, resolveRunPhaseTarget(progress("responding")), 600);
  assert.equal(step.state.shown, "working");
  assert.equal(step.dueAt, 600 + RUN_PHASE_DEBOUNCE_MS);
  step = stepRunPhase(step.state, resolveRunPhaseTarget(progress("responding")), 1_399);
  assert.equal(step.state.shown, "working");
  step = stepRunPhase(step.state, resolveRunPhaseTarget(progress("responding")), 1_400);
  assert.equal(step.state.shown, "responding");
  assert.equal(step.dueAt, null);
});

test("waiting for the model reads as thinking after 1.5 s, or 800 ms once reasoning streams", () => {
  const waiting = resolveRunPhaseTarget(progress("waiting_model"));
  let step = stepRunPhase({ shown: "working", pending: null }, waiting, 0);
  assert.equal(step.dueAt, RUN_PHASE_MODEL_WAIT_MS);
  assert.equal(stepRunPhase(step.state, waiting, 1_499).state.shown, "working");
  assert.equal(stepRunPhase(step.state, waiting, 1_500).state.shown, "thinking");

  // Reasoning starts at 300 ms: the pending phase keeps its start and takes
  // the shorter delay, so "thinking" shows at 800 ms instead of 1.1 s or 1.5 s.
  step = stepRunPhase(step.state, resolveRunPhaseTarget(progress("thinking")), 300);
  assert.equal(step.dueAt, RUN_PHASE_DEBOUNCE_MS);
  assert.equal(stepRunPhase(step.state, resolveRunPhaseTarget(progress("thinking")), 800).state.shown, "thinking");
});

test("reconnecting is immediate, and the detailed view skips every delay", () => {
  const shown = { shown: "thinking", pending: null };
  assert.equal(stepRunPhase(shown, resolveRunPhaseTarget(progress("reconnecting")), 5).state.shown, "reconnecting");
  assert.equal(
    stepRunPhase(shown, resolveRunPhaseTarget(progress("preparing")), 5, true).state.shown,
    "preparing",
  );
  assert.equal(initialRunPhaseState(resolveRunPhaseTarget(progress("preparing")), true).shown, "preparing");
  // Returning to the shown phase drops whatever was pending.
  const pending = stepRunPhase(shown, resolveRunPhaseTarget(progress("persisting")), 0).state;
  assert.notEqual(pending.pending, null);
  assert.equal(stepRunPhase(pending, resolveRunPhaseTarget(progress("thinking")), 10).state.pending, null);
});

// --- reasoning merge rules (pure) ---

let nextId = 0;
const thinking = (text) => {
  const key = `think-${++nextId}`;
  return { key, roundKey: "r1", block: { kind: "thinking", text }, runningToolCallIds: [], thinkingOpen: false };
};
const tools = (...ids) => ({
  key: `tools-${++nextId}`,
  roundKey: "r1",
  block: {
    kind: "toolGroup",
    items: ids.map((id) => ({ toolCall: { type: "toolCall", id, name: "Read", arguments: { path: `${id}.ts` } } })),
  },
  runningToolCallIds: [],
  thinkingOpen: false,
});
const note = (text) => ({
  key: `note-${++nextId}`,
  roundKey: "r1",
  block: { kind: "text", id: `text-${nextId}`, text },
  runningToolCallIds: [],
  thinkingOpen: false,
});
const subagent = (id) => ({
  key: `agent-${++nextId}`,
  roundKey: "r1",
  block: { kind: "tool", item: { toolCall: { type: "toolCall", id, name: "Agent", arguments: {} } } },
  runningToolCallIds: [],
  thinkingOpen: false,
});

const shape = (items) =>
  items.map((item) =>
    item.kind === "activity"
      ? {
          kind: item.kind,
          key: item.key,
          tools: item.items.map((tool) => tool.toolCall.id),
        }
      : item.kind === "reasoning"
        ? { kind: item.kind, key: item.key, texts: item.segments.map((segment) => segment.text) }
        : { kind: item.kind, key: item.key },
  );

test("a turn's reasoning merges into one leading row; tool calls between it form one group", () => {
  const plan = thinking("plan");
  const firstTools = tools("a", "b");
  const entries = [plan, firstTools, thinking("check a"), thinking("check b"), tools("c"), thinking("wrap up")];
  assert.deepEqual(shape(buildWorkTraceItems(entries)), [
    // One reasoning row for the whole turn, keyed by its first segment.
    { kind: "reasoning", key: plan.key, texts: ["plan", "check a", "check b", "wrap up"] },
    // The first batch's key stays put as the stage grows: no remount.
    { kind: "activity", key: firstTools.key, tools: ["a", "b", "c"] },
  ]);
  assert.equal(countWorkTraceToolCalls(entries), 3);
});

test("notes or standalone tools still end a tool stage, but never split the reasoning row", () => {
  const first = thinking("read the issue");
  const progressNote = note("Found the bug, fixing it now.");
  const agent = subagent("agent-1");
  const entries = [first, thinking("look at tests"), progressNote, tools("x"), thinking("verify"), agent, thinking("done")];
  assert.deepEqual(shape(buildWorkTraceItems(entries)), [
    { kind: "reasoning", key: first.key, texts: ["read the issue", "look at tests", "verify", "done"] },
    { kind: "entry", key: progressNote.key },
    { kind: "activity", key: entries[3].key, tools: ["x"] },
    { kind: "entry", key: agent.key },
  ]);
  assert.equal(countWorkTraceToolCalls(entries), 2);
});

test("reasoning under a second stays out of the trace; untimed history reasoning stays", () => {
  const cases = [
    // [running, active, detailed, settledMs, visible]
    [false, false, false, 400, false],
    [false, false, false, 1_000, true],
    [false, false, false, null, true],
    [true, true, false, null, false],
    [true, false, false, 600, false],
    [true, true, false, 2_400, true],
    [true, true, true, null, true],
  ];
  for (const [running, active, detailed, settledMs, visible] of cases) {
    assert.equal(
      shouldShowReasoningRow({ running, active, detailed, settledMs }),
      visible,
      JSON.stringify({ running, active, detailed, settledMs }),
    );
  }
});

test("the reply text at the live edge is what the status row steps aside for", () => {
  assert.equal(trailingReplyTextLength([thinking("plan"), tools("a")]), 0);
  assert.equal(trailingReplyTextLength([tools("a"), note("  Done.  ")]), 5);
  assert.equal(trailingReplyTextLength([]), 0);
});

// --- rendered status row and turn (DOM, fake timers) ---

const T = {
  "chat.thinking": "思考中",
  "chat.thinkingProcess": "思考过程",
  "chat.thoughtDuration": "思考 · {duration}",
  "chat.runPhase.responding": "正在回复",
  "chat.runProgress.preparing": "准备中",
  "chat.runProgress.persisting": "保存中",
  "chat.runProgress.reconnecting": "正在重新连接",
  "chat.runProgress.waiting_model": "等待模型响应",
  "chat.runProgress.backend": "后端",
  "chat.runProgress.modelRequest": "模型请求",
  "chat.work.running": "处理中",
  "chat.work.activity": "已处理",
  "chat.work.trace": "执行过程",
  "chat.work.toolCount": "{count} 个工具",
  "chat.work.toolCountOne": "1 个工具",
  "chat.work.thinkingTotal": "思考 {duration}",
  "chat.work.awaitingDecision": "等待你的决定",
};
const EmptyIcon = () => null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/Markdown": {
      Markdown: ({ content }) => env.React.createElement("div", { "data-md": "" }, content),
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "zh-CN", t: (key) => T[key] ?? key }) },
    "../../i18n/index": { useLocale: () => ({ locale: "zh-CN", t: (key) => T[key] ?? key }) },
    "../../IconSet": new Proxy({}, { get: () => EmptyIcon }),
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => EmptyIcon }),
  },
});
const { React, act, createRoot } = env;
const { LiveTurnStatus } = env.loadModule("@liveagent/ui/components/chat/LiveTurnStatus.tsx");
const { ProcessDisclosureProvider } = env.loadModule("@liveagent/ui/components/chat/processDisclosure.tsx");
const { AssistantTurnContent, shouldShowReasoningRow } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/RoundContent.tsx",
);

test.after(() => env.cleanup());

const START = Date.parse("2026-10-19T10:00:00Z");

function withFakeClock(run) {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: START });
  try {
    return run((ms) => act(() => mock.timers.tick(ms)));
  } finally {
    mock.timers.reset();
  }
}

function mountStatus({ detailedProgress = false } = {}) {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (props) =>
    act(() =>
      root.render(
        React.createElement(
          ProcessDisclosureProvider,
          { expandByDefault: false, detailedProgress },
          React.createElement(LiveTurnStatus, { startedAtMs: START, ...props }),
        ),
      ),
    );
  const row = () => host.querySelector("[data-live-turn-status]");
  // The elapsed span sits right after the label; spacing comes from CSS.
  const label = () => (row()?.textContent ?? "").replace(/\s*·\s*/g, " · ");
  return { host, render, row, label, unmount: () => act(() => root.unmount()) };
}

test("the status row hides a sub-800 ms preparing stage and shows the next phase once it holds", () => {
  withFakeClock((advance) => {
    const view = mountStatus();
    const seen = new Set();
    const record = () => seen.add(view.label());

    view.render({ status: progress("preparing") });
    record();
    advance(600);
    record();
    view.render({ status: progress("responding") });
    record();
    advance(799);
    record();
    assert.match(view.label(), /^处理中/);
    advance(1);
    record();
    assert.match(view.label(), /^正在回复 · 1s$/);
    assert.ok(![...seen].some((label) => label.includes("准备中")), [...seen].join(" | "));
    view.unmount();
  });
});

test("a model wait shows 思考中 only after 1.5 s; a reconnect shows at once", () => {
  withFakeClock((advance) => {
    const view = mountStatus();
    view.render({ status: progress("waiting_model") });
    assert.match(view.label(), /^处理中/);
    advance(1_499);
    assert.match(view.label(), /^处理中/);
    advance(1);
    assert.match(view.label(), /^思考中 · 1s$/);
    assert.equal(view.row().dataset.phase, "thinking");

    view.render({ status: progress("reconnecting") });
    assert.match(view.label(), /^正在重新连接/);
    view.unmount();
  });
});

test("diagnostic timings live in the tooltip; the detailed view shows them and every stage at once", () => {
  withFakeClock(() => {
    const status = progress("waiting_model", { elapsed_ms: 1_200, model_request_ms: 900 });
    const quiet = mountStatus();
    quiet.render({ status: progress("thinking") });
    quiet.render({ status: progress("thinking", { elapsed_ms: 1_200, model_request_ms: 900 }) });
    // No elapsed suffix yet at 0 s.
    assert.equal(quiet.row().getAttribute("title"), "后端: 1.20 s\n模型请求: 0.90 s");
    assert.equal(quiet.host.querySelector("[data-run-progress-timings]"), null);
    assert.equal(quiet.label(), "思考中");
    quiet.unmount();

    const detailed = mountStatus({ detailedProgress: true });
    detailed.render({ status: progress("preparing") });
    assert.match(detailed.label(), /^准备中/);
    detailed.render({ status });
    assert.match(detailed.label(), /^等待模型响应/);
    assert.ok(detailed.host.querySelector("[data-run-progress-timings]"));
    detailed.unmount();
  });
});

test("a turn waiting on the user freezes the one row instead of adding another", () => {
  withFakeClock(() => {
    const view = mountStatus();
    view.render({ status: progress("thinking"), awaitingDecision: true });
    assert.match(view.label(), /^等待你的决定/);
    assert.ok(view.row().hasAttribute("data-paused"));
    assert.equal(view.host.querySelectorAll("[data-live-turn-status]").length, 1);
    view.unmount();
  });
});

const readTool = (id, path, done = true) => ({
  kind: "tool",
  item: {
    toolCall: { type: "toolCall", id, name: "Read", arguments: { path } },
    ...(done
      ? { toolResult: { role: "toolResult", toolCallId: id, isError: false, content: [], details: { path } } }
      : {}),
  },
});

function turnRounds({ settled }) {
  const rounds = [
    {
      round: 1,
      key: "r1",
      blocks: [{ kind: "thinking", id: "th-1", text: "先读入口文件。" }, readTool("t1", "src/main.ts")],
      meta: { stopReason: "toolUse" },
      runningToolCallIds: [],
    },
    {
      round: 2,
      key: "r2",
      blocks: [
        { kind: "thinking", id: "th-2", text: "再看配置。" },
        ...(settled ? [readTool("t2", "src/config.ts")] : []),
      ],
      meta: settled ? { stopReason: "toolUse" } : undefined,
      // The live round is still streaming its reasoning.
      thinkingOpen: !settled,
      runningToolCallIds: [],
    },
  ];
  if (settled) {
    rounds.push({
      round: 3,
      key: "r3",
      blocks: [{ kind: "text", id: "answer", text: "配置读取顺序没问题。" }],
      meta: { stopReason: "stop" },
      runningToolCallIds: [],
    });
  }
  return rounds;
}

test("a live turn with reasoning and tools renders exactly one status row and no spinners", () => {
  withFakeClock((advance) => {
    const host = document.createElement("div");
    const root = createRoot(host);
    act(() =>
      root.render(
        React.createElement(AssistantTurnContent, {
          rounds: turnRounds({ settled: false }),
          isLive: true,
          isStreaming: true,
          toolStatus: progress("thinking"),
          startedAtMs: START,
        }),
      ),
    );
    advance(4_000);

    assert.equal(host.querySelectorAll("[data-live-turn-status]").length, 1);
    assert.equal(host.querySelectorAll("[role=status]").length, 1);
    assert.equal(host.querySelectorAll(".animate-spin, [data-thinking-active]").length, 0);
    // "思考中" appears once, on the status row; reasoning rows never repeat it.
    assert.equal(host.textContent.split("思考中").length - 1, 1);
    assert.equal(host.querySelector("[data-live-turn-status]").textContent.replace(/\s*·\s*/g, " · "), "思考中 · 4s");
    // The trace header is a static label without its own clock.
    assert.equal(host.querySelector("[data-chat-work-summary]").textContent, "执行过程 · 1 个工具");
    // The live row is the last thing in the turn.
    assert.ok(host.firstElementChild.lastElementChild.matches("[data-live-turn-status]"));
    act(() => root.unmount());
  });
});

test("a completed turn folds into one expandable summary row", () => {
  withFakeClock((advance) => {
    const host = document.createElement("div");
    const root = createRoot(host);
    const render = (props) => act(() => root.render(React.createElement(AssistantTurnContent, props)));

    // Reasoning is measured while it streams (the last block of a live turn).
    render({ rounds: turnRounds({ settled: false }), isLive: true, isStreaming: true, startedAtMs: START });
    advance(8_000);
    render({ rounds: turnRounds({ settled: true }), isLive: false, isStreaming: false, durationMs: 12_000 });

    assert.equal(host.querySelectorAll("[data-live-turn-status]").length, 0);
    const traces = host.querySelectorAll("[data-chat-work-trace]");
    assert.equal(traces.length, 1);
    assert.equal(
      traces[0].querySelector("[data-chat-work-summary]").textContent,
      "已处理 12s · 2 个工具 · 思考 8s",
    );
    const toggle = traces[0].querySelector("button");
    assert.equal(toggle.getAttribute("aria-expanded"), "false");
    assert.match(host.textContent, /配置读取顺序没问题/);

    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(toggle.getAttribute("aria-expanded"), "true");
    // Expanded: one collapsed reasoning row for the whole turn, then one tool group.
    const operations = traces[0].querySelectorAll("[data-assistant-operation]");
    assert.equal(operations.length, 2);
    const disclosures = traces[0].querySelectorAll("[data-thinking-disclosure] > button");
    assert.deepEqual(
      Array.from(disclosures, (button) => [button.textContent, button.getAttribute("aria-expanded")]),
      [["思考 · 8s", "false"]],
    );
    assert.ok(operations[0].querySelector("[data-thinking-disclosure]"));
    act(() => root.unmount());
  });
});

function mountTurn() {
  const host = document.createElement("div");
  const root = createRoot(host);
  const render = (props) =>
    act(() =>
      root.render(
        React.createElement(
          ProcessDisclosureProvider,
          { expandByDefault: false, detailedProgress: false },
          React.createElement(AssistantTurnContent, { startedAtMs: START, ...props }),
        ),
      ),
    );
  const reasoningLabels = () =>
    Array.from(host.querySelectorAll("[data-thinking-disclosure] > button"), (button) => button.textContent);
  return { host, render, reasoningLabels, unmount: () => act(() => root.unmount()) };
}

const reasoningRound = (key, text, { open = false, tool = null, stopReason } = {}) => ({
  round: Number(key.slice(1)),
  key,
  blocks: [{ kind: "thinking", id: `th-${key}`, text }, ...(tool ? [tool] : [])],
  meta: stopReason ? { stopReason } : undefined,
  thinkingOpen: open,
  runningToolCallIds: [],
});

test("a live turn grows one reasoning row once a second of reasoning has settled", () => {
  withFakeClock((advance) => {
    const view = mountTurn();
    const r1 = reasoningRound("q1", "Read the readme.", { open: true });
    view.render({ rounds: [r1], isLive: true, isStreaming: true });
    advance(300);
    // A 300 ms burst settles below the threshold: no row, only the status row.
    const r1done = reasoningRound("q1", "Read the readme.", { tool: readTool("q1-t", "README.md"), stopReason: "toolUse" });
    const r2 = reasoningRound("q2", "Search the sources for exports.", { open: true });
    view.render({ rounds: [r1done, r2], isLive: true, isStreaming: true });
    assert.deepEqual(view.reasoningLabels(), []);
    advance(2_200);
    const r2done = reasoningRound("q2", "Search the sources for exports.", { tool: readTool("q2-t", "src/app.ts"), stopReason: "toolUse" });
    const r3 = reasoningRound("q3", "List the files.", { open: true });
    view.render({ rounds: [r1done, r2done, r3], isLive: true, isStreaming: true });
    // One row with the settled total, while the next burst streams.
    assert.deepEqual(view.reasoningLabels(), ["思考 · 2s"]);
    assert.equal(view.host.querySelectorAll("[data-live-turn-status]").length, 1);
    view.unmount();
  });
});

test("a settled turn hides reasoning under a second", () => {
  withFakeClock((advance) => {
    const view = mountTurn();
    const live = reasoningRound("s1", "Quick check.", { open: true });
    view.render({ rounds: [live], isLive: true, isStreaming: true });
    advance(400);
    const done = reasoningRound("s1", "Quick check.", { tool: readTool("s1-t", "a.ts"), stopReason: "toolUse" });
    const answer = { round: 2, key: "s2", blocks: [{ kind: "text", id: "s2-a", text: "All good." }], meta: { stopReason: "stop" }, runningToolCallIds: [] };
    view.render({ rounds: [done, answer], isLive: false, isStreaming: false, durationMs: 3_000 });
    const toggle = view.host.querySelector("[data-chat-work-trace] > button");
    act(() => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    assert.equal(view.host.querySelectorAll("[data-assistant-operation]").length, 1);
    assert.deepEqual(view.reasoningLabels(), []);
    view.unmount();
  });
});

test("the status row steps aside while reply text streams and returns when it stalls", () => {
  withFakeClock((advance) => {
    const view = mountTurn();
    const replyRound = (text) => ({
      round: 1,
      key: "w1",
      blocks: [readTool("w1-t", "a.ts"), { kind: "text", id: "w1-a", text }],
      runningToolCallIds: [],
    });
    const statusRows = () => view.host.querySelectorAll("[data-live-turn-status]").length;
    view.render({ rounds: [replyRound("")], isLive: true, isStreaming: true, toolStatus: progress("responding") });
    advance(1_000);
    assert.equal(statusRows(), 1);
    view.render({ rounds: [replyRound("The project")], isLive: true, isStreaming: true, toolStatus: progress("responding") });
    assert.equal(statusRows(), 0, "streaming text is the indicator");
    advance(1_000);
    view.render({ rounds: [replyRound("The project has a")], isLive: true, isStreaming: true, toolStatus: progress("responding") });
    assert.equal(statusRows(), 0);
    advance(3_000);
    assert.equal(statusRows(), 1, "a stalled reply brings the status row back");
    // A blocked phase always shows, even mid-text.
    view.render({ rounds: [replyRound("The project has a short")], isLive: true, isStreaming: true, toolStatus: progress("reconnecting") });
    assert.equal(statusRows(), 1);
    view.unmount();
  });
});
