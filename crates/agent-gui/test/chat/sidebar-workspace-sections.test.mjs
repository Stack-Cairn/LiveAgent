import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import React from "react";

let dialogProps;
const scrolls = [];
const virtualizer = {
  getVirtualItems: () => [],
  getTotalSize: () => 3200,
  scrollToIndex: (index) => scrolls.push(index),
  measureElement() {},
};
const icons = [
  "AlertCircle",
  "Blend",
  "Brain",
  "Cable",
  "Check",
  "ChevronRight",
  "CirclePlus",
  "Clock3",
  "Folder",
  "FolderClosed",
  "FolderOpen",
  "ListChecks",
  "Loader2",
  "MessageSquare",
  "PanelLeftClose",
  "Plus",
  "Search",
  "Settings",
  "Share2",
  "Trash2",
  "X",
];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": Object.fromEntries(icons.map((name) => [name, () => null])),
    "@liveagent/ui/components/ui/confirm-dialog": {
      useConfirmDialog: () => ({ requestConfirmDialog: async () => false }),
    },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
    "@tanstack/react-virtual": { useVirtualizer: () => virtualizer },
    "./ChatHistorySidebarRows": {
      HistoryRow: (props) => React.createElement("div", { "data-conversation-id": props.item.id },
        React.createElement("button", { onClick: () => props.isSelectionMode && props.onSelectForBulk(props.item.id, { shiftKey: false, toggleKey: false }) }, props.item.title),
        props.isSelectionMode && React.createElement("input", { type: "checkbox", checked: props.isSelected, readOnly: true })),
      ProjectRow: ({ project, expanded, onToggleExpanded, onSelectProject }) => React.createElement("button", {
        "data-project-id": project.id, "aria-expanded": expanded,
        onClick: () => { onToggleExpanded?.(project); onSelectProject(project); },
      }, project.name),
      ProjectGroupHeader: ({ group, memberCount }) => React.createElement("div", { "data-group-id": group.id }, `${group.name} (${memberCount})`),
    },
    "./ConversationSearchDialog": {
      ConversationSearchDialog: (props) => {
        dialogProps = props;
        return null;
      },
    },
  },
});
const { act, createRoot } = env;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
HTMLElement.prototype.scrollTo = () => {};
HTMLElement.prototype.scrollIntoView = function () { scrolls.push(this.dataset.conversationId); };
const { ChatHistorySidebar: SidebarContentUnderTest } = env.loadModule(
  "@liveagent/ui/components/chat/ChatHistorySidebar.tsx",
);
const { SidebarProvider } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
function ChatHistorySidebar(props) { return React.createElement(SidebarProvider, { open: props.isOpen }, React.createElement(SidebarContentUnderTest, props)); }

const items = Array.from({ length: 100 }, (_, index) => ({
  id: String(index),
  title: String(index),
  cwd: "/repo/b",
  createdAt: 1,
  updatedAt: index,
  providerId: "p",
  model: "m",
}));


const baseProps = {
  items: [{ ...items[0], id: "pinned", title: "Pinned conversation", isPinned: true }, ...items],
  currentConversationId: "0", busyConversationIds: new Map(), runningConversationIds: new Set(),
  runningProjectPathKeys: new Set(), missingProjectPathKeys: new Set(), listStatus: "ready", scopeKey: "cwd:/repo/b",
  hasMore: false, isLoadingMore: false, isOpen: true, showProjects: true, canShareConversations: true,
  sharedConversationCount: 1, renamingId: null, renameDraft: "", activeProjectId: "b",
  projects: [{ id: "a", name: "Pinned workspace", path: "/repo/a", isPinned: true }, { id: "b", name: "Workspace B", path: "/repo/b" }],
  workspaceHistory: new Map([["/repo/b", { limit: 10, loaded: true }]]),
  onCancelRename() {},
  onRecentCollapsedChange() { assert.fail("workspace bulk selection must not save recent-list preferences"); },
};
const click = async (element) => {
  assert.ok(element, "click target exists");
  await act(async () => element.click());
};

