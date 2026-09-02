import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 不变量:「点击 Right Dock 内的控件不改变 focusedPaneId」
// (docs/design/session-workbench-pane-architecture.md §28、§30.2)。
// Dock 位于 Canvas 之外,只做会话列表/工具面板;它既不持有布局命令通路
// (源码层断言),reducer 也只在显式 FOCUS/OPEN 上改焦点(模型层断言)。
//
// 被 Pane 租用的终端与文件树都从 dock 整体隐藏(任一时刻只出现在一个宿主里),
// 因此 dock 不保留 Pane 焦点入口。SSH overlay 的 shell tab 是唯一例外:它是
// 连接管理入口,保留由页面注入的占位跳转回调。

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

const DOCK_SOURCES = {
  "RightDockPanel.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockPanel.tsx",
  ),
  "RightDockTabStrip.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockTabStrip.tsx",
  ),
  "RightDockContent.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockContent.tsx",
  ),
  "RightDockLauncher.tsx": readSource(
    "../../../agent-ui/src/components/project-tools/RightDockLauncher.tsx",
  ),
  "useRightDockSessions.ts": readSource(
    "../../../agent-ui/src/components/project-tools/useRightDockSessions.ts",
  ),
  "useRightDockProjectTabs.ts": readSource(
    "../../../agent-ui/src/components/project-tools/useRightDockProjectTabs.ts",
  ),
};

const chatPageSource = readSource("../../src/pages/ChatPage.tsx");

/**
 * 取出 ChatPage 中 `<RightDockPanel ... />` 的属性区文本。按 `{}` 深度扫描,
 * 对属性增删/换行重排稳健(不锚定行号)。
 */
function extractJsxProps(source, componentName) {
  const start = source.indexOf(`<${componentName}`);
  assert.notEqual(start, -1, `${componentName} JSX not found in ChatPage`);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (depth === 0 && char === "/" && source[index + 1] === ">") {
      return source.slice(start, index + 2);
    }
  }
  assert.fail(`${componentName} JSX block is unterminated`);
}

test("dock components hold no workbench layout commands", () => {
  for (const [name, source] of Object.entries(DOCK_SOURCES)) {
    // 直接调焦点命令 = 把 dock 点击接进焦点通路,正是本不变量要挡的写法。
    assert.equal(source.includes("focusPane("), false, `${name} calls focusPane(`);
    assert.equal(source.includes("FOCUS_PANE"), false, `${name} dispatches FOCUS_PANE`);
    // 更粗的护栏:dock 根本不该 import 布局层(reducer/commands/useWindowWorkbench)。
    assert.equal(source.includes("lib/workbench"), false, `${name} imports the workbench layout lib`);
    assert.equal(
      source.includes("applyWorkbenchCommand"),
      false,
      `${name} applies a workbench command`,
    );
    assert.equal(source.includes("useWindowWorkbench"), false, `${name} uses the workbench hook`);
  }
});

test("leased sessions are hidden from dock terminal tabs, leaving no focus affordance", () => {
  // 新语义:拖入画板的会话从 localSessions 整体过滤,dock 里不存在它的 tab、
  // 视口或跳转按钮;detach 释放租约后自动回归。
  assert.match(
    DOCK_SOURCES["useRightDockSessions.ts"],
    /!leasedSessionIds\?\.has\(session\.id\)/,
  );
  // dock 本地终端路径不再有任何 Pane 焦点回调。
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("onFocusWorkbenchPane"), false);
  assert.equal(DOCK_SOURCES["RightDockTabStrip.tsx"].includes("onFocusWorkbenchPane"), false);
  assert.equal(DOCK_SOURCES["RightDockPanel.tsx"].includes("onFocusWorkbenchPane"), false);
  // leased 标记态随隐藏语义一并退场。
  assert.equal(DOCK_SOURCES["RightDockTabStrip.tsx"].includes("isLeased"), false);
  assert.equal(
    DOCK_SOURCES["RightDockContent.tsx"].includes("terminalLeasedPlaceholder"),
    false,
  );
});

test("a leased project tool leaves the dock tab, content, and launcher", () => {
  // 文件树/审查/内网穿透/SSH/后台任务共用同一套租约:布局里有该工具的 Pane,
  // dock 就不再挂 tab、内容与新建入口。
  assert.match(
    DOCK_SOURCES["useRightDockProjectTabs.ts"],
    /getRightDockVisibleTabs\(\{[\s\S]*leasedTools/,
  );
  assert.match(DOCK_SOURCES["RightDockContent.tsx"], /leasedTools\.has\(definition\.kind\)\) return null/);
  assert.match(DOCK_SOURCES["RightDockContent.tsx"], /!leasedTools\.has\("backgroundTasks"\)/);
  assert.match(DOCK_SOURCES["RightDockLauncher.tsx"], /!leasedTools\.has\(definition\.kind\)/);
  assert.match(DOCK_SOURCES["RightDockLauncher.tsx"], /leasedTools\.has\("backgroundTasks"\)/);
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("openInWorkbenchHint"), false);
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("onFocusFileTreePane"), false);
  assert.equal(DOCK_SOURCES["RightDockContent.tsx"].includes("fileTreeLeased"), false);
});

