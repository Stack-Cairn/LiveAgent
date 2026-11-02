import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Chat file link context menu in a split Session Workbench.
// Each pane's transcript mounts a ChatFileLinkContextMenuHost, but only the
// first mounted host renders the popup. The popup is portaled to <body>, yet
// React still bubbles its synthetic events through the *host's* React tree, so
// the press on a menu item reaches the first pane's PaneFrame
// onPointerDownCapture and focuses that pane — even when the link that opened
// the menu lives in another pane.

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
const { ChatFileLinkContextMenuHost } = env.loadModule(
  "@liveagent/ui/components/chat/ChatFileLinkContextMenu.tsx",
);
const markdown = env.loadModule("@liveagent/ui/components/Markdown.tsx");

function fileLinkNode(href) {
  const node = { type: "element", tagName: "a", properties: { href }, children: [] };
  markdown.rewriteChatFileLinks()({ type: "root", children: [node] });
  return node;
}

function pointer(type, target, button) {
  target.dispatchEvent(
    new MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: 40, clientY: 30 }),
  );
}

for (const { name, linkPane, otherPane, hostOutsidePanes = false } of [
  // Control: the link lives in the pane whose host renders the menu.
  { name: "using the link menu from the first workbench pane keeps it focused", linkPane: "pane-1", otherPane: "pane-2" },
  // Control: a single host outside every PaneFrame does not steal focus,
  // so the cause is the popup's React bubbling through its host's pane.
  { name: "a page-level host outside the panes keeps the second pane focused", linkPane: "pane-2", otherPane: "pane-1", hostOutsidePanes: true },
  { name: "using the link menu from a second workbench pane must not focus the first pane", linkPane: "pane-2", otherPane: "pane-1" },
]) test(name, async () => {
  const focusRequests = [];
  const opened = [];
  const rect = (left) => ({ left, top: 0, width: 400, height: 600 });
  function Pane({ paneId, left }) {
    const node = fileLinkNode(`C:/work/${paneId}/report.ts`);
    return React.createElement(
      PaneFrame,
      {
        paneId,
        rect: rect(left),
        isFocused: false,
        regionLabel: paneId,
        onFocusRequest: () => focusRequests.push(paneId),
      },
      React.createElement(markdown.MarkdownFileLink, {
        href: node.properties.href,
        node,
        onOpenFileLink: (link) => opened.push({ paneId, path: link.path }),
        children: `${paneId} link`,
      }),
      // Same placement as ChatTranscript / GatewayTranscript: one host per transcript.
      hostOutsidePanes ? null : React.createElement(ChatFileLinkContextMenuHost),
    );
  }
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement(Pane, { paneId: "pane-1", left: 0 }),
          React.createElement(Pane, { paneId: "pane-2", left: 400 }),
          hostOutsidePanes ? React.createElement(ChatFileLinkContextMenuHost) : null,
        ),
      ),
    );
    const link = container.querySelector(`[data-workbench-pane="${linkPane}"] [data-liveagent-file-link="true"]`);
    assert.ok(link, `${linkPane} renders its file link`);

    // Right-click the link: pointerdown focuses its pane, contextmenu opens the menu.
    await act(async () => {
      pointer("pointerdown", link, 2);
      pointer("contextmenu", link, 2);
    });
    assert.deepEqual(focusRequests, [linkPane]);
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === "chat.fileLink.open",
    );
    assert.ok(item, "the link menu is open");

    // Press "Open file".
    focusRequests.length = 0;
    await act(async () => {
      pointer("pointerdown", item, 0);
      item.click();
    });
    assert.deepEqual(opened, [{ paneId: linkPane, path: `C:/work/${linkPane}/report.ts` }]);
    assert.deepEqual(
      focusRequests.filter((paneId) => paneId === otherPane),
      [],
      "pressing the menu item focused another pane",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
