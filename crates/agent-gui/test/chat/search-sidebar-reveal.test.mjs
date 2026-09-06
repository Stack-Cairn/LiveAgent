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
  "Cable",
  "Check",
  "ChevronRight",
  "CirclePlus",
  "Folder",
  "FolderClosed",
  "FolderOpen",
  "ListChecks",
  "Loader2",
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
    "@liveagent/ui/components/ui/button": {
      Button: ({ children, onClick, ...props }) =>
        React.createElement(
          "button",
          { onClick, "aria-expanded": props["aria-expanded"], "data-testid": props["data-testid"] },
          children,
        ),
    },
    "@liveagent/ui/components/ui/confirm-dialog": {
      useConfirmDialog: () => ({ requestConfirmDialog: async () => false }),
    },
    "@liveagent/ui/components/ui/dropdown-menu": Object.fromEntries(
      ["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuTrigger"].map(
        (name) => [name, ({ children }) => React.createElement("div", null, children)],
      ),
    ),
    "@liveagent/ui/components/ui/input": { Input: (props) => React.createElement("input", props) },
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: (key) => key, locale: "en" }) },
    "@tanstack/react-virtual": { useVirtualizer: () => virtualizer },
    "./ChatHistorySidebarRows": {
      HistoryRow: () => null,
      ProjectRow: () => null,
      ProjectGroupHeader: () => null,
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
const { ChatHistorySidebar } = env.loadModule(
  "@liveagent/ui/components/chat/ChatHistorySidebar.tsx",
);
const items = Array.from({ length: 100 }, (_, index) => ({
  id: String(index),
  title: String(index),
  cwd: "/repo/b",
  createdAt: 1,
  updatedAt: index,
  providerId: "p",
  model: "m",
}));

test("search completion reveals a collapsed virtual list once without saving sidebar preferences", async () => {
  const container = document.createElement("div"),
    root = createRoot(container);
  let props = {
    items,
    currentConversationId: "a",
    busyConversationIds: new Map(),
    runningConversationIds: new Set(),
    listStatus: "ready",
    scopeKey: "cwd:/repo/a",
    totalItems: 100,
    hasMore: false,
    isLoadingMore: false,
    isOpen: true,
    recentCollapsed: true,
    canShareConversations: false,
    renamingId: null,
    renameDraft: "",
    activeProjectId: "a",
    onRecentCollapsedChange: () => assert.fail("search saved sidebar preferences"),
  };
  let completion;
  props.onSelectConversation = (_id, options) => {
    completion = options.afterCommit;
  };
  try {
    await act(async () => root.render(React.createElement(ChatHistorySidebar, props)));
    await act(async () => dialogProps.onSelectConversation("99", { source: "search" }));
    assert.equal(scrolls.length, 0);
    props = { ...props, currentConversationId: "99", scopeKey: "cwd:/repo/b", items: [items[99]], listStatus: "syncing" };
    await act(async () => {
      root.render(React.createElement(ChatHistorySidebar, props));
      completion();
    });
    assert.deepEqual(scrolls, [], "wait for the target position after the first page arrives");
    props = { ...props, items, listStatus: "ready" };
    await act(async () => root.render(React.createElement(ChatHistorySidebar, props)));
    assert.deepEqual(scrolls, [99]);
    const list = container.querySelector(".chat-history-list");
    assert.equal(list.parentElement.getAttribute("aria-hidden"), "false");
    props = { ...props, items: [...items] };
    await act(async () => root.render(React.createElement(ChatHistorySidebar, props)));
    assert.deepEqual(
      scrolls,
      [99],
      "background list refresh must not pull the user back to the row",
    );
  } finally {
    await act(async () => root.unmount());
  }
});
