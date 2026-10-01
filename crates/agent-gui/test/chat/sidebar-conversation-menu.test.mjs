import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Keep the real menu and button components: a menu body alone does not prove
// users have a working trigger to reach its actions.
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key }) },
    "@liveagent/app/lib/settings": {
      DEFAULT_WORKSPACE_PROJECT_ID: "default",
      workspaceProjectPathKey: (path) => path,
    },
  },
});
const { React, act, createRoot } = env;
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const { SidebarProvider } = env.loadModule("@liveagent/ui/components/ui/sidebar.tsx");
const { HistoryRow } = env.loadModule("@liveagent/ui/components/chat/ChatHistorySidebarRows.tsx");

function mountRow(overrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = { selected: [], moved: [], deleted: [], renamed: [] };
  function Harness() {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [isSelectionMode, setSelectionMode] = React.useState(false);
    calls.exitSelection = () => setSelectionMode(false);
    const [pendingDelete, setPendingDelete] = React.useState(null);
    const [isRenaming, setRenaming] = React.useState(false);
    const [renameDraft, setRenameDraft] = React.useState("");
    calls.setDraft = setRenameDraft;
    return React.createElement(HistoryRow, {
      item: { id: "one", title: "Conversation", cwd: "/repo/a", createdAt: 1, updatedAt: 1 },
      isActive: false, isBusy: false, isRunning: false, isDeleteDisabled: false,
      isSelectionMode, isInteractionDisabled: false, isMobileMenuLayout: false,
      isPendingDelete: pendingDelete === "one", menuOpen, menuSide: "right",
      onMenuOpenChange: (_id, open) => setMenuOpen(open),
      onSetPendingDelete: setPendingDelete,
      onSelectConversation: (id) => calls.selected.push(id),
      onMoveToWorkspace: (id, cwd) => calls.moved.push([id, cwd]),
      onDeleteConversation: (id) => calls.deleted.push(id),
      isRenaming, renameDraft,
      onStartRenaming(item) { setRenameDraft(item.title); setRenaming(true); },
      onRenameDraftChange: setRenameDraft,
      onCommitRename() { calls.renamed.push(renameDraft.trim()); setRenaming(false); },
      onCancelRename() { setRenaming(false); },
      onSetPinned() {},
      onEnterSelectionMode() { setMenuOpen(false); setSelectionMode(true); },
      moveWorkspaces: [{ id: "a", name: "Alpha", path: "/repo/a" }, { id: "b", name: "Beta", path: "/repo/b" }],
      ...overrides,
    });
  }
  act(() => root.render(React.createElement(SidebarProvider, null, React.createElement(Harness))));
  return {
    container, calls,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function click(element) {
  assert.ok(element, "the action must be reachable");
  await act(async () => element.click());
}

function menuItem(label) {
  return [...document.querySelectorAll('[role="menuitem"]')]
    .find((element) => element.textContent === label);
}

test("desktop more menu reaches workspace transfer and confirmed deletion", async () => {
  const row = mountRow();
  try {
    assert.ok(row.container.querySelector('[aria-label="chat.conversationPin"]'));
    assert.equal(row.container.querySelector('[aria-label="chat.conversationArchive"]'), null);
    const more = () => row.container.querySelector('[aria-label="chat.conversationMore"]');
    await click(more());
    assert.equal(more().getAttribute("aria-expanded"), "true");
    assert.ok(menuItem("chat.conversationDelete"));
    await click(menuItem("chat.conversationMoveToWorkspace"));
    assert.equal(menuItem("Alpha(/repo/a)").getAttribute("aria-disabled"), "true");
    await click(menuItem("Beta(/repo/b)"));
    assert.deepEqual(row.calls.moved, [["one", "/repo/b"]]);
    assert.deepEqual(row.calls.selected, []);

    await click(more());
    await click(menuItem("chat.conversationDelete"));
    assert.deepEqual(row.calls.deleted, [], "opening confirmation must not delete history");
    await click([...row.container.querySelectorAll("button")]
      .find((element) => element.textContent === "chat.delete"));
    assert.deepEqual(row.calls.deleted, ["one"]);
  } finally {
    await row.cleanup();
  }
});

test("running conversation keeps the menu reachable and mutation restrictions intact", async () => {
  const row = mountRow({ isRunning: true, isDeleteDisabled: true });
  try {
    await click(row.container.querySelector('[aria-label="chat.conversationMore"]'));
    assert.equal(menuItem("chat.conversationMoveToWorkspace").getAttribute("aria-disabled"), "true");
    assert.equal(menuItem("chat.conversationDelete").getAttribute("aria-disabled"), "true");
    assert.deepEqual(row.calls.moved, []);
    assert.deepEqual(row.calls.deleted, []);
  } finally {
    await row.cleanup();
  }
});


test("leaving bulk selection does not resurrect a closed menu", async () => {
  const row = mountRow();
  try {
    const more = () => row.container.querySelector('[aria-label="chat.conversationMore"]');
    await click(more());
    await click(menuItem("chat.conversationBulkSelect"));
    await act(async () => row.calls.exitSelection());
    assert.equal(document.querySelector('[role="menu"]'), null);
    await click(more());
    assert.equal(more().getAttribute("aria-expanded"), "true");
    await click(menuItem("chat.conversationMoveToWorkspace"));
    await click(menuItem("Beta(/repo/b)"));
    assert.deepEqual(row.calls.moved, [["one", "/repo/b"]]);
  } finally {
    await row.cleanup();
  }
});

async function openContext(row) {
  const title = row.container.querySelector('button[title="Conversation"]');
  await act(async () => title.dispatchEvent(new window.MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2, clientX: 100, clientY: 120,
  })));
}

