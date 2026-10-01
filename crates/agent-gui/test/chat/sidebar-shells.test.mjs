import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
const env = await createDomTestEnv({ mocks: {
  "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
  "../IconSet": new Proxy({}, { get: () => () => null }),
} });
const { React, act, createRoot } = env;
window.ResizeObserver = globalThis.ResizeObserver;
let mobile = false;
const mediaListeners = new Set();
window.matchMedia = () => ({ get matches() { return mobile; }, media: "", addEventListener: (_, listener) => mediaListeners.add(listener), removeEventListener: (_, listener) => mediaListeners.delete(listener) });
const { Sidebar, SidebarProvider, SidebarTrigger, useSidebar } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");

function mount() {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  let setOpen;
  function Content() {
    const sidebar = useSidebar();
    setOpen = sidebar.isMobile ? sidebar.setOpenMobile : sidebar.setOpen;
    return React.createElement(React.Fragment, null,
      React.createElement(SidebarTrigger, { id: "open-navigation" }),
      React.createElement(Sidebar, { label: "Navigation" }, React.createElement("button", { id: "inside-navigation" }, "Conversation")));
  }
  function Harness() { return React.createElement(SidebarProvider, { defaultOpen: false }, React.createElement(Content)); }
  return { container, root, Harness, setOpen: value => setOpen(value), destroy: async () => { await act(async () => root.unmount()); container.remove(); } };
}
test("desktop sidebar keeps content identity and makes collapsed controls inert", async () => {
  mobile = false;
  const h = mount();
  try {
    await act(async () => h.root.render(React.createElement(h.Harness)));
    const content = document.getElementById("inside-navigation");
    assert.equal(h.container.querySelector("[data-slot=sidebar-container]").getAttribute("aria-hidden"), "true");
    assert.ok(h.container.querySelector("[data-slot=sidebar-container]").hasAttribute("inert"));
    await act(async () => h.setOpen(true));
    assert.equal(h.container.querySelector("[data-slot=sidebar]").dataset.state, "expanded");
    assert.equal(document.getElementById("inside-navigation"), content);
    assert.equal(h.container.querySelector("[data-slot=sidebar-container]").hasAttribute("inert"), false);
    await act(async () => h.setOpen(false));
    assert.equal(document.getElementById("inside-navigation"), content);
    assert.ok(h.container.querySelector("[data-slot=sidebar-container]").hasAttribute("inert"));
  } finally { await h.destroy(); }
});
test("mobile sidebar uses a real Sheet dialog with a label and Escape dismissal", async () => {
  mobile = true;
  const h = mount();
  try {
    await act(async () => h.root.render(React.createElement(h.Harness)));
    const opener = document.getElementById("open-navigation");
    opener.focus();
    await act(async () => opener.click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(document.getElementById(dialog.getAttribute("aria-labelledby")).textContent, "Navigation");
    assert.ok(dialog.contains(document.getElementById("inside-navigation")));
    await act(async () => { dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.activeElement, opener);
  } finally { await h.destroy(); mobile = false; }
});

// react-resizable-panels measures panels; jsdom returns 0 for everything, so
// fake a 1000px group with a 1px separator.
function installPanelLayoutMocks() {
  const oldRect = HTMLElement.prototype.getBoundingClientRect;
  const widthDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
  const leftDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetLeft");
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() {
    if (this.hasAttribute("data-panel")) {
      const grow = Number.parseFloat(this.style.flexGrow);
      const panels = [...this.parentElement.querySelectorAll(":scope > [data-panel]")];
      const total = panels.reduce((sum, panel) => sum + (Number.parseFloat(panel.style.flexGrow) || 0), 0);
      return Number.isFinite(grow) && total > 1 ? grow / total * 999 : (this.id === "workspace-tools" ? 400 : 599);
    }
    return this.hasAttribute("data-separator") ? 1 : 1000;
  } });
  Object.defineProperty(HTMLElement.prototype, "offsetLeft", { configurable: true, get() { return this.id === "workspace-tools" ? 601 : this.hasAttribute("data-separator") ? 600 : 0; } });
  HTMLElement.prototype.getBoundingClientRect = function () { return { x: 0, y: 0, left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON() {} }; };
  return () => { HTMLElement.prototype.getBoundingClientRect = oldRect; Object.defineProperty(HTMLElement.prototype, "offsetWidth", widthDescriptor); Object.defineProperty(HTMLElement.prototype, "offsetLeft", leftDescriptor); };
}

