// 项目工具 Pane 合同测试:文件树/审查/内网穿透/SSH/后台任务作为 Workbench
// Surface 的身份、最小尺寸、reducer 唯一性、拖拽落点解析与共享 drop 事务。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const workbench = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
const dragMachine = loader.loadModule("@liveagent/ui/lib/workbench/dragMachine.ts");
const dockModel = loader.loadModule("@liveagent/ui/components/project-tools/rightDockModel.ts");
const settings = loader.loadModule("src/lib/settings/index.ts");
const { releaseProjectToolFromDock } = loader.loadModule(
  "@liveagent/ui/lib/projectTools/releaseProjectToolFromDock.ts",
);
const { feedManagedProcessState } = loader.loadModule(
  "@liveagent/ui/lib/managed-process/store.ts",
);

const {
  applyWorkbenchCommand,
  collectWorkbenchLayoutIssues,
  commitProjectToolDrop,
  computeWorkbenchGeometry,
  createEmptyWorkbenchLayout,
  findPaneIdBySurfaceKey,
  isProjectToolSurface,
  isWorkbenchLayoutValid,
  leasedProjectToolKinds,
  MIN_BACKGROUND_TASKS_PANE_WIDTH,
  MIN_GIT_REVIEW_PANE_WIDTH,
  MIN_SSH_TUNNEL_PANE_HEIGHT,
  MIN_TUNNEL_PANE_HEIGHT,
  openProjectToolInSplit,
  PROJECT_TOOL_SURFACE_KINDS,
  projectToolSurfaceIdentityKey,
  projectToolSurfaceRequiresProject,
  projectToolSurfaceTitleKey,
  surfaceIdentityKey,
  surfaceMinSize,
  surfaceProjectRef,
} = workbench;
const { resolveWorkbenchDropTarget } = dragMachine;
const { getRightDockVisibleTabs } = dockModel;

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/project-main" };
const OTHER_PROJECT = { projectId: "project-other", projectPathKey: "/workspace/project-other" };

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `tool-split-${++splitCounter}` };

function conversationPane(paneId, conversationId) {
  return { paneId, surface: { kind: "conversation", conversationId, project: PROJECT }, view: {} };
}

function toolPane(paneId, kind, project = PROJECT) {
  return { paneId, surface: { kind, project }, view: {} };
}

function apply(layout, command) {
  return applyWorkbenchCommand(
    layout,
    { expectedRevision: layout.revision, ...command },
    reducerOptions,
  );
}

function mustApply(layout, command) {
  const result = apply(layout, command);
  assert.ok(result.ok, result.ok ? "" : `${result.error.code}: ${result.error.message}`);
  return result.layout;
}

function rootLayout() {
  return mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: conversationPane("pane-root", "conversation-root"),
    target: { kind: "canvas-empty" },
  });
}

test("every project tool has a stable per-scope identity and label key", () => {
  assert.deepEqual(PROJECT_TOOL_SURFACE_KINDS, [
    "fileTree",
    "gitReview",
    "tunnel",
    "sshTunnel",
    "backgroundTasks",
  ]);
  for (const kind of PROJECT_TOOL_SURFACE_KINDS) {
    const surface = { kind, project: PROJECT };
    assert.ok(isProjectToolSurface(surface), kind);
    assert.equal(
      surfaceIdentityKey(surface),
      projectToolSurfaceIdentityKey(kind, PROJECT.projectPathKey),
    );
    assert.deepEqual(surfaceProjectRef(surface), PROJECT);
    assert.match(projectToolSurfaceTitleKey(kind), /^projectTools\./);
  }
  assert.equal(surfaceIdentityKey({ kind: "gitReview", project: PROJECT }), "gitReview:/workspace/project-main");
  // 后台任务镜像全局进程注册表:整窗口单例,身份不含项目。
  assert.equal(
    projectToolSurfaceIdentityKey("backgroundTasks", PROJECT.projectPathKey),
    projectToolSurfaceIdentityKey("backgroundTasks", OTHER_PROJECT.projectPathKey),
  );
  assert.notEqual(
    projectToolSurfaceIdentityKey("gitReview", PROJECT.projectPathKey),
    projectToolSurfaceIdentityKey("gitReview", OTHER_PROJECT.projectPathKey),
  );
  assert.equal(projectToolSurfaceRequiresProject("gitReview"), true);
  assert.equal(projectToolSurfaceRequiresProject("tunnel"), false);
  assert.equal(projectToolSurfaceRequiresProject("backgroundTasks"), false);
  assert.equal(isProjectToolSurface({ kind: "unsupported", originalKind: "x", raw: {} }), false);
});