test("dock tab selection routes through dock-local state, never through pane focus", () => {
  const sessions = DOCK_SOURCES["useRightDockSessions.ts"];
  // 选中一个终端标签只写 dock 自己的 activeTabId(项目状态),不碰布局。
  assert.match(sessions, /activeTabId: session\.id/);
  assert.equal(sessions.includes("onFocusWorkbenchPane"), false);
  assert.equal(sessions.includes("paneId"), false);
});

test("ChatPage passes only tool lease state into the dock", () => {
  const dockProps = extractJsxProps(chatPageSource, "RightDockPanel");
  // Dock 只需要知道哪些工具被 Pane 租用,不应获得任何 Pane 聚焦能力。
  assert.match(dockProps, /leasedTools=\{leasedDockTools\}/);
  assert.match(
    chatPageSource,
    /leasedProjectToolKinds\(workbench\.layout, terminalProjectPathKey, PROJECT_TOOL_SURFACE_KINDS\)/,
  );
  assert.equal(dockProps.includes("onFocusFileTreePane"), false);
  // (onGitReviewFocusRequest* 是 git 面板内部的滚动/选中请求,与 Pane 焦点
  // 无关,故按 "Pane" 过滤。)
  const paneFocusProps = [...dockProps.matchAll(/\bon[A-Za-z]*Focus[A-Za-z]*Pane[A-Za-z]*=/g)].map(
    (match) => match[0],
  );
  assert.deepEqual(paneFocusProps, []);
});

test("the explicit jump only focuses a pane that actually holds the session's lease", () => {
  // 白名单通路本身是收窄的:没有租约(会话仍在 dock)就什么都不做,
  // 不会凭 sessionId 猜一个 Pane 去抢焦点。
  const helper = chatPageSource.slice(chatPageSource.indexOf("const focusWorkbenchTerminalPane"));
  const body = helper.slice(0, helper.indexOf("\n  );") + 5);
  assert.match(body, /terminalPaneLease\.paneIdFor\(sessionId\)/);
  assert.match(body, /if \(paneId && workbench\.layoutRef\.current\.panes\[paneId\]\)/);
  assert.match(body, /handleWorkbenchFocusPane\(paneId\)/);
});

// ---------------------------------------------------------------------------
// 模型层:reducer 中只有显式 FOCUS/OPEN 改 focusedPaneId。
// ---------------------------------------------------------------------------

const loader = createTsModuleLoader();
const { applyWorkbenchCommand } = loader.loadModule("@liveagent/ui/lib/workbench/reducer.ts");
const { createEmptyWorkbenchLayout } = loader.loadModule("@liveagent/ui/lib/workbench/types.ts");

let splitCounter = 0;
const reducerOptions = { createSplitId: () => `split-${++splitCounter}` };

const PROJECT = { projectId: "project-main", projectPathKey: "/workspace/project-main" };

function conversationPane(paneId, conversationId) {
  return {
    paneId,
    surface: { kind: "conversation", conversationId, project: PROJECT },
    view: {},
  };
}

function terminalPane(paneId, surfaceId) {
  return {
    paneId,
    surface: {
      kind: "localTerminal",
      surfaceId,
      project: PROJECT,
      launchSpec: { cwd: "/workspace/project-main" },
    },
    view: {},
  };
}

function apply(layout, command) {
  return applyWorkbenchCommand(
    layout,
    { expectedRevision: layout.revision, ...command },
    reducerOptions,
  );
}

function mustApply(layout, command) {
  const result = apply(layout, command);
  assert.equal(result.ok, true, `command ${command.type} failed: ${JSON.stringify(result)}`);
  return result.layout;
}

/** 会话 Pane + 从 dock 拖入的终端 Pane;焦点停在会话 Pane 上。 */
function dockedLayout() {
  const withConversation = mustApply(createEmptyWorkbenchLayout(), {
    type: "OPEN_PANE",
    pane: conversationPane("pane-conv", "conv-a"),
    target: { kind: "canvas-empty" },
  });
  const withTerminal = mustApply(withConversation, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-term", "term-1"),
    target: { kind: "pane-edge", paneId: "pane-conv", edge: "right" },
  });
  return mustApply(withTerminal, { type: "FOCUS_PANE", paneId: "pane-conv" });
}

