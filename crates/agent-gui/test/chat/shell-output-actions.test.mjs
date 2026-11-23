import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Long shell output (`seq 1 4000`, 18,892 characters without the final newline) shows a 6,000-character preview.
// The card copies the whole output through the clipboard adapter (stubbed here, never
// the real clipboard) and can show all of it, then fold it back.
// Assertions compare strings and booleans only: a failing assert on a DOM node would
// try to print the whole jsdom tree.

const NullComponent = () => null;
const OUTPUT = `${Array.from({ length: 4000 }, (_, i) => i + 1).join("\n")}\n`;

async function renderShell(output) {
  const copied = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => NullComponent }),
      "../../IconSet": new Proxy({}, { get: () => NullComponent }),
      "@liveagent/ui/components/Markdown": { Markdown: NullComponent },
      "@liveagent/ui/components/chat/EditDiffView": { EditDiffView: NullComponent },
      "@liveagent/ui/lib/shared/clipboard": {
        copyTextToClipboard: async (text) => {
          copied.push(text);
          return true;
        },
      },
      "@liveagent/ui/i18n/index": {
        useLocale: () => ({
          locale: "en-US",
          t: (key) =>
            ({
              "chat.tool.output.copy": "Copy output",
              "chat.tool.output.copied": "Copied",
              "chat.tool.output.showAll": "Show all output",
              "chat.tool.output.showLess": "Show less",
              "chat.tool.output.truncated": "… Showing the first {shown} of {total} characters",
            })[key] ?? key,
        }),
      },
    },
  });
  const { ShellToolDisplay } = env.loadModule(
    "@liveagent/ui/components/chat/assistant-bubble/ToolResultDisplay.tsx",
  );
  const item = {
    toolCall: { id: "c1", name: "Bash", arguments: { command: "seq 1 4000" } },
  };
  const result = {
    role: "toolResult",
    toolCallId: "c1",
    toolName: "Bash",
    isError: false,
    content: [{ type: "text", text: output }],
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () => root.render(env.React.createElement(ShellToolDisplay, { item, result })));
  const click = (element) =>
    env.act(async () => {
      element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  const pre = () => host.querySelector("pre")?.textContent ?? "";
  const cleanup = async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  };
  return { host, copied, click, pre, cleanup };
}

test("long shell output can be copied whole and shown in full", async () => {
  const { host, copied, click, pre, cleanup } = await renderShell(OUTPUT);
  try {
    assert.equal(pre().includes("\n4000"), false, "the preview stops at 6,000 characters");
    assert.equal(pre().includes("Showing the first 6,000 of 18,892 characters"), true);

    const copy = host.querySelector('button[aria-label="Copy output"]');
    assert.equal(copy !== null, true, "the card has a Copy action");
    await click(copy);
    assert.equal(copied.length, 1);
    assert.equal(copied[0] === OUTPUT.trimEnd(), true, "Copy takes the whole output, not the preview");

    const toggle = () => host.querySelector("button[data-shell-show-all]");
    assert.equal(toggle()?.textContent, "Show all output");
    assert.equal(toggle()?.getAttribute("aria-expanded"), "false");
    await click(toggle());
    assert.equal(pre().includes("\n4000"), true, "Show all renders the rest");
    assert.equal(pre().includes("Showing the first"), false);
    assert.equal(toggle()?.textContent, "Show less");
    assert.equal(toggle()?.getAttribute("aria-expanded"), "true");
    await click(toggle());
    assert.equal(pre().includes("\n4000"), false, "Show less folds it back");
  } finally {
    await cleanup();
  }
});

test("short shell output has Copy but no Show all", async () => {
  const { host, copied, click, cleanup } = await renderShell("hello\n");
  try {
    assert.equal(host.querySelector("button[data-shell-show-all]") === null, true);
    const copy = host.querySelector('button[aria-label="Copy output"]');
    assert.equal(copy !== null, true);
    await click(copy);
    assert.equal(copied[0], "hello");
  } finally {
    await cleanup();
  }
});