test("project tool surfaces resolve their own hard minimum sizes", () => {
  assert.equal(surfaceMinSize({ kind: "gitReview", project: PROJECT }).minWidth, MIN_GIT_REVIEW_PANE_WIDTH);
  assert.equal(surfaceMinSize({ kind: "tunnel", project: PROJECT }).minHeight, MIN_TUNNEL_PANE_HEIGHT);
  assert.equal(surfaceMinSize({ kind: "sshTunnel", project: PROJECT }).minHeight, MIN_SSH_TUNNEL_PANE_HEIGHT);
  assert.equal(
    surfaceMinSize({ kind: "backgroundTasks", project: PROJECT }).minWidth,
    MIN_BACKGROUND_TASKS_PANE_WIDTH,
  );
});

test("reducer opens each tool once per scope and rejects duplicates", () => {
  let layout = rootLayout();
  for (const kind of PROJECT_TOOL_SURFACE_KINDS) {
    layout = mustApply(layout, {
      type: "OPEN_PANE",
      pane: toolPane(`pane-${kind}`, kind),
      target: { kind: "pane-edge", paneId: "pane-root", edge: "right" },
    });
    assert.equal(layout.focusedPaneId, `pane-${kind}`);
  }
  assert.deepEqual(collectWorkbenchLayoutIssues(layout), []);
  assert.ok(isWorkbenchLayoutValid(layout));

  const duplicate = apply(layout, {
    type: "OPEN_PANE",
    pane: toolPane("pane-dup", "gitReview"),
    target: { kind: "pane-edge", paneId: "pane-root", edge: "bottom" },
  });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, "duplicate-surface");

  // 另一个项目的审查是不同身份,可以并存;后台任务整窗口单例,第二个项目也被拒。
  const otherReview = apply(layout, {
    type: "OPEN_PANE",
    pane: toolPane("pane-other-review", "gitReview", OTHER_PROJECT),
    target: { kind: "pane-edge", paneId: "pane-root", edge: "bottom" },
  });
  assert.ok(otherReview.ok);
  const otherTasks = apply(layout, {
    type: "OPEN_PANE",
    pane: toolPane("pane-other-tasks", "backgroundTasks", OTHER_PROJECT),
    target: { kind: "pane-edge", paneId: "pane-root", edge: "bottom" },
  });
  assert.equal(otherTasks.ok, false);
  assert.equal(otherTasks.error.code, "duplicate-surface");

  const incomplete = apply(layout, {
    type: "OPEN_PANE",
    pane: { paneId: "pane-bad", surface: { kind: "tunnel", project: { projectId: "", projectPathKey: "" } }, view: {} },
    target: { kind: "pane-edge", paneId: "pane-root", edge: "bottom" },
  });
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.error.code, "invalid-layout");
});

test("invariants flag duplicate tool panes in a persisted layout", () => {
  const layout = {
    ...createEmptyWorkbenchLayout(),
    root: {
      type: "split",
      splitId: "s1",
      axis: "horizontal",
      ratio: 0.5,
      first: { type: "leaf", paneId: "a" },
      second: { type: "leaf", paneId: "b" },
    },
    panes: { a: toolPane("a", "sshTunnel"), b: toolPane("b", "sshTunnel") },
    focusedPaneId: "a",
  };
  const codes = collectWorkbenchLayoutIssues(layout).map((issue) => issue.code);
  assert.ok(codes.includes("duplicate-surface"), codes.join(","));
  assert.equal(isWorkbenchLayoutValid(layout), false);
});

