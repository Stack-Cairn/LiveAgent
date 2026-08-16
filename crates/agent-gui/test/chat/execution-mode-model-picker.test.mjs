import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const pickerSources = [
  readFileSync(
    new URL("../../../agent-ui/src/components/chat/ComposerModelControls.tsx", import.meta.url),
    "utf8",
  ),
];
const headerSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ChatHeader.tsx", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);

test("model pickers use popover semantics instead of menu semantics", () => {
  for (const source of pickerSources) {
    assert.match(source, /import \{ Popover \} from "@base-ui\/react"/);
    assert.match(source, /<Popover\.Root open=\{isModelPickerOpen\}/);
    assert.match(source, /<Popover\.Popup/);
    assert.match(source, /aria-label=\{t\("chat\.selectModel"\)\}/);
    assert.doesNotMatch(source, /DropdownMenu/);
  }
});

test("execution mode switchers expose a native radio group", () => {
  for (const source of pickerSources) {
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

test("popover interactions preserve mode and model changes until an outside dismissal", () => {
  for (const source of pickerSources) {
    assert.match(source, /onClick=\{\(\) => toggleGroup\(group\.id\)\}/);
    assert.match(source, /const \[expandedGroupId, setExpandedGroupId\] = useState/);
    assert.match(source, /return activeGroupId === id \? null : id/);
    assert.doesNotMatch(source, /expandedGroups/);
    assert.match(source, /aria-pressed=\{isSelected\}/);
    assert.match(
      source,
      /<Popover\.Root open=\{isModelPickerOpen\} onOpenChange=\{setIsModelPickerOpen\}>/,
    );
    assert.match(source, /onSelectModel\(parsed\);/);
    assert.doesNotMatch(source, /onSelectModel\(parsed\);\s+setIsModelPickerOpen\(false\);/);
  }
});

test("model pickers search models and providers", () => {
  for (const source of pickerSources) {
    assert.match(source, /initialFocus=\{searchInputRef\}/);
    assert.match(source, /placeholder=\{t\("chat\.searchModel"\)\}/);
    assert.match(source, /\w+\.model\.toLowerCase\(\)\.includes\(normalizedSearch\)/);
    assert.match(source, /\w+\.providerName\.toLowerCase\(\)\.includes\(normalizedSearch\)/);
    assert.match(source, /t\("chat\.noModelFound"\)/);
  }
});

test("provider groups reveal the edit affordance before the count on hover", () => {
  for (const source of pickerSources) {
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

test("upload stays leftmost before model controls in the composer toolbar", () => {
  assert.match(composerSource, /<ComposerModelControls/);
  assert.match(composerSource, /<RuntimeControlTooltip label=\{uploadTooltip\}>/);
  assert.ok(
    composerSource.indexOf("<RuntimeControlTooltip label={uploadTooltip}>") <
      composerSource.indexOf("<ComposerModelControls"),
  );
  assert.doesNotMatch(headerSource, /model-selector-trigger|Popover\.Root|currentModelLabel/);

  for (const source of pickerSources) {
    assert.match(source, /aria-label=\{t\("chat\.runtime\.controls"\)\}/);
    assert.match(source, /nativeWebSearchEnabled: !chatRuntimeControls\.nativeWebSearchEnabled/);
    assert.match(source, /thinkingEnabled: !chatRuntimeControls\.thinkingEnabled/);
    assert.match(source, /onChatRuntimeControlsChange\(\{ reasoning:/);
    assert.match(source, /reasoningOptions\.length > 0 \? "grid-cols-3" : "grid-cols-2"/);
    assert.match(source, /className="h-8 w-full min-w-0 gap-0\.5/);
  }
});
