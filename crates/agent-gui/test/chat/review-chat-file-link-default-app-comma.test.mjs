import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Review round 4 — reachability for the Windows comma split.
// open_with_default_app passes the canonical target to `explorer.exe <path>`
// through Command::arg, which only quotes arguments containing whitespace.
// explorer.exe treats an unquoted comma as a separator and opens the first
// token (verified on this machine, see the review report). So a path like
// `<workspace>/run.bat,report.pdf` passes the DEFAULT_APP_EXTENSIONS check
// (extension "pdf") while explorer launches `<workspace>/run.bat`.
// These tests show the agent-written path reaches the Tauri command intact,
// with open_with_default_app set, from the real Write tool row and from a
// markdown link. The fix belongs in Rust; these are reachability evidence.

const invokes = [];
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
    "../../IconSet": noopIcons,
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/shims/tauriOpener": { openUrl: async () => {} },
    "@liveagent/app/shims/tauriCore": {
      invoke: async (command, args) => {
        invokes.push({ command, args });
        return { action: "opened", kind: "file", outsideWorkspace: false };
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
const { openChatFileLink } = env.loadModule("@liveagent/ui/lib/chat/openChatFileLink.ts");
const markdown = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { MemoToolCallItem } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolCallItem.tsx",
);

const WORKDIR = "D:/work/demo";
const SPLIT_PATH = `${WORKDIR}/run.bat,report.pdf`;
const openLink = (link) => openChatFileLink({ ...link, conversationId: "conv-1", workdir: WORKDIR });

async function mount(child) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        "div",
        null,
        child,
        React.createElement(ChatFileLinkContextMenuHost, { canOpenWithDefaultApp: true }),
      ),
    ),
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function openWithDefaultApp(target) {
  await act(async () =>
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 4, clientY: 4 }),
    ),
  );
  const item = [...document.querySelectorAll('[role="menuitem"]')].find(
    (element) => element.textContent === "chat.fileLink.openWithDefaultApp",
  );
  assert.equal(Boolean(item), true, "the desktop menu offers the default app");
  await act(async () => item.click());
}

const sent = () =>
  invokes.map(({ command, args }) => `${command}|${args.path}|${args.open_with_default_app === true}`);

test("Write tool row: a comma path reaches open_chat_file_link with open_with_default_app", async () => {
  invokes.length = 0;
  const item = {
    toolCall: { type: "toolCall", id: "call-w", name: "Write", arguments: { path: "run.bat,report.pdf" } },
    toolResult: {
      role: "toolResult",
      toolCallId: "call-w",
      toolName: "Write",
      isError: false,
      content: [{ type: "text", text: "ok" }],
      details: { absolutePath: SPLIT_PATH },
    },
  };
  const view = await mount(React.createElement(MemoToolCallItem, { item, onOpenFileLink: openLink }));
  try {
    const target = view.container.querySelector("[data-chat-file-link]");
    assert.equal(Boolean(target), true, "the Write row renders its file link");
    await openWithDefaultApp(target);
    assert.deepEqual(sent(), [`open_chat_file_link|${SPLIT_PATH}|true`]);
  } finally {
    await view.unmount();
  }
});

test("markdown link: a comma path reaches open_chat_file_link with open_with_default_app", async () => {
  invokes.length = 0;
  const node = { type: "element", tagName: "a", properties: { href: SPLIT_PATH }, children: [] };
  markdown.rewriteChatFileLinks()({ type: "root", children: [node] });
  const view = await mount(
    React.createElement(markdown.MarkdownFileLink, {
      href: node.properties.href,
      node,
      onOpenFileLink: openLink,
      children: "report.pdf",
    }),
  );
  try {
    const target = view.container.querySelector('[data-liveagent-file-link="true"]');
    assert.equal(Boolean(target), true, "the comma path is rewritten into a file link");
    await openWithDefaultApp(target);
    assert.deepEqual(sent(), [`open_chat_file_link|${SPLIT_PATH}|true`]);
  } finally {
    await view.unmount();
  }
});