test("double-click opens a rename dialog, and blur does not save", async () => {
  const row = mountRow();
  try {
    const title = row.container.querySelector('button[title="Conversation"]');
    await act(async () => title.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })));
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    const input = dialog.querySelector("input");
    assert.equal(input.value, "Conversation");
    assert.ok(document.activeElement === input, "rename input receives initial focus");
    assert.equal(input.selectionStart, 0);
    assert.equal(input.selectionEnd, "Conversation".length);
    await act(async () => row.calls.setDraft("New name"));
    act(() => input.blur());
    assert.deepEqual(row.calls.renamed, []);
    await click(dialog.querySelector('button[type="submit"]'));
    assert.deepEqual(row.calls.renamed, ["New name"]);
    assert.ok(!document.querySelector('[role="dialog"]'), "rename dialog closes");
  } finally { await row.cleanup(); }
});

test("right-click opens shared actions without selecting the chat; rename can be cancelled", async () => {
  const row = mountRow();
  try {
    await openContext(row);
    assert.ok(menuItem("chat.conversationMoveToWorkspace"));
    assert.deepEqual(row.calls.selected, []);
    await click(menuItem("chat.conversationRename"));
    const dialog = document.querySelector('[role="dialog"]');
    assert.ok(dialog);
    assert.equal(document.querySelector('[role="menu"]'), null);
    await act(async () => row.calls.setDraft("   "));
    assert.equal(dialog.querySelector('button[type="submit"]').disabled, true);
    await click([...dialog.querySelectorAll("button")].find(el => el.textContent === "chat.cancel"));
    assert.deepEqual(row.calls.renamed, []);
    await openContext(row);
    await click(menuItem("chat.conversationBulkSelect"));
    await act(async () => row.calls.exitSelection());
    assert.equal(document.querySelector('[role="menu"]'), null);
    await openContext(row);
    assert.ok(menuItem("chat.conversationRename"));
  } finally { await row.cleanup(); }
});

test("keyboard context menu, Escape cancellation, and Enter submission remain accessible", async () => {
  const row = mountRow();
  try {
    const title = row.container.querySelector('button[title="Conversation"]');
    await act(async () => title.dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "F10", shiftKey: true, bubbles: true, cancelable: true,
    })));
    assert.ok(menuItem("chat.conversationRename"));
    await click(menuItem("chat.conversationRename"));
    let dialog = document.querySelector('[role="dialog"]');
    await act(async () => dialog.querySelector("input").dispatchEvent(new window.KeyboardEvent("keydown", {
      key: "Escape", bubbles: true, cancelable: true,
    })));
    assert.ok(!document.querySelector('[role="dialog"]'));
    assert.deepEqual(row.calls.renamed, []);
    await act(async () => title.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true })));
    await act(async () => row.calls.setDraft("Updated"));
    dialog = document.querySelector('[role="dialog"]');
    // jsdom does not synthesize Enter's native form submission.
    await act(async () => dialog.querySelector("form").dispatchEvent(new window.Event("submit", {
      bubbles: true, cancelable: true,
    })));
    assert.deepEqual(row.calls.renamed, ["Updated"]);
  } finally { await row.cleanup(); }
});
