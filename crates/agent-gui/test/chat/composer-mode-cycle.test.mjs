import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Shift+Tab in the composer cycles ask → auto edit → plan → ask.

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

const { nextComposerPermissionMode } = env.loadModule("@liveagent/ui/lib/chat/permissionModes.ts");
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");

test("cycle order is ask, auto edit, plan, then back to ask", () => {
  const ask = { commandSafetyMode: "ask", planModeEnabled: false };
  const autoEdit = nextComposerPermissionMode(ask);
  assert.deepEqual(autoEdit, { commandSafetyMode: "autoEdit", planModeEnabled: false, shown: "autoEdit" });
  const plan = nextComposerPermissionMode(autoEdit);
  // Plan mode is its own switch; the permission mode under it is kept, so turning
  // plan off from its pill restores auto edit.
  assert.deepEqual(plan, { commandSafetyMode: "autoEdit", planModeEnabled: true, shown: "plan" });
  assert.deepEqual(nextComposerPermissionMode(plan), {
    commandSafetyMode: "ask",
    planModeEnabled: false,
    shown: "ask",
  });
});

test("modes outside the cycle return to ask and always allow is never entered", () => {
  for (const mode of ["autoReview", "always", "auto", "sandbox", "sandboxOffline", undefined]) {
    assert.deepEqual(
      nextComposerPermissionMode({ commandSafetyMode: mode, planModeEnabled: false }),
      { commandSafetyMode: "ask", planModeEnabled: false, shown: "ask" },
      String(mode),
    );
  }
  // Plan switched on from the plus menu over any mode: the next press leaves plan.
  assert.deepEqual(
    nextComposerPermissionMode({ commandSafetyMode: "always", planModeEnabled: true }),
    { commandSafetyMode: "ask", planModeEnabled: false, shown: "ask" },
  );
  let state = { commandSafetyMode: "ask", planModeEnabled: false };
  for (let i = 0; i < 9; i++) {
    state = nextComposerPermissionMode(state);
    assert.notEqual(state.commandSafetyMode, "always");
  }
});

let host;
let root;
let editor;
let cycles = 0;

async function mount(props) {
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
        onSend: () => {},
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

async function tab(options = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    code: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await env.act(async () => editor.dispatchEvent(event));
  return event;
}

test.beforeEach(() => {
  cycles = 0;
});

test("Shift+Tab in the editor cycles the mode instead of moving focus", async () => {
  await mount({ onCycleMode: () => cycles++ });
  const event = await tab();
  assert.equal(cycles, 1);
  assert.equal(event.defaultPrevented, true);
});

test("plain Tab and Shift+Tab with other modifiers are left alone", async () => {
  await mount({ onCycleMode: () => cycles++ });
  for (const options of [
    { shiftKey: false },
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
  ]) {
    const event = await tab(options);
    assert.equal(event.defaultPrevented, false, JSON.stringify(options));
  }
  assert.equal(cycles, 0);
});

test("without a cycle handler Shift+Tab keeps its focus behaviour", async () => {
  await mount({});
  const event = await tab();
  assert.equal(event.defaultPrevented, false);
});

test("Shift+Tab during IME composition does not cycle", async () => {
  await mount({ onCycleMode: () => cycles++ });
  await tab({ isComposing: true });
  await tab({ keyCode: 229 });
  assert.equal(cycles, 0);
});

test("an open completion popup keeps Shift+Tab", async () => {
  const commandHost = {
    listCommands: async () => [{ name: "plan", kind: "action", source: "builtin", description: "Plan" }],
    sendTurn: async () => {},
    enablePlanMode: () => {},
  };
  await mount({ onCycleMode: () => cycles++, commandHost });
  await type("/pla");
  assert.ok(document.querySelector("[data-command-name]"), "popup shows suggestions");
  await tab();
  assert.equal(cycles, 0);
  // A popup still loading or with no match is open too.
  await type("/zzzz");
  await tab();
  assert.equal(cycles, 0);
});

test("a disabled editor does not cycle", async () => {
  await mount({ onCycleMode: () => cycles++, disabled: true });
  await tab();
  assert.equal(cycles, 0);
});

test.after(async () => {
  if (root) await env.act(async () => root.unmount());
  env.cleanup();
});
