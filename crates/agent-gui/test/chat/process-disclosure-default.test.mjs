import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// #1154: "默认展开执行过程" — the transcript-wide default for process disclosures.
const EmptyIcon = () => null;
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/adapters/assistantBubble": { retainRunningToolContent: false },
    "@liveagent/ui/components/chat/AssistantStatus": {
      AssistantStatus: ({ children }) => children,
    },
    "@liveagent/ui/components/chat/LazyCollapse": {
      LazyCollapse: ({ children, open }) => (open ? children() : null),
    },
    "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem": {
      MemoToolCallItem: () => null,
      areToolTraceItemsEqual: () => false,
    },
    "@liveagent/ui/components/chat/assistant-bubble/assistantBubbleUtils": {
      getToolActivityCategory: () => "read",
      getToolTraceKey: (item, index) => item.toolCall.id ?? String(index),
    },
    "@liveagent/ui/components/IconSet": { Brain: EmptyIcon, ChevronDown: EmptyIcon },
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({
        locale: "zh-CN",
        t: (key) =>
          ({
            "chat.tool.batch.read": "读取了文件",
            "chat.tool.batch.command": "运行了命令",
            "chat.tool.running": "运行中",
            "chat.tool.waiting": "等待中",
            "chat.tool.failed": "失败",
            "chat.tool.success": "完成",
            "chat.thinking": "思考中",
            "chat.thinkingActive": "正在思考",
            "chat.work.activity": "已处理",
            "chat.work.running": "处理中",
            "chat.tool.activity.read.running": "正在读取",
            "chat.tool.activity.command.running": "正在运行",
            "chat.tool.activity.other.running": "正在执行",
            "chat.tool.file.read.running": "正在读取",
            "chat.tool.file.create.running": "正在创建",
            "chat.tool.file.edit.running": "正在编辑",
            "chat.tool.file.delete.running": "正在删除",
          })[key] ?? key,
      }),
    },
    "@liveagent/ui/components/Markdown": {
      Markdown: ({ content }) => content,
    },
    "@liveagent/ui/lib/chat/thinkingDurations": {
      resolveThinkingDurationMs: () => null,
    },
    "@liveagent/ui/lib/chat-scroll/useScrollFollow": {
      useScrollFollow: () => ({ handle: {}, following: true }),
    },
    "@liveagent/ui/lib/shared/utils": {
      cn: (...values) => values.filter(Boolean).join(" "),
    },
    "../../IconSet": {
      Bot: EmptyIcon,
      Brain: EmptyIcon,
      ChevronRight: EmptyIcon,
      Eye: EmptyIcon,
      Loader2: EmptyIcon,
      FilePenLine: EmptyIcon,
      FolderTree: EmptyIcon,
      Search: EmptyIcon,
      Terminal: EmptyIcon,
      Wrench: EmptyIcon,
    },
    "./assistantBubbleUtils": {
      compactInlineText: (value) => value,
      getFileOperationDisplay: (item) => {
        if (!["Read", "Write", "Edit", "Delete"].includes(item.toolCall.name)) return null;
        const path = item.toolCall.arguments?.path;
        if (typeof path !== "string" || !path) return null;
        const kind =
          item.toolCall.name === "Read"
            ? "read"
            : item.toolCall.name === "Write"
              ? "create"
              : item.toolCall.name.toLowerCase();
        return { kind, path, fileName: path.split("/").at(-1), link: null };
      },
      getToolActivityCategory: (name) => (name === "Bash" ? "command" : "read"),
      getToolDisplayName: (name) => name,
      getToolTraceKey: (item, index) => item.toolCall.id ?? String(index),
      hasActiveUserInteraction: (items, runningToolCallIds) =>
        items.some(
          (item) =>
            !item.toolResult &&
            ["AskUserQuestion", "ExitPlanMode"].includes(item.toolCall.name) &&
            runningToolCallIds.includes(item.toolCall.id),
        ),
    },
    "./ToolCallItem": {
      MemoToolCallItem: () => null,
      areToolTraceItemsEqual: () => false,
    },
  },
});
const { React, act, createRoot } = env;

const { ProcessDisclosureProvider } = env.loadModule(
  "@liveagent/ui/components/chat/processDisclosure.tsx",
);
const { AssistantWorkTrace } = env.loadModule(
  "@liveagent/ui/components/chat/AssistantWorkTrace.tsx",
);
const { ToolTraceGroup } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);
const { ThinkingDisclosure } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ThinkingDisclosure.tsx",
);

const toolItem = {
  toolCall: { id: "tool-1", name: "Bash", arguments: {} },
  toolResult: { isError: false },
};

function click(element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

// Renders a settled turn: work trace (with an answer) → thinking + tool group.
function renderTurn(root, { expandByDefault, running = false, active = false }) {
  act(() => {
    root.render(
      React.createElement(
        ProcessDisclosureProvider,
        { expandByDefault },
        React.createElement(AssistantWorkTrace, {
          hasDetails: true,
          running,
          collapseAfterAnswer: true,
          children: React.createElement(
            React.Fragment,
            null,
            React.createElement(ThinkingDisclosure, {
              text: "先读取文件，再检查测试。",
              trackKey: "turn-1:r1:thinking-1",
              active,
            }),
            React.createElement(ToolTraceGroup, {
              items: [toolItem],
              runningToolCallIds: [],
            }),
          ),
        }),
      ),
    );
  });
}

function disclosureStates(container) {
  return [...container.querySelectorAll("button[aria-expanded]")].map((button) =>
    button.getAttribute("aria-expanded"),
  );
}

test("process rows stay folded on a settled turn by default", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderTurn(root, { expandByDefault: false });
  // Only the folded work trace header is rendered; its details stay unmounted.
  assert.deepEqual(disclosureStates(container), ["false"]);

  act(() => root.unmount());
});

test("expand-by-default opens the work trace, thinking and tool groups on mount", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderTurn(root, { expandByDefault: true });
  assert.deepEqual(disclosureStates(container), ["true", "true", "true"]);
  assert.match(container.textContent, /先读取文件/);

  act(() => root.unmount());
});

test("expand-by-default keeps rows open after the turn and thinking settle", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderTurn(root, { expandByDefault: true, running: true, active: true });
  assert.deepEqual(disclosureStates(container), ["true", "true", "true"]);

  renderTurn(root, { expandByDefault: true, running: false, active: false });
  assert.deepEqual(disclosureStates(container), ["true", "true", "true"]);

  act(() => root.unmount());
});

test("flipping the preference updates rows that are already mounted", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderTurn(root, { expandByDefault: false });
  assert.deepEqual(disclosureStates(container), ["false"]);

  renderTurn(root, { expandByDefault: true });
  assert.deepEqual(disclosureStates(container), ["true", "true", "true"]);

  // Turning it back off folds every row again (the work-trace body may still be
  // mid exit animation, so inner rows can linger — collapsed).
  renderTurn(root, { expandByDefault: false });
  const states = disclosureStates(container);
  assert.ok(states.length >= 1);
  assert.ok(states.every((state) => state === "false"), `states: ${states}`);

  act(() => root.unmount());
});

test("a manual collapse still belongs to the user while the preference is on", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderTurn(root, { expandByDefault: true, running: true, active: true });
  const thinkingButton = container.querySelectorAll("button[aria-expanded]")[1];
  click(thinkingButton);
  assert.equal(thinkingButton.getAttribute("aria-expanded"), "false");

  renderTurn(root, { expandByDefault: true, running: false, active: false });
  assert.deepEqual(disclosureStates(container), ["true", "false", "true"]);

  act(() => root.unmount());
});
