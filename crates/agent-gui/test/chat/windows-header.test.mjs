import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

let maximized = false;
const calls = [];
const appWindow = {
  isMaximized: async () => maximized,
  isFocused: async () => true,
  onResized: async () => () => calls.push("unlisten-resize"),
  onFocusChanged: async () => () => calls.push("unlisten-focus"),
  minimize: async () => calls.push("minimize"),
  close: async () => calls.push("close"),
  toggleMaximize: async () => { maximized = !maximized; calls.push("maximize"); },
  startDragging: async () => calls.push("drag"),
};
const env = await createDomTestEnv({ mocks: {
  "../../src-tauri/icons/icon-simple.png": "icon.png",
  "../../../src-tauri/icons/icon-simple.png": "icon.png",
  "@tauri-apps/api/window": { getCurrentWindow: () => appWindow },
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "@liveagent/adapters/chatHeaderChrome": { isDesktopChatHeaderInset: () => false },
  "@liveagent/app/lib/settings": { getNextTheme: () => "dark" },
}});
const { React, act, createRoot } = env;
Object.defineProperty(navigator, "platform", { value: "Win32", configurable: true });
Object.defineProperty(navigator, "userAgent", { value: "Windows NT 10.0", configurable: true });
window.__TAURI_INTERNALS__ = {};
const { WindowsTitleBar } = env.loadModule(fileURLToPath(new URL("../../src/components/WindowsTitleBar.tsx", import.meta.url)));
const { AppBootShell } = env.loadModule(fileURLToPath(new URL("../../src/components/app/AppBootShell.tsx", import.meta.url)));
const { ChatHeader } = env.loadModule("@liveagent/ui/components/chat/ChatHeader.tsx");
const { AppErrorBoundary } = env.loadModule("@liveagent/ui/components/AppErrorBoundary.tsx");

test("Windows workbench has one header with live native controls and a marked drag surface", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  let toggles = 0;
  try {
    await act(async () => root.render(React.createElement(ChatHeader, {
      settings: { theme: "light" }, sidebarOpen: true,
      onOpenSidebar: () => toggles++, onOpenSettings() {}, onToggleTheme() {},
      windowControls: React.createElement(WindowsTitleBar, { controlsOnly: true }),
    })));
    assert.equal(host.querySelectorAll("header").length, 1);
    const controls = host.querySelector("[data-windows-window-controls]");
    assert.equal(controls.parentElement.tagName, "HEADER");
    assert.equal(controls.getAttribute("data-tauri-drag-region"), "false");
    assert.ok(host.querySelector("header > div.flex-1[data-tauri-drag-region]"));
    const buttons = controls.querySelectorAll("button");
    await act(async () => buttons[0].click());
    const oldLabel = buttons[1].getAttribute("aria-label");
    await act(async () => buttons[1].click());
    assert.notEqual(buttons[1].getAttribute("aria-label"), oldLabel);
    await act(async () => buttons[2].click());
    assert.deepEqual(calls.slice(0, 3), ["minimize", "maximize", "close"]);
    await act(async () => host.querySelector('button[aria-expanded]').click());
    assert.equal(toggles, 1);
  } finally { await act(async () => root.unmount()); host.remove(); }
  assert.ok(calls.includes("unlisten-resize"));
  assert.ok(calls.includes("unlisten-focus"));
});

test("Windows boot and error fallback retain window controls; non-Windows renders none", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const oldError = console.error;
  try {
    await act(async () => root.render(React.createElement(AppBootShell, { loadingLabel: "Loading" })));
    assert.equal(host.querySelectorAll("[data-windows-window-controls]").length, 1);
    function Broken() { throw new Error("test failure"); }
    console.error = () => {};
    await act(async () => root.render(React.createElement(AppErrorBoundary, {
      fallbackHeader: React.createElement(WindowsTitleBar),
    }, React.createElement(Broken))));
    assert.equal(host.querySelectorAll("[data-windows-window-controls]").length, 1);
    assert.ok(host.textContent.includes("test failure"));
    delete window.__TAURI_INTERNALS__;
    await act(async () => root.render(React.createElement(WindowsTitleBar, { controlsOnly: true })));
    assert.equal(host.querySelector("[data-windows-window-controls]"), null);
  } finally {
    console.error = oldError;
    await act(async () => root.unmount()); host.remove();
  }
});
