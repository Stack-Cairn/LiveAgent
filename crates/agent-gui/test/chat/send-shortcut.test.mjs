import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
const env = await createDomTestEnv({
  mocks: { "@liveagent/ui/i18n/index": { useLocale: () => locale } },
});
const { readSendShortcut, writeSendShortcut } = env.loadModule(
  "@liveagent/ui/lib/chat/sendShortcut.ts",
);
const { MentionComposer } = env.loadModule("@liveagent/ui/components/chat/MentionComposer.tsx");
const host = document.createElement("div");
document.body.append(host);
const root = env.createRoot(host);
let sends = 0;
let lineBreaks = 0;
document.execCommand = (command) => {
  if (command === "insertLineBreak") lineBreaks++;
  return true;
};
await env.act(async () =>
  root.render(
    env.React.createElement(MentionComposer, {
      workdir: "",
      enabledSkills: [],
      conversations: [],
      mentionApps: [],
      onSend: () => sends++,
    }),
  ),
);
const editor = host.querySelector('[contenteditable="true"]');
assert.ok(editor);
async function enter(options = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    code: "Enter",
    bubbles: true,
    cancelable: true,
    ...options,
  });
  await env.act(async () => editor.dispatchEvent(event));
  return event;
}
test.beforeEach(() => {
  sends = 0;
  lineBreaks = 0;
  window.localStorage.clear();
});
test("default Enter sends and Shift+Enter inserts a line break", async () => {
  assert.equal(readSendShortcut(), "enter");
  await enter();
  await enter({ shiftKey: true });
  assert.equal(sends, 1);
  assert.equal(lineBreaks, 1);
});
test("Ctrl+Enter preference changes the mounted editor immediately and supports Command+Enter", async () => {
  writeSendShortcut("ctrlEnter");
  await enter();
  await enter({ ctrlKey: true });
  await enter({ metaKey: true });
  await enter({ shiftKey: true, ctrlKey: true });
  assert.equal(sends, 2);
  assert.equal(lineBreaks, 2);
});
test("composition confirmation and held send keys do not submit", async () => {
  writeSendShortcut("ctrlEnter");
  await enter({ isComposing: true, ctrlKey: true });
  await enter({ repeat: true, ctrlKey: true });
  assert.equal(sends, 0);
});
test("invalid stored preferences fall back to Enter", () => {
  window.localStorage.setItem("liveagent.sendShortcut.v1", "invalid");
  assert.equal(readSendShortcut(), "enter");
});
test.after(async () => {
  await env.act(async () => root.unmount());
  env.cleanup();
});
