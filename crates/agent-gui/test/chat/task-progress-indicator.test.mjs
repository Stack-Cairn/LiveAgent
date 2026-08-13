import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const iconsPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url),
);
const utilsPath = fileURLToPath(new URL("../../src/lib/shared/utils.ts", import.meta.url));
const localeContextPath = fileURLToPath(
  new URL("../../../agent-ui/src/i18n/LocaleContext.tsx", import.meta.url),
);
const taskProgressIndicatorPath = fileURLToPath(
  new URL(
    "../../../agent-ui/src/components/chat/TaskProgressIndicator.tsx",
    import.meta.url,
  ),
);

const labels = {
  title: "Task progress",
  step: "Step 2 of 3",
  completedCount: "1/3 completed",
  running: "Running",
  pending: "Pending",
  paused: "Paused",
  completed: "All completed",
};

function createHookHarness() {
  const states = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  let idIndex = 0;
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
    useId() {
      return `task-progress-panel-${idIndex++}`;
    },
    useEffect() {},
  };
  return {
    react,
    refs,
    render(run) {
      stateIndex = 0;
      refIndex = 0;
      idIndex = 0;
      return run();
    },
  };
}

function createIndicatorHarness() {
  const hooks = createHookHarness();
  const loader = createTsModuleLoader({
    mocks: {
      react: hooks.react,
      [iconsPath]: {
        CheckCircle2: (props) => ({ type: "CheckCircle2", props }),
        Circle: (props) => ({ type: "Circle", props }),
        Loader2: (props) => ({ type: "Loader2", props }),
      },
      [utilsPath]: {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
    },
  });
  const { TaskProgressIndicator } = loader.loadModule(
    "@liveagent/ui/components/chat/TaskProgressIndicator.tsx",
  );
  return {
    hooks,
    render(props = {}) {
      return hooks.render(() =>
        TaskProgressIndicator({
          snapshot: createSnapshot(),
          isConversationRunning: true,
          labels,
          ...props,
        }),
      );
    },
  };
}

function createSnapshot(overrides = {}) {
  const tasks =
    overrides.tasks ??
    [
      {
        id: "1",
        subject: "Inspect",
        description: "Inspect completion criteria",
        status: "completed",
        activeForm: "Inspecting",
      },
      {
        id: "2",
        subject: "Implement",
        description: "Implement completion criteria",
        status: "in_progress",
        activeForm: "Implementing",
      },
      {
        id: "3",
        subject: "Verify",
        description: "Verify completion criteria",
        status: "pending",
        activeForm: "Verifying",
      },
    ];
  return {
    runId: "run-1",
    revision: 3,
    tasks,
    completedCount: 1,
    totalCount: tasks.length,
    currentStep: 2,
    state: "in_progress",
    ...overrides,
  };
}

function findAll(node, predicate, matches = []) {
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, matches);
    return matches;
  }
  if (!node || typeof node !== "object") return matches;
  if (predicate(node)) matches.push(node);
  findAll(node.props?.children, predicate, matches);
  return matches;
}

function treeText(node) {
  if (Array.isArray(node)) return node.map(treeText).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (!node || typeof node !== "object") return "";
  return treeText(node.props?.children);
}

