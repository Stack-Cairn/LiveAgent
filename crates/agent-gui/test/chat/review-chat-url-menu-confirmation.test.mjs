import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Review round 4: chat web links require the "Open external link" dialog,
// which shows the real destination, until the user ticks "don't remind"
// (externalLinkPreference.ts). The right-click menu's "Open in default
// browser" calls openUrl directly and its menu never shows the URL, so a link
// whose text disguises its target opens without the user ever seeing where it
// goes — even though the left click on the same link still asks.
// Assertions compare plain values only.

const openedUrls = [];
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
    "@liveagent/ui/i18n/index": { useLocale: () => ({ locale: "en-US", t: (key) => key }) },
    "@liveagent/app/shims/tauriOpener": {
      openUrl: async (url) => {
        openedUrls.push(url);
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
window.open = () => null;
const { React, act, createRoot } = env;
const { ChatFileLinkContextMenuHost } = env.loadModule(
  "@liveagent/ui/components/chat/ChatFileLinkContextMenu.tsx",
);
const markdown = env.loadModule("@liveagent/ui/components/Markdown.tsx");
const { shouldSkipExternalLinkConfirmation } = env.loadModule(
  "@liveagent/ui/lib/externalLinkPreference.ts",
);

const DESTINATION = "https://login.example-attacker.test/session";

async function mountDisguisedLink() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(
        "div",
        null,
        React.createElement(markdown.MarkdownLink, {
          href: DESTINATION,
          children: "docs.python.org",
        }),
        React.createElement(ChatFileLinkContextMenuHost, { canOpenWithDefaultApp: true }),
      ),
    ),
  );
  return {
    link: () => container.querySelector('[data-streamdown="link"]'),
    destinationShown: () => document.body.textContent.includes(DESTINATION),
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test("control: a left click on a disguised web link asks first and shows the destination", async () => {
  openedUrls.length = 0;
  assert.equal(shouldSkipExternalLinkConfirmation(), false);
  const view = await mountDisguisedLink();
  try {
    await act(async () => view.link().click());
    assert.deepEqual(openedUrls, []);
    assert.equal(view.destinationShown(), true, "the dialog shows the real URL");
  } finally {
    await view.unmount();
  }
});

test("the menu's open-in-browser does not open a disguised link the user has not seen", async () => {
  openedUrls.length = 0;
  assert.equal(shouldSkipExternalLinkConfirmation(), false);
  const view = await mountDisguisedLink();
  try {
    await act(async () =>
      view
        .link()
        .dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: 4, clientY: 4 }),
        ),
    );
    const menuShowsDestination = view.destinationShown();
    const item = [...document.querySelectorAll('[role="menuitem"]')].find(
      (element) => element.textContent === "chat.fileLink.openInBrowser",
    );
    assert.equal(Boolean(item), true, "the menu offers open in browser");
    await act(async () => item.click());
    // Either fix is fine: ask first (nothing opened yet) or show the URL in
    // the menu before opening it. Opening a destination never shown is not.
    assert.equal(
      openedUrls.length === 0 || menuShowsDestination,
      true,
      `opened ${JSON.stringify(openedUrls)} without ever showing it (menu shows URL: ${menuShowsDestination})`,
    );
    if (openedUrls.length === 0) {
      assert.equal(view.destinationShown(), true, "the confirmation shows the real URL");
    }
  } finally {
    await view.unmount();
  }
});
