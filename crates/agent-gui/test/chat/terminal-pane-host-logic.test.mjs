import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// TerminalPaneHost 的纯逻辑层:恢复 Pane 显式授权、陈旧绑定清理、
// ensure 的挂载竞态去重、restartFromLaunchSpec 的收尾顺序。
// 宿主本身需要 DOM 才能挂载,这里分两层覆盖:
//   1) 模型层——真实 runtime 模块(授权集 + 绑定表 + ensure)的组合语义;
//   2) 源码断言——宿主确实按这些语义接线(判定表达式/早退/调用顺序)。
// 已在 terminal-pane-runtime.test.mjs 覆盖的 ensure 基础路径(单次创建、
// 并发共享一次 create、失败后可重试、SSH 提示错误)不在此重复。

const loader = createTsModuleLoader();
const {
  createTerminalPaneAutoLaunchRegistry,
  ensureTerminalPaneSession,
  isTerminalPaneAutoLaunchAuthorized,
} = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneRuntime.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

// 宿主实现已共享给 WebUI:源码断言指向 @liveagent/ui 中的实现;
// 桌面文件只是注入 Tauri client 与窗口级单例的薄包装。
const hostSource = readFileSync(
  new URL(
    "../../../agent-ui/src/components/workbench/TerminalPaneHost.tsx",
    import.meta.url,
  ),
  "utf8",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function localSurface(surfaceId) {
  return {
    kind: "localTerminal",
    surfaceId,
    project: PROJECT,
    launchSpec: { cwd: "/repo", shell: "zsh", title: "Build" },
  };
}

function session(id) {
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
  };
}

function countingClient() {
  let created = 0;
  return {
    get created() {
      return created;
    },
    async create() {
      created += 1;
      return { session: session(`session-${created}`), output: "", truncated: false };
    },
  };
}

// ---------------------------------------------------------------------------
// 模型层:恢复授权
// ---------------------------------------------------------------------------

test("a restored surface without a binding stays unauthorized", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const autoLaunch = createTerminalPaneAutoLaunchRegistry();
  assert.equal(bindings.get("surface-a"), null);
  assert.equal(isTerminalPaneAutoLaunchAuthorized("surface-a", autoLaunch), false);
});

test("a webview reload that keeps its binding mounts live", () => {
  // sessionStorage 存活 + Rust 终端注册表存活:绑定命中,无需授权即可直接重挂。
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  assert.equal(bindings.get("surface-a"), "session-1");
});

test("an explicitly authorized surface can ensure a replacement PTY", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const autoLaunch = createTerminalPaneAutoLaunchRegistry();
  const client = countingClient();
  const surface = localSurface("surface-a");
  const inflight = new Map();

  autoLaunch.authorize(surface.surfaceId);
  assert.equal(isTerminalPaneAutoLaunchAuthorized(surface.surfaceId, autoLaunch), true);
  const created = await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(client.created, 1);
  assert.equal(bindings.get("surface-a"), created.id);
});

// ---------------------------------------------------------------------------
// 模型层:ensure 的去重边界
// ---------------------------------------------------------------------------

test("the module-level in-flight table dedupes the host's own double mount", async () => {
  // 宿主不注入 inflight,走模块级共享表;StrictMode 双挂载在这条路径上也只建一次。
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const surface = localSurface(`surface-shared-${Date.now().toString(36)}`);
  const [first, second] = await Promise.all([
    ensureTerminalPaneSession(surface, { client, bindings }),
    ensureTerminalPaneSession(surface, { client, bindings }),
  ]);
  assert.equal(client.created, 1);
  assert.equal(first.id, second.id);
  assert.equal(bindings.get(surface.surfaceId), first.id);
});

test("dedupe is keyed by surfaceId: sibling panes each get their own session", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const inflight = new Map();
  const [a, b] = await Promise.all([
    ensureTerminalPaneSession(localSurface("surface-a"), { client, bindings, inflight }),
    ensureTerminalPaneSession(localSurface("surface-b"), { client, bindings, inflight }),
  ]);
  assert.equal(client.created, 2);
  assert.notEqual(a.id, b.id);
  assert.equal(bindings.get("surface-a"), a.id);
  assert.equal(bindings.get("surface-b"), b.id);
});

