import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// TerminalPaneHost 的纯逻辑层:恢复 Pane 自动重建、陈旧绑定清理、
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
} = loader.loadModule("src/pages/chat/workbench/terminalPaneRuntime.ts");
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

const hostSource = readFileSync(
  new URL("../../src/pages/chat/surfaces/TerminalPaneHost.tsx", import.meta.url),
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

/**
 * 宿主的休眠判定:`!boundSessionId && !launchRequested`。恢复时
 * launchRequested 固定为 true;这里只复算显式 kill 后的兜底状态。
 */
function isDormant(bindings, launchRequested, surfaceId) {
  const boundSessionId = bindings.get(surfaceId);
  return !boundSessionId && !launchRequested;
}

// ---------------------------------------------------------------------------
// 模型层:自动恢复、授权键与休眠判定
// ---------------------------------------------------------------------------

test("a restored surface without a binding mounts ready to auto-launch", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  assert.equal(isDormant(bindings, true, "surface-a"), false);
});

test("only explicit kill puts an unbound surface into the dormant fallback", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  assert.equal(isDormant(bindings, false, "surface-a"), true);
  bindings.set("surface-a", "session-1");
  assert.equal(isDormant(bindings, false, "surface-a"), false);
});

test("authorization keys are trimmed on both write and read", () => {
  const registry = createTerminalPaneAutoLaunchRegistry();
  registry.authorize("  surface-a  ");
  // 绑定表也按 trim 后的 key 存取,两侧对同一 surfaceId 的看法必须一致。
  assert.equal(registry.isAuthorized("surface-a"), true);
  assert.equal(registry.isAuthorized("  surface-a "), true);
});

test("a webview reload that keeps its binding mounts live, not dormant", () => {
  // sessionStorage 存活 + Rust 终端注册表存活:绑定命中,无需授权即可直接重挂。
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");
  assert.equal(isDormant(bindings, true, "surface-a"), false);
});

test("a restored unbound surface immediately ensures a replacement PTY", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = countingClient();
  const surface = localSurface("surface-a");
  const inflight = new Map();

  assert.equal(isDormant(bindings, true, surface.surfaceId), false);
  const created = await ensureTerminalPaneSession(surface, { client, bindings, inflight });
  assert.equal(client.created, 1);
  assert.equal(bindings.get("surface-a"), created.id);
});

test("kill revokes launchRequested until the page closes the pane", () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-a", "session-1");

  bindings.delete("surface-a");
  assert.equal(bindings.get("surface-a"), null);
  assert.equal(isDormant(bindings, false, "surface-a"), true);
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

test("host auto-launches restored panes and reserves dormancy for kill cleanup", () => {
  assert.match(hostSource, /const dormant = !boundSessionId && !launchRequested;/);
  assert.match(hostSource, /const \[launchRequested, setLaunchRequested\] = useState\(true\);/);
  // 绑定命中即视为授权:会话退出后的重启不再回落到休眠占位。
  const bindingEffect = blockFrom(hostSource, "if (!boundSessionId) return;");
  assertOrder(
    bindingEffect,
    ["terminalPaneAutoLaunch.authorize(surface.surfaceId)", "setLaunchRequested(true)"],
    "binding-hit authorization",
  );
});

test("the ensure effect early-returns while dormant and re-runs when dormancy changes", () => {
  const ensureEffect = blockFrom(hostSource, "if (!sessionsLoaded || session || errorState");
  assert.match(ensureEffect, /\|\| dormant\) return;/);
  // 早退在 ensure 调用之前。
  assertOrder(
    ensureEffect,
    ["dormant) return;", "ensureTerminalPaneSession(surface, {"],
    "dormant early return",
  );
  // dormant 是依赖项:授权后必须重跑,否则重启按钮点了没反应。
  assert.match(ensureEffect, /\}, \[[^\]]*\bdormant\b[^\]]*\]\);$/);
});

test("a bound-but-missing session drops the stale binding before auto-recreate", () => {
  const ensureEffect = blockFrom(hostSource, "if (!sessionsLoaded || session || errorState");
  assertOrder(
    ensureEffect,
    [
      "if (boundSessionId) {",
      "terminalPaneBindings.delete(surface.surfaceId)",
      "setCreatedSession(null)",
    ],
    "stale-binding branch",
  );
  assert.match(
    ensureEffect,
    /terminalPaneBindings\.delete\(surface\.surfaceId\);\s*setCreatedSession\(null\);\s*return;/,
  );
  // 先触发 binding store 更新,下一轮 effect 才进入 ensure,避免同轮双建。
  assert.ok(
    ensureEffect.indexOf("terminalPaneBindings.delete(surface.surfaceId)") <
      ensureEffect.indexOf("ensureTerminalPaneSession(surface, {"),
  );
});

test("restartFromLaunchSpec closes the stale session, drops the binding, then authorizes", () => {
  const restart = blockFrom(hostSource, "const restartFromLaunchSpec = useCallback(");
  assertOrder(
    restart,
    [
      "terminalPaneBindings.get(surface.surfaceId)",
      "tauriTerminalClient.close(staleSessionId)",
      "terminalPaneBindings.delete(surface.surfaceId)",
      "terminalPaneAutoLaunch.authorize(surface.surfaceId)",
      "setLaunchRequested(true)",
      "setErrorState(null)",
    ],
    "restartFromLaunchSpec",
  );
  // 重启自身不调 ensure:清干净状态后由 ensure effect 重跑接手。
  assert.equal(restart.includes("ensureTerminalPaneSession"), false);
});

test("the explicit-kill dormant fallback never renders a live viewport", () => {
  assert.match(hostSource, /if \(dormant\) \{[\s\S]{0,200}phase = "exited";/);
  // 只有持有租约的会话才会被交给视口渲染。
  assert.match(hostSource, /const leased = session !== null && leasedSessionId === session\.id;/);
  assert.match(hostSource, /\} else if \(leased && session\) \{[\s\S]{0,80}renderSession = session;/);
});

test("kill closes the process, reclaims the binding, and hands the pane back to the page", () => {
  const kill = blockFrom(hostSource, "const killSession = useCallback(");
  assertOrder(
    kill,
    [
      "tauriTerminalClient",
      ".close(targetSessionId)",
      "terminalPaneBindings.delete(surface.surfaceId)",
      "setLaunchRequested(false)",
      "onSessionKilled?.()",
    ],
    "killSession",
  );
});