test("dragging a dock session in is an explicit open: focus follows the new pane", () => {
  // 例外(有意):显式打开就是显式跳转,与「点 dock 控件」不同。
  const layout = mustApply(
    mustApply(createEmptyWorkbenchLayout(), {
      type: "OPEN_PANE",
      pane: conversationPane("pane-conv", "conv-a"),
      target: { kind: "canvas-empty" },
    }),
    {
      type: "OPEN_PANE",
      pane: terminalPane("pane-term", "term-1"),
      target: { kind: "pane-edge", paneId: "pane-conv", edge: "right" },
    },
  );
  assert.equal(layout.focusedPaneId, "pane-term");
});

test("resizing the split that hosts a dock terminal never moves focus", () => {
  const layout = dockedLayout();
  const splitId = layout.root.splitId;
  const resized = mustApply(layout, { type: "RESIZE_SPLIT", splitId, ratio: 0.72 });
  assert.equal(resized.root.ratio, 0.72);
  assert.equal(resized.revision, layout.revision + 1);
  assert.equal(resized.focusedPaneId, "pane-conv");
});

test("equalizing a split never moves focus", () => {
  const base = dockedLayout();
  const splitId = base.root.splitId;
  const skewed = mustApply(base, { type: "RESIZE_SPLIT", splitId, ratio: 0.8 });
  const equalized = mustApply(skewed, { type: "EQUALIZE_SPLIT", splitId });
  assert.equal(equalized.root.ratio, 0.5);
  assert.equal(equalized.focusedPaneId, "pane-conv");
});

test("re-opening a session already living in a pane is rejected and leaves focus put", () => {
  // dock 里被 Pane 取走的会话再次拖入:reducer 拒绝重复 surface;
  // 「跳到已有 Pane」必须由调用方显式发 FOCUS_PANE,不是 OPEN 的副作用。
  const layout = dockedLayout();
  const result = apply(layout, {
    type: "OPEN_PANE",
    pane: terminalPane("pane-term-dup", "term-1"),
    target: { kind: "pane-edge", paneId: "pane-conv", edge: "bottom" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "duplicate-surface");
  assert.equal(result.error.currentRevision, layout.revision);
  assert.equal(layout.focusedPaneId, "pane-conv");
  assert.equal(Object.keys(layout.panes).length, 2);
});

test("a whole dock-shaped command run keeps focus until an explicit FOCUS_PANE", () => {
  let layout = dockedLayout();
  const splitId = layout.root.splitId;
  const steps = [
    { type: "RESIZE_SPLIT", splitId, ratio: 0.3 },
    { type: "RESIZE_SPLIT", splitId, ratio: 0.65 },
    { type: "EQUALIZE_SPLIT", splitId },
    { type: "SWAP_PANES", firstPaneId: "pane-conv", secondPaneId: "pane-term" },
  ];
  for (const step of steps) {
    layout = mustApply(layout, step);
    assert.equal(layout.focusedPaneId, "pane-conv", `${step.type} moved focus`);
  }
  // 失败命令同样不得改焦点。
  const failed = apply(layout, { type: "RESIZE_SPLIT", splitId: "split-missing", ratio: 0.5 });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "target-not-found");
  assert.equal(layout.focusedPaneId, "pane-conv");

  const focused = mustApply(layout, { type: "FOCUS_PANE", paneId: "pane-term" });
  assert.equal(focused.focusedPaneId, "pane-term");
});

test("re-focusing the already focused pane is a no-op with no revision churn", () => {
  // dock 占位上的「聚焦工作台面板」被连点时不产生布局版本/持久化抖动。
  const layout = dockedLayout();
  const result = apply(layout, { type: "FOCUS_PANE", paneId: "pane-conv" });
  assert.equal(result.ok, true);
  assert.equal(result.layout, layout);
  assert.equal(result.layout.revision, layout.revision);
});

test("the dock toggle badge counts only sessions still living in the dock", () => {
  // 顶栏折叠按钮的 sessionCount 与 dock 内 tab 数保持一致:拖入画板(租约)
  // 的会话不计入,detach 回归后恢复计入。
  const start = chatPageSource.indexOf("const projectTerminalSessions = useMemo(");
  assert.notEqual(start, -1);
  const memo = chatPageSource.slice(start, chatPageSource.indexOf("]);", start) + 3);
  assert.match(memo, /!leasedDockSessionIds\?\.has\(session\.id\)/);
  assert.match(chatPageSource, /sessionCount=\{projectTerminalSessions\.length\}/);
});
