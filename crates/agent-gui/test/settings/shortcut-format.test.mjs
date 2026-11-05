import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The shared shortcut formatter in agent-ui lib/shortcuts/shortcutKeys.ts: every
// Kbd cap, tooltip, menu hint and settings row reads its label from here.
const loader = createTsModuleLoader();
const keys = loader.loadModule("@liveagent/ui/lib/shortcuts/shortcutKeys.ts");
const MAC = true;
const OTHER = false;

test("macOS uses ⌃⌥⇧⌘ glyphs in menu order and joins them without separators", () => {
  assert.deepEqual(keys.shortcutDisplayTokens("Mod+Shift+KeyO", MAC), ["⇧", "⌘", "O"]);
  assert.equal(keys.formatShortcutLabel("Mod+Shift+KeyO", MAC), "⇧⌘O");
  // Any input order comes out as Control, Option, Shift, Command.
  assert.deepEqual(keys.shortcutDisplayTokens("Super+Shift+Alt+Ctrl+KeyK", MAC), [
    "⌃",
    "⌥",
    "⇧",
    "⌘",
    "K",
  ]);
  assert.equal(keys.formatShortcutLabel("Mod+Alt+BracketLeft", MAC), "⌥⌘[");
  assert.equal(keys.formatShortcutLabel("Ctrl+KeyK", MAC), "⌃K", "Ctrl stays Control on macOS");
});

test("Windows/Linux spell modifiers out as Ctrl+Shift+Alt+Win", () => {
  assert.deepEqual(keys.shortcutDisplayTokens("Mod+Shift+KeyO", OTHER), ["Ctrl", "Shift", "O"]);
  assert.equal(keys.formatShortcutLabel("Mod+Shift+KeyO", OTHER), "Ctrl+Shift+O");
  assert.equal(keys.formatShortcutLabel("Super+Alt+Shift+Ctrl+KeyK", OTHER), "Ctrl+Shift+Alt+Win+K");
  assert.equal(keys.formatShortcutLabel("Mod+Alt+BracketRight", OTHER), "Ctrl+Alt+]");
});

test("Mod and modifier aliases resolve per platform", () => {
  for (const spelling of ["Mod+KeyB", "Cmd+KeyB", "Command+KeyB", "Meta+KeyB", "super+b"]) {
    assert.equal(keys.formatShortcutLabel(spelling, MAC), "⌘B", spelling);
  }
  assert.equal(keys.formatShortcutLabel("Mod+KeyB", OTHER), "Ctrl+B");
  assert.equal(keys.formatShortcutLabel("Meta+KeyB", OTHER), "Win+B");
  assert.equal(keys.formatShortcutLabel("Option+Control+KeyA", MAC), "⌃⌥A");
  assert.equal(keys.formatShortcutLabel("Option+Control+KeyA", OTHER), "Ctrl+Alt+A");
});

test("special keys share one name table", () => {
  const cases = [
    // [chord, macOS, other]
    ["Enter", "↩", "Enter"],
    ["Return", "↩", "Enter"],
    ["Mod+Enter", "⌘↩", "Ctrl+Enter"],
    ["Shift+Enter", "⇧↩", "Shift+Enter"],
    ["Escape", "Esc", "Esc"],
    ["Esc", "Esc", "Esc"],
    ["Tab", "Tab", "Tab"],
    ["Shift+Tab", "⇧Tab", "Shift+Tab"],
    ["Space", "Space", "Space"],
    ["Backspace", "⌫", "Backspace"],
    ["Delete", "⌦", "Del"],
    ["ArrowUp", "↑", "↑"],
    ["ArrowDown", "↓", "↓"],
    ["Alt+ArrowLeft", "⌥←", "Alt+←"],
    ["Alt+ArrowRight", "⌥→", "Alt+→"],
    ["PageUp", "PgUp", "PgUp"],
    ["F5", "F5", "F5"],
    ["Mod+Comma", "⌘,", "Ctrl+,"],
    ["Mod+Slash", "⌘/", "Ctrl+/"],
    ["Digit1", "1", "1"],
    ["Numpad1", "Num 1", "Num 1"],
    ["NumpadAdd", "Num +", "Num +"],
  ];
  for (const [chord, mac, other] of cases) {
    assert.equal(keys.formatShortcutLabel(chord, MAC), mac, `${chord} on macOS`);
    assert.equal(keys.formatShortcutLabel(chord, OTHER), other, `${chord} elsewhere`);
  }
});

test("plain labels, the plus key and empty chords", () => {
  assert.equal(keys.formatShortcutLabel("d", OTHER), "D");
  assert.equal(keys.formatShortcutLabel("?", MAC), "?");
  assert.equal(keys.formatShortcutLabel("/", OTHER), "/");
  assert.equal(keys.formatShortcutLabel("Ctrl++", OTHER), "Ctrl++");
  assert.equal(keys.formatShortcutLabel("Mod+Plus", MAC), "⌘+");
  assert.equal(keys.formatShortcutLabel("", MAC), "");
  assert.deepEqual(keys.shortcutDisplayTokens("", OTHER), []);
  // A recording draft holds modifiers only.
  assert.deepEqual(keys.shortcutDisplayTokens("Ctrl+Shift+Super", MAC), ["⌃", "⇧", "⌘"]);
  assert.deepEqual(keys.shortcutDisplayTokens("Ctrl+Shift+Super", OTHER), ["Ctrl", "Shift", "Win"]);
});

