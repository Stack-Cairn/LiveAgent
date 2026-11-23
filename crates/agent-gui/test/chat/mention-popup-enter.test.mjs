import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Enter while the @/slash completion popup is open must never submit the
// half-typed draft, even when the popup has no selectable row (no match,
// still loading, or an index error).

const locale = { locale: "en-US", t: (key) => key };
const EmptyIcon = () => null;
const icons = new Proxy(
  {},
  {
    get: (_target, name) =>
      name === "__esModule"
        ? true
        : String(name).endsWith("_SVG_MARKUP")
          ? "<svg></svg>"
          : EmptyIcon,
  },
);
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": icons,
  },
});
window.HTMLElement.prototype.scrollIntoView = () => {};
window.Range.prototype.getClientRects = () => [];
window.Range.prototype.getBoundingClientRect = () => ({
  left: 0,
  top: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
});
document.execCommand = () => true;

const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");

let host;
let root;
let editor;
let sent = [];

async function mount(props = {}) {
  if (root) {
    await env.act(async () => root.unmount());
    host.remove();
  }
  host = document.createElement("div");
  document.body.append(host);
  root = env.createRoot(host);
  await env.act(async () =>
    root.render(
      env.React.createElement(MentionComposer, {
        workdir: "",
        enabledSkills: [],
        conversations: [],
        mentionApps: [],
        onSend: (text) => sent.push(text),
        ...props,
      }),
    ),
  );
  editor = host.querySelector('[role="textbox"]');
  assert.ok(editor);
}

async function type(text) {
  await env.act(async () => {
    editor.focus();
    editor.textContent = text;
    const range = document.createRange();
    if (editor.firstChild) range.setStart(editor.firstChild, text.length);
    else range.setStart(editor, 0);
    range.collapse(true);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function enter() {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
  });
  await env.act(async () => editor.dispatchEvent(event));
  await env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  return event;
}

test.beforeEach(() => {
  sent = [];
});

test("Enter on an @ popup with no matching reference type does not send", async () => {
  await mount();
  await type("@READ");
  assert.match(host.ownerDocument.body.textContent, /chat\.composer\.noMatchingReferenceTypes/);
  const event = await enter();
  assert.deepEqual(sent, []);
  assert.equal(event.defaultPrevented, true);
});

test("Enter on a slash popup with no matching command does not send", async () => {
  const commandHost = {
    listCommands: async () => [{ name: "plan", kind: "action", source: "builtin", description: "Plan" }],
    sendTurn: async () => {},
    enablePlanMode: () => {},
  };
  await mount({ commandHost });
  await type("/zzzz");
  await enter();
  assert.deepEqual(sent, []);
});

test("a typed slash command with arguments still runs on Enter", async () => {
  const turns = [];
  const commandHost = {
    listCommands: async () => [
      { name: "review", kind: "prompt", source: "builtin", description: "Review", argumentHint: "<focus>" },
    ],
    sendTurn: async (turn) => turns.push(turn),
    enablePlanMode: () => {},
  };
  await mount({ commandHost });
  await type("/review the parser");
  await enter();
  assert.equal(sent.length + turns.length, 1);
});

test("Enter without an open popup still sends", async () => {
  await mount();
  await type("hello there");
  await enter();
  assert.equal(sent.length, 1);
});

test.after(async () => {
  if (root) await env.act(async () => root.unmount());
  env.cleanup();
});
