// Web 端 Session Workbench 拖拽合同测试：
// 1) 模型层——Web 与桌面共用同一拖拽状态机/终端 drop 事务；这里验证 Web 的
//    窗口级单例(可恢复绑定表 + 内存租约)与共享事务的组合语义:既有会话拖入先写
//    绑定再开 Pane、重复拖入只移动/聚焦、关 Pane(Detach)后绑定可回收。
// 2) 源码断言——useGatewayWorkbench 按桌面同一口径接线:提交前 CAS 校验布局
//    修订号、workspace 拖拽经"草稿转正后在记住的落点开新 Pane"、终端 Pane
//    关闭回收绑定、`closed` 事件联动关 Pane;视图层装上 dropPreview、拖拽
//    幽灵、Pane 拖动把手与侧栏/Right Dock 拖拽入口。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();

const { resolveWorkbenchDropTarget } = loader.loadModule(
  "@liveagent/ui/lib/workbench/dragMachine.ts",
);
const { commitTerminalDrop } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalDropCommit.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalPaneBindingStore.ts",
);
const { createTerminalPaneLeaseStore } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalPaneLeaseStore.ts",
);
const webTerminalRuntime = loader.loadModule("src/app/workbench/terminalPaneRuntime.ts");

const webRoot = fileURLToPath(new URL("../../web", import.meta.url));
const hookSource = readFileSync(
  path.join(webRoot, "src/app/workbench/useGatewayWorkbench.ts"),
  "utf8",
);
const viewSource = readFileSync(path.join(webRoot, "src/app/GatewayAppView.tsx"), "utf8");

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function session(id, overrides = {}) {
  return {
    id,
    projectPathKey: "/repo",
    cwd: "/repo",
    shell: "zsh",
    title: "Build",
    kind: "local",
    cols: 80,
    rows: 24,
    createdAt: 1,
    updatedAt: 1,
    running: true,
    ...overrides,
  };
}

function singlePaneLayout(paneId = "pane-a") {
  return {
    schemaVersion: 1,
    revision: 1,
    focusedPaneId: paneId,
    root: { type: "leaf", paneId },
    panes: {
      [paneId]: {
        paneId,
        surface: { kind: "conversation", conversationId: "conv-1", project: PROJECT },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 模型层:Web 单例 + 共享 drop 事务
// ---------------------------------------------------------------------------

test("web terminal pane runtime exposes the same binding contract as desktop", () => {
  const { gatewayTerminalPaneBindings } = webTerminalRuntime;
  gatewayTerminalPaneBindings.set("surface-mem", "session-mem");
  assert.equal(gatewayTerminalPaneBindings.get("surface-mem"), "session-mem");
  gatewayTerminalPaneBindings.delete("surface-mem");
  assert.equal(gatewayTerminalPaneBindings.get("surface-mem"), null);
  // Node 环境无 window/sessionStorage 时共享 store 会安全降级为内存实现。
});

test("dropping an existing dock session binds first, then opens the pane", () => {
  const bindings = createTerminalPaneBindingStore({
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const lease = createTerminalPaneLeaseStore();
  const layout = singlePaneLayout();
  const opened = [];
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "pane-edge", paneId: "pane-a", edge: "right" },
    {
      layout,
      sessions: [session("session-1")],
      lease,
      bindings,
      resolveProjectPath: () => "/repo",
      createSurfaceId: () => "surface-1",
      authorizeAutoLaunch: () => {},
      openTerminalSurface: (surface, target) => {
        // 开 Pane 时绑定必须已就位,宿主挂载即可复用会话而不是新建 PTY。
        assert.equal(bindings.get(surface.surfaceId), "session-1");
        opened.push({ surface, target });
        return { paneId: "pane-b" };
      },
      movePane: () => {
        throw new Error("fresh drops never move panes");
      },
      focusPane: () => {},
    },
  );
  assert.deepEqual(result, { action: "opened", paneId: "pane-b", surfaceId: "surface-1" });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].surface.kind, "localTerminal");
  // 租约必须在 drop 事务里同步占住,这样 Right Dock 同一次渲染就会卸视口。
  assert.equal(lease.paneIdFor("session-1"), "pane-b");
});

test("a leased session dropped again only moves its existing pane", () => {
  const bindings = createTerminalPaneBindingStore({
    storage: { getItem: () => null, setItem() {}, removeItem() {} },
  });
  const lease = createTerminalPaneLeaseStore();
  lease.acquire("session-1", "pane-term");
  const layout = singlePaneLayout("pane-a");
  layout.panes["pane-term"] = {
    paneId: "pane-term",
    surface: {
      kind: "localTerminal",
      surfaceId: "surface-1",
      project: PROJECT,
      launchSpec: { cwd: "/repo" },
    },
  };
  const moves = [];
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "pane-edge", paneId: "pane-a", edge: "bottom" },
    {
      layout,
      sessions: [session("session-1")],
      lease,
      bindings,
      resolveProjectPath: () => "/repo",
      createSurfaceId: () => {
        throw new Error("moving a leased session never mints a new surface");
      },
      authorizeAutoLaunch: () => {},
      openTerminalSurface: () => {
        throw new Error("moving a leased session never opens a second pane");
      },
      movePane: (paneId, target) => {
        moves.push({ paneId, target });
        return true;
      },
      focusPane: () => {},
    },
  );
  assert.deepEqual(result, { action: "moved", paneId: "pane-term" });
  assert.equal(moves.length, 1);
});