test("bulk selection toggles off using the same button, clears selection and keeps share visible", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(ChatHistorySidebar, baseProps)));
    const toggle = () => container.querySelector('[aria-label="chat.conversationBulkSelect"]');
    await click(toggle());
    assert.equal(toggle().getAttribute("aria-pressed"), "true");
    await click(container.querySelector('[data-conversation-id="0"] button'));
    assert.equal(container.querySelectorAll('input:checked').length, 1);
    assert.ok(container.querySelector('[aria-label="chat.manageSharedConversations"]'));
    await click(toggle());
    assert.equal(toggle().getAttribute("aria-pressed"), "false");
    assert.equal(container.querySelectorAll('input[type="checkbox"]').length, 0);
    await click(toggle());
    assert.equal(container.querySelectorAll('input:checked').length, 0);
    await act(async () => root.render(React.createElement(ChatHistorySidebar, { ...baseProps, items: [] })));
    assert.equal(toggle().disabled, false, "can still exit when the last selectable row disappears");
    await click(toggle());
    assert.equal(toggle().getAttribute("aria-pressed"), "false");
  } finally { await act(async () => root.unmount()); }
});

test("pinned and workspace sections collapse independently and only workspace accepts folder drops", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  let props = { ...baseProps };
  const render = () => root.render(React.createElement(ChatHistorySidebar, props));
  props.onProjectsCollapsedChange = (collapsed) => { props = { ...props, projectsCollapsed: collapsed }; render(); };
  try {
    await act(async () => render());
    const pinned = container.querySelector('[data-slot="sidebar-group"][aria-label="chat.pinnedSection"]');
    const workspace = container.querySelector('[data-slot="sidebar-group"][aria-label="chat.workspaceSection"]');
    assert.equal(pinned.parentElement, workspace.parentElement);
    assert.equal(pinned.closest('[data-workspace-folder-drop-zone]'), null);
    assert.equal(workspace.hasAttribute('data-workspace-folder-drop-zone'), true);
    assert.equal(pinned.querySelectorAll('[data-conversation-id="pinned"]').length, 1);
    assert.equal(workspace.querySelectorAll('[data-conversation-id="pinned"]').length, 0);
    await click(workspace.querySelector('button[aria-expanded]'));
    assert.equal(workspace.querySelector('button[aria-expanded]').getAttribute('aria-expanded'), 'false');
    assert.ok(pinned.querySelector('[data-conversation-id="pinned"]'));
    const toggle = workspace.querySelector('[aria-label="chat.conversationBulkSelect"]');
    assert.equal(toggle.disabled, false, "pinned conversations stay selectable when workspaces collapse");
    await click(pinned.querySelector('button[aria-expanded]'));
    assert.equal(pinned.querySelector('[data-conversation-id="pinned"]'), null);
    await click(workspace.querySelector('button[aria-expanded]'));
    assert.equal(pinned.querySelector('button[aria-expanded]').getAttribute('aria-expanded'), 'false');
  } finally { await act(async () => root.unmount()); }
});

test("search reveals a result beyond the first workspace page and scrolls once", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  scrolls.length = 0;
  let completion;
  let props = { ...baseProps, projectsCollapsed: true, onSelectConversation: (_id, options) => { completion = options.afterCommit; } };
  try {
    await act(async () => root.render(React.createElement(ChatHistorySidebar, props)));
    await act(async () => dialogProps.onSelectConversation("99", { source: "search" }));
    props = { ...props, currentConversationId: "99" };
    await act(async () => { root.render(React.createElement(ChatHistorySidebar, props)); completion(); });
    assert.ok(container.querySelector('[data-conversation-id="99"]'));
    assert.deepEqual(scrolls, ["99"]);
    assert.equal(container.querySelectorAll('[data-testid="workspace-conversations-b"] [data-conversation-id]').length, 11);
    await act(async () => root.render(React.createElement(ChatHistorySidebar, { ...props, items: [...props.items] })));
    assert.deepEqual(scrolls, ["99"]);
  } finally { await act(async () => root.unmount()); }
});


