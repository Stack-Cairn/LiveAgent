import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { transpileTypeScriptModule } from "../../../../scripts/typescript-source-tools.mjs";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const doc = env.dom.window.document;
const { createReplyHoverStore } = env.loadModule("src/pages/chat/transcript/replyHoverStore.ts");
const { ReplyHoverProvider, useReplyHovered } = env.loadModule("src/pages/chat/transcript/rowInteraction.tsx");

test("hover updates only affected footers, preserving list and message render counts", async () => {
  const store = createReplyHoverStore();
  const renders = { list: 0, body: 0, a: 0, b: 0, c: 0 };
  function Footer({ replyKey }) {
    const hovered = useReplyHovered(replyKey);
    renders[replyKey]++;
    return React.createElement("button", { "data-reply": replyKey, "data-hovered": hovered }, replyKey);
  }
  function Body() { renders.body++; return React.createElement("p", null, "Expensive Markdown"); }
  function List() {
    renders.list++;
    return React.createElement(ReplyHoverProvider, { value: store },
      React.createElement(Body), ...["a", "b", "c"].map(replyKey => React.createElement(Footer, { key: replyKey, replyKey })));
  }
  const container = doc.createElement("div"); doc.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(List)));
    await act(async () => store.setHoveredReply("a"));
    assert.equal(container.querySelector('[data-reply="a"]').dataset.hovered, "true");
    const afterA = { ...renders };
    await act(async () => store.setHoveredReply("a"));
    assert.deepEqual(renders, afterA, "same reply hover must do no work");
    await act(async () => store.setHoveredReply("b"));
    assert.equal(container.querySelector('[data-reply="a"]').dataset.hovered, "false");
    assert.equal(container.querySelector('[data-reply="b"]').dataset.hovered, "true");
    assert.equal(renders.list, 1);
    assert.equal(renders.body, 1);
    assert.equal(renders.c, 1, "unrelated footer must not rerender");
    await act(async () => store.setHoveredReply(null));
    assert.equal(container.querySelector('[data-reply="b"]').dataset.hovered, "false");
  } finally { await act(async () => root.unmount()); container.remove(); }
});

test("ChatPage initialization does not rebuild context on theme/sidebar rerenders", async () => {
  const source = readFileSync(new URL("../../src/pages/ChatPage.tsx", import.meta.url), "utf8");
  const block = source.slice(source.indexOf("  // Ref arguments"), source.indexOf("  const [compactionStatus"));
  const initialize = new Function("useState", "useRef", "createConversationIdentity", "createConversationStateFromContext", "context",
    transpileTypeScriptModule(block + "\nreturn conversationState;", "/tmp/initialization.ts"));
  let identityCalls = 0, contextCalls = 0;
  const createIdentity = () => { identityCalls++; return { conversationId: "initial" }; };
  const createState = context => { contextCalls++; return { initialCount: context.messages.length }; };
  function Stage({ context }) {
    const state = initialize(React.useState, React.useRef, createIdentity, createState, context);
    return React.createElement("span", null, state.initialCount);
  }
  const container = doc.createElement("div"); doc.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(Stage, { context: { messages: [1] } })));
    const longContext = { messages: Array(10170).fill({ role: "assistant" }) };
    for (let i = 0; i < 20; i++) {
      await act(async () => root.render(React.createElement(Stage, { context: longContext })));
    }
    assert.equal(contextCalls, 1);
    assert.equal(identityCalls, 1);
    assert.equal(container.textContent, "1", "initial state is retained across later context props");
  } finally { await act(async () => root.unmount()); container.remove(); }
});