test("sidebar payloads auto-dock instead of overwriting a pane center", () => {
  const layout = singlePaneLayout("pane-a");
  const geometry = {
    canvas: { left: 0, top: 0, width: 1200, height: 800 },
    panes: [{ paneId: "pane-a", rect: { left: 0, top: 0, width: 1200, height: 800 } }],
    dividers: [],
  };
  const resolved = resolveWorkbenchDropTarget(
    { kind: "pane-center", paneId: "pane-a" },
    { kind: "conversation", conversationId: "conv-2", project: PROJECT, title: "Other" },
    geometry,
    layout,
  );
  assert.deepEqual(resolved, { kind: "pane-edge", paneId: "pane-a", edge: "right" });
});

// ---------------------------------------------------------------------------
// 源码断言:useGatewayWorkbench 的接线口径
// ---------------------------------------------------------------------------

/** 从标记处截到该 hook/callback 的依赖数组收尾(`]);` 或多行 `],\n  );`),不锚定行号。 */
function blockFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const tail = source.slice(start);
  const end = tail.search(/\][,]?\s*\);/);
  assert.notEqual(end, -1, `unterminated block for marker: ${marker}`);
  return tail.slice(0, end + 3);
}

function assertOrder(block, steps, label) {
  let previous = -1;
  for (const step of steps) {
    const index = block.indexOf(step);
    assert.notEqual(index, -1, `${label}: missing step ${step}`);
    assert.ok(index > previous, `${label}: step out of order — ${step}`);
    previous = index;
  }
}

test("drop commits are CAS-checked against the layout revision", () => {
  const commit = blockFrom(hookSource, "const handleDropCommit = useCallback(");
  assert.match(
    commit,
    /if \(commit\.revision !== workbench\.layoutRef\.current\.revision\) return;/,
  );
});

test("workspace drops remember the target before starting the draft conversation", () => {
  const commit = blockFrom(hookSource, "const handleDropCommit = useCallback(");
  assertOrder(
    commit,
    [
      'if (payload.kind === "workspace") {',
      'if (target.kind === "pane-center") return;',
      "if (archivedProjectPathKeys.has(pathKey)) return;",
      "pendingWorkspaceOpenRef.current = {",
      "startConversationForProjectRef.current(project);",
    ],
    "workspace drop",
  );
});

test("the sync effect opens the pending workspace pane only after verifying the draft", () => {
  const sync = blockFrom(hookSource, "const pendingOpen = pendingWorkspaceOpenRef.current;");
  assertOrder(
    sync,
    [
      "pendingWorkspaceOpenRef.current = null;",
      "const hasNoPane = !workbench.paneIdForConversation(key);",
      "workspaceProjectPathKey(workdir) === pendingOpen.projectPathKey",
      "workbench.openConversation(",
      "workbench.syncCurrentConversation(key, sidebarProjectRef(key));",
    ],
    "pending workspace open",
  );
});

test("closing a terminal pane recycles its runtime binding (detach-first)", () => {
  const close = blockFrom(hookSource, "const handleClosePane = useCallback(");
  assertOrder(
    close,
    [
      "const result = workbench.closePane(paneId);",
      "gatewayTerminalPaneBindings.delete(pane.surface.surfaceId);",
    ],
    "terminal pane close",
  );
});

