import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createHookHarness() {
  const states = [];
  const refs = [];
  const effects = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectIndex = 0;
  let pendingEffects = [];

  const react = {
    useState(initialValue) {
      const index = stateIndex++;
      if (!(index in states)) {
        states[index] = typeof initialValue === "function" ? initialValue() : initialValue;
      }
      return [
        states[index],
        (next) => {
          states[index] = typeof next === "function" ? next(states[index]) : next;
        },
      ];
    },
    useRef(initialValue) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initialValue };
      return refs[index];
    },
    useEffect(effect, dependencies) {
      const index = effectIndex++;
      const previous = effects[index];
      const changed =
        !previous ||
        dependencies.length !== previous.dependencies.length ||
        dependencies.some((dependency, dependencyIndex) => !Object.is(dependency, previous.dependencies[dependencyIndex]));
      if (changed) pendingEffects.push({ index, effect, dependencies });
    },
  };

  return {
    react,
    render(run) {
      stateIndex = 0;
      refIndex = 0;
      effectIndex = 0;
      pendingEffects = [];
      const value = run();
      const scheduled = pendingEffects;
      pendingEffects = [];
      for (const entry of scheduled) {
        effects[entry.index]?.cleanup?.();
        effects[entry.index] = {
          dependencies: entry.dependencies,
          cleanup: entry.effect() ?? undefined,
        };
      }
      return value;
    },
    unmount() {
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

function installFakeWindow() {
  const previousWindow = globalThis.window;
  const timers = new Map();
  const delays = [];
  let nextId = 1;
  globalThis.window = {
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, callback);
      delays.push(delay);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
  };
  return {
    delays,
    get size() {
      return timers.size;
    },
    runNext() {
      const next = timers.entries().next().value;
      assert.ok(next, "expected a queued sequence timer");
      const [id, callback] = next;
      timers.delete(id);
      callback();
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

function snapshot(completedCount) {
  const todos = [
    { content: "One", activeForm: "Working one", status: completedCount >= 1 ? "completed" : "in_progress" },
    {
      content: "Two",
      activeForm: "Working two",
      status: completedCount >= 2 ? "completed" : completedCount === 1 ? "in_progress" : "pending",
    },
    { content: "Three", activeForm: "Working three", status: completedCount >= 2 ? "in_progress" : "pending" },
  ];
  return {
    todos,
    completedCount,
    totalCount: todos.length,
    currentStep: Math.min(completedCount + 1, todos.length),
    state: "in_progress",
  };
}

function snapshotFromTodos(todos) {
  const completedCount = todos.filter((todo) => todo.status === "completed").length;
  const inProgressIndex = todos.findIndex((todo) => todo.status === "in_progress");
  const pendingIndex = todos.findIndex((todo) => todo.status === "pending");
  return {
    todos,
    completedCount,
    totalCount: todos.length,
    currentStep:
      inProgressIndex >= 0 ? inProgressIndex + 1 : pendingIndex >= 0 ? pendingIndex + 1 : todos.length,
    state:
      completedCount === todos.length
        ? "completed"
        : inProgressIndex >= 0
          ? "in_progress"
          : "pending",
  };
}

const update = (key, completedCount) => ({ key, snapshot: snapshot(completedCount) });

test("GUI sequencer presents batched real updates one at a time and ignores persistence handoff", () => {
  const fakeWindow = installFakeWindow();
  const hooks = createHookHarness();
  const { TASK_PROGRESS_SEQUENCE_STEP_MS, useSequencedTaskProgress } = createTsModuleLoader({
    mocks: { react: hooks.react },
  }).loadModule("src/components/chat/useSequencedTaskProgress.ts");
  const initial = [update("todo-0", 0)];
  const batch = [...initial, update("todo-1", 1), update("todo-2", 2)];

  try {
    assert.equal(hooks.render(() => useSequencedTaskProgress(initial)).completedCount, 0);
    assert.equal(hooks.render(() => useSequencedTaskProgress(batch)).completedCount, 0);
    assert.equal(hooks.render(() => useSequencedTaskProgress(batch)).completedCount, 1);
    assert.deepEqual(fakeWindow.delays, [TASK_PROGRESS_SEQUENCE_STEP_MS]);

    fakeWindow.runNext();
    assert.equal(hooks.render(() => useSequencedTaskProgress(batch)).completedCount, 2);
    assert.equal(fakeWindow.size, 0);

    const duplicateSnapshot = [
      ...batch,
      { key: "anonymous-live-overlap", snapshot: snapshot(2) },
    ];
    assert.equal(hooks.render(() => useSequencedTaskProgress(duplicateSnapshot)).completedCount, 2);
    assert.equal(hooks.render(() => useSequencedTaskProgress(duplicateSnapshot)).completedCount, 2);
    assert.equal(fakeWindow.size, 0);

    assert.equal(hooks.render(() => useSequencedTaskProgress(initial)).completedCount, 2);
    assert.equal(hooks.render(() => useSequencedTaskProgress(batch)).completedCount, 2);
    assert.equal(fakeWindow.size, 0);
  } finally {
    hooks.unmount();
    fakeWindow.restore();
  }
});

test("GUI sequencer keeps the initial roster stable through shorter updates and history restore", () => {
  const fakeWindow = installFakeWindow();
  const hooks = createHookHarness();
  const { useSequencedTaskProgress } = createTsModuleLoader({
    mocks: { react: hooks.react },
  }).loadModule("src/components/chat/useSequencedTaskProgress.ts");
  const initialTodos = Array.from({ length: 12 }, (_, index) => ({
    content: `Task ${index + 1}`,
    activeForm: `Working ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending",
  }));
  const initial = [{ key: "plan", snapshot: snapshotFromTodos(initialTodos) }];
  const shortened = {
    key: "status-1",
    snapshot: snapshotFromTodos(
      initialTodos.slice(0, 5).map((todo) => ({ ...todo, status: "completed" })),
    ),
  };
  const batch = [...initial, shortened];

  try {
    assert.equal(hooks.render(() => useSequencedTaskProgress(initial)).totalCount, 12);
    assert.equal(hooks.render(() => useSequencedTaskProgress(batch)).completedCount, 0);
    const displayed = hooks.render(() => useSequencedTaskProgress(batch));
    assert.equal(displayed.totalCount, 12);
    assert.equal(displayed.completedCount, 5);
    assert.deepEqual(
      displayed.todos.map((todo) => todo.content),
      initialTodos.map((todo) => todo.content),
    );
    assert.equal(fakeWindow.size, 0);

    const restoredHooks = createHookHarness();
    const restoredHook = createTsModuleLoader({
      mocks: { react: restoredHooks.react },
    }).loadModule("src/components/chat/useSequencedTaskProgress.ts").useSequencedTaskProgress;
    const restored = restoredHooks.render(() => restoredHook(batch, false));
    assert.equal(restored.totalCount, 12);
    assert.equal(restored.completedCount, 5);
    assert.equal(fakeWindow.size, 0);
    restoredHooks.unmount();
  } finally {
    hooks.unmount();
    fakeWindow.restore();
  }
});

test("GUI sequencer skips restored history replay, applies same-call changes, and clears immediately", () => {
  const fakeWindow = installFakeWindow();
  const hooks = createHookHarness();
  const { useSequencedTaskProgress } = createTsModuleLoader({
    mocks: { react: hooks.react },
  }).loadModule("src/components/chat/useSequencedTaskProgress.ts");
  const restored = [update("todo-0", 0), update("todo-1", 1), update("todo-2", 2)];

  try {
    assert.equal(hooks.render(() => useSequencedTaskProgress(restored)).completedCount, 2);
    assert.equal(fakeWindow.size, 0);

    const hydrationHooks = createHookHarness();
    const hydrationHook = createTsModuleLoader({
      mocks: { react: hydrationHooks.react },
    }).loadModule("src/components/chat/useSequencedTaskProgress.ts").useSequencedTaskProgress;
    assert.equal(hydrationHooks.render(() => hydrationHook([], false)), null);
    assert.equal(hydrationHooks.render(() => hydrationHook(restored, false)), null);
    assert.equal(hydrationHooks.render(() => hydrationHook(restored, false)).completedCount, 2);
    assert.equal(fakeWindow.size, 0);
    hydrationHooks.unmount();

    const revised = [{ key: "todo-2", snapshot: snapshot(1) }];
    const replacementHooks = createHookHarness();
    const replacementHook = createTsModuleLoader({
      mocks: { react: replacementHooks.react },
    }).loadModule("src/components/chat/useSequencedTaskProgress.ts").useSequencedTaskProgress;
    assert.equal(replacementHooks.render(() => replacementHook(revised)).completedCount, 1);
    const sameCallUpdated = [{ key: "todo-2", snapshot: snapshot(2) }];
    assert.equal(replacementHooks.render(() => replacementHook(sameCallUpdated)).completedCount, 1);
    assert.equal(replacementHooks.render(() => replacementHook(sameCallUpdated)).completedCount, 2);
    replacementHooks.unmount();

    const cleared = [...restored, { key: "todo-clear", snapshot: null }];
    assert.equal(hooks.render(() => useSequencedTaskProgress(cleared)), null);
    assert.equal(hooks.render(() => useSequencedTaskProgress(cleared)), null);
    assert.equal(fakeWindow.size, 0);
  } finally {
    hooks.unmount();
    fakeWindow.restore();
  }
});

test("GUI sequencer clears on a new user-turn boundary and starts the next plan fresh", () => {
  const fakeWindow = installFakeWindow();
  const hooks = createHookHarness();
  const { useSequencedTaskProgress } = createTsModuleLoader({
    mocks: { react: hooks.react },
  }).loadModule("src/components/chat/useSequencedTaskProgress.ts");
  const oldPlan = [update("old-todo", 2)];
  const boundary = [{ key: "user-turn:next", snapshot: null }];
  const nextPlan = [...boundary, update("new-todo", 0)];

  try {
    assert.equal(hooks.render(() => useSequencedTaskProgress(oldPlan)).completedCount, 2);
    assert.equal(hooks.render(() => useSequencedTaskProgress(boundary)), null);
    assert.equal(hooks.render(() => useSequencedTaskProgress(boundary)), null);
    assert.equal(hooks.render(() => useSequencedTaskProgress(nextPlan)), null);
    assert.equal(hooks.render(() => useSequencedTaskProgress(nextPlan)).completedCount, 0);
    assert.equal(fakeWindow.size, 0);
  } finally {
    hooks.unmount();
    fakeWindow.restore();
  }
});

test("GUI sequencer keeps partial argument frames hidden until the TodoWrite result settles", () => {
  const fakeWindow = installFakeWindow();
  const hooks = createHookHarness();
  const { TASK_PROGRESS_ARGUMENT_STABLE_MS, useSequencedTaskProgress } = createTsModuleLoader({
    mocks: { react: hooks.react },
  }).loadModule("src/components/chat/useSequencedTaskProgress.ts");
  const boundary = [{ key: "user-turn:new", snapshot: null }];
  const draft = (todos) => [
    ...boundary,
    { key: "todo-live", snapshot: snapshotFromTodos(todos), settled: false },
  ];
  const invalidDraft = [
    ...boundary,
    { key: "todo-live", snapshot: undefined, settled: false },
  ];
  const fullTodos = Array.from({ length: 12 }, (_, index) => ({
    content: `Task ${index + 1}`,
    activeForm: `Working ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending",
  }));

  try {
    assert.equal(hooks.render(() => useSequencedTaskProgress(boundary)), null);

    assert.equal(hooks.render(() => useSequencedTaskProgress(draft(fullTodos.slice(0, 1)))), null);
    assert.equal(fakeWindow.size, 1);
    assert.equal(fakeWindow.delays.at(-1), TASK_PROGRESS_ARGUMENT_STABLE_MS);

    assert.equal(hooks.render(() => useSequencedTaskProgress(invalidDraft)), null);
    assert.equal(fakeWindow.size, 0);

    assert.equal(hooks.render(() => useSequencedTaskProgress(draft(fullTodos.slice(0, 4)))), null);
    assert.equal(fakeWindow.size, 1);
    assert.equal(hooks.render(() => useSequencedTaskProgress(invalidDraft)), null);
    assert.equal(fakeWindow.size, 0);

    const settled = [
      ...boundary,
      { key: "todo-live", snapshot: snapshotFromTodos(fullTodos), settled: true },
    ];
    assert.equal(hooks.render(() => useSequencedTaskProgress(settled)), null);
    const displayed = hooks.render(() => useSequencedTaskProgress(settled));
    assert.equal(displayed.totalCount, 12);
    assert.equal(fakeWindow.size, 0);
  } finally {
    hooks.unmount();
    fakeWindow.restore();
  }
});

test("GUI sequencer adopts a stable complete-arguments fallback when no result arrives", () => {
  const fakeWindow = installFakeWindow();
  const hooks = createHookHarness();
  const { useSequencedTaskProgress } = createTsModuleLoader({
    mocks: { react: hooks.react },
  }).loadModule("src/components/chat/useSequencedTaskProgress.ts");
  const boundary = [{ key: "user-turn:fallback", snapshot: null }];
  const todos = Array.from({ length: 12 }, (_, index) => ({
    content: `Fallback ${index + 1}`,
    activeForm: `Working fallback ${index + 1}`,
    status: index === 0 ? "in_progress" : "pending",
  }));
  const completeArguments = [
    ...boundary,
    { key: "todo-fallback", snapshot: snapshotFromTodos(todos), settled: false },
  ];

  try {
    assert.equal(hooks.render(() => useSequencedTaskProgress(boundary)), null);
    assert.equal(hooks.render(() => useSequencedTaskProgress(completeArguments)), null);
    assert.equal(fakeWindow.size, 1);
    fakeWindow.runNext();
    assert.equal(
      hooks.render(() => useSequencedTaskProgress(completeArguments)).totalCount,
      12,
    );
  } finally {
    hooks.unmount();
    fakeWindow.restore();
  }
});