function readIndicator(tree) {
  return {
    root: tree,
    button: findAll(tree, (node) => node.type === "button")[0],
    progress: findAll(tree, (node) => node.props?.role === "progressbar")[0],
    panel: findAll(tree, (node) => node.type === "section")[0],
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
    runTimers() {
      const callbacks = Array.from(timers.values());
      timers.clear();
      for (const callback of callbacks) callback();
    },
    restore() {
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
}

test("renders props-only copy, progress semantics, and an absolute reduced-motion panel", () => {
  const indicator = createIndicatorHarness();
  const { root, button, progress, panel } = readIndicator(indicator.render());

  assert.equal(root.type, "fieldset");
  assert.match(root.props.className, /\bmb-4\b/);
  assert.equal(button.props["aria-expanded"], false);
  assert.equal(button.props["aria-controls"], panel.props.id);
  assert.equal(button.props["aria-label"], "Task progress · Step 2 of 3 · 1/3 completed · Running");
  assert.deepEqual(
    [progress.props["aria-valuemin"], progress.props["aria-valuenow"], progress.props["aria-valuemax"]],
    [0, 1, 3],
  );
  assert.equal(panel.props["aria-hidden"], true);
  assert.match(panel.props.className, /\babsolute\b/);
  assert.match(panel.props.className, /motion-reduce:transition-none/);
  assert.match(button.props.className, /motion-reduce:transition-none/);
  const completedCount = findAll(button, (node) => treeText(node) === labels.completedCount).at(-1);
  assert.ok(completedCount);
  assert.doesNotMatch(completedCount.props.className, /\bhidden\b/);
  assert.match(completedCount.props.className, /\bshrink-0\b/);
  assert.match(treeText(root), /Task progress/);
  assert.match(treeText(root), /Implement/);
  assert.doesNotMatch(treeText(root), /Implementing/);
});

test("keeps task labels stable and scopes transition motion to the changed row status", () => {
  const indicator = createIndicatorHarness();
  const runningSnapshot = createSnapshot({
    tasks: [
      {
        id: "stable",
        subject: "Stable task",
        description: "Stable completion criteria",
        status: "in_progress",
        activeForm: "Changing label",
      },
    ],
    completedCount: 0,
    totalCount: 1,
    currentStep: 1,
    state: "in_progress",
  });
  const runningTree = indicator.render({ snapshot: runningSnapshot });
  const runningRow = findAll(runningTree, (node) => node.type === "li")[0];
  const statusVisual = findAll(
    runningRow,
    (node) => typeof node.props?.className === "string" && node.props.className.includes("animate-in"),
  )[0];

  assert.equal(treeText(runningRow), "Stable task");
  assert.equal(runningRow.props["data-task-status"], "in_progress");
  assert.equal(runningRow.props["aria-current"], "step");
  assert.match(runningRow.props.className, /transition-colors/);
  assert.match(statusVisual.props.className, /motion-reduce:animate-none/);

  const completedTree = indicator.render({
    snapshot: createSnapshot({
      tasks: [
        {
          id: "stable",
          subject: "Stable task",
          description: "Stable completion criteria",
          status: "completed",
          activeForm: "Changed again",
        },
      ],
      completedCount: 1,
      totalCount: 1,
      currentStep: 1,
      state: "completed",
    }),
  });
  const completedRow = findAll(completedTree, (node) => node.type === "li")[0];
  assert.equal(treeText(completedRow), "Stable task");
  assert.equal(completedRow.props["data-task-status"], "completed");
  assert.equal(completedRow.props["aria-current"], undefined);
});

test("hover and keyboard focus expand, then collapse only after the close delay", () => {
  const fakeWindow = installFakeWindow();
  const previousHTMLElement = globalThis.HTMLElement;
  globalThis.HTMLElement = class TestHTMLElement {
    constructor(focusVisible) {
      this.focusVisible = focusVisible;
    }
    matches(selector) {
      return selector === ":focus-visible" && this.focusVisible;
    }
  };
  try {
    const indicator = createIndicatorHarness();
    let view = readIndicator(indicator.render());
    view.root.props.onPointerEnter({ pointerType: "mouse" });
    view = readIndicator(indicator.render());
    assert.equal(view.button.props["aria-expanded"], true);

    view.root.props.onPointerLeave({ pointerType: "mouse" });
    assert.equal(readIndicator(indicator.render()).button.props["aria-expanded"], true);
    assert.equal(fakeWindow.delays.at(-1), 140);
    fakeWindow.runTimers();
    assert.equal(readIndicator(indicator.render()).button.props["aria-expanded"], false);

    view = readIndicator(indicator.render());
    view.root.props.onFocusCapture({ target: new globalThis.HTMLElement(true) });
    view = readIndicator(indicator.render());
    assert.equal(view.button.props["aria-expanded"], true);
    view.root.props.onBlurCapture({
      currentTarget: { contains: () => false },
      relatedTarget: null,
    });
    assert.equal(readIndicator(indicator.render()).button.props["aria-expanded"], true);
    assert.equal(fakeWindow.delays.at(-1), 140);
    fakeWindow.runTimers();
    assert.equal(readIndicator(indicator.render()).button.props["aria-expanded"], false);
  } finally {
    fakeWindow.restore();
    if (previousHTMLElement === undefined) delete globalThis.HTMLElement;
    else globalThis.HTMLElement = previousHTMLElement;
  }
});

test("Escape closes while touch clicks toggle", () => {
  const fakeWindow = installFakeWindow();
  try {
    const indicator = createIndicatorHarness();
    let view = readIndicator(indicator.render());
    view.button.props.onPointerDown({ pointerType: "touch" });
    view.button.props.onClick();
    view = readIndicator(indicator.render());
    assert.equal(view.button.props["aria-expanded"], true);

    view.root.props.onKeyDown({ key: "Escape" });
    view = readIndicator(indicator.render());
    assert.equal(view.button.props["aria-expanded"], false);

    view.button.props.onPointerDown({ pointerType: "touch" });
    view.button.props.onClick();
    assert.equal(readIndicator(indicator.render()).button.props["aria-expanded"], true);
    readIndicator(indicator.render()).button.props.onClick();
    assert.equal(readIndicator(indicator.render()).button.props["aria-expanded"], false);
  } finally {
    fakeWindow.restore();
  }
});

test("shows pending, paused, and completed states without auto-dismissing completion", () => {
  const indicator = createIndicatorHarness();
  const pending = createSnapshot({
    tasks: [
      {
        id: "wait",
        subject: "Wait",
        description: "Wait completion criteria",
        status: "pending",
        activeForm: "Waiting",
      },
    ],
    completedCount: 0,
    totalCount: 1,
    currentStep: 1,
    state: "pending",
  });
  assert.match(treeText(indicator.render({ snapshot: pending })), /Pending/);
  assert.match(
    treeText(indicator.render({ snapshot: pending, isConversationRunning: false })),
    /Paused/,
  );

  const completedTasks = [
    {
      id: "done",
      subject: "Done",
      description: "Done completion criteria",
      status: "completed",
      activeForm: "Finishing",
    },
  ];
  const completed = createSnapshot({
    tasks: completedTasks,
    completedCount: 1,
    totalCount: 1,
    currentStep: 1,
    state: "completed",
  });
  assert.match(treeText(indicator.render({ snapshot: completed })), /All completed/);
  assert.match(treeText(indicator.render({ snapshot: completed })), /All completed/);
});

test("shared task progress bar localizes labels and handles an empty snapshot", () => {
  const indicator = (props) => ({ type: "TaskProgressIndicator", props });
  const translations = {
    "chat.taskProgress.title": "Task progress",
    "chat.taskProgress.step": "Step {current} of {total}",
    "chat.taskProgress.completedCount": "completed",
    "chat.taskProgress.running": "Running",
    "chat.taskProgress.pending": "Pending",
    "chat.taskProgress.paused": "Paused",
    "chat.taskProgress.completed": "All completed",
  };
  const loader = createTsModuleLoader({
    mocks: {
      [localeContextPath]: {
        useLocale: () => ({ t: (key) => translations[key] ?? key }),
      },
      [taskProgressIndicatorPath]: { TaskProgressIndicator: indicator },
    },
  });
  const { TaskProgressBar } = loader.loadModule(
    "@liveagent/ui/components/chat/TaskProgressBar.tsx",
  );
  const snapshot = createSnapshot();
  const tree = TaskProgressBar({ snapshot, isConversationRunning: true });

  assert.equal(tree.type, indicator);
  assert.deepEqual(tree.props.labels, labels);
  assert.equal(TaskProgressBar({ snapshot: null, isConversationRunning: false }), null);
});