test("an explicit dock close cascades to the leased pane via the closed event", () => {
  const effect = blockFrom(hookSource, "return terminalClient.subscribe((event) => {");
  assertOrder(
    effect,
    [
      'if (event.kind !== "closed") return;',
      "findTerminalPaneForSession(closedSessionId, {",
      "if (paneId) handleClosePaneRef.current(paneId);",
    ],
    "closed-event cascade",
  );
});

// ---------------------------------------------------------------------------
// 源码断言:视图层装上拖拽入口
// ---------------------------------------------------------------------------

test("the canvas renders the drop preview and the drag ghost from dragState", () => {
  assert.match(viewSource, /dropPreview=\{\s*dragState\?\.previewRect/);
  assert.ok(viewSource.includes("data-workbench-drag-ghost"));
});

test("pane chrome, sidebar and right dock all expose drag entry points", () => {
  assert.ok(viewSource.includes("onDragHandlePointerDown={(event) => {"));
  assert.ok(viewSource.includes("workbenchController.beginPaneDrag(pane, title, {"));
  assert.ok(viewSource.includes("onConversationWorkbenchDragIntent={"));
  assert.ok(viewSource.includes("onProjectWorkbenchDragIntent={"));
  assert.ok(viewSource.includes("onTerminalTabDragStart={"));
  assert.ok(viewSource.includes("onNewTerminalDragStart={"));
  assert.ok(viewSource.includes("onOpenTerminalInWorkbench={"));
  assert.ok(viewSource.includes("onOpenNewTerminalInWorkbench={"));
  assert.ok(viewSource.includes("leasedSessionIds={workbenchLeasedDockSessionIds}"));
});

test("terminal panes render through the gateway terminal pane host", () => {
  assert.match(
    viewSource,
    /surface\.kind === "localTerminal" \|\| surface\.kind === "sshTerminal"/,
  );
  assert.ok(viewSource.includes("<GatewayTerminalPaneHost"));
});

// ---------------------------------------------------------------------------
// 源码断言:会话 Pane 与桌面端同一宿主模型
// ---------------------------------------------------------------------------

const hostSource = readFileSync(
  path.join(webRoot, "src/app/workbench/GatewayConversationPaneHost.tsx"),
  "utf8",
);

test("workbench never injects the page stage into the focused pane", () => {
  assert.equal(viewSource.includes("return stage"), false);
  assert.equal(viewSource.includes("key={surface.conversationId}"), false);
  assert.match(viewSource, /<GatewayConversationPaneHost/);
  assert.match(viewSource, /paneId=\{pane\.paneId\}/);
  assert.match(viewSource, /isPrimary=\{isPrimary\}/);
  assert.match(viewSource, /pageComposerRef=\{isPrimary \? composerRef : undefined\}/);
});

test("every conversation pane keeps a stable host; focus only swaps the primary binding", () => {
  assert.match(hostSource, /isPrimary: boolean/);
  assert.match(hostSource, /pageComposerRef\?/);
  assert.match(hostSource, /if \(isDraft \|\| isPrimary\) return;/);
  assert.match(hostSource, /onSend=\{usePrimary && primary \? primary\.onSend : handleSend\}/);
  assert.doesNotMatch(hostSource, /pageComposerRef\.current = null/);
  assert.match(
    hostSource,
    /if \(composerRef\.current\) pageComposerRef\.current = composerRef\.current/,
  );
  assert.match(hostSource, /if \(!hydrated && !isPrimary && rowCount === 0\)/);
});

test("pane chrome owns per-conversation trajectory toggle and hides top tabs when split", () => {
  assert.match(viewSource, /trajectoryToggle=/);
  assert.match(viewSource, /setConversationView\(/);
  assert.match(
    viewSource,
    /activeView === "chat" && hasConversationReply && !workbenchHasMultiplePanes/,
  );
});

test("file-drop hover focuses the pane under the cursor via workbench hit-testing", () => {
  assert.match(viewSource, /focusWorkbenchPaneUnderPoint/);
  assert.match(viewSource, /hitTestWorkbenchDrop\(/);
  assert.match(viewSource, /onDragEnter: handleChatFileDragEnter/);
});

test("archived and missing workspaces render a blocked banner without rebinding the pane", () => {
  assert.match(viewSource, /workbench\.projectArchived/);
  assert.match(viewSource, /workbench\.projectMissing/);
  assert.match(hostSource, /data-workbench-pane-blocked=/);
});
