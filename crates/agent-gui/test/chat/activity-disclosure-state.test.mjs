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
      getToolActivityTitleKey: (_toolCall, phase) => `chat.tool.activity.read.${phase}`,
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
            "chat.tool.batch.read.running": "正在读取文件",
            "chat.tool.batch.command.running": "正在运行命令",
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
      Braces: EmptyIcon,
      ChevronRight: EmptyIcon,
      Eye: EmptyIcon,
      FilePenLine: EmptyIcon,
      FolderTree: EmptyIcon,
      Globe: EmptyIcon,
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
      getShellSessionDisplayDetails: () => null,
      getToolActivityCategory: (name) => (name === "Bash" ? "command" : "read"),
      getToolActivityTitleKey: (toolCall, phase) =>
        `chat.tool.activity.${toolCall.name === "Bash" ? "command" : "read"}.${phase}`,
      getToolDisplayName: (name) => name,
      getToolTraceKey: (item, index) => item.toolCall.id ?? String(index),
      isWebFetchToolName: (name) => name === "web_fetch" || name === "WebFetch",
      isWebSearchToolName: (name) => name === "web_search",
      LSP_TOOL_NAME: "lsp",
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

function renderWorkTrace(root, running, attentionRequired = false, extra = {}) {
  act(() => {
    root.render(
      React.createElement(AssistantWorkTrace, {
        hasDetails: true,
        attentionRequired,
        running,
        ...extra,
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

test("a running work trace keeps counting from the turn start across remounts", () => {
  // 切换会话 / 虚拟列表回收会卸载工作区块；重挂后「处理中」必须接着回合真实
  // 起点计时，而不是从挂载时刻重新从 1s 数起（#875）。
  const startedAtMs = Date.now() - 15_000;
  const mount = () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(AssistantWorkTrace, {
          hasDetails: false,
          running: true,
          startedAtMs,
          children: null,
        }),
      );
    });
    return { container, root };
  };

  const first = mount();
  assert.match(first.container.textContent, /处理中 1[5-6]s/);
  act(() => first.root.unmount());

  const second = mount();
  assert.match(second.container.textContent, /处理中 1[5-6]s/);
  act(() => second.root.unmount());
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
  // The pixels cycle in a staggered wave while the turn runs.
  const pixels = [...container.querySelectorAll("[data-chat-work-grid] span span")];
  assert.equal(pixels.length, 9);
  for (const pixel of pixels) {
    assert.match(pixel.className, /(?:^|\s)animate-chat-work-pixel(?:\s|$)/);
    assert.match(pixel.className, /(?:^|\s)motion-reduce:animate-none(?:\s|$)/);
    assert.equal(pixel.hasAttribute("data-paused"), false);
  }
  const delays = pixels.map((pixel) => pixel.style.getPropertyValue("--chat-work-delay"));
  assert.ok(new Set(delays).size > 1, `delays should differ: ${delays}`);
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

  // An answered history turn mounts collapsed; only a blocking interaction reopens it.
  renderWorkTrace(root, false, false, { collapseAfterAnswer: true });
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

test("a running tool batch opens, then folds once its calls finish", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderToolTrace(root, true);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "true");

  renderToolTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  // A later call in the same batch opens it again.
  renderToolTrace(root, true);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  act(() => root.unmount());
});

test("a finished tool batch loaded from history mounts collapsed", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderToolTrace(root, false);
  assert.equal(container.querySelector("button").getAttribute("aria-expanded"), "false");

  act(() => root.unmount());
});

test("manual tool-batch disclosure survives tool completion and restart", () => {
  const container = document.createElement("div");
  const root = createRoot(container);

  renderToolTrace(root, true);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "true");

  // Collapsed by hand while running: finishing and restarting leave it shut.
  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderToolTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  renderToolTrace(root, true);
  assert.equal(button.getAttribute("aria-expanded"), "false");

  // Reopened by hand: finishing no longer folds it.
  click(button);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  renderToolTrace(root, false);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  act(() => root.unmount());
});

test("a tool batch that settles with a failed call stays open", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const pending = { toolCall: { id: "bash-1", name: "Bash", arguments: { command: "make" } } };
  const failed = { ...pending, toolResult: { isError: true } };

  renderToolTrace(root, true, [pending]);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "true");

  renderToolTrace(root, false, [failed]);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  // Reloaded from history the failure shows in the folded header instead.
  act(() => root.unmount());
  const reloaded = document.createElement("div");
  const reloadedRoot = createRoot(reloaded);
  renderToolTrace(reloadedRoot, false, [failed]);
  const header = reloaded.querySelector("button");
  assert.equal(header.getAttribute("aria-expanded"), "false");
  assert.match(header.textContent, /失败/);
  act(() => reloadedRoot.unmount());
});