test("search reveals a workspace hidden beyond the collapsed workspace limit", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  scrolls.length = 0;
  let completion;
  let props = {
    ...baseProps,
    activeProjectId: "other-0",
    projects: [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `other-${index}`, name: `Workspace ${index}`, path: `/repo/other-${index}`,
      })),
      baseProps.projects[1],
    ],
    onSelectConversation: (_id, options) => { completion = options.afterCommit; },
  };
  try {
    await act(async () => root.render(React.createElement(ChatHistorySidebar, props)));
    assert.equal(container.querySelector('[data-project-id="b"]'), null);
    await act(async () => dialogProps.onSelectConversation("99", { source: "search" }));
    props = { ...props, currentConversationId: "99", activeProjectId: "b" };
    await act(async () => { root.render(React.createElement(ChatHistorySidebar, props)); completion(); });
    assert.ok(container.querySelector('[data-project-id="b"]'));
    assert.ok(container.querySelector('[data-conversation-id="99"]'));
    assert.deepEqual(scrolls, ["99"]);
  } finally { await act(async () => root.unmount()); }
});



test("an expanded inactive workspace collapses on the first click even when it becomes active", async () => {
  const container = document.createElement("div"), root = createRoot(container);
  let props = { ...baseProps };
  const render = () => root.render(React.createElement(ChatHistorySidebar, props));
  props.onSelectProject = (project) => { props = { ...props, activeProjectId: project.id }; render(); };
  const row = (id) => container.querySelector(`[data-project-id="${id}"]`);
  try {
    await act(async () => render());
    assert.equal(row("b").getAttribute("aria-expanded"), "true");
    await click(row("a"));
    assert.equal(props.activeProjectId, "a");
    assert.equal(row("a").getAttribute("aria-expanded"), "true");
    // B is still expanded, but no longer active. Its click must close it.
    await click(row("b"));
    assert.equal(props.activeProjectId, "b");
    assert.equal(row("b").getAttribute("aria-expanded"), "false");
    assert.equal(container.querySelector('[data-testid="workspace-conversations-b"]'), null);
    await click(row("b"));
    assert.equal(row("b").getAttribute("aria-expanded"), "true");
    // Pinned workspaces use the same click behavior.
    await click(row("a"));
    assert.equal(row("a").getAttribute("aria-expanded"), "false");
    // Navigation from outside the tree can still reveal a workspace normally.
    await act(async () => { props = { ...props, activeProjectId: "b" }; render(); });
    await act(async () => { props = { ...props, activeProjectId: "a" }; render(); });
    assert.equal(row("a").getAttribute("aria-expanded"), "true");
  } finally { await act(async () => root.unmount()); }
});


