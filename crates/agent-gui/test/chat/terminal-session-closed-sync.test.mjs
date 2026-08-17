import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 显式关闭(registry `closed` 事件)与工作台 Pane 的联动:
//   1) 模型层——findTerminalPaneForSession 按绑定定位受影响 Pane;
//   2) 源码断言——ChatPage 订阅 closed 事件并关 Pane;宿主对"见过又消失"
//      的会话停在 session-closed 态,绝不按 launchSpec 复活新 PTY。
// 背景:没有这条链路时,dock 关闭一个已拖入画板的终端会触发宿主的
// stale-binding 自动重建,表现为"终端关不掉"(杀旧进程 + 起新进程循环)。

const loader = createTsModuleLoader();
const { findTerminalPaneForSession, createTerminalAppExitGuard } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneRuntime.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

const chatPageSource = readFileSync(
  new URL("../../src/pages/ChatPage.tsx", import.meta.url),
  "utf8",
);
const hostSource = readFileSync(
  new URL("../../src/pages/chat/surfaces/TerminalPaneHost.tsx", import.meta.url),
  "utf8",
);
const projectTerminalsSource = readFileSync(
  new URL("../../src/pages/chat/workspace/useProjectTerminals.tsx", import.meta.url),
  "utf8",
);
const dockSessionsSource = readFileSync(
  new URL("../../../agent-ui/src/components/project-tools/useRightDockSessions.ts", import.meta.url),
  "utf8",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: PROJECT,
      launchSpec: { cwd: "/repo" },
    },
    view: {},
  };
}

function conversationPane(paneId) {
  return {
    paneId,
    surface: { kind: "conversation", conversationId: "conv-1", project: PROJECT },
    view: {},
  };
}

// ---------------------------------------------------------------------------
// 模型层:findTerminalPaneForSession
// ---------------------------------------------------------------------------

test("finds the pane whose binding points at the closed session", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  bindings.set("surface-b", "session-2");
  const layout = {
    panes: {
      "pane-a": terminalPane("pane-a", "surface-a"),
      "pane-b": terminalPane("pane-b", "surface-b"),
      "pane-c": conversationPane("pane-c"),
    },
  };
  assert.equal(findTerminalPaneForSession("session-2", { bindings, layout }), "pane-b");
  assert.equal(findTerminalPaneForSession("session-1", { bindings, layout }), "pane-a");
});

test("misses cleanly: unbound session, conversation panes, blank id", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  const layout = {
    panes: {
      "pane-a": terminalPane("pane-a", "surface-a"),
      "pane-c": conversationPane("pane-c"),
    },
  };
  assert.equal(findTerminalPaneForSession("session-9", { bindings, layout }), null);
  assert.equal(findTerminalPaneForSession("   ", { bindings, layout }), null);
  assert.equal(findTerminalPaneForSession("", { bindings, layout }), null);
});

test("connecting window: a binding without a lease still resolves the pane", () => {
  // drop 事务先写绑定后开 Pane;宿主取得租约前 dock 关闭也必须命中。
  // 该查找只依赖绑定,不依赖 lease store——这里用空 lease 语义直接验证。
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-fresh", "session-1");
  const layout = { panes: { "pane-fresh": terminalPane("pane-fresh", "surface-fresh") } };
  assert.equal(findTerminalPaneForSession("session-1", { bindings, layout }), "pane-fresh");
});

test("a deleted binding no longer resolves (restart raced with a late closed event)", () => {
  // restartFromLaunchSpec 同步删绑定后才可能收到迟到的 closed 事件;
  // 此时查找必须落空,不能把用户刚要重启的 Pane 误关。
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  const layout = { panes: { "pane-a": terminalPane("pane-a", "surface-a") } };
  bindings.delete("surface-a");
  assert.equal(findTerminalPaneForSession("session-1", { bindings, layout }), null);
});

// ---------------------------------------------------------------------------
// 源码断言:ChatPage 的 closed 事件联动
// ---------------------------------------------------------------------------

