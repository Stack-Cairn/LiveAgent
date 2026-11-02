import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Menu items re-click the right-clicked link button and arm a one-shot intent
// ("Open containing folder", "Open with default app") that the button's own
// onClick consumes through withChatFileLinkMenuIntent. These cases check that
// the re-click reaches React synchronously, that the intent never survives
// into the next ordinary click, the ToolCallItem row, and the web link menu.
// Assertions compare plain values only (a failing assert on a jsdom node would
// try to print the whole tree).

const openedUrls = [];
const copiedTexts = [];
const noopIcons = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "__esModule" ? true : String(key).endsWith("_SVG_MARKUP") ? "<svg></svg>" : () => null,
  },
);
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": noopIcons,
    "@liveagent/ui/components/chat/fileTypeIcons": noopIcons,
    // ToolCallItem imports ChevronRight relatively.
    "../../IconSet": noopIcons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/shims/tauriOpener": {
      openUrl: async (url) => {
        openedUrls.push(url);
      },
    },
    "@liveagent/ui/lib/shared/clipboard": {
      copyTextToClipboard: async (text) => {
        copiedTexts.push(text);
        return true;
      },
    },
    "@streamdown/cjk": { cjk: {} },
    "@streamdown/code": { code: {} },
    "@streamdown/math": { math: {} },
    "@streamdown/mermaid": { mermaid: {} },
    streamdown: {
      Streamdown: () => null,
      defaultRemarkPlugins: {},
      defaultRehypePlugins: { raw: () => {}, sanitize: [() => {}, {}], harden: () => {} },
    },
  },
});
globalThis.DOMRect = window.DOMRect;
const { React, act, createRoot } = env;
const { ChatFileLinkContextMenuHost } = env.loadModule(
  "@liveagent/ui/components/chat/ChatFileLinkContextMenu.tsx",
);
const markdown = env.loadModule("@liveagent/ui/components/Markdown.tsx");

function fileLinkNode(href) {
  const node = { type: "element", tagName: "a", properties: { href }, children: [] };
  markdown.rewriteChatFileLinks()({ type: "root", children: [node] });
  return node;
}

function mouse(type, target, button) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: 40, clientY: 30 }),
  );
}

const menuItem = (label) =>
  [...document.querySelectorAll('[role="menuitem"]')].find((element) => element.textContent === label);

async function mount(element) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function chooseFromMenu(target, label) {
  await act(async () => mouse("contextmenu", target, 2));
  const item = menuItem(label);
  assert.equal(Boolean(item), true, `${label} is in the menu`);
  await act(async () => item.click());
}

const summary = (calls) => calls.map((link) => `${link.path}|${link.openInFileManager === true}`);

test("markdown link: reveal reaches the re-clicked handler and the next left click is a plain open", async () => {
  const calls = [];
  const node = fileLinkNode("C:/work/project/src/report.ts");
  const view = await mount(
    React.createElement(
      "div",
      null,
      React.createElement(markdown.MarkdownFileLink, {
        href: node.properties.href,
        node,
        onOpenFileLink: (link) => calls.push(link),
        children: "report.ts",
      }),
      React.createElement(ChatFileLinkContextMenuHost),
    ),
  );
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await chooseFromMenu(link, "chat.fileLink.openContainingDirectory");
    await act(async () => link.click());
    await chooseFromMenu(link, "chat.fileLink.open");
    assert.deepEqual(summary(calls), [
      "C:/work/project/src/report.ts|true",
      "C:/work/project/src/report.ts|false",
      "C:/work/project/src/report.ts|false",
    ]);
  } finally {
    await view.unmount();
  }
});

test("markdown link: a handler that throws during a reveal leaves no armed flag behind", async () => {
  const calls = [];
  let throwOnce = true;
  const node = fileLinkNode("C:/work/project/src/report.ts");
  const errors = [];
  const onError = (event) => {
    errors.push(String(event.error?.message ?? event.message));
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  const view = await mount(
    React.createElement(
      "div",
      null,
      React.createElement(markdown.MarkdownFileLink, {
        href: node.properties.href,
        node,
        onOpenFileLink: (link) => {
          calls.push(link);
          if (throwOnce) {
            throwOnce = false;
            throw new Error("open failed");
          }
        },
        children: "report.ts",
      }),
      React.createElement(ChatFileLinkContextMenuHost),
    ),
  );
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await chooseFromMenu(link, "chat.fileLink.openContainingDirectory").catch(() => {});
    await act(async () => link.click());
    assert.deepEqual(summary(calls), [
      "C:/work/project/src/report.ts|true",
      "C:/work/project/src/report.ts|false",
    ]);
  } finally {
    window.removeEventListener("error", onError);
    await view.unmount();
  }
});

test("tool file operation row: reveal reaches the re-clicked handler and the next click is plain", async () => {
  const { MemoToolCallItem } = env.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
  );
  const calls = [];
  const item = {
    toolCall: { type: "toolCall", id: "call-1", name: "Read", arguments: { path: "src/report.ts" } },
    toolResult: {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "Read",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details: { absolutePath: "C:/work/project/src/report.ts" },
    },
  };
  const view = await mount(
    React.createElement(
      "div",
      null,
      React.createElement(MemoToolCallItem, { item, onOpenFileLink: (link) => calls.push(link) }),
      React.createElement(ChatFileLinkContextMenuHost),
    ),
  );
  try {
    const target = view.container.querySelector("[data-chat-file-link]");
    assert.equal(Boolean(target), true, "the Read row renders its file link");
    await chooseFromMenu(target, "chat.fileLink.openContainingDirectory");
    await act(async () => target.click());
    assert.deepEqual(summary(calls), [
      "C:/work/project/src/report.ts|true",
      "C:/work/project/src/report.ts|false",
    ]);
  } finally {
    await view.unmount();
  }
});

