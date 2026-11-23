import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// A write the user denied never ran: its batch header says "Denied", not
// "Edited files" with a failure count.

const EmptyIcon = () => null;
const messages = {
  "chat.tool.batch.edit": "Edited files",
  "chat.tool.batch.read": "Read files",
  "chat.tool.failed": "Failed",
  "chat.tool.denied": "Denied",
  "chat.tool.success": "Completed",
  "chat.tool.expandActivity": "Expand",
  "chat.tool.collapseActivity": "Collapse",
};
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/adapters/assistantBubble": { retainRunningToolContent: false },
    "@liveagent/ui/components/chat/LazyCollapse": {
      LazyCollapse: ({ children, open }) => (open ? children() : null),
    },
    "@liveagent/ui/i18n/index": {
      useLocale: () => ({ locale: "en-US", t: (key) => messages[key] ?? key }),
    },
    "../../IconSet": new Proxy({}, { get: () => EmptyIcon }),
    "./assistantBubbleUtils": {
      getFileOperationDisplay: () => null,
      getShellSessionDisplayDetails: () => null,
      getToolActivityCategory: (name) => (name === "Read" ? "read" : "edit"),
      getToolActivityTitleKey: (_toolCall, phase) => `chat.tool.activity.edit.${phase}`,
      getToolTraceKey: (item, index) => item.toolCall.id ?? String(index),
      hasActiveUserInteraction: () => false,
    },
    "./ToolCallItem": { MemoToolCallItem: () => null, areToolTraceItemsEqual: () => false },
  },
});
const { React, act, createRoot } = env;
const { ProcessDisclosureProvider } = env.loadModule(
  "@liveagent/ui/components/chat/processDisclosure.tsx",
);
const { ToolTraceGroup } = env.loadModule(
  "@liveagent/ui/components/chat/assistant-bubble/ToolTraceGroup.tsx",
);

const result = (text, isError = true) => ({ isError, content: [{ type: "text", text }] });
const denied = {
  toolCall: { id: "w1", name: "Write", arguments: { path: "notes/hello.txt" } },
  toolResult: result("Error: Permission denied: the user rejected this action"),
};
const read = {
  toolCall: { id: "r1", name: "Read", arguments: { path: "README.md" } },
  toolResult: result("hello", false),
};
const failed = {
  toolCall: { id: "w2", name: "Write", arguments: { path: "/etc/hosts" } },
  toolResult: result("Error: open /etc/hosts: permission denied"),
};

function header(items) {
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      React.createElement(
        ProcessDisclosureProvider,
        { expandByDefault: false, detailedProgress: false },
        React.createElement(ToolTraceGroup, { items, runningToolCallIds: [] }),
      ),
    ),
  );
  const text = container.querySelector("button").textContent;
  act(() => root.unmount());
  return text;
}

test("a batch of denied calls reads Denied, not a failed edit", () => {
  assert.equal(header([denied]), "Denied");
});

test("a denied call next to calls that ran is counted as denied, not failed", () => {
  assert.equal(header([read, denied]), "Read files1 Denied");
});

test("a real failure still reads as a failure", () => {
  assert.equal(header([failed]), "Edited files1 Failed");
});
