import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 终端 Pane 泛化后的 useWindowWorkbench 行为:openTerminalSurface 复用、
// closePane/syncCurrentConversation 对非会话 Pane 的收窄。

function createHookHarness() {
  const refs = [];
  const states = [];
  const effects = [];
  let refIndex = 0;
  let stateIndex = 0;
  let effectIndex = 0;

  const react = {
    useRef(initialValue) {
      const index = refIndex++;
      refs[index] ??= { current: initialValue };
      return refs[index];
    },
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      const setState = (next) => {
        states[index] = typeof next === "function" ? next(states[index]) : next;
      };
      return [states[index], setState];
    },
    useCallback(callback) {
      return callback;
    },
    useMemo(factory) {
      return factory();
    },
    useEffect(effect, deps = []) {
      const index = effectIndex++;
      const previous = effects[index];
      const changed =
        !previous ||
        deps.length !== previous.deps.length ||
        deps.some((value, depIndex) => value !== previous.deps[depIndex]);
      if (!changed) return;
      previous?.cleanup?.();
      effects[index] = { deps: [...deps], cleanup: effect() };
    },
  };

  return {
    react,
    render(run) {
      refIndex = 0;
      stateIndex = 0;
      effectIndex = 0;
      return run();
    },
    cleanup() {
      for (const effect of effects) {
        effect?.cleanup?.();
      }
    },
  };
}

function loadHook(harness) {
  const loader = createTsModuleLoader({ mocks: { react: harness.react } });
  const workbenchLib = loader.loadModule("@liveagent/ui/lib/workbench/index.ts");
  const { useWindowWorkbench } = loader.loadModule(
    "src/pages/chat/workbench/useWindowWorkbench.ts",
  );
  return { workbenchLib, useWindowWorkbench };
}

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/project-main" };

function terminalSurface(surfaceId) {
  return {
    kind: "localTerminal",
    surfaceId,
    project: PROJECT,
    launchSpec: { cwd: "/workspace/project-main" },
  };
}

function renderWorkbench(harness, hook, params) {
  return harness.render(() =>
    hook({
      initialConversationId: "conv-root",
      initialProject: PROJECT,
      ...params,
    }),
  );
}

test("openTerminalSurface opens a pane and focuses the existing one on reuse", () => {
  const harness = createHookHarness();
  const { useWindowWorkbench } = loadHook(harness);
  const workbench = renderWorkbench(harness, useWindowWorkbench, {});
  const rootPaneId = workbench.layoutRef.current.focusedPaneId;

  const opened = workbench.openTerminalSurface(terminalSurface("term-1"), {
    kind: "pane-edge",
    paneId: rootPaneId,
    edge: "right",
  });
  assert.ok(opened);
  assert.equal(workbench.layoutRef.current.panes[opened.paneId].surface.surfaceId, "term-1");
  assert.equal(workbench.layoutRef.current.focusedPaneId, opened.paneId);

  // Same surfaceId again: no second pane, the existing one is focused.
  workbench.focusPane(rootPaneId);
  const reused = workbench.openTerminalSurface(terminalSurface("term-1"), {
    kind: "pane-edge",
    paneId: rootPaneId,
    edge: "bottom",
  });
  assert.ok(reused);
  assert.equal(reused.paneId, opened.paneId);
  assert.equal(Object.keys(workbench.layoutRef.current.panes).length, 2);
  assert.equal(workbench.layoutRef.current.focusedPaneId, opened.paneId);
  harness.cleanup();
});

test("closePane returns a null next conversation when focus lands on a terminal pane", () => {
  const harness = createHookHarness();
  const { useWindowWorkbench } = loadHook(harness);
  const workbench = renderWorkbench(harness, useWindowWorkbench, {});
  const rootPaneId = workbench.layoutRef.current.focusedPaneId;
  const opened = workbench.openTerminalSurface(terminalSurface("term-1"), {
    kind: "pane-edge",
    paneId: rootPaneId,
    edge: "right",
  });
  assert.ok(opened);
  workbench.focusPane(rootPaneId);

  const result = workbench.closePane(rootPaneId);
  assert.equal(result.closedFocused, true);
  // The surviving pane is the terminal: the page keeps its conversation.
  assert.equal(result.nextConversationId, null);
  assert.equal(workbench.layoutRef.current.focusedPaneId, opened.paneId);
  harness.cleanup();
});

test("syncCurrentConversation is a no-op while a terminal pane is focused", () => {
  const harness = createHookHarness();
  const { useWindowWorkbench } = loadHook(harness);
  const workbench = renderWorkbench(harness, useWindowWorkbench, {});
  const rootPaneId = workbench.layoutRef.current.focusedPaneId;
  const opened = workbench.openTerminalSurface(terminalSurface("term-1"), {
    kind: "pane-edge",
    paneId: rootPaneId,
    edge: "right",
  });
  assert.ok(opened);
  assert.equal(workbench.layoutRef.current.focusedPaneId, opened.paneId);

  const before = workbench.layoutRef.current;
  workbench.syncCurrentConversation("conv-other", PROJECT);
  const after = workbench.layoutRef.current;
  // The conversation must never be written into the terminal pane.
  assert.equal(after, before);
  assert.equal(after.panes[opened.paneId].surface.kind, "localTerminal");
  harness.cleanup();
});

test("an explicit null persistence storage never falls back to localStorage", () => {
  const previousLocalStorage = globalThis.localStorage;
  let reads = 0;
  let writes = 0;
  globalThis.localStorage = {
    getItem() {
      reads += 1;
      return null;
    },
    setItem() {
      writes += 1;
    },
    removeItem() {},
  };
  try {
    const harness = createHookHarness();
    const { useWindowWorkbench } = loadHook(harness);
    renderWorkbench(harness, useWindowWorkbench, { persistence: { storage: null } });
    assert.equal(reads, 0);
    assert.equal(writes, 0);
    harness.cleanup();
  } finally {
    if (previousLocalStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousLocalStorage;
  }
});
