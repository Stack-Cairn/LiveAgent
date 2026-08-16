import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { commitTerminalDrop, terminalSurfaceForSession } = loader.loadModule(
  "src/pages/chat/workbench/terminalDropCommit.ts",
);
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);
const { createTerminalPaneLeaseStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneLeaseStore.ts",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };
const EDGE_TARGET = { kind: "pane-edge", paneId: "pane-a", edge: "right" };

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

function makeDeps(overrides = {}) {
  let surfaceCounter = 0;
  const calls = { open: [], move: [], focus: [] };
  const deps = {
    layout: { panes: {} },
    sessions: [],
    lease: createTerminalPaneLeaseStore(),
    bindings: createTerminalPaneBindingStore({ storage: null }),
    resolveProjectPath: () => "/repo",
    createSurfaceId: () => {
      surfaceCounter += 1;
      return `surface-${surfaceCounter}`;
    },
    openTerminalSurface: (surface, target) => {
      calls.open.push({ surface, target });
      return { paneId: `pane-for-${surface.surfaceId}` };
    },
    movePane: (paneId, target) => {
      calls.move.push({ paneId, target });
      return true;
    },
    focusPane: (paneId) => {
      calls.focus.push(paneId);
    },
    ...overrides,
  };
  return { deps, calls };
}

test("dropping a dock session binds it and opens a pane at the target", () => {
  const { deps, calls } = makeDeps({ sessions: [session("session-1")] });
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    EDGE_TARGET,
    deps,
  );
  assert.deepEqual(result, {
    action: "opened",
    paneId: "pane-for-surface-1",
    surfaceId: "surface-1",
  });
  assert.equal(deps.bindings.get("surface-1"), "session-1");
  assert.equal(calls.open.length, 1);
  const surface = calls.open[0].surface;
  assert.equal(surface.kind, "localTerminal");
  assert.deepEqual(surface.launchSpec, { cwd: "/repo", shell: "zsh", title: "Build" });
  assert.equal(calls.open[0].target, EDGE_TARGET);
});

test("a session already leased by a pane is moved instead of duplicated", () => {
  const { deps, calls } = makeDeps({
    layout: { panes: { "pane-a": { paneId: "pane-a" } } },
    sessions: [session("session-1")],
  });
  deps.lease.acquire("session-1", "pane-a");
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "canvas-edge", edge: "left" },
    deps,
  );
  assert.deepEqual(result, { action: "moved", paneId: "pane-a" });
  assert.equal(calls.open.length, 0);
  assert.equal(calls.move.length, 1);
});

test("a leased session dropped on empty canvas only refocuses its pane", () => {
  const { deps, calls } = makeDeps({
    layout: { panes: { "pane-a": { paneId: "pane-a" } } },
    sessions: [session("session-1")],
  });
  deps.lease.acquire("session-1", "pane-a");
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "canvas-empty" },
    deps,
  );
  assert.deepEqual(result, { action: "focused", paneId: "pane-a" });
  assert.deepEqual(calls.focus, ["pane-a"]);
});

test("an unknown session id is ignored without side effects", () => {
  const { deps, calls } = makeDeps();
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "missing", project: PROJECT, title: "Gone" },
    EDGE_TARGET,
    deps,
  );
  assert.deepEqual(result, { action: "ignored" });
  assert.equal(calls.open.length, 0);
  assert.deepEqual(deps.bindings.surfaceIds(), []);
});

test("a failed open rolls the fresh binding back", () => {
  const { deps } = makeDeps({
    sessions: [session("session-1")],
    openTerminalSurface: () => null,
  });
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    EDGE_TARGET,
    deps,
  );
  assert.deepEqual(result, { action: "ignored" });
  assert.deepEqual(deps.bindings.surfaceIds(), []);
});

test("newTerminal opens an unbound local surface with the project cwd", () => {
  const { deps, calls } = makeDeps({ resolveProjectPath: () => "/workspace/app" });
  const result = commitTerminalDrop(
    { kind: "newTerminal", project: PROJECT, title: "Terminal" },
    EDGE_TARGET,
    deps,
  );
  assert.equal(result.action, "opened");
  const surface = calls.open[0].surface;
  assert.equal(surface.kind, "localTerminal");
  assert.deepEqual(surface.launchSpec, { cwd: "/workspace/app" });
  // PTY 由宿主挂载后创建:drop 阶段不得预建会话或写绑定。
  assert.deepEqual(deps.bindings.surfaceIds(), []);
});

test("newTerminal with an unresolvable project path is ignored", () => {
  const { deps, calls } = makeDeps({ resolveProjectPath: () => null });
  const result = commitTerminalDrop(
    { kind: "newTerminal", project: PROJECT, title: "Terminal" },
    EDGE_TARGET,
    deps,
  );
  assert.deepEqual(result, { action: "ignored" });
  assert.equal(calls.open.length, 0);
});

test("stale pane-center targets are ignored for terminal payloads", () => {
  const { deps, calls } = makeDeps({ sessions: [session("session-1")] });
  const result = commitTerminalDrop(
    { kind: "terminalSession", sessionId: "session-1", project: PROJECT, title: "Build" },
    { kind: "pane-center", paneId: "pane-a" },
    deps,
  );
  assert.deepEqual(result, { action: "ignored" });
  assert.equal(calls.open.length, 0);
});

test("terminalSurfaceForSession maps ssh sessions to sshTerminal launch specs", () => {
  const sshSession = session("ssh-1", {
    kind: "ssh",
    cwd: "/srv",
    ssh: {
      hostId: "host-1",
      hostName: "prod",
      username: "ops",
      host: "prod.example.com",
      port: 22,
      authType: "key",
      status: "connected",
      reconnectAttempt: 0,
      reconnectMaxAttempts: 3,
      sftpEnabled: true,
    },
  });
  const surface = terminalSurfaceForSession(sshSession, "surface-9", PROJECT);
  assert.equal(surface.kind, "sshTerminal");
  assert.deepEqual(surface.launchSpec, {
    cwd: "/srv",
    sshHostId: "host-1",
    title: "Build",
    sftpEnabled: true,
  });
});
