import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  createTerminalSurfaceId,
  ensureTerminalPaneSession,
  resolveLiveTerminalSurfaceIds,
  TerminalPaneSshPromptError,
} = loader.loadModule("src/pages/chat/workbench/terminalPaneRuntime.ts");
const { createTerminalPaneBindingStore } = loader.loadModule(
  "src/pages/chat/workbench/terminalPaneBindingStore.ts",
);

const PROJECT = { projectId: "project-1", projectPathKey: "/repo" };

function localSurface(surfaceId = "surface-1") {
  return {
    kind: "localTerminal",
    surfaceId,
    project: PROJECT,
    launchSpec: { cwd: "/repo", shell: "zsh", title: "Build" },
  };
}

function sshSurface(surfaceId = "surface-ssh") {
  return {
    kind: "sshTerminal",
    surfaceId,
    project: PROJECT,
    launchSpec: { cwd: "/srv", sshHostId: "host-1", sftpEnabled: true },
  };
}

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

test("createTerminalSurfaceId yields unique term- prefixed ids", () => {
  const first = createTerminalSurfaceId();
  const second = createTerminalSurfaceId();
  assert.match(first, /^term-/);
  assert.notEqual(first, second);
});

test("ensure creates a local session, binds it, and returns the record", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const calls = [];
  const client = {
    create: async (params) => {
      calls.push(params);
      return { session: session("session-1"), output: "", truncated: false };
    },
  };
  const created = await ensureTerminalPaneSession(localSurface(), {
    client,
    bindings,
    inflight: new Map(),
  });
  assert.equal(created.id, "session-1");
  assert.equal(bindings.get("surface-1"), "session-1");
  assert.deepEqual(calls, [{ cwd: "/repo", projectPathKey: "/repo", shell: "zsh", title: "Build" }]);
});

test("concurrent ensure calls for one surface share a single create", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  let createCount = 0;
  let releaseCreate;
  const gate = new Promise((resolve) => {
    releaseCreate = resolve;
  });
  const client = {
    create: async () => {
      createCount += 1;
      await gate;
      return { session: session("session-1"), output: "", truncated: false };
    },
  };
  const inflight = new Map();
  const first = ensureTerminalPaneSession(localSurface(), { client, bindings, inflight });
  const second = ensureTerminalPaneSession(localSurface(), { client, bindings, inflight });
  releaseCreate();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(createCount, 1);
  assert.equal(a.id, "session-1");
  assert.equal(b.id, "session-1");
  assert.equal(inflight.size, 0);
});

test("a failed ensure clears the in-flight slot so a retry can run", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  let attempt = 0;
  const client = {
    create: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("spawn failed");
      return { session: session("session-2"), output: "", truncated: false };
    },
  };
  const inflight = new Map();
  await assert.rejects(
    ensureTerminalPaneSession(localSurface(), { client, bindings, inflight }),
    /spawn failed/,
  );
  assert.equal(bindings.get("surface-1"), null);
  const created = await ensureTerminalPaneSession(localSurface(), { client, bindings, inflight });
  assert.equal(created.id, "session-2");
  assert.equal(bindings.get("surface-1"), "session-2");
});

test("ssh ensure binds the created session and forwards the launch spec", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const calls = [];
  const client = {
    createSsh: async (params) => {
      calls.push(params);
      return { snapshot: { session: session("ssh-1", { kind: "ssh" }), output: "", truncated: false } };
    },
  };
  const created = await ensureTerminalPaneSession(sshSurface(), {
    client,
    bindings,
    inflight: new Map(),
  });
  assert.equal(created.id, "ssh-1");
  assert.equal(bindings.get("surface-ssh"), "ssh-1");
  assert.deepEqual(calls, [
    { cwd: "/srv", projectPathKey: "/repo", hostId: "host-1", title: undefined, sftpEnabled: true },
  ]);
});

test("ssh ensure surfaces an interactive prompt as a typed error", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  const client = {
    createSsh: async () => ({ prompt: { id: "prompt-1" } }),
  };
  await assert.rejects(
    ensureTerminalPaneSession(sshSurface(), { client, bindings, inflight: new Map() }),
    (error) => error instanceof TerminalPaneSshPromptError,
  );
  assert.equal(bindings.get("surface-ssh"), null);
});

test("resolveLiveTerminalSurfaceIds reconciles bindings against the registry", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-live", "session-live");
  bindings.set("surface-dead", "session-dead");
  const live = await resolveLiveTerminalSurfaceIds({
    client: { list: async () => [session("session-live")] },
    bindings,
  });
  assert.deepEqual([...live].sort(), ["surface-live"]);
  assert.equal(bindings.get("surface-dead"), null);
});

test("resolveLiveTerminalSurfaceIds returns null when the registry is unreachable", async () => {
  const bindings = createTerminalPaneBindingStore({ storage: null });
  bindings.set("surface-live", "session-live");
  const live = await resolveLiveTerminalSurfaceIds({
    client: {
      list: async () => {
        throw new Error("ipc down");
      },
    },
    bindings,
  });
  assert.equal(live, null);
  assert.equal(bindings.get("surface-live"), "session-live");
});
