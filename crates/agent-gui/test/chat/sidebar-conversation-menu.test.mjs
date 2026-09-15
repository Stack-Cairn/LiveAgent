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
const { HistoryRow } = env.loadModule("@liveagent/ui/components/chat/ChatHistorySidebarRows.tsx");

function mountRow(overrides = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const calls = { selected: [], moved: [], deleted: [] };
  function Harness() {
    const [menuOpen, setMenuOpen] = React.useState(false);
    const [pendingDelete, setPendingDelete] = React.useState(null);
    return React.createElement(HistoryRow, {
      item: { id: "one", title: "Conversation", cwd: "/repo/a", createdAt: 1, updatedAt: 1 },
      isActive: false, isBusy: false, isRunning: false, isDeleteDisabled: false,
      isSelectionMode: false, isInteractionDisabled: false, isMobileMenuLayout: false,
      isPendingDelete: pendingDelete === "one", menuOpen, menuSide: "right",
      onMenuOpenChange: (_id, open) => setMenuOpen(open),
      onSetPendingDelete: setPendingDelete,
      onSelectConversation: (id) => calls.selected.push(id),
      onMoveToWorkspace: (id, cwd) => calls.moved.push([id, cwd]),
      onDeleteConversation: (id) => calls.deleted.push(id),
      onSetPinned() {},
      moveWorkspaces: [{ id: "a", path: "/repo/a" }, { id: "b", path: "/repo/b" }],
      ...overrides,
    });
  }
  act(() => root.render(React.createElement(Harness)));
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
    assert.equal(menuItem("/repo/a").getAttribute("aria-disabled"), "true");
    await click(menuItem("/repo/b"));
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