// Use real Base UI menus and inputs to exercise portal closing and return focus.
function menuItem(label) {
  return [...document.querySelectorAll('[role="menuitem"]')]
    .find((element) => element.textContent === label);
}
async function mountGroupSidebar(overrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const groups = [], projects = [];
  function Harness() {
    const [collapsed, setCollapsed] = React.useState(overrides.projectsCollapsed ?? false);
    const [workspaceProjectGroups, setGroups] = React.useState(overrides.workspaceProjectGroups ?? []);
    return React.createElement(ChatHistorySidebar, {
      ...baseProps, ...overrides, projectsCollapsed: collapsed, workspaceProjectGroups,
      onProjectsCollapsedChange: setCollapsed,
      onCreateProject: () => projects.push("created"),
      onCreateWorkspaceGroup: (name) => {
        groups.push(name);
        setGroups((current) => [...current, { id: `new-${groups.length}`, name, projectPaths: [], createdAt: 1, updatedAt: 1 }]);
      },
      ...overrides.callbacks,
    });
  }
  await act(async () => root.render(React.createElement(Harness)));
  return {
    container, groups, projects,
    async start() {
      await click(container.querySelector('[aria-label="chat.workspaceAdd"]'));
      await click(menuItem("chat.workspaceGroupCreate"));
      const input = container.querySelector('[aria-label="chat.workspaceGroupNamePlaceholder"]');
      assert.ok(input, "new-group input is reachable through the plus menu");
      assert.equal(document.activeElement, input, "closing the menu must not steal draft focus");
      return input;
    },
    async cleanup() { await act(async () => root.unmount()); container.remove(); },
  };
}
async function typeName(input, value) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function key(input, key, options = {}) {
  await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options })));
}
async function pointerClick(button) {
  await act(async () => button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
  await click(button);
}

test("workspace plus retains workspace creation alongside group creation", async () => {
  const sidebar = await mountGroupSidebar();
  try {
    await click(sidebar.container.querySelector('[aria-label="chat.workspaceAdd"]'));
    assert.ok(menuItem("chat.workspaceGroupCreate"));
    await click(menuItem("chat.workspaceCreate"));
    assert.deepEqual(sidebar.projects, ["created"]);
    assert.deepEqual(sidebar.groups, []);
  } finally { await sidebar.cleanup(); }
});

test("new group expands collapsed workspaces and commits a trimmed name once on Enter", async () => {
  const sidebar = await mountGroupSidebar({ projectsCollapsed: true });
  try {
    const input = await sidebar.start();
    assert.equal(sidebar.container.querySelector('[data-slot="sidebar-group"][aria-label="chat.workspaceSection"] button[aria-expanded]').getAttribute("aria-expanded"), "true");
    await typeName(input, "  中文分组  ");
    await key(input, "Enter");
    assert.deepEqual(sidebar.groups, ["中文分组"]);
    assert.equal(sidebar.container.contains(input), false);
  } finally { await sidebar.cleanup(); }
});

test("new group supports blur and confirm, rejects blank names, and cancels by Escape or button", async () => {
  const sidebar = await mountGroupSidebar();
  try {
    let input = await sidebar.start();
    await typeName(input, "Blur group");
    await act(async () => input.blur());
    input = await sidebar.start();
    await typeName(input, "Confirm group");
    await pointerClick(sidebar.container.querySelector('[aria-label="chat.workspaceGroupCreate"]'));
    input = await sidebar.start();
    await typeName(input, "   ");
    await key(input, "Enter");
    input = await sidebar.start();
    await typeName(input, "Cancel by key");
    await key(input, "Escape");
    input = await sidebar.start();
    await typeName(input, "Cancel by button");
    await pointerClick(sidebar.container.querySelector('[aria-label="chat.cancel"]'));
    assert.deepEqual(sidebar.groups, ["Blur group", "Confirm group"]);
    assert.equal(sidebar.container.contains(input), false);
  } finally { await sidebar.cleanup(); }
});

test("Chinese IME confirmation does not prematurely create or cancel a group", async () => {
  const sidebar = await mountGroupSidebar();
  try {
    const input = await sidebar.start();
    await typeName(input, "中文");
    await key(input, "Enter", { isComposing: true });
    await key(input, "Escape", { isComposing: true });
    await key(input, "Enter", { keyCode: 229 });
    assert.deepEqual(sidebar.groups, []);
    assert.ok(sidebar.container.contains(input));
    await key(input, "Enter");
    assert.deepEqual(sidebar.groups, ["中文"]);
  } finally { await sidebar.cleanup(); }
});

test("workspace add respects disabled state and independent creation capabilities", async () => {
  for (const overrides of [
    { sectionsDisabled: true },
    { callbacks: { onCreateProject: undefined, onCreateWorkspaceGroup: undefined } },
  ]) {
    const sidebar = await mountGroupSidebar(overrides);
    try {
      assert.equal(sidebar.container.querySelector('[aria-label="chat.workspaceAdd"]').disabled, true);
    } finally { await sidebar.cleanup(); }
  }
  const sidebar = await mountGroupSidebar({ callbacks: { onCreateProject: undefined } });
  try {
    await click(sidebar.container.querySelector('[aria-label="chat.workspaceAdd"]'));
    assert.equal(menuItem("chat.workspaceCreate").getAttribute("aria-disabled"), "true");
    assert.notEqual(menuItem("chat.workspaceGroupCreate").getAttribute("aria-disabled"), "true");
  } finally { await sidebar.cleanup(); }
});


test("created empty groups remain visible in empty and truncated workspace lists", async () => {
  const manyProjects = Array.from({ length: 31 }, (_, index) => ({
    id: `project-${index}`, name: `Project ${index}`, path: `/repo/${index}`,
  }));
  for (const projects of [[], manyProjects]) {
    const sidebar = await mountGroupSidebar({
      projects,
      workspaceProjectGroups: projects.length ? [{
        id: "large", name: "Large group", projectPaths: projects.map((project) => project.path), createdAt: 1, updatedAt: 1,
      }] : [],
    });
    try {
      const input = await sidebar.start();
      await typeName(input, "New empty group");
      await key(input, "Enter");
      assert.equal(sidebar.container.querySelector('[data-group-id="new-1"]').textContent, "New empty group (0)");
    } finally { await sidebar.cleanup(); }
  }
});