test("standard resizable panels restore width, preserve main content, and save keyboard resizing", async () => {
  mobile = false;
  const restoreLayout = installPanelLayoutMocks();
  const { WorkspacePanelGroup, WorkspaceMainPanel, WorkspaceToolsPanel } = env.loadModule("@liveagent/ui/components/project-tools/WorkspacePanels.tsx");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const widths = [];
  const { ProjectToolsPanelToggle } = env.loadModule("@liveagent/ui/components/project-tools/ProjectToolsPanelToggle.tsx");
  let setOpen;
  function Harness() {
    const [open, updateOpen] = React.useState(false); setOpen = updateOpen;
    return React.createElement(React.Fragment, null,
      React.createElement("header", null, React.createElement(ProjectToolsPanelToggle, {isOpen: open, sessionCount: 0, onToggle: () => updateOpen(value => !value)})),
      React.createElement(WorkspacePanelGroup, { open, width: 400, onClose: () => updateOpen(false), onWidthChange: width => widths.push(width) },
      React.createElement(WorkspaceMainPanel, null, React.createElement("input", { id: "main-draft", defaultValue: "draft" })),
      React.createElement(WorkspaceToolsPanel, null, React.createElement("div", { id: "tools-content" }, "Tools"))));
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    const draft = document.getElementById("main-draft");
    const tools = container.querySelector('#workspace-tools');
    assert.ok(tools);
    assert.equal(tools.getAttribute("aria-hidden"), "true");
    await act(async () => container.querySelector("header button").click());
    assert.equal(container.querySelector("header button").getAttribute("aria-expanded"), "true");
    assert.equal(tools.getAttribute("aria-hidden"), "false");
    assert.ok(Number(tools.style.flexGrow) > 0, "opening a panel mounted collapsed allocates width");
    await act(async () => setOpen(false));
    assert.equal(tools.getAttribute("aria-hidden"), "true");
    assert.ok(tools.hasAttribute("inert"));
    await act(async () => setOpen(true));
    assert.ok(Number(tools.style.flexGrow) > 0, "reopening restores panel width");
    assert.equal(document.getElementById("main-draft"), draft);
    assert.equal(draft.value, "draft");
    const separator = container.querySelector('[role="separator"]');
    assert.ok(separator);
    await act(async () => separator.focus());
    await act(async () => separator.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })));
    assert.ok(widths.length > 0, "keyboard resizing saves the new width");
    assert.ok(widths.at(-1) > 400);
    await act(async () => { mobile = true; mediaListeners.forEach(listener => listener()); });
    assert.equal(document.querySelectorAll("#tools-content").length, 1);
    assert.ok(document.querySelector('[role="dialog"]')?.contains(document.getElementById("tools-content")));
    assert.equal(document.getElementById("main-draft"), draft);
    await act(async () => { mobile = false; mediaListeners.forEach(listener => listener()); });
    assert.equal(document.querySelectorAll("#tools-content").length, 1);
    assert.equal(document.getElementById("main-draft"), draft);
  } finally { await act(async () => root.unmount()); container.remove(); restoreLayout(); }
});

