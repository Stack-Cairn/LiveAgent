import assert from "node:assert/strict";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const goal = loader.loadModule("src/lib/chat/goalState.ts");
const adapters = loader.loadModule("src/lib/gatewaySocketV2/adapters.ts");
const { createWebComposerCommandHost } = loader.loadModule("src/app/webComposerCommandHost.ts");
const pb = loader.loadModule("@bufbuild/protobuf");
const v2 = loader.loadModule("src/lib/proto/gen/proto/v2/gateway_ws_pb.ts");

// 桌面桥接与直连网关推送的同一形状：外层是 WebUI 对话 id，内层是 K-brain GoalState。
function goalUpdated(conversationId, state) {
  return {
    type: "goal_updated",
    conversation_id: conversationId,
    run_id: "run-1",
    seq: 7,
    goal: {
      version: 1,
      conversation_id: "kbrain-session-1",
      goal: "ship the release notes",
      status: "active",
      round: 2,
      max_rounds: 20,
      started_at: "2026-11-05T08:00:00Z",
      ...state,
    },
  };
}

test("goal_updated events are keyed by the outer WebUI conversation id", () => {
  const parsed = goal.goalStateFromChatEvent(goalUpdated(" conv-1 ", {}));
  assert.deepEqual(parsed, {
    conversationId: "conv-1",
    state: {
      goal: "ship the release notes",
      status: "active",
      round: 2,
      maxRounds: 20,
      reason: "",
      startedAt: "2026-11-05T08:00:00Z",
    },
  });
  assert.equal(goal.goalStateFromChatEvent({ type: "token", conversation_id: "conv-1" }), null);
  assert.equal(goal.goalStateFromChatEvent({ type: "goal_updated", goal: {} }), null);
  assert.equal(
    goal.goalStateFromChatEvent({ type: "goal_updated", conversation_id: "c", goal: [] }),
    null,
  );
  assert.equal(goal.goalStateFromChatEvent(null), null);
});

test("goal bar shows running and paused goals only, like the desktop bar", () => {
  const base = {
    goal: "g",
    round: 1,
    maxRounds: 5,
    reason: "",
    startedAt: "2026-11-05T08:00:00Z",
  };
  assert.deepEqual(goal.goalBarState({ ...base, status: "continuing" }), {
    goal: "g",
    status: "continuing",
    round: 1,
    maxRounds: 5,
    reason: undefined,
    startedAt: Date.parse("2026-11-05T08:00:00Z"),
  });
  const paused = goal.goalBarState({
    ...base,
    status: "paused",
    reason: "awaiting_input",
    startedAt: "",
  });
  assert.equal(paused.reason, "awaiting_input");
  assert.equal(paused.startedAt, undefined);
  for (const status of ["met", "cleared", "none", ""]) {
    assert.equal(goal.goalBarState({ ...base, status }), null, status);
  }
  assert.equal(goal.goalBarState({ ...base, goal: "", status: "active" }), null);
  assert.equal(goal.goalBarState(undefined), null);
});

test("pushed goal events and RPC results share one store with revisions", () => {
  const seen = [];
  const unsubscribe = goal.subscribeGoalState((id) => seen.push(id));
  const before = goal.readGoalRevision("conv-store");
  assert.equal(goal.absorbGoalChatEvent(goalUpdated("conv-store", { status: "paused" })), true);
  assert.equal(goal.absorbGoalChatEvent({ type: "token", conversation_id: "conv-store" }), false);
  assert.equal(goal.readGoalState("conv-store").status, "paused");
  assert.equal(goal.readGoalRevision("conv-store"), before + 1);
  goal.publishGoalState(
    "conv-store",
    goal.goalStateFromResponse({
      conversationId: "conv-store",
      goal: "ship the release notes",
      status: "cleared",
      round: 0,
      maxRounds: 20,
      reason: "",
      startedAt: "",
    }),
  );
  assert.equal(goal.readGoalState("conv-store").status, "cleared");
  assert.equal(goal.readGoalRevision("conv-store"), before + 2);
  unsubscribe();
  goal.publishGoalState("conv-store", goal.readGoalState("conv-store"));
  assert.deepEqual(seen, ["conv-store", "conv-store"]);
  assert.equal(goal.readGoalState(undefined), undefined);
});

test("resume is offered only when the runtime lists the goal action", () => {
  assert.equal(goal.catalogSupportsGoalResume([{ name: "goal", kind: "action" }]), true);
  assert.equal(goal.catalogSupportsGoalResume([{ name: "goal", kind: "prompt" }]), false);
  assert.equal(goal.catalogSupportsGoalResume([{ name: "loop", kind: "action" }]), false);
  assert.equal(goal.catalogSupportsGoalResume([]), false);
});