test("single-token helpers match the chord formatter", () => {
  assert.equal(keys.shortcutModifierDisplayLabel("Super", MAC), "⌘");
  assert.equal(keys.shortcutModifierDisplayLabel("Super", OTHER), "Win");
  assert.equal(keys.shortcutModifierDisplayLabel("Alt", MAC), "⌥");
  assert.equal(keys.shortcutKeyDisplayLabel("KeyK", MAC), "K");
  assert.equal(keys.shortcutKeyDisplayLabel("Enter", MAC), "↩");
  assert.equal(keys.shortcutKeyDisplayLabel("Enter", OTHER), "Enter");
  assert.deepEqual(keys.parseShortcutChord("Shift+Mod+KeyO", MAC), {
    modifiers: ["Shift", "Super"],
    key: "KeyO",
  });
  assert.deepEqual(keys.parseShortcutChord("Shift+Mod+KeyO", OTHER), {
    modifiers: ["Ctrl", "Shift"],
    key: "KeyO",
  });
});

test("aria-keyshortcuts values use DOM key names", () => {
  assert.equal(keys.shortcutAriaKeys("Mod+KeyB", MAC), "Meta+B");
  assert.equal(keys.shortcutAriaKeys("Mod+KeyB", OTHER), "Control+B");
  assert.equal(keys.shortcutAriaKeys("Mod+Shift+Slash", OTHER), "Control+Shift+/");
  assert.equal(keys.shortcutAriaKeys("Esc", MAC), "Escape");
  assert.equal(keys.shortcutAriaKeys("Enter", MAC), "Enter");
  assert.equal(keys.shortcutAriaKeys("Alt+ArrowUp", OTHER), "Alt+ArrowUp");
});

test("isMac defaults to the browser platform", () => {
  const { isMacLikePlatform } = loader.loadModule("@liveagent/ui/lib/shared/platform.ts");
  assert.equal(keys.formatShortcutLabel("Mod+Enter"), keys.formatShortcutLabel("Mod+Enter", isMacLikePlatform()));
});

test("display formatting never changes how a chord matches", () => {
  // resolveAccelerator (used for matching and conflict checks) keeps its strict syntax.
  assert.equal(keys.resolveAccelerator("Shift+Mod+KeyO", MAC), "Shift+Super+KeyO");
  assert.equal(keys.resolveAccelerator("Shift+Mod+KeyO", OTHER), "Ctrl+Shift+KeyO");
});

test("no surface hand-builds a shortcut label", () => {
  const read = (relative) => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
  const surfaces = [
    "../../src/pages/settings/GlobalShortcutsSection.tsx",
    "../../../agent-ui/src/components/chat/ConversationSearchDialog.tsx",
    "../../../agent-ui/src/components/chat/ToolApprovalBar.tsx",
    "../../../agent-ui/src/components/chat/TranscriptFindBar.tsx",
    "../../../agent-ui/src/components/chat/ComposerGoalBar.tsx",
    "../../../agent-ui/src/components/project-tools/git-review/CommitComposer.tsx",
    "../../../agent-ui/src/components/project-tools/git-review/DiffView.tsx",
    "../../../agent-ui/src/components/workspace-editor/SftpPathNavigator.tsx",
    "../../../agent-ui/src/components/workspace-editor/WorkspaceCodeEditorOverlay.tsx",
    "../../../agent-ui/src/pages/chat/ChatComposerBar.tsx",
    "../../../agent-ui/src/pages/planning/PlanningToolbar.tsx",
    "../../../agent-ui/src/pages/planning/ShortcutHelp.tsx",
    "../../../agent-ui/src/pages/settings/SettingsShell.tsx",
    "../../../agent-ui/src/pages/settings/ShortcutCommandsSection.tsx",
  ];
  for (const file of surfaces) {
    const code = read(file)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /[⌘⌥⇧⌃↩↵]/, `${file}: modifier glyph outside the formatter`);
    assert.doesNotMatch(code, /: "Ctrl"|(Ctrl|Cmd) \+ |["'`]Cmd\b/, `${file}: hand-written modifier label`);
    assert.doesNotMatch(code, /<kbd\b/, `${file}: raw <kbd>`);
    assert.doesNotMatch(code, /formatShortcutText|globalShortcutDisplayToken/, file);
  }
  for (const [locale, file] of [
    ["en-US", "../../../agent-ui/src/i18n/translations/enUSCommon.ts"],
    ["zh-CN", "../../../agent-ui/src/i18n/translations/zhCNCommon.ts"],
  ]) {
    const source = read(file);
    for (const key of [
      "chat.goalBar.editHint",
      "chat.find.previous",
      "chat.find.next",
      "chat.find.close",
      "chat.safety.cycleShortcut",
      "projectTools.gitReview.lineComments.saveHint",
      "workspaceSftp.pathKeyboardHint",
    ]) {
      const line = source.slice(source.indexOf(`"${key}"`)).split(",\n")[0];
      assert.match(line, /\{(keys|save|select)\}/, `${locale} ${key} takes formatted keys`);
      assert.doesNotMatch(line, /Ctrl|⌘|Enter|Esc|Shift/, `${locale} ${key}`);
    }
  }
});