test("tools panel content follows the panel width once the open animation settles", async () => {
  mobile = false;
  const restoreLayout = installPanelLayoutMocks();
  const { WorkspacePanelGroup, WorkspaceMainPanel, WorkspaceToolsPanel } = env.loadModule("@liveagent/ui/components/project-tools/WorkspacePanels.tsx");
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const content = () => document.getElementById("tools-content").parentElement;
  try {
    await act(async () => root.render(React.createElement(WorkspacePanelGroup, { open: true, width: 400, onClose: () => {}, onWidthChange: () => {} },
      React.createElement(WorkspaceMainPanel, null, "Main"),
      React.createElement(WorkspaceToolsPanel, null, React.createElement("div", { id: "tools-content" }, "Tools")))));
    // While the flex-grow transition runs the content keeps its saved pixel width (slide-in).
    assert.equal(content().style.width, "400px");
    // Afterwards it must track the real panel width, otherwise a narrower group
    // (left sidebar expanded) leaves it overflowing and clipped on the left.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 300)); });
    assert.equal(content().style.width, "100%");
    // Immediate mode never waits.
    await act(async () => root.render(React.createElement(WorkspacePanelGroup, { open: true, width: 400, immediate: true, onClose: () => {}, onWidthChange: () => {} },
      React.createElement(WorkspaceMainPanel, null, "Main"),
      React.createElement(WorkspaceToolsPanel, null, React.createElement("div", { id: "tools-content" }, "Tools")))));
    assert.equal(content().style.width, "100%");
  } finally { await act(async () => root.unmount()); container.remove(); restoreLayout(); }
});

test("desktop preference survives mobile dismissal and shortcut ignores text editing", async () => {
  mobile = false;
  const h = mount();
  try {
    await act(async () => h.root.render(React.createElement(h.Harness)));
    await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })));
    assert.equal(h.container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
    assert.ok(document.cookie.includes("sidebar_state=true"));
    const input = document.createElement("textarea"); h.container.appendChild(input);
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })));
    assert.equal(h.container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
    input.remove();
    await act(async () => { mobile = true; mediaListeners.forEach(listener => listener()); });
    assert.equal(document.querySelector('[role="dialog"]'), null, "mobile starts closed despite desktop being expanded");
    await act(async () => document.getElementById("open-navigation").click());
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(document.querySelector('[role="dialog"]'), null);
    await act(async () => { mobile = false; mediaListeners.forEach(listener => listener()); });
    assert.equal(h.container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
  } finally { mobile = false; await h.destroy(); }
});

test("controlled provider and standard trigger share one state owner", async () => {
  mobile = false;
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  const changes = [];
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return React.createElement(SidebarProvider, { open, onOpenChange: next => { changes.push(next); setOpen(next); } },
      React.createElement(SidebarTrigger, { id: "controlled-trigger" }),
      React.createElement(Sidebar, { label: "Controlled", collapsible: "icon", variant: "inset" }, "Contents"));
  }
  try {
    await act(async () => root.render(React.createElement(Harness)));
    assert.equal(container.querySelector('[data-slot="sidebar"]').dataset.collapsible, "icon");
    await act(async () => document.getElementById("controlled-trigger").click());
    assert.deepEqual(changes, [true]);
    assert.equal(container.querySelector('[data-slot="sidebar"]').dataset.state, "expanded");
    await act(async () => document.getElementById("controlled-trigger").click());
    assert.deepEqual(changes, [true, false]);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("five sidebar toggles do not update 200 memoized plain menu rows or replace action callbacks", async () => {
  mobile = false;
  const { SidebarMenuButton } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
  let toggle;
  const setters = new Set(), toggles = new Set();
  let rowUpdates = 0;
  function Controller() {
    const sidebar = useSidebar(); toggle = sidebar.toggleSidebar;
    setters.add(sidebar.setOpen); toggles.add(sidebar.toggleSidebar);
    return null;
  }
  const Row = React.memo(function Row() {
    return React.createElement(React.Profiler, { id: "row", onRender: (_id, phase) => { if (phase !== "mount") rowUpdates++; } },
      React.createElement(SidebarMenuButton, null, "Conversation"));
  });
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(SidebarProvider, null,
      React.createElement(Controller), ...Array.from({ length: 200 }, (_, i) => React.createElement(Row, { key: i })))));
    for (let i = 0; i < 5; i++) await act(async () => toggle());
    assert.equal(rowUpdates, 0);
    assert.equal(setters.size, 1);
    assert.equal(toggles.size, 1);
    // Functional updates compose correctly even before React commits.
    await act(async () => { toggle(); toggle(); });
    assert.equal(document.cookie.includes("sidebar_state=false"), true);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