test("goal.manage carries the update text and decodes started_at", () => {
  const frame = pb.fromBinary(
    v2.WebClientFrameSchema,
    adapters.encodeRequestFrame(
      "goal-1",
      "goal.manage",
      { conversationId: " conv-1 ", action: "update", goal: "  draft the notes  " },
      "agent-1",
    ),
  );
  assert.equal(frame.payload.value.payload.case, "goalManage");
  assert.equal(frame.payload.value.payload.value.conversationId, "conv-1");
  assert.equal(frame.payload.value.payload.value.action, "update");
  assert.equal(frame.payload.value.payload.value.goal, "draft the notes");

  const decoded = adapters.decodeServerFrame(
    adapters.decodeServerFrameBinary(
      pb.toBinary(
        v2.WebServerFrameSchema,
        pb.fromJson(v2.WebServerFrameSchema, {
          request_id: "goal-1",
          agent_id: "agent-1",
          agent_response: {
            request_id: "goal-1",
            goal_manage_resp: {
              conversation_id: "conv-1",
              goal: "draft the notes",
              status: "paused",
              round: 3,
              max_rounds: 20,
              reason: "restored",
              started_at: "2026-11-05T08:00:00Z",
            },
          },
        }),
      ),
    ),
    { agentOnline: true },
  );
  assert.equal(decoded.kind, "response");
  assert.deepEqual(decoded.payload, {
    conversationId: "conv-1",
    goal: "draft the notes",
    status: "paused",
    round: 3,
    maxRounds: 20,
    reason: "restored",
    startedAt: "2026-11-05T08:00:00Z",
  });
});

test("/goal pause and /goal clear in the WebUI update the goal bar", async () => {
  const calls = [];
  const response = (status) => ({
    conversationId: "conv-host",
    goal: "ship",
    status,
    round: 1,
    maxRounds: 5,
    reason: "",
    startedAt: "",
  });
  const client = {
    listCommands: async () => ({ commands: [] }),
    async clearGoal(id) {
      calls.push(["clear", id]);
      return response("cleared");
    },
    async pauseGoal(id) {
      // 方法调用要保留 this（实际客户端是类实例）。
      assert.equal(this, client);
      calls.push(["pause", id]);
      return response("paused");
    },
    listLoops: async () => ({ loops: [] }),
    createLoop: async () => ({ loops: [] }),
    cancelLoop: async () => ({ loops: [] }),
  };
  const host = createWebComposerCommandHost({
    t: (key) => key,
    client,
    getConversationId: () => "conv-host",
    getWorkdir: () => undefined,
    getRuntimeControls: () => ({ planModeEnabled: false }),
    sendTurn: () => true,
  });
  await host.pauseGoal();
  assert.equal(goal.readGoalState("conv-host").status, "paused");
  await host.clearGoal();
  assert.equal(goal.readGoalState("conv-host").status, "cleared");
  assert.deepEqual(calls, [
    ["pause", "conv-host"],
    ["clear", "conv-host"],
  ]);

  const { pauseGoal: _omit, ...legacy } = client;
  const legacyHost = createWebComposerCommandHost({
    t: (key) => key,
    client: legacy,
    getConversationId: () => "conv-host",
    getWorkdir: () => undefined,
    getRuntimeControls: () => ({ planModeEnabled: false }),
    sendTurn: () => true,
  });
  assert.equal(legacyHost.pauseGoal, undefined);
});

function NullIcon() {
  return null;
}

test("shared goal bar hides the resume button when the host cannot resume", () => {
  const requireFromRoot = createRequire(path.join(rootDir, "package.json"));
  const jsxRuntime = requireFromRoot("react/jsx-runtime");
  const { renderToStaticMarkup } = requireFromRoot("react-dom/server");
  const barLoader = createWebModuleLoader({
    rootDir,
    mocks: {
      "react/jsx-runtime": jsxRuntime,
      "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
      "@liveagent/ui/components/IconSet": {
        Check: NullIcon,
        Goal: NullIcon,
        Pause: NullIcon,
        Play: NullIcon,
        SquarePen: NullIcon,
        Trash2: NullIcon,
        X: NullIcon,
      },
      "@liveagent/ui/components/ui/confirm-dialog": {
        useConfirmDialog: () => ({ confirm: async () => true, dialog: null }),
      },
    },
  });
  const { ComposerGoalBar } = barLoader.loadModule(
    "@liveagent/ui/components/chat/ComposerGoalBar.tsx",
  );
  const render = (status, actions) =>
    renderToStaticMarkup(
      jsxRuntime.jsx(ComposerGoalBar, {
        state: { goal: "ship", status, round: 1, maxRounds: 5 },
        actions: { onPause() {}, onUpdate() {}, onClear() {}, ...actions },
      }),
    );
  assert.doesNotMatch(render("paused", {}), /chat\.goalBar\.resume/);
  assert.match(render("paused", {}), /chat\.goalBar\.clear/);
  assert.match(render("paused", { onResume() {} }), /chat\.goalBar\.resume/);
  assert.match(render("active", {}), /chat\.goalBar\.pause/);
});
