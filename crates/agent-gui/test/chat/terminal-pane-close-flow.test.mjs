// 终端 Pane 关闭 = 终止终端(不再 Detach 回 Right Dock):运行中的会话在 Pane 内
// 红条确认;已退出的会话直接 close;无会话的占位 Pane 直接关视图。Pane 本身由
// closed 事件联动收掉,会话不会在 dock 里闪现。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { resolveTerminalPaneCloseAction } = loader.loadModule(
  "@liveagent/ui/lib/workbench/terminalPaneClose.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

const PROJECT = { projectId: "p", projectPathKey: "/repo" };

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: { kind: "localTerminal", surfaceId, project: PROJECT, launchSpec: { cwd: "/repo" } },
    view: {},
  };
}

function session(id, running) {
  return { id, projectPathKey: "/repo", cwd: "/repo", kind: "local", running, title: "Build" };
}

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test("close action: confirm for running, terminate for exited, plain close otherwise", () => {
  const bindings = createTerminalPaneBindingStore();
  bindings.set("surface-a", "session-a");
  bindings.set("surface-b", "session-b");
  bindings.set("surface-ghost", "session-ghost");
  const sessions = [session("session-a", true), session("session-b", false)];

  assert.deepEqual(resolveTerminalPaneCloseAction(terminalPane("a", "surface-a"), sessions, bindings), {
    kind: "confirm",
    session: sessions[0],
  });
  assert.deepEqual(resolveTerminalPaneCloseAction(terminalPane("b", "surface-b"), sessions, bindings), {
    kind: "terminate",
    session: sessions[1],
  });
  // 绑定指向已消失的会话、从未绑定的休眠占位、非终端 Pane、未知 Pane:直接关视图。
  assert.deepEqual(
    resolveTerminalPaneCloseAction(terminalPane("g", "surface-ghost"), sessions, bindings),
    { kind: "close-pane" },
  );
  assert.deepEqual(
    resolveTerminalPaneCloseAction(terminalPane("d", "surface-dormant"), sessions, bindings),
    { kind: "close-pane" },
  );
  assert.deepEqual(
    resolveTerminalPaneCloseAction(
      { paneId: "c", surface: { kind: "conversation", conversationId: "c1", project: PROJECT }, view: {} },
      sessions,
      bindings,
    ),
    { kind: "close-pane" },
  );
  assert.deepEqual(resolveTerminalPaneCloseAction(undefined, sessions, bindings), {
    kind: "close-pane",
  });
});

test("the shared flow terminates instead of detaching and never re-creates a PTY", () => {
  const flow = readSource("../../../agent-ui/src/lib/workbench/terminalPaneClose.ts");
  assert.match(flow, /client\s*\.close\(session\.id, session\.projectPathKey\)/);
  // Pane 由 closed 事件收掉;事件丢失时只在会话确认离开列表后兜底关 Pane。
  assert.match(flow, /if \(paneStillOpen\(\) && sessionGone\(\)\) closePaneRef\.current\(paneId\);/);
  // 幽灵会话:close 失败但列表里已不存在 → 视为已关。
  assert.match(flow, /if \(!alive\) \{\s*if \(paneStillOpen\(\)\) closePaneRef\.current\(paneId\);/);
  assert.equal(flow.includes("create("), false);
});

test("the pane host shows the confirmation in place without remounting the viewport", () => {
  const host = readSource("../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx");
  assert.match(host, /data-terminal-pane-close-confirm=\{paneId\}/);
  assert.match(host, /projectTools\.closeRunningTerminal/);
  // 外层包裹始终存在:红条出现/消失不会改变 XTermViewport 的父节点。
  assert.match(
    host,
    /<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">\s*\{closeConfirmBar\}/,
  );
});

test("both hosts route the pane × and Meta+Alt+W through the terminal close flow", () => {
  const chatPage = readSource("../../src/pages/ChatPage.tsx");
  const gatewayView = readSource("../../../agent-gateway/web/src/app/GatewayAppView.tsx");
  const gatewayWorkbench = readSource(
    "../../../agent-gateway/web/src/app/workbench/useGatewayWorkbench.ts",
  );
  assert.match(chatPage, /useTerminalPaneCloseFlow\(\{/);
  assert.match(chatPage, /onClose=\{\(\) => requestWorkbenchClosePane\(pane\.paneId\)\}/);
  assert.match(chatPage, /event\.preventDefault\(\);\s*requestWorkbenchClosePane\(focusedPaneId\);/);
  assert.match(chatPage, /closeRequest=\{\s*terminalPaneClose\.pendingClose\?\.paneId === pane\.paneId/);
  assert.match(gatewayWorkbench, /useTerminalPaneCloseFlow\(\{/);
  assert.match(gatewayWorkbench, /event\.preventDefault\(\);\s*requestClosePane\(focusedPaneId\);/);
  assert.match(gatewayView, /onClose=\{\(\) => workbenchController\.requestClosePane\(pane\.paneId\)\}/);
  assert.match(gatewayView, /workbenchController\.terminalPaneCloseRequest\?\.paneId === pane\.paneId/);
  // closed 事件联动收 Pane 的通路保留,是终止后 Pane 消失的正式路径。
  assert.match(chatPage, /if \(paneId\) handleWorkbenchClosePane\(paneId\);/);
  assert.match(gatewayWorkbench, /if \(paneId\) handleClosePaneRef\.current\(paneId\);/);
});

test("a parked session-closed pane recovers by itself when the session is listed again", () => {
  const host = readSource("../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx");
  assert.match(
    host,
    /if \(liveSession && errorState\?\.kind === "session-closed"\) setErrorState\(null\);/,
  );
});
