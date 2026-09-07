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
const tooltipPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/ui/tooltip.tsx", import.meta.url),
);

const labels = {
  title: "Task progress",
  step: "Step 2 of 3",
  completedCount: "1/3 completed",
  running: "Running",
  pending: "Pending",
  paused: "Paused",
  completed: "All completed",
  taskPaused: "Paused",
  taskCompleted: "Completed",
};

function createHookHarness() {
  let idIndex = 0;
  const react = {
    useId() {
      return `task-progress-panel-${idIndex++}`;
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
  };
  return {
    react,
    render(run) {
      idIndex = 0;
      return run();
    },
  };
}

function createTooltipMock() {
  let handleIndex = 0;
  return {
    createTooltipHandle: () => ({
      kind: "tooltip-handle",
      id: handleIndex++,
      isOpen: false,
      closeCalls: 0,
      close() {
        this.closeCalls += 1;
      },
    }),
    Tooltip: (props) => ({ type: "Tooltip", props }),
    TooltipTrigger: (props) => ({ type: "TooltipTrigger", props }),
    TooltipContent: (props) => ({ type: "TooltipContent", props }),
  };
}

function createIndicatorHarness() {
  const hooks = createHookHarness();
  const tooltip = createTooltipMock();
  const loader = createTsModuleLoader({
    mocks: {
      react: hooks.react,
      [iconsPath]: {
        Check: (props) => ({ type: "Check", props }),
      },
      [utilsPath]: {
        cn(...values) {
          return values.filter(Boolean).join(" ");
        },
      },
      [tooltipPath]: tooltip,
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

function componentsNamed(node, name) {
  return findAll(node, (child) => typeof child.type === "function" && child.type.name === name);
}

function statusIcons(node) {
  return componentsNamed(node, "TaskStatusIcon");
}

function readIndicator(tree) {
  const allButtons = findAll(tree, (node) => node.type === "button");
  const trigger = allButtons.find((button) => button.props?.["data-task-progress-toggle"] === "");
  return {
    root: tree,
    trigger,
    otherButtons: allButtons.filter((button) => button !== trigger),
    panel: findAll(tree, (node) => node.props?.["data-task-progress-panel"] === "")[0],
    list: findAll(tree, (node) => node.type === "ul")[0],
    progress: findAll(tree, (node) => node.props?.role === "progressbar")[0],
    rows: findAll(tree, (node) => typeof node.props?.["data-task-status"] === "string"),
    subjectTriggers: componentsNamed(tree, "TooltipTrigger"),
    tooltip: componentsNamed(tree, "Tooltip")[0],
  };
}

test("renders a compact trigger whose task list never occupies layout space", () => {
  const { root, trigger, otherButtons, panel, progress, rows } = readIndicator(
    createIndicatorHarness().render(),
  );

  assert.equal(root.type, "div");
  assert.equal(root.props["data-task-progress-root"], "");
  // 药丸按内容收缩，不再撑成固定宽度的常驻卡片。
  assert.match(root.props.className, /\binline-flex\b/);
  assert.match(root.props.className, /group\/task-progress/);
  assert.doesNotMatch(root.props.className, /max-w-\[440px\]/);
  assert.doesNotMatch(root.props.className, /\bmb-4\b/);

  // 触发器只留状态图标与步进文案。
  assert.equal(treeText(trigger), "Step 2 of 3");
  assert.equal(trigger.props["aria-label"], "Task progress · Step 2 of 3 · 1/3 completed · Running");
  assert.equal(trigger.props["aria-describedby"], panel.props.id);
  assert.equal(trigger.props.onClick, undefined);
  assert.equal(otherButtons.length, 0);
  assert.equal(statusIcons(trigger)[0].props.state, "running");

  // 浮层绝对定位在触发器之上，默认透明且不吃指针，hover / 键盘聚焦才显形。
  assert.equal(panel.props.role, "tooltip");
  assert.match(panel.props.className, /\babsolute\b/);
  assert.match(panel.props.className, /\bbottom-full\b/);
  assert.match(panel.props.className, /\bpointer-events-none\b/);
  assert.match(panel.props.className, /\bopacity-0\b/);
  assert.match(panel.props.className, /group-hover\/task-progress:opacity-100/);
  assert.match(panel.props.className, /group-hover\/task-progress:pointer-events-auto/);
  assert.match(panel.props.className, /group-focus-within\/task-progress:opacity-100/);
  assert.match(panel.props.className, /motion-reduce:transition-none/);
  assert.equal(panel.props.hidden, undefined);

  assert.equal(progress.props["aria-label"], "Task progress · Step 2 of 3 · 1/3 completed · Running");
  assert.deepEqual(
    [progress.props["aria-valuemin"], progress.props["aria-valuenow"], progress.props["aria-valuemax"]],
    [0, 1, 3],
  );

  assert.equal(rows.length, 3);
  assert.match(treeText(panel), /Inspect/);
  assert.match(treeText(panel), /Implement/);
  assert.match(treeText(panel), /Verify/);
});

test("lists task subjects only, dropping descriptions and per-row disclosure", () => {
  const { panel, rows } = readIndicator(createIndicatorHarness().render());

  assert.deepEqual(
    rows.map((row) => row.type),
    ["li", "li", "li"],
  );
  assert.doesNotMatch(treeText(panel), /completion criteria/);
  assert.doesNotMatch(treeText(panel), /Inspecting|Implementing|Verifying/);
  for (const row of rows) {
    assert.equal(row.props["aria-expanded"], undefined);
    assert.equal(row.props["aria-controls"], undefined);
  }
});

test("clamps long subjects to two lines and reveals the full text through one shared tooltip", async () => {
  const { list, rows, subjectTriggers, tooltip } = readIndicator(
    createIndicatorHarness().render(),
  );

  // 列表容器本身永不出现横向滚动条：无空格长串在行内折行，其余溢出一律裁掉。
  assert.match(list.props.className, /\boverflow-x-hidden\b/);
  assert.match(list.props.className, /\boverflow-y-auto\b/);

  // 每一行都是同一个 tooltip 的分离式触发器，payload 携带完整标题。
  assert.equal(subjectTriggers.length, rows.length);
  const handle = tooltip.props.handle;
  assert.equal(handle.kind, "tooltip-handle");
  const subjects = ["Inspect", "Implement", "Verify"];
  for (const [index, subjectTrigger] of subjectTriggers.entries()) {
    assert.equal(subjectTrigger.props.handle, handle);
    assert.equal(subjectTrigger.props.payload, subjects[index]);
    assert.equal(subjectTrigger.props.children, subjects[index]);
    assert.equal(subjectTrigger.props.closeOnClick, false);
    assert.equal(subjectTrigger.props.render.type, "span");
    const textClass = subjectTrigger.props.render.props.className;
    assert.match(textClass, /\bline-clamp-2\b/);
    assert.match(textClass, /\bbreak-words\b/);
    assert.match(textClass, /\bmin-w-0\b/);
    assert.match(textClass, /\bflex-1\b/);
  }
  // 运行中的行加粗、已完成的行降为次要色，与之前的行样式一致。
  assert.match(subjectTriggers[0].props.render.props.className, /text-muted-foreground/);
  assert.match(subjectTriggers[1].props.render.props.className, /font-medium/);

  // 只有真被 line-clamp 截断的行才允许弹出；完整可见的行取消这次打开。
  assert.equal(tooltip.props.disableHoverablePopup, true);
  const attemptOpen = (open, trigger) => {
    let canceled = false;
    tooltip.props.onOpenChange(open, {
      trigger,
      cancel() {
        canceled = true;
      },
    });
    return canceled;
  };
  assert.equal(attemptOpen(true, { scrollHeight: 60, clientHeight: 40 }), false);
  assert.equal(attemptOpen(true, { scrollHeight: 40, clientHeight: 40 }), true);
  // 亚像素舍入带来的 1px 差值不算截断。
  assert.equal(attemptOpen(true, { scrollHeight: 41, clientHeight: 40 }), true);
  assert.equal(attemptOpen(true, undefined), true);
  // 关闭请求从不拦截，否则弹层会卡在打开态。
  assert.equal(attemptOpen(false, undefined), false);
  // 弹层本就没开时，否决不会多余地触发一次关闭。
  await Promise.resolve();
  assert.equal(handle.closeCalls, 0);

  // 弹层还挂在上一条被截断的行上、指针直接滑进相邻完整行：hover 逻辑把它当作
  // "换触发器"而不主动收起，这里否决新行的同时必须把旧弹层关掉，否则会卡住不动。
  handle.isOpen = true;
  assert.equal(attemptOpen(true, { scrollHeight: 20, clientHeight: 20 }), true);
  await Promise.resolve();
  assert.equal(handle.closeCalls, 1);
  // 换到另一条同样被截断的行则交给 tooltip 自己迁移锚点，不能误关。
  assert.equal(attemptOpen(true, { scrollHeight: 60, clientHeight: 40 }), false);
  await Promise.resolve();
  assert.equal(handle.closeCalls, 1);

  // 弹层内容就是当前触发行的完整标题，且不吃指针，避免盖住上一行时把外层 hover 面板打断。
  const content = tooltip.props.children({ payload: "Implement completion criteria" });
  assert.equal(content.type.name, "TooltipContent");
  assert.equal(content.props.children, "Implement completion criteria");
  assert.equal(content.props.side, "top");
  assert.match(content.props.className, /\bpointer-events-none\b/);
  assert.match(content.props.className, /\bbreak-words\b/);
});

test("keeps task labels stable and scopes the spinning ring to the running row", () => {
  const indicator = createIndicatorHarness();
  const runningRow = readIndicator(
    indicator.render({
      snapshot: createSnapshot({
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
      }),
    }),
  ).rows[0];

  assert.match(treeText(runningRow), /Stable task/);
  assert.doesNotMatch(treeText(runningRow), /Changing label/);
  assert.equal(runningRow.props["data-task-status"], "in_progress");
  assert.equal(runningRow.props["aria-current"], "step");
  assert.equal(statusIcons(runningRow)[0].props.state, "running");

  const completedRow = readIndicator(
    indicator.render({
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
    }),
  ).rows[0];

  assert.match(treeText(completedRow), /Stable task/);
  assert.doesNotMatch(treeText(completedRow), /Changed again/);
  assert.equal(completedRow.props["data-task-status"], "completed");
  assert.equal(completedRow.props["aria-current"], undefined);
  assert.equal(statusIcons(completedRow)[0].props.state, "completed");
});

test("reflects pending, paused, and completed states in the trigger and rows", () => {
  const indicator = createIndicatorHarness();

  const paused = readIndicator(indicator.render({ isConversationRunning: false }));
  assert.equal(statusIcons(paused.trigger)[0].props.state, "paused");
  assert.equal(statusIcons(paused.rows[0])[0].props.state, "completed");
  assert.equal(statusIcons(paused.rows[1])[0].props.state, "paused");
  assert.equal(statusIcons(paused.rows[2])[0].props.state, "pending");
  assert.match(paused.progress.props["aria-label"], /Paused/);
  assert.match(treeText(paused.panel), /Paused/);

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
  const pendingView = readIndicator(indicator.render({ snapshot: pending }));
  assert.equal(statusIcons(pendingView.trigger)[0].props.state, "pending");
  assert.equal(treeText(pendingView.trigger), "Step 2 of 3");
  assert.match(treeText(pendingView.panel), /Pending/);

  const completed = createSnapshot({
    tasks: createSnapshot().tasks.map((task) => ({ ...task, status: "completed" })),
    completedCount: 3,
    currentStep: 3,
    state: "completed",
  });
  const completedView = readIndicator(indicator.render({ snapshot: completed }));
  assert.equal(statusIcons(completedView.trigger)[0].props.state, "completed");
  // 计划跑完后药丸改用汇总文案，步进数字已无信息量。
  assert.equal(treeText(completedView.trigger), "All completed");
  assert.match(completedView.progress.props["aria-label"], /All completed/);
  assert.equal(completedView.rows.length, 3);
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
    "chat.taskProgress.taskPaused": "Paused",
    "chat.taskProgress.taskCompleted": "Completed",
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
