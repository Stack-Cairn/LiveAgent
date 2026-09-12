import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

test("conversation search preserves ordering, navigation, draft opening and stale request guards", async () => {
  let env;
  const pending = [];
  const Box = ({ children }) => env.React.createElement("div", null, children);
  env = await createDomTestEnv({ mocks: {
    "@liveagent/ui/components/IconSet": Object.fromEntries(["Clock3", "Loader2", "MessageSquareText", "Pin", "Search"].map(name => [name, () => null])),
    "@liveagent/ui/components/ui/dialog": Object.fromEntries(["Dialog", "DialogContent", "DialogDescription", "DialogTitle"].map(name => [name, Box])),
    "@liveagent/ui/i18n/index": { useLocale: () => ({ t: key => key, locale: "en" }) },
    "@liveagent/ui/lib/chat/conversationSearch": { searchPersistedConversations: args => new Promise((resolve, reject) => pending.push({ args, resolve, reject })) },
  }});
  const { React, act, createRoot } = env;
  HTMLElement.prototype.scrollIntoView = () => {};
  const { ConversationSearchDialog } = env.loadModule("@liveagent/ui/components/chat/ConversationSearchDialog.tsx");
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const events = [];
  const props = { open: true, currentWorkdir: "/project", conversations: [
    { id: "recent", title: "Recent", isPending: true },
    { id: "pinned", title: "Pinned", isPinned: true },
  ], onOpenChange: value => events.push(["open", value]), onSelectConversation: (...args) => events.push(["select", ...args]) };
  const render = changes => act(async () => root.render(React.createElement(ConversationSearchDialog, { ...props, ...changes })));
  const input = () => host.querySelector("input");
  const options = () => [...host.querySelectorAll('[role="option"]')];
  const key = (value, modifiers = {}) => act(async () => input().dispatchEvent(new KeyboardEvent("keydown", { key: value, ...modifiers, bubbles: true, cancelable: true })));
  const type = value => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  const debounce = () => act(async () => new Promise(resolve => setTimeout(resolve, 210)));
  try {
    await render();
    assert.deepEqual(options().map(el => el.textContent), ["Pinned", "Recent"]);
    await key("ArrowUp");
    assert.equal(options()[0].getAttribute("aria-selected"), "true");
    await key("ArrowDown"); await key("ArrowDown");
    assert.equal(options()[1].getAttribute("aria-selected"), "true");
    await key("ArrowUp", { isComposing: true });
    assert.equal(options()[0].getAttribute("aria-selected"), "true");
    await key("ArrowDown", { isComposing: true });
    await key("Home");
    assert.equal(options()[1].getAttribute("aria-selected"), "true");
    await key("ArrowUp", { metaKey: true });
    assert.equal(options()[0].getAttribute("aria-selected"), "true");
    await key("ArrowDown");
    await key("Enter");
    assert.deepEqual(events, [["open", false], ["select", "recent", undefined]]);
    events.length = 0;
    await type("first"); await debounce();
    await type("second"); await debounce();
    assert.deepEqual(pending.map(p => p.args), [{ query: "first", currentWorkdir: "/project" }, { query: "second", currentWorkdir: "/project" }]);
    await act(async () => pending[0].resolve([{ id: "stale", title: "Stale" }]));
    assert.equal(options().length, 0);
    await act(async () => pending[1].resolve([{ id: "z", title: "Z" }, { id: "a", title: "A" }]));
    assert.deepEqual(options().map(el => el.textContent), ["Z", "A"]);
    await key("Enter");
    assert.deepEqual(events, [["open", false], ["select", "z", { source: "search" }]]);
    await type("failure"); await debounce();
    await act(async () => pending[2].reject(new Error("offline")));
    const retry = [...host.querySelectorAll("button")].find(el => el.textContent === "chat.retryConversationSearch");
    assert.ok(retry);
    await act(async () => retry.click());
    assert.equal(pending.length, 4);
    await render({ open: false });
    await act(async () => pending[3].resolve([{ id: "late", title: "Late" }]));
    await render();
    assert.equal(input().value, "");
    assert.deepEqual(options().map(el => el.textContent), ["Pinned", "Recent"]);
  } finally {
    await act(async () => root.unmount()); host.remove(); env.cleanup();
  }
});