test("in-flight dedupe only guards the mount race; the binding guards idempotence", async () => {
  // 结算后槽位释放,再次 ensure 会真的再建一个 PTY。宿主因此不能靠 ensure 幂等,
  // 而是先看绑定(有绑定就解析既有会话,不进 ensure 分支)。
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const inflight = new Map();
  const surface = localSurface("surface-a");
  await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(inflight.size, 0);
  await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(client.created, 2);
  assert.equal(bindings.get("surface-a"), "session-2");
});

// ---------------------------------------------------------------------------
// 源码断言:宿主按上述语义接线
// ---------------------------------------------------------------------------

/** 从标记处截到该 hook/callback 的依赖数组收尾 `]);`,不锚定行号。 */
function blockFrom(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `marker not found in TerminalPaneHost: ${marker}`);
  const end = source.indexOf("]);", start);
  assert.notEqual(end, -1, `unterminated block for marker: ${marker}`);
  return source.slice(start, end + 3);
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

test("host exposes a dormant state for restored unbound surfaces", () => {
  assert.equal(hostSource.includes("launchRequestedSurfaceId"), true);
  assert.equal(hostSource.includes('phase = "dormant"'), true);
  assert.equal(hostSource.includes("killSession"), false);
});

test("an unbound surface requires explicit auto-launch authorization", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  assert.match(ensureEffect, /if \(session \|\| errorState\) return;/);
  assertOrder(
    ensureEffect,
    [
      "if (boundSessionId && !pendingEnsure) {",
      "if (!sessionsLoaded) return;",
      "if (!launchAuthorized && !pendingEnsure) return;",
      "ensureTerminalPaneSession(surface, {",
    ],
    "binding-only session-list gate",
  );
});

test("a bound-but-missing restored session drops the stale binding before going dormant", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  assertOrder(
    ensureEffect,
    [
      "if (boundSessionId && !pendingEnsure) {",
      "bindings.delete(surface.surfaceId)",
      "setCreatedSession(null)",
    ],
    "stale-binding branch",
  );
  assert.match(
    ensureEffect,
    /bindings\.delete\(surface\.surfaceId\);\s*setCreatedSession\(null\);\s*return;/,
  );
  // 先触发 binding store 更新,下一轮 effect 才进入 ensure,避免同轮双建。
  assert.ok(
    ensureEffect.indexOf("bindings.delete(surface.surfaceId)") <
      ensureEffect.indexOf("ensureTerminalPaneSession(surface, {"),
  );
});

test("a fresh binding cannot be deleted while its create promise is settling", () => {
  const ensureEffect = blockFrom(hostSource, "if (session || errorState) return;");
  assertOrder(
    ensureEffect,
    [
      "const pendingEnsure = ensureSessionPromiseRef.current;",
      "if (boundSessionId && !pendingEnsure) {",
      "bindings.delete(surface.surfaceId)",
      "const ensurePromise =",
      "pendingEnsure ??",
      "ensureSessionPromiseRef.current = ensurePromise;",
      "void ensurePromise",
      "setCreatedSession(created)",
    ],
    "create binding/list race guard",
  );
});

test("restartFromLaunchSpec closes the stale session and drops the binding", () => {
  const restart = blockFrom(hostSource, "const restartFromLaunchSpec = useCallback(");
  assertOrder(
    restart,
    [
      "bindings.get(surface.surfaceId)",
      "client.close(staleSessionId)",
      "autoLaunch.authorize(surface.surfaceId)",
      "bindings.delete(surface.surfaceId)",
      "setErrorState(null)",
    ],
    "restartFromLaunchSpec",
  );
  // 重启自身不调 ensure:清干净状态后由 ensure effect 重跑接手。
  assert.equal(restart.includes("ensureTerminalPaneSession"), false);
});

test("only a leased session renders a live viewport", () => {
  // 只有持有租约的会话才会被交给视口渲染。
  assert.match(hostSource, /const leased = session !== null && leasedSessionId === session\.id;/);
  assert.match(hostSource, /if \(errorState\) \{[\s\S]{0,240}else if \(leased && session\) \{[\s\S]{0,80}renderSession = session;/);
});
