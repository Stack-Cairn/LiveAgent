import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// A failed file index shows the translated message together with the
// backend's reason instead of a hard-coded, cause-less English string.

const messages = { "chat.composer.fileIndexFailed": "IDX-FAILED<{reason}>" };
const locale = { locale: "en-US", t: (key) => messages[key] ?? key };
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
const calls = [];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": icons,
    "@liveagent/ui/lib/tools/fsBackend": {
      invokeFs: async (command, args) => {
        calls.push({ command, args });
        throw new Error("unsupported filesystem action");
      },
    },
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
const { formatMentionIndexError } = env.loadModule(
  "@liveagent/ui/components/chat/MentionComposerModel.ts",
);

let root;
let host;

async function settle() {
  for (let i = 0; i < 5; i++) {
    await env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

test("choosing Files and folders surfaces the index failure reason", async () => {
  host = document.createElement("div");
  document.body.append(host);
  root = env.createRoot(host);
  await env.act(async () =>
    root.render(
      env.React.createElement(MentionComposer, {
        workdir: "/workspace/demo",
        enabledSkills: [],
        conversations: [],
        mentionApps: [],
        onSend: () => {},
      }),
    ),
  );
  const editor = host.querySelector('[role="textbox"]');
  await env.act(async () => {
    editor.focus();
    editor.textContent = "@";
    const range = document.createRange();
    range.setStart(editor.firstChild, 1);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
  // The root menu only offers the files category here; Enter opens it.
  await env.act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }),
    ),
  );
  await settle();
  assert.ok(calls.some((call) => call.command === "fs_mention_list"));
  const text = document.body.textContent;
  assert.match(text, /IDX-FAILED<unsupported filesystem action>/);
  assert.doesNotMatch(text, /Could not index files/);
});

test("the reason is collapsed to one line and bounded", () => {
  const t = (key) => messages[key] ?? key;
  assert.equal(formatMentionIndexError(t, new Error("a\n  b")), "IDX-FAILED<a b>");
  assert.equal(formatMentionIndexError(t, "x".repeat(500)).length, "IDX-FAILED<>".length + 240);
});

test.after(async () => {
  if (root) await env.act(async () => root.unmount());
  env.cleanup();
});
