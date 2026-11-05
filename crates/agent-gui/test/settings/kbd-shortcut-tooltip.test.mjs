import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
const { React, act, createRoot } = env;
const kbd = env.loadModule("@liveagent/ui/components/ui/kbd.tsx");
const keys = env.loadModule("@liveagent/ui/lib/shortcuts/shortcutKeys.ts");
const { ShortcutTooltip } = env.loadModule("@liveagent/ui/components/ui/shortcut-tooltip.tsx");

test.after(() => env.cleanup());

test("Kbd reads labels from the shared formatter instead of keeping its own", () => {
  const source = fs.readFileSync(
    new URL("../../../agent-ui/src/components/ui/kbd.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /from "\.\.\/\.\.\/lib\/shortcuts\/shortcutKeys"/);
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /[⌘⌥⇧⌃↩↵]/, "no glyph table inside the component");
  assert.equal(kbd.shortcutKeyTokens, undefined);
  assert.equal(kbd.formatShortcutText, undefined);
});

test("KbdShortcut compact renders one cap with the compact label", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    for (const [isMac, label] of [
      [true, "⇧⌘O"],
      [false, "Ctrl+Shift+O"],
    ]) {
      await act(async () =>
        root.render(
          React.createElement(kbd.KbdShortcut, { shortcut: "Mod+Shift+KeyO", isMac, compact: true }),
        ),
      );
      const caps = [...host.querySelectorAll('[data-slot="kbd"]')];
      assert.deepEqual(caps.map((cap) => cap.textContent), [label]);
      assert.equal(host.querySelector('[data-slot="kbd-shortcut"]'), null);
      assert.equal(keys.formatShortcutLabel("Mod+Shift+KeyO", isMac), label);
    }
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("KbdShortcut renders one cap per key and a single screen-reader label", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(React.createElement(kbd.KbdShortcut, { shortcut: "Mod+Shift+KeyO", isMac: false })),
    );
    const group = host.querySelector('[data-slot="kbd-shortcut"]');
    assert.equal(group.tagName, "KBD");
    const caps = [...group.querySelectorAll('[data-slot="kbd"]')];
    assert.deepEqual(caps.map((cap) => cap.textContent), ["Ctrl", "Shift", "O"]);
    assert.ok(caps.every((cap) => cap.getAttribute("aria-hidden") === "true"));
    assert.equal(group.querySelector(".sr-only").textContent, "Ctrl+Shift+O");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("ShortcutTooltip shows label + keys on keyboard focus and falls back to title when disabled", async () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const render = (props) =>
    act(async () =>
      root.render(
        React.createElement(
          ShortcutTooltip,
          { label: "Close sidebar", shortcut: "Mod+KeyB", isMac: true, delay: 0, ...props },
          React.createElement("button", { type: "button", "aria-label": "Close sidebar", disabled: props?.triggerDisabled }, "x"),
        ),
      ),
    );
  try {
    await render();
    const button = host.querySelector("button");
    assert.equal(button.getAttribute("aria-keyshortcuts"), "Meta+B");
    assert.equal(button.getAttribute("title"), null, "no native tooltip next to the custom one");
    assert.equal(document.querySelector('[data-slot="tooltip-content"]'), null, "closed until focused");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      button.focus();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const content = document.querySelector('[data-slot="tooltip-content"]');
    assert.ok(content, "keyboard focus opens the tooltip");
    assert.match(content.textContent, /Close sidebar/);
    assert.deepEqual(
      [...content.querySelectorAll('[data-slot="kbd"]')].map((cap) => cap.textContent),
      ["⌘", "B"],
    );

    await act(async () => button.blur());
    await render({ triggerDisabled: true });
    assert.equal(host.querySelector("button").getAttribute("title"), "Close sidebar (⌘B)");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test("no hand-rolled <kbd> remains and converted icon buttons drop native titles", () => {
  const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const kbdUsers = [
    "../../../agent-ui/src/components/chat/ConversationSearchDialog.tsx",
    "../../../agent-ui/src/components/workspace-editor/SftpPathNavigator.tsx",
    "../../../agent-ui/src/components/workspace-editor/WorkspaceCodeEditorOverlay.tsx",
    "../../../agent-ui/src/components/project-tools/git-review/CommitComposer.tsx",
    "../../../agent-ui/src/pages/settings/SettingsShell.tsx",
    "../../../agent-ui/src/pages/planning/PlanningToolbar.tsx",
    "../../../agent-ui/src/pages/planning/ShortcutHelp.tsx",
    "../../src/pages/settings/GlobalShortcutsSection.tsx",
  ];
  for (const file of kbdUsers) assert.ok(!/<kbd\b/.test(read(file)), file);

  const converted = {
    "../../../agent-ui/src/components/chat/ChatHeader.tsx": [
      /title=\{t\(sidebarOpen/,
      /title=\{t\("tooltip\.settings"\)\}/,
    ],
    "../../../agent-ui/src/pages/chat/ChatComposerBar.tsx": [
      /title=\{primaryActionTitle\}/,
      /title=\{addMenuTooltip\}/,
    ],
    "../../../agent-ui/src/components/chat/TranscriptMessageActions.tsx": [
      /title=\{t\("chat\.(copy|share)"\)\}/,
      /title=\{(editTitle|rewindTitle|retryTitle|branchTitle)\}/,
    ],
    "../../../agent-ui/src/components/project-tools/ProjectToolsPanelToggle.tsx": [/\btitle=\{/],
    "../../../agent-ui/src/components/project-tools/git-review/DiffView.tsx": [
      /title=\{workingTreeTitle\}/,
      /title=\{branchTitle\}/,
    ],
  };
  for (const [file, patterns] of Object.entries(converted)) {
    const source = read(file);
    assert.ok(source.includes("<ShortcutTooltip"), file);
    for (const pattern of patterns) assert.ok(!pattern.test(source), `${file} ${pattern}`);
  }
});