test("commitProjectToolDrop focuses, moves, or opens by identity", () => {
  let layout = rootLayout();
  const calls = [];
  const deps = () => ({
    layout,
    openProjectToolSurface(surface, target) {
      calls.push(["open", surface.kind, target.kind]);
      const paneId = `pane-${surface.kind}`;
      layout = mustApply(layout, { type: "OPEN_PANE", pane: { paneId, surface, view: {} }, target });
      return { paneId };
    },
    movePane(paneId, target) {
      calls.push(["move", paneId, target.kind]);
      return true;
    },
    focusPane(paneId) {
      calls.push(["focus", paneId]);
    },
  });
  const payload = { kind: "projectTool", tool: "tunnel", project: PROJECT, title: "Tunnel" };

  assert.deepEqual(
    commitProjectToolDrop(payload, { kind: "pane-edge", paneId: "pane-root", edge: "right" }, deps()),
    { action: "opened", paneId: "pane-tunnel" },
  );
  assert.equal(findPaneIdBySurfaceKey(layout, "tunnel:/workspace/project-main"), "pane-tunnel");

  assert.deepEqual(
    commitProjectToolDrop(payload, { kind: "pane-center", paneId: "pane-tunnel" }, deps()),
    { action: "focused", paneId: "pane-tunnel" },
  );
  // 落在别的 Pane 中心不是移动语义(与文件树一致):忽略。
  assert.deepEqual(
    commitProjectToolDrop(payload, { kind: "pane-center", paneId: "pane-root" }, deps()),
    { action: "ignored" },
  );
  assert.deepEqual(
    commitProjectToolDrop(payload, { kind: "canvas-edge", edge: "bottom" }, deps()),
    { action: "moved", paneId: "pane-tunnel" },
  );
  assert.deepEqual(commitProjectToolDrop(payload, { kind: "canvas-empty" }, deps()), {
    action: "ignored",
  });
  assert.deepEqual(calls, [
    ["open", "tunnel", "pane-edge"],
    ["focus", "pane-tunnel"],
    ["move", "pane-tunnel", "canvas-edge"],
  ]);
});

test("openProjectToolInSplit focuses an existing pane or auto-docks a new one", () => {
  let layout = rootLayout();
  const events = [];
  const deps = (target) => ({
    layout,
    openProjectToolSurface(surface, openTarget) {
      const paneId = `pane-${surface.kind}`;
      layout = mustApply(layout, { type: "OPEN_PANE", pane: { paneId, surface, view: {} }, target: openTarget });
      return { paneId };
    },
    focusPane(paneId) {
      events.push(`focus:${paneId}`);
    },
    resolveAutoDockTarget: () => target,
    onNoSpace() {
      events.push("no-space");
    },
  });
  assert.deepEqual(openProjectToolInSplit("backgroundTasks", PROJECT, deps(null)), { action: "ignored" });
  assert.deepEqual(events, ["no-space"]);
  assert.deepEqual(
    openProjectToolInSplit("backgroundTasks", PROJECT, deps({ kind: "pane-edge", paneId: "pane-root", edge: "right" })),
    { action: "opened", paneId: "pane-backgroundTasks" },
  );
  assert.deepEqual(openProjectToolInSplit("backgroundTasks", OTHER_PROJECT, deps(null)), {
    action: "focused",
    paneId: "pane-backgroundTasks",
  });
  assert.deepEqual(events, ["no-space", "focus:pane-backgroundTasks"]);
});