test("markdown link: a native listener that swallows the re-click leaves no armed flag behind", async () => {
  const calls = [];
  const node = fileLinkNode("C:/work/project/src/report.ts");
  let swallow = true;
  const attach = (element) => {
    element?.addEventListener("click", (event) => {
      if (!swallow) return;
      swallow = false;
      event.stopPropagation();
    });
  };
  const view = await mount(
    React.createElement(
      "div",
      null,
      React.createElement(
        "div",
        { ref: attach },
        React.createElement(markdown.MarkdownFileLink, {
          href: node.properties.href,
          node,
          onOpenFileLink: (link) => calls.push(link),
          children: "report.ts",
        }),
      ),
      React.createElement(ChatFileLinkContextMenuHost),
    ),
  );
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await chooseFromMenu(link, "chat.fileLink.openContainingDirectory");
    assert.deepEqual(summary(calls), [], "the swallowed re-click never reached React");
    await act(async () => link.click());
    assert.deepEqual(summary(calls), ["C:/work/project/src/report.ts|false"]);
  } finally {
    await view.unmount();
  }
});

// If the right-clicked row remounts while the menu is open, its old button has
// left the DOM; the menu must not fall back to the handler frozen at right-click.
test("remounted link: the menu never opens it with the handler frozen at right-click", async () => {
  const calls = [];
  let switchPane = null;
  function Pane() {
    const [current, setCurrent] = React.useState("conv-1");
    switchPane = () => setCurrent("conv-2");
    const node = fileLinkNode("src/report.ts");
    return React.createElement(
      "div",
      null,
      React.createElement(markdown.MarkdownFileLink, {
        // The row remounts when the conversation commits.
        key: current,
        href: node.properties.href,
        node,
        onOpenFileLink: (link) => calls.push(`${current}:${link.path}`),
        children: "src/report.ts",
      }),
      React.createElement(ChatFileLinkContextMenuHost),
    );
  }
  const view = await mount(React.createElement(Pane));
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await act(async () => mouse("contextmenu", link, 2));
    await act(async () => switchPane());
    await act(async () => menuItem("chat.fileLink.open").click());
    assert.deepEqual(calls, []);
  } finally {
    await view.unmount();
  }
});

test("desktop host offers the default app, and the browser for web pages; the WebUI host does not", async () => {
  const calls = [];
  const renderLink = (path, canOpenWithDefaultApp) => {
    const node = fileLinkNode(path);
    return mount(
      React.createElement(
        "div",
        null,
        React.createElement(markdown.MarkdownFileLink, {
          href: node.properties.href,
          node,
          onOpenFileLink: (link) => calls.push(link),
          children: path,
        }),
        React.createElement(ChatFileLinkContextMenuHost, { canOpenWithDefaultApp }),
      ),
    );
  };
  let view = await renderLink("C:/work/out/deck.pptx", true);
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await chooseFromMenu(link, "chat.fileLink.openWithDefaultApp");
    await act(async () => link.click());
    assert.deepEqual(
      calls.map((call) => `${call.path}|${call.openWithDefaultApp === true}`),
      ["C:/work/out/deck.pptx|true", "C:/work/out/deck.pptx|false"],
    );
  } finally {
    await view.unmount();
  }
  view = await renderLink("C:/work/out/index.html", true);
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await act(async () => mouse("contextmenu", link, 2));
    assert.equal(Boolean(menuItem("chat.fileLink.openInBrowser")), true);
    assert.equal(Boolean(menuItem("chat.fileLink.openWithDefaultApp")), false);
    await act(async () => menuItem("chat.fileLink.openInBrowser").click());
    assert.equal(calls.at(-1).openWithDefaultApp, true);
  } finally {
    await view.unmount();
  }
  view = await renderLink("C:/work/out/deck.pptx", false);
  try {
    const link = view.container.querySelector('[data-liveagent-file-link="true"]');
    await act(async () => mouse("contextmenu", link, 2));
    assert.equal(Boolean(menuItem("chat.fileLink.openContainingDirectory")), true);
    assert.equal(Boolean(menuItem("chat.fileLink.openWithDefaultApp")), false);
    await act(async () => menuItem("chat.fileLink.open").click());
  } finally {
    await view.unmount();
  }
});

test("web links open in the default browser or copy from the right-click menu", async () => {
  openedUrls.length = 0;
  copiedTexts.length = 0;
  const view = await mount(
    React.createElement(
      "div",
      null,
      React.createElement(markdown.MarkdownLink, {
        href: "https://example.com/docs",
        children: "docs",
      }),
      React.createElement(ChatFileLinkContextMenuHost),
    ),
  );
  try {
    const link = view.container.querySelector('[data-streamdown="link"]');
    await act(async () => mouse("contextmenu", link, 2));
    assert.equal(Boolean(menuItem("chat.fileLink.open")), false);
    await act(async () => menuItem("chat.fileLink.openInBrowser").click());
    await act(async () => mouse("contextmenu", link, 2));
    await act(async () => menuItem("chat.fileLink.copyLink").click());
    assert.deepEqual(openedUrls, ["https://example.com/docs"]);
    assert.deepEqual(copiedTexts, ["https://example.com/docs"]);
  } finally {
    await view.unmount();
  }
});
