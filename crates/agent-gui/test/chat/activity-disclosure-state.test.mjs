import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

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
    "@liveagent/ui/lib/shared/utils": {
      cn: (...values) => values.filter(Boolean).join(" "),
    },
    "../../IconSet": {
      Bot: EmptyIcon,
      ChevronRight: EmptyIcon,
      Eye: EmptyIcon,
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

const { AssistantWorkTrace } = env.loadModule(
  "@liveagent/ui/components/chat/AssistantWorkTrace.tsx",
);
const { ToolTraceGroup } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);

function click(element) {
  act(() => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

function renderWorkTrace(root, running, attentionRequired = false) {
  act(() => {
    root.render(
      React.createElement(AssistantWorkTrace, {
        hasDetails: true,
        attentionRequired,
        running,
        children: React.createElement("div", { "data-testid": "work-details" }),
      }),
    );
  });
}

const toolItem = {
  toolCall: { id: "tool-1", name: "read_file", arguments: {} },
  toolResult: { isError: false },
};

function renderToolTrace(root, running, items = [toolItem], showTurnStatus = false) {
  act(() => {
    root.render(
      React.createElement(ToolTraceGroup, {
        items,
        runningToolCallIds: running ? items.map((item) => item.toolCall.id) : [],
        showTurnStatus,
      }),
    );
  });
}

test("manual work-trace disclosure survives running state transitions", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderWorkTrace(root, true);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "true");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  renderWorkTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderWorkTrace(root, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  renderWorkTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  act(() => root.unmount());
});

test("an empty running work trace shows the plain processing header, not a button", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  act(() => {
    root.render(
      React.createElement(AssistantWorkTrace, {
        hasDetails: false,
        running: true,
        children: null,
      }),
    );
  });

  assert.match(container.textContent, /处理中/);
  assert.ok(container.querySelector("[data-chat-work-grid]"));
  assert.equal(container.querySelector("button"), null);
  assert.equal(container.querySelector("[data-chat-work-collapsed-tail]"), null);

  act(() => root.unmount());
});

test("a work trace parked on a user decision renders a frozen header", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  const render = (awaitingDecision) => {
    act(() => {
      root.render(
        React.createElement(AssistantWorkTrace, {
          hasDetails: false,
          running: true,
          awaitingDecision,
          children: null,
        }),
      );
    });
  };

  render(false);
  assert.equal(container.querySelector("section").getAttribute("aria-busy"), "true");
  assert.equal(container.querySelector(".chat-work-pixel[data-paused]"), null);
  assert.match(container.innerHTML, /shimmer/);

  render(true);
  assert.equal(container.querySelector("section").getAttribute("aria-busy"), "false");
  assert.equal(
    container.querySelectorAll(".chat-work-pixel[data-paused]").length,
    container.querySelectorAll(".chat-work-pixel").length,
  );
  assert.doesNotMatch(container.innerHTML, /shimmer/);

  act(() => root.unmount());
});

test("collapsing a running work trace surfaces the active block outside it", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const tail = React.createElement("div", { "data-testid": "active-tail" }, "正在读取 App.tsx");

  const render = (running) => {
    act(() => {
      root.render(
        React.createElement(AssistantWorkTrace, {
          hasDetails: true,
          running,
          collapsedTail: tail,
          children: React.createElement("div", null, "details"),
        }),
      );
    });
  };

  // Expanded by default while running: the trace body is visible, no tail.
  render(true);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(container.querySelector("[data-chat-work-collapsed-tail]"), null);

  // User collapses mid-run: the in-progress block re-homes below the header.
  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.ok(container.querySelector("[data-chat-work-collapsed-tail]"));
  assert.match(container.textContent, /正在读取 App\.tsx/);

  // Re-expanding removes the duplicate; the body carries the content again.
  click(button);
  assert.equal(container.querySelector("[data-chat-work-collapsed-tail]"), null);

  // Once the run settles, a collapsed trace shows no tail either.
  click(button);
  render(false);
  assert.equal(container.querySelector("[data-chat-work-collapsed-tail]"), null);

  act(() => root.unmount());
});

test("a new blocking interaction opens the work trace once without stealing later control", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderWorkTrace(root, false, false);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "false");

  renderWorkTrace(root, true, true);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderWorkTrace(root, true, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  renderWorkTrace(root, true, false);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderWorkTrace(root, true, true);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  renderWorkTrace(root, true, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  act(() => root.unmount());
});

test("manual tool-batch disclosure survives tool completion and restart", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderToolTrace(root, true);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "false");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  renderToolTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  renderToolTrace(root, true);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderToolTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  act(() => root.unmount());
});

test("a tool batch opens when a pending user interaction appears inside it", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const interactionItem = {
    toolCall: { id: "interaction-1", name: "ExitPlanMode", arguments: { plan: "Plan" } },
  };

  renderToolTrace(root, false, [interactionItem]);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "false");

  renderToolTrace(root, true, [interactionItem]);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderToolTrace(root, true, [interactionItem]);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  act(() => root.unmount());
});

test("mixed tool batch labels are separated by a fullwidth bar", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const commandItem = {
    toolCall: { id: "tool-2", name: "Bash", arguments: { command: "pnpm test" } },
    toolResult: { isError: false },
  };

  act(() => {
    root.render(
      React.createElement(ToolTraceGroup, {
        items: [toolItem, commandItem],
      }),
    );
  });

  const label = container.querySelector("button").textContent;
  assert.equal(label, "读取了文件｜运行了命令");
  assert.doesNotMatch(label, /[·•]/);

  act(() => root.unmount());
});

test("a single-category tool batch renders no separator", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const secondReadItem = {
    toolCall: { id: "tool-3", name: "Read", arguments: { path: "src/main.ts" } },
    toolResult: { isError: false },
  };

  act(() => {
    root.render(
      React.createElement(ToolTraceGroup, {
        items: [toolItem, secondReadItem],
      }),
    );
  });

  assert.equal(container.querySelector("button").textContent, "读取了文件");

  act(() => root.unmount());
});

test("latest tool batch shows 运行中 while running and no filler status when idle", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  // All tools settled: no fake "思考中" phase — the turn-level sparkle and
  // real reasoning rows carry the live state instead.
  renderToolTrace(root, false, [toolItem], true);
  assert.doesNotMatch(container.querySelector("button").textContent, /思考中/);
  assert.doesNotMatch(container.querySelector("button").textContent, /运行中/);

  renderToolTrace(root, true, [toolItem], true);
  assert.match(container.querySelector("button").textContent, /运行中/);
  assert.doesNotMatch(container.querySelector("button").textContent, /思考中/);

  act(() => root.unmount());
});

test("a running tool batch names the current operation and caps its expanded height", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const readItem = {
    toolCall: { id: "read-1", name: "Read", arguments: { path: "src/App.tsx" } },
  };

  renderToolTrace(root, true, [readItem], true);
  const button = container.querySelector("button");
  assert.match(button.textContent, /正在读取 App\.tsx/);
  assert.match(button.textContent, /运行中/);

  click(button);
  const scrollRegion = container.querySelector("[data-tool-trace-scroll]");
  assert.match(scrollRegion.className, /max-h-\[400px\]/);
  assert.match(scrollRegion.className, /overflow-y-auto/);

  act(() => root.unmount());
});

test.after(() => env.cleanup());