test("drag resolution treats the tool's own pane as focus and honours its minimum", () => {
  let layout = rootLayout();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: toolPane("pane-review", "gitReview"),
    target: { kind: "pane-edge", paneId: "pane-root", edge: "right" },
  });
  // 1400px 画布分两半各 697px;再切半得 345px,满足审查 Pane 的 320px 最小宽。
  const geometry = computeWorkbenchGeometry(layout.root, { left: 0, top: 0, width: 1400, height: 600 }, { dividerSize: 6 });
  const payload = { kind: "projectTool", tool: "gitReview", project: PROJECT, title: "Git" };
  assert.deepEqual(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-review", edge: "left" }, payload, geometry, layout),
    { kind: "pane-center", paneId: "pane-review" },
  );
  // 另一个项目的审查是新的 Surface:沿着 root Pane 右侧切半仍满足最小宽,落点保留。
  const otherPayload = { ...payload, project: OTHER_PROJECT };
  assert.deepEqual(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-root", edge: "right" }, otherPayload, geometry, layout),
    { kind: "pane-edge", paneId: "pane-root", edge: "right" },
  );
  // 太窄的画布:两半都放不下审查的最小宽,落点被拒。
  const narrow = computeWorkbenchGeometry(layout.root, { left: 0, top: 0, width: 640, height: 600 }, { dividerSize: 6 });
  assert.equal(
    resolveWorkbenchDropTarget({ kind: "pane-edge", paneId: "pane-root", edge: "right" }, otherPayload, narrow, layout),
    null,
  );
});

test("leased tools disappear from the dock tab list", () => {
  let layout = rootLayout();
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: toolPane("pane-ssh", "sshTunnel"),
    target: { kind: "pane-edge", paneId: "pane-root", edge: "right" },
  });
  layout = mustApply(layout, {
    type: "OPEN_PANE",
    pane: toolPane("pane-tasks", "backgroundTasks", OTHER_PROJECT),
    target: { kind: "pane-edge", paneId: "pane-root", edge: "bottom" },
  });
  const leased = leasedProjectToolKinds(layout, PROJECT.projectPathKey, PROJECT_TOOL_SURFACE_KINDS);
  assert.deepEqual([...leased].sort(), ["backgroundTasks", "sshTunnel"]);
  // 后台任务是整窗口单例:任何项目的 dock 都视为已租用。
  assert.deepEqual(
    [...leasedProjectToolKinds(layout, OTHER_PROJECT.projectPathKey, PROJECT_TOOL_SURFACE_KINDS)],
    ["backgroundTasks"],
  );

  const projectState = {
    tabOrder: [],
    tools: { gitReview: { openedAt: 1 }, sshTunnel: { openedAt: 2 } },
    backgroundTasks: { opened: true, dismissedIds: [] },
    openVersion: 0,
    stateVersion: 0,
    writerId: "",
    lastUsedAt: 0,
  };
  const tabs = getRightDockVisibleTabs({
    backgroundTasksVisible: true,
    leasedTools: leased,
    localSessions: [],
    projectPathKey: PROJECT.projectPathKey,
    projectState,
    tunnelAvailable: true,
  });
  assert.deepEqual(tabs.map((tab) => tab.kind), ["gitReview"]);
  const unleased = getRightDockVisibleTabs({
    backgroundTasksVisible: true,
    localSessions: [],
    projectPathKey: PROJECT.projectPathKey,
    projectState,
    tunnelAvailable: true,
  });
  assert.deepEqual(unleased.map((tab) => tab.kind), ["gitReview", "sshTunnel", "backgroundTasks"]);
});