test("the trailing batch of a running turn stays open between calls", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (live, runningToolCallIds) =>
    act(() => {
      root.render(
        React.createElement(ToolTraceGroup, { items: [toolItem], runningToolCallIds, live }),
      );
    });

  render(true, ["tool-1"]);
  const button = container.querySelector("button");
  assert.equal(button.getAttribute("aria-expanded"), "true");

  // The call finished but the model is still deciding on the next one.
  render(true, []);
  assert.equal(button.getAttribute("aria-expanded"), "true");

  // An answer started after it (or the turn ended): now it folds.
  render(false, []);
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

  // Running, it opens and leaves the status to its rows; folded, the header says 运行中.
  renderToolTrace(root, true, [toolItem], true);
  assert.equal(container.querySelector("button").getAttribute("aria-expanded"), "true");
  click(container.querySelector("button"));
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
  // Open while running; folded by hand, the header names the running call.
  assert.equal(button.getAttribute("aria-expanded"), "true");
  click(button);
  assert.match(button.textContent, /正在读取 App\.tsx/);
  assert.match(button.textContent, /运行中/);

  click(button);
  const scrollRegion = container.querySelector("[data-tool-trace-scroll]");
  assert.match(scrollRegion.className, /max-h-400px/);
  assert.match(scrollRegion.className, /overflow-y-auto/);

  act(() => root.unmount());
});

test.after(() => env.cleanup());

test("a settled turn without an answer mounts with its trace open, an answered one collapsed", () => {
  // An interrupted run (queue run-now, Stop) persists only its process: once the
  // history twin remounts it, a collapsed trace would leave just the header.
  for (const [collapseAfterAnswer, expanded] of [
    [false, "true"],
    [true, "false"],
  ]) {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => {
      root.render(
        React.createElement(AssistantWorkTrace, {
          hasDetails: true,
          running: false,
          collapseAfterAnswer,
          durationMs: 18_000,
          children: React.createElement("div", { "data-testid": "work-details" }),
        }),
      );
    });
    const button = container.querySelector("button");
    assert.equal(button.getAttribute("aria-expanded"), expanded);
    assert.equal(Boolean(container.querySelector('[data-testid="work-details"]')), expanded === "true");
    act(() => root.unmount());
  }
});

test("an expanded tool batch leaves the running call and its status to the call's own row", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const commandItem = {
    toolCall: { id: "bash-1", name: "Bash", arguments: { command: "make test" } },
  };

  renderToolTrace(root, true, [commandItem], true);
  const button = container.querySelector("button");
  // Open while running: the row inside names the command and says 运行中; the
  // header only labels the batch, in the present tense while the command runs.
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(button.textContent, "正在运行命令");

  click(button);
  assert.equal(container.querySelector("button").textContent, "正在运行 make test运行中");

  click(container.querySelector("button"));
  assert.equal(container.querySelector("button").textContent, "正在运行命令");

  act(() => root.unmount());
});

test("an expanded batch label stays in the present tense until its calls are done", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const readItem = {
    toolCall: { id: "read-1", name: "read_file", arguments: {} },
    toolResult: { isError: false },
  };
  const commandItem = {
    toolCall: { id: "bash-1", name: "Bash", arguments: { command: "make test" } },
  };
  const render = (items, runningToolCallIds) =>
    act(() => {
      root.render(
        React.createElement(ToolTraceGroup, { items, runningToolCallIds, showTurnStatus: true }),
      );
    });

  render([readItem, commandItem], ["bash-1"]);
  // Open while running. Fold and reopen it by hand so it stays open once done.
  click(container.querySelector("button"));
  click(container.querySelector("button"));
  assert.equal(container.querySelector("button").getAttribute("aria-expanded"), "true");
  // Only the category with a running call reads as ongoing.
  assert.equal(container.querySelector("button").textContent, "读取了文件｜正在运行命令");

  render([readItem, { ...commandItem, toolResult: { isError: false } }], []);
  assert.equal(container.querySelector("button").textContent, "读取了文件｜运行了命令");

  // A call left without a result in a settled turn is not running any more.
  render([readItem, commandItem], []);
  assert.match(container.querySelector("button").textContent, /^读取了文件｜运行了命令/);

  act(() => root.unmount());
});

test("an expanded tool batch keeps the waiting status its rows do not show", () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const waitingItem = { toolCall: { id: "read-1", name: "read_file", arguments: {} } };

  renderToolTrace(root, false, [waitingItem]);
  click(container.querySelector("button"));
  assert.equal(container.querySelector("button").textContent, "读取了文件1 等待中");

  act(() => root.unmount());
});
