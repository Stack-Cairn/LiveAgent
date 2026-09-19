import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let clipboardRead = async () => "replacement";
const copied = [];
const locale = { locale: "en-US", t: (key) => key };
const env = await createDomTestEnv({ mocks: {
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "@liveagent/ui/i18n/index": { useLocale: () => locale },
  "@liveagent/ui/lib/shared/clipboard": { copyTextToClipboard: async (text) => { copied.push(text); return true; } },
  "../../lib/system/clipboardText": { readClipboardText: () => clipboardRead() },
} });
globalThis.DOMRect = window.DOMRect;
globalThis.HTMLInputElement = window.HTMLInputElement;
globalThis.HTMLTextAreaElement = window.HTMLTextAreaElement;
const { React, act, createRoot } = env;
const { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuPopup, ContextMenuItem } =
  env.loadModule("@liveagent/ui/components/ui/context-menu.tsx");
const { useNativeInputContextMenu } = env.loadModule("src/components/input-context-menu/NativeInputContextMenu.tsx");
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");

async function mount(Component) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Component)));
  return async () => {
    await act(async () => root.unmount());
    container.remove();
  };
}

async function key(key) {
  await act(async () => document.activeElement.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  ));
}

test("delegated context menu portals, blocks disabled actions, activates with keyboard and closes", async () => {
  let selected = 0;
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(ContextMenuPopup, {
      point: { x: 100, y: 80 }, onClose: () => setOpen(false),
    },
    React.createElement(ContextMenuItem, { disabled: true, onClick: () => assert.fail("disabled") }, "Disabled"),
    React.createElement(ContextMenuItem, { onClick: () => selected++ }, "Copy")) : null;
  }
  const cleanup = await mount(Harness);
  try {
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu);
    assert.ok(menu.closest('[data-base-ui-portal]'));
    await key("ArrowDown");
    assert.equal(document.activeElement.getAttribute("aria-disabled"), "true");
    await key("Enter");
    assert.equal(selected, 0);
    assert.ok(document.querySelector('[role="menu"]'));
    await key("ArrowDown");
    assert.equal(document.activeElement.textContent, "Copy");
    await key("Enter");
    assert.equal(selected, 1);
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally { await cleanup(); }
});

test("Escape dismisses only the menu and keep-open actions retain it", async () => {
  let selected = 0;
  function Harness() {
    const [open, setOpen] = React.useState(true);
    return open ? React.createElement(ContextMenuPopup, {
      point: { x: 10, y: 20 }, onClose: () => setOpen(false),
    }, React.createElement(ContextMenuItem, { closeOnClick: false, onClick: () => selected++ }, "Copy path")) : null;
  }
  const cleanup = await mount(Harness);
  try {
    await act(async () => document.querySelector('[role="menuitem"]').click());
    assert.equal(selected, 1);
    assert.ok(document.querySelector('[role="menu"]'));
    await key("Escape");
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally { await cleanup(); }
});

test("standard trigger opens on right click and outside pointer dismisses", async () => {
  function Harness() {
    return React.createElement(ContextMenu, null,
      React.createElement(ContextMenuTrigger, { render: React.createElement("div", { "data-trigger": true }) }, "File"),
      React.createElement(ContextMenuContent, null, React.createElement(ContextMenuItem, null, "Open")),
    );
  }
  const cleanup = await mount(Harness);
  try {
    await act(async () => document.querySelector('[data-trigger]').dispatchEvent(
      new MouseEvent("contextmenu", { button: 2, clientX: 30, clientY: 40, bubbles: true, cancelable: true }),
    ));
    assert.ok(document.querySelector('[role="menu"]'));
    await act(async () => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally { await cleanup(); }
});

test("native input copy and asynchronous paste act on the captured selection", async () => {
  function Harness() {
    const { onRootContextMenu, onRootMouseDownCapture, menu } = useNativeInputContextMenu();
    const [value, setValue] = React.useState("hello world");
    return React.createElement("div", { onContextMenu: onRootContextMenu, onMouseDownCapture: onRootMouseDownCapture },
      React.createElement("input", { value, onChange: (event) => setValue(event.target.value) }), menu);
  }
  const cleanup = await mount(Harness);
  const input = document.querySelector("input");
  const open = async () => {
    await act(async () => {
      input.focus(); input.setSelectionRange(6, 11);
      input.dispatchEvent(new MouseEvent("contextmenu", { button: 2, clientX: 40, clientY: 60, bubbles: true, cancelable: true }));
    });
  };
  const item = (label) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent === label);
  try {
    await open();
    await act(async () => item("inputContextMenu.copy").click());
    assert.equal(copied.at(-1), "world");
    assert.equal(input.value, "hello world");
    await open();
    let resolveRead;
    clipboardRead = () => new Promise((resolve) => { resolveRead = resolve; });
    await act(async () => item("inputContextMenu.paste").click());
    // Menu dismissal must not invalidate the async action's target or range.
    await act(async () => resolveRead("there"));
    assert.equal(input.value, "hello there");
    assert.equal(input.selectionStart, 11);
    assert.equal(document.querySelector('[role="menu"]'), null);
  } finally { await cleanup(); }
});

test("composer menu survives focus transfer from the editor and Escape restores editor focus", async () => {
  function Harness() {
    return React.createElement(MentionComposer, { workdir: "", enabledSkills: [], conversations: [], mentionApps: [], onSend() {} });
  }
  const cleanup = await mount(Harness);
  try {
    const editor = document.querySelector('[contenteditable="true"]');
    await act(async () => {
      editor.focus();
      editor.dispatchEvent(new MouseEvent("contextmenu", { button: 2, clientX: 30, clientY: 40, bubbles: true, cancelable: true }));
    });
    const menu = document.querySelector('[role="menu"]');
    assert.ok(menu, "editor blur must not close the newly opened menu");
    // Base UI 把焦点移进弹窗是异步的（定位就绪后的一帧）；等它落地，而不是假设与
    // contextmenu 同步完成。期间菜单必须一直开着（编辑器失焦不能关掉它）。
    for (let attempt = 0; attempt < 10 && !menu.contains(document.activeElement); attempt += 1) {
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      assert.ok(document.querySelector('[role="menu"]'), "menu must stay open while focus settles");
    }
    assert.ok(menu.contains(document.activeElement));
    await key("Escape");
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(document.activeElement, editor);
  } finally { await cleanup(); }
});
