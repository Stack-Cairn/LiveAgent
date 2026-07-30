import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const headerSources = [
  readFileSync(
    new URL("../../src/pages/chat/components/ChatHeader.tsx", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../../../agent-gateway/web/src/pages/chat/ChatHeader.tsx", import.meta.url),
    "utf8",
  ),
];

test("model pickers use popover semantics instead of menu semantics", () => {
  for (const source of headerSources) {
    assert.match(source, /import \{ Popover \} from "@base-ui\/react"/);
    assert.match(source, /<Popover\.Root open=\{isModelPickerOpen\}/);
    assert.match(source, /<Popover\.Popup/);
    assert.match(source, /aria-label=\{t\("chat\.selectModel"\)\}/);
    assert.doesNotMatch(source, /DropdownMenu/);
  }
});

test("execution mode switchers expose a native radio group", () => {
  for (const source of headerSources) {
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /aria-label=\{t\("settings\.executionMode"\)\}/);
    assert.equal((source.match(/type="radio"/g) ?? []).length, 2);
    assert.match(source, /checked=\{!isAgent\}/);
    assert.match(source, /checked=\{isAgent\}/);
    assert.match(source, /onChange=\{\(\) => onSelectExecutionMode\("text"\)\}/);
    assert.match(source, /onChange=\{\(\) => onSelectExecutionMode\("tools"\)\}/);
    assert.match(source, /has-\[:focus-visible\]:ring-2/);
  }
});

test("popover interactions preserve mode changes and close after model selection", () => {
  for (const source of headerSources) {
    assert.match(source, /onClick=\{\(\) => toggleGroup\(group\.id\)\}/);
    assert.match(source, /aria-pressed=\{isSelected\}/);
    assert.match(source, /onSelectModel\(parsed\);\s+setIsModelPickerOpen\(false\);/);
  }
});

test("model pickers search models and providers", () => {
  for (const source of headerSources) {
    assert.match(source, /initialFocus=\{searchInputRef\}/);
    assert.match(source, /placeholder=\{t\("chat\.searchModel"\)\}/);
    assert.match(source, /\w+\.model\.toLowerCase\(\)\.includes\(normalizedSearch\)/);
    assert.match(source, /\w+\.providerName\.toLowerCase\(\)\.includes\(normalizedSearch\)/);
    assert.match(source, /t\("chat\.noModelFound"\)/);
  }
});

test("provider groups reveal the edit affordance before the count on hover", () => {
  for (const source of headerSources) {
    assert.match(source, /\bPencil\b/);
    assert.match(source, /t\("settings\.editProvider"\)/);
    assert.doesNotMatch(source, /title=\{`\$\{t\("settings\.editProvider"\)/);
    assert.doesNotMatch(source, /title=\{\s*expanded \? t\("chat\.collapseProvider"\)/);
    assert.match(source, /pointer-events-none flex w-7 max-w-0/);
    assert.match(source, /group-hover:max-w-7/);
    assert.match(source, /group-focus-within:max-w-7/);
    assert.ok(source.indexOf("<Pencil") < source.indexOf("{group.opts.length}"));
    assert.match(
      source,
      /setIsModelPickerOpen\(false\);\s+onOpenSettings\("providers", group\.id\);/,
    );
  }
});
