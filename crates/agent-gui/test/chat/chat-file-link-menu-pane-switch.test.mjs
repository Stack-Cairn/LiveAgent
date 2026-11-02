import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Both hosts give every workbench pane the same page-level file link handler,
// bound to the page's current conversation, and focusing a background pane
// commits its conversation only after the history window loads. The menu must
// run the link's handler as of the item press, not as of the right-click.

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
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/shims/tauriOpener": { openUrl() {} },
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
const { PaneFrame } = env.loadModule("@liveagent/ui/components/workbench/PaneFrame.tsx");
const { ContextMenuPopup, ContextMenuItem } = env.loadModule(
  "@liveagent/ui/components/ui/context-menu.tsx",
);
const { ChatFileLinkContextMenuHost } = env.loadModule(
  "@liveagent/ui/components/chat/ChatFileLinkContextMenu.tsx",
);
const markdown = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { useChatFileLinkNavigation } = env.loadModule(
  "@liveagent/ui/lib/chat/useChatFileLinkNavigation.ts",
);

const PANES = [
  { paneId: "pane-1", conversationId: "conv-1", workdir: "C:/work/project-1" },
  { paneId: "pane-2", conversationId: "conv-2", workdir: "C:/work/project-2" },
];

function relativeLinkNode() {
  const node = { type: "element", tagName: "a", properties: { href: "src/report.ts" }, children: [] };
  markdown.rewriteChatFileLinks()({ type: "root", children: [node] });
  return node;
}

function mouse(type, target, button) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: 40, clientY: 30 }),
  );
}

async function mountWorkbench() {
  const requests = [];
  let pendingCommit = null;
  // Page model: focus is immediate, the current conversation commits later.
  function Workbench() {
    const [focused, setFocused] = React.useState("pane-1");
    const [current, setCurrent] = React.useState(PANES[0]);
    const handleOpenChatFileLink = useChatFileLinkNavigation({
      conversationId: current.conversationId,
      conversationWorkdir: current.workdir,
      terminalProjectPathKey: "",
      notifyError: () => {},
      onRevealInFileTree: () => {},
      openWorkspaceEditorFile: () => {},
      openWorkspaceFilePreview: () => {},
      openLink: async (request) => {
        requests.push({ conversationId: request.conversationId, workdir: request.workdir });
        return { action: "revealed", kind: "file", outsideWorkspace: false };
      },
    });
    return React.createElement(
      "div",
      null,
      PANES.map((pane, index) => {
        const node = relativeLinkNode();
        return React.createElement(
          PaneFrame,
          {
            key: pane.paneId,
            paneId: pane.paneId,
            rect: { left: index * 400, top: 0, width: 400, height: 600 },
            isFocused: focused === pane.paneId,
            regionLabel: pane.paneId,
            onFocusRequest:
              focused === pane.paneId
                ? undefined
                : () => {
                    setFocused(pane.paneId);
                    pendingCommit = () => setCurrent(pane);
                  },
          },
          React.createElement(markdown.MarkdownFileLink, {
            href: node.properties.href,
            node,
            workdir: current.workdir,
            onOpenFileLink: handleOpenChatFileLink,
            children: `${pane.paneId} src/report.ts`,
          }),
          React.createElement(ChatFileLinkContextMenuHost),
        );
      }),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Workbench)));
  return {
    requests,
    link: () =>
      container.querySelector('[data-workbench-pane="pane-2"] [data-liveagent-file-link="true"]'),
    commit: async () => {
      assert.ok(pendingCommit, "focusing pane-2 scheduled a conversation commit");
      await act(async () => pendingCommit());
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("control: an action that reads the handler after pane-2 commits opens it against conv-2", async () => {
  const view = await mountWorkbench();
  try {
    await act(async () => mouse("pointerdown", view.link(), 0));
    await view.commit();
    await act(async () => view.link().click());
    assert.deepEqual(view.requests, [{ conversationId: "conv-2", workdir: "C:/work/project-2" }]);
  } finally {
    await view.unmount();
  }
});

test("the link menu opens a pane-2 link against conv-2 once pane-2's conversation commits", async () => {
  const view = await mountWorkbench();
  try {
    await act(async () => {
      mouse("pointerdown", view.link(), 2);
      mouse("contextmenu", view.link(), 2);
    });
    // The user moves to the menu; meanwhile the history window loads and commits.
    await view.commit();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === "chat.fileLink.open",
    );
    assert.ok(item, "the link menu is open");
    await act(async () => item.click());
    assert.deepEqual(view.requests, [{ conversationId: "conv-2", workdir: "C:/work/project-2" }]);
  } finally {
    await view.unmount();
  }
});

test("the menu popup carries the workbench focus guard and still closes on an outside press", async () => {
  const view = await mountWorkbench();
  try {
    await act(async () => {
      mouse("pointerdown", view.link(), 2);
      mouse("contextmenu", view.link(), 2);
    });
    const menu = document.querySelector('[role="menu"]');
    assert.equal(Boolean(menu), true, "the link menu is open");
    assert.equal(
      Boolean(menu.closest("[data-workbench-preserve-focus]")),
      true,
      "data-workbench-preserve-focus reaches the rendered menu",
    );
    // Base UI ignores outside presses for a short window after opening (a
    // plain ContextMenuPopup without the attribute behaves the same), so wait.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    await act(async () => {
      mouse("pointerdown", document.body, 0);
      mouse("mousedown", document.body, 0);
    });
    assert.equal(Boolean(document.querySelector('[role="menu"]')), false, "an outside press closes the menu");
  } finally {
    await view.unmount();
  }
});

test("control: a plain ContextMenuPopup without the attribute needs the same wait before an outside press closes it", async () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open
      ? React.createElement(
          ContextMenuPopup,
          { point: { x: 5, y: 5 }, onClose: () => setOpen(false) },
          React.createElement(ContextMenuItem, null, "Copy"),
        )
      : null;
  }
  const outsidePress = async () =>
    act(async () => {
      mouse("pointerdown", document.body, 0);
      mouse("mousedown", document.body, 0);
    });
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await outsidePress();
    assert.equal(Boolean(document.querySelector('[role="menu"]')), true, "an immediate press is ignored");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 600)));
    await outsidePress();
    assert.equal(Boolean(document.querySelector('[role="menu"]')), false, "a later press closes it");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