function blockFrom(source, marker, terminator = "]);") {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found: ${marker}`);
  const end = source.indexOf(terminator, start);
  assert.notEqual(end, -1, `unterminated block for marker: ${marker}`);
  return source.slice(start, end + terminator.length);
}

function assertOrderIn(block, steps, label) {
  let previous = -1;
  for (const step of steps) {
    const index = block.indexOf(step);
    assert.notEqual(index, -1, `${label}: missing step ${step}`);
    assert.ok(index > previous, `${label}: step out of order — ${step}`);
    previous = index;
  }
}

test("ChatPage subscribes to closed events and closes the bound pane", () => {
  const effect = blockFrom(chatPageSource, 'if (event.kind !== "closed") return;');
  assert.match(effect, /findTerminalPaneForSession\(closedSessionId, \{/);
  assert.match(effect, /bindings: terminalPaneBindings/);
  assert.match(effect, /layout: workbench\.layoutRef\.current/);
  assert.match(effect, /if \(paneId\) handleWorkbenchClosePane\(paneId\);/);
});

test("the closed-event sync is gated on the workbench flag", () => {
  const start = chatPageSource.indexOf('if (event.kind !== "closed") return;');
  assert.notEqual(start, -1);
  const gate = chatPageSource.lastIndexOf("if (!sessionWorkbench.enabled) return;", start);
  assert.notEqual(gate, -1, "closed-event effect must early-return when workbench is disabled");
  // 门禁与订阅之间不得隔着别的 effect(同一 useEffect 体内)。
  const between = chatPageSource.slice(gate, start);
  assert.equal(between.includes("useEffect"), false);
});

// ---------------------------------------------------------------------------
// 应用退出护栏:close_all 的 closed 风暴不得清空布局里的终端 Pane
// ---------------------------------------------------------------------------

test("the exit guard latches on mark and releases on reset", () => {
  const guard = createTerminalAppExitGuard();
  assert.equal(guard.isExiting(), false);
  guard.mark();
  assert.equal(guard.isExiting(), true);
  guard.mark();
  assert.equal(guard.isExiting(), true);
  guard.reset();
  assert.equal(guard.isExiting(), false);
});

test("ChatPage skips pane teardown while the app-exit guard is set", () => {
  const effect = blockFrom(chatPageSource, 'if (event.kind !== "closed") return;');
  assertOrderIn(
    effect,
    [
      'if (event.kind !== "closed") return;',
      "if (terminalAppExitGuard.isExiting()) return;",
      "findTerminalPaneForSession(closedSessionId, {",
    ],
    "exit-guard precedes pane lookup",
  );
});

test("the exit flow marks the guard before invoking and resets it on failure", () => {
  const markIndex = projectTerminalsSource.indexOf("terminalAppExitGuard.mark();");
  const invokeIndex = projectTerminalsSource.indexOf('await invoke("app_confirmed_exit")');
  assert.ok(markIndex !== -1 && invokeIndex !== -1);
  assert.ok(markIndex < invokeIndex, "guard must be set before app_confirmed_exit");
  const catchStart = projectTerminalsSource.indexOf("} catch (error) {", markIndex);
  const resetIndex = projectTerminalsSource.indexOf("terminalAppExitGuard.reset();");
  assert.ok(catchStart !== -1 && resetIndex > catchStart, "guard must reset when the exit fails");
});

// ---------------------------------------------------------------------------
// 源码断言:宿主对显式关闭停在 session-closed,不再自动重建
// ---------------------------------------------------------------------------

test("a session seen live that disappears parks in session-closed instead of recreating", () => {
  const ensureEffect = blockFrom(hostSource, "if (!sessionsLoaded || session || errorState");
  const guard = ensureEffect.indexOf("seenLiveSessionIdRef.current === boundSessionId");
  const parked = ensureEffect.indexOf('setErrorState({ kind: "session-closed" })');
  const staleDelete = ensureEffect.indexOf("terminalPaneBindings.delete(surface.surfaceId)");
  const ensureCall = ensureEffect.indexOf("ensureTerminalPaneSession(surface, {");
  assert.ok(guard !== -1, "missing seen-live guard");
  assert.ok(parked !== -1, "missing session-closed state");
  assert.ok(guard < parked, "guard must decide before parking");
  assert.ok(parked < staleDelete, "seen-live guard must run before the stale-binding cleanup");
  assert.ok(staleDelete < ensureCall, "stale cleanup still precedes auto-recreate");
  // 停在关闭态的分支必须 return,不得落进重建路径。
  assert.match(
    ensureEffect,
    /setErrorState\(\{ kind: "session-closed" \}\);\s*return;/,
  );
});

test("session-closed maps to the dedicated missing-session message", () => {
  assert.match(hostSource, /case "session-closed":\s*return t\("workbench\.terminalSessionMissing"\)/);
});

test("the seen-live marker only records sessions observed in the live list", () => {
  const marker = blockFrom(hostSource, "const seenLiveSessionIdRef");
  assert.match(marker, /if \(liveSession\) seenLiveSessionIdRef\.current = liveSession\.id;/);
});

// ---------------------------------------------------------------------------
// 幽灵会话自愈:前端残留、后端已丢的记录必须能退场且能关闭
// ---------------------------------------------------------------------------

test("dock close treats an already-gone session as closed instead of erroring forever", () => {
  // catch 内先按权威列表复核;确认消失走与成功关闭相同的收尾(移 tab、忘记
  // 会话),仅确认仍存活才落错误条。list 失败保守视为存活,不误删。
  const closeBlock = blockFrom(dockSessionsSource, "const closeSession = useCallback(");
  assertOrderIn(
    closeBlock,
    [
      "const finalizeClose = () => {",
      ".then(finalizeClose)",
      ".catch(async (err) => {",
      ".list()",
      ".catch(() => true)",
      "if (!alive) {",
      "finalizeClose();",
      "setError(err instanceof Error ? err.message : String(err));",
    ],
    "ghost-tolerant close",
  );
});

test("viewport errors escalate to an authoritative session-alive check", () => {
  const handler = blockFrom(hostSource, "const handleViewportError = useCallback(");
  assert.match(handler, /if \(message\) onSessionGhost\?\.\(errorSessionId\);/);
  // 页面侧:确认消失才整表刷新;仍存活(瞬时错误)不动列表。
  const verify = blockFrom(projectTerminalsSource, "const verifyTerminalSessionAlive");
  assertOrderIn(
    verify,
    [
      ".list()",
      "if (live.some((session) => session.id === key)) return;",
      "setTerminalSessions(sortTerminalSessions(live));",
    ],
    "verify-alive refresh",
  );
});

test("ChatPage wires the ghost check into every terminal pane host", () => {
  assert.match(chatPageSource, /onSessionGhost=\{verifyTerminalSessionAlive\}/);
});

test("dock viewport errors escalate to the same ghost check as pane hosts", () => {
  const dockSource = readFileSync(
    new URL(
      "../../../agent-ui/src/components/project-tools/RightDockPanel.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  // dock 侧错误分桶后同样上抛 onSessionGhost;ChatPage 接 verifyTerminalSessionAlive。
  assert.match(dockSource, /if \(message\) onSessionGhost\?\.\(sessionId\);/);
  assert.match(chatPageSource, /onSessionGhost=\{verifyTerminalSessionAlive\}/);
});