test("both hosts route project tools through the shared pane host and drop transaction", () => {
  const chatPage = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  const gatewayView = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
    "utf8",
  );
  const gatewayWorkbench = readFileSync(
    new URL("../../../agent-gateway/web/src/app/workbench/useGatewayWorkbench.ts", import.meta.url),
    "utf8",
  );
  for (const source of [chatPage, gatewayView]) {
    assert.match(source, /isProjectToolSurface\(surface\)/);
    assert.match(source, /<ProjectToolPaneHost/);
    assert.match(source, /leasedTools=\{leasedDockTools\}/);
    assert.equal(source.includes("FileTreePaneSurface"), false);
  }
  for (const source of [chatPage, gatewayWorkbench]) {
    assert.match(source, /payload\.kind === "projectTool"/);
    assert.match(source, /commitProjectToolDrop\(payload, target, \{/);
    assert.match(source, /openProjectToolInSplit\(tool, project, \{/);
  }
});

test("closing a tool pane closes the tool in the dock instead of handing the tab back", () => {
  const base = settings.normalizeSettings({});
  const key = "/workspace/app";
  const otherKey = "/workspace/other";
  let state = settings.openRightDockSingletonTab(base, key, "gitReview");
  state = settings.openRightDockSingletonTab(state, key, "sshTunnel");
  state = settings.updateRightDockProjectState(state, key, (current) =>
    settings.openRightDockBackgroundTasksTabState(current),
  );
  state = settings.updateRightDockProjectState(state, otherKey, (current) =>
    settings.openRightDockBackgroundTasksTabState(current),
  );
  const before = settings.getRightDockProjectState(state.customSettings, key);
  assert.deepEqual(Object.keys(before.tools).sort(), ["gitReview", "sshTunnel"]);
  assert.equal(before.backgroundTasks.opened, true);

  const afterReview = releaseProjectToolFromDock(state, "gitReview", key);
  const reviewState = settings.getRightDockProjectState(afterReview.customSettings, key);
  assert.deepEqual(Object.keys(reviewState.tools), ["sshTunnel"]);
  assert.equal(reviewState.tabOrder.includes(settings.RIGHT_DOCK_SINGLETON_TAB_IDS.gitReview), false);
  // The persisted active tab pointed at the closed tool: it is cleared so the
  // render-time fallback picks the next visible tab instead of a hidden one.
  assert.notEqual(reviewState.activeTabId, settings.RIGHT_DOCK_SINGLETON_TAB_IDS.gitReview);

  const afterTasks = releaseProjectToolFromDock(afterReview, "backgroundTasks", key);
  assert.equal(
    settings.getRightDockProjectState(afterTasks.customSettings, key).backgroundTasks.opened,
    false,
  );
  // Background tasks are window-global: closing their Pane clears every
  // persisted project projection, not only the project that created it.
  assert.equal(
    settings.getRightDockProjectState(afterTasks.customSettings, otherKey).backgroundTasks.opened,
    false,
  );
  // Tools that were never in the dock, and unknown projects, are no-ops.
  assert.equal(releaseProjectToolFromDock(afterTasks, "tunnel", key), afterTasks);
  assert.equal(releaseProjectToolFromDock(afterTasks, "gitReview", ""), afterTasks);
});

test("closing a derived background-tasks pane snapshots visible processes", () => {
  const key = "/workspace/app";
  const process = {
    id: "process-1",
    label: "Build",
    command: "pnpm build",
    cwd: key,
    shell: "/bin/zsh",
    pid: 42,
    logPath: "/tmp/process-1.log",
    startedAt: 1,
    finishedAt: null,
    exitCode: null,
    running: true,
    isolated: false,
    restored: false,
  };
  feedManagedProcessState({ ready: true, agentOnline: true, revision: 1, processes: [process] });
  const base = settings.normalizeSettings({});
  const after = releaseProjectToolFromDock(base, "backgroundTasks", key);
  const backgroundTasks = settings.getRightDockProjectState(
    after.customSettings,
    key,
  ).backgroundTasks;
  assert.equal(backgroundTasks.opened, false);
  assert.deepEqual(backgroundTasks.dismissedIds, [process.id]);
  feedManagedProcessState({ ready: true, agentOnline: true, revision: 2, processes: [] });
});

test("project-tool workbench entry points require a stable project context", () => {
  const chatPage = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  const gatewayView = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayAppView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chatPage, /sessionWorkbench\.enabled && terminalProjectPathKey/);
  assert.match(gatewayView, /sessionWorkbench\.enabled && terminalProjectPath\.trim\(\)/);
});

test("both hosts release the dock tool when its pane is closed", () => {
  const chatPage = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  const gatewayWorkbench = readFileSync(
    new URL("../../../agent-gateway/web/src/app/workbench/useGatewayWorkbench.ts", import.meta.url),
    "utf8",
  );
  const gatewayApp = readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayApp.tsx", import.meta.url),
    "utf8",
  );
  assert.match(chatPage, /releaseProjectToolFromDock\(prev, kind, project\.projectPathKey\)/);
  assert.match(gatewayWorkbench, /onProjectToolPaneClosed\?\.\(pane\.surface\.kind, pane\.surface\.project\.projectPathKey\)/);
  assert.match(gatewayApp, /releaseProjectToolFromDock\(prev, tool, projectPathKey\)/);
});
