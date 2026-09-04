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
const composerControlStylesSource = readFileSync(
  new URL("../../../agent-ui/src/lib/chat/composerControlStyles.ts", import.meta.url),
  "utf8",
);
const branchSelectorSource = readFileSync(
  new URL("../../../agent-ui/src/components/git/GitBranchSelector.tsx", import.meta.url),
  "utf8",
);
const popoverSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/popover.tsx", import.meta.url),
  "utf8",
);
const selectSource = readFileSync(
  new URL("../../../agent-ui/src/components/ui/select.tsx", import.meta.url),
  "utf8",
);
const baseStylesSource = readFileSync(
  new URL("../../../agent-ui/src/styles/base.css", import.meta.url),
  "utf8",
);
const iconSetSource = readFileSync(
  new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url),
  "utf8",
);

test("model pickers use popover semantics instead of menu semantics", () => {
  for (const source of pickerSources) {
    assert.match(
      source,
      /import \{ Popover, PopoverContent, PopoverTrigger \} from "@liveagent\/ui\/components\/ui\/popover"/,
    );
    assert.match(source, /<Popover open=\{isModelPickerOpen\}/);
    assert.match(source, /<PopoverContent/);
    assert.match(source, /aria-label=\{t\("chat\.selectModel"\)\}/);
    assert.doesNotMatch(source, /DropdownMenu/);
  }
});

test("execution mode switchers expose a native radio group", () => {
  for (const source of pickerSources) {
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /aria-label=\{t\("settings\.executionMode"\)\}/);
    assert.match(source, /value="text"/);
    assert.match(source, /value="tools"/);
    assert.match(source, /checked=\{!isAgent\}/);
    assert.match(source, /checked=\{isAgent\}/);
    assert.match(source, /onChange=\{\(\) => onSelectExecutionMode\("text"\)\}/);
    assert.match(source, /onChange=\{\(\) => onSelectExecutionMode\("tools"\)\}/);
    assert.match(source, /has-\[:focus-visible\]:ring-2/);
  }
});

test("model selection closes the popover while group controls keep it open", () => {
  for (const source of pickerSources) {
    assert.match(source, /onClick=\{\(\) => toggleGroup\(group\.id\)\}/);
    assert.match(source, /const \[expandedGroupId, setExpandedGroupId\] = useState/);
    assert.match(source, /return activeGroupId === id \? null : id/);
    assert.doesNotMatch(source, /expandedGroups/);
    assert.match(source, /aria-pressed=\{isSelected\}/);
    assert.match(
      source,
      /<Popover open=\{isModelPickerOpen\} onOpenChange=\{setIsModelPickerOpen\}>/,
    );
    assert.match(source, /onSelectModel\(parsed\);\s+setIsModelPickerOpen\(false\);/);
  }
});

test("model pickers search models and providers", () => {
  for (const source of pickerSources) {
    assert.match(source, /initialFocus=\{resolveModelPickerInitialFocus\}/);
    assert.match(source, /openType === "touch"/);
    assert.match(source, /searchInputRef\.current/);
    assert.match(source, /placeholder=\{t\("chat\.searchModel"\)\}/);
    assert.match(source, /\w+\.model\.toLowerCase\(\)\.includes\(normalizedSearch\)/);
    assert.match(source, /\w+\.providerName\.toLowerCase\(\)\.includes\(normalizedSearch\)/);
    assert.match(source, /t\("chat\.noModelFound"\)/);
  }
});

test("provider groups reserve a stable edit affordance before the count", () => {
  for (const source of pickerSources) {
    assert.match(source, /\bPencil\b/);
    assert.match(source, /t\("settings\.editProvider"\)/);
    assert.doesNotMatch(source, /title=\{`\$\{t\("settings\.editProvider"\)/);
    assert.doesNotMatch(source, /title=\{\s*expanded \? t\("chat\.collapseProvider"\)/);
    assert.match(source, /pointer-events-none flex w-7 shrink-0/);
    assert.match(source, /group-hover:pointer-events-auto group-hover:opacity-100/);
    assert.match(source, /group-focus-within:pointer-events-auto group-focus-within:opacity-100/);
    assert.doesNotMatch(source, /max-w-0|group-hover:max-w-7|group-focus-within:max-w-7/);
    assert.ok(source.indexOf("<Pencil") < source.indexOf("{group.opts.length}"));
    assert.match(
      source,
      /setIsModelPickerOpen\(false\);\s+onOpenSettings\("providers", group\.id\);/,
    );
  }
});

test("upload stays leftmost before model controls in the composer toolbar", () => {
  assert.match(composerSource, /<ComposerModelControls/);
  // 上传入口是 Codex 风格的 + 菜单。触发键按菜单可用性禁用(aria-label 用
  // addMenuTooltip),上传专属限制(需要 workdir 等)下沉到上传菜单项自身——
  // plan 开关不依赖上传前置条件,不得被 uploadDisabled 连坐锁死。
  assert.match(composerSource, /aria-label=\{addMenuTooltip\}/);
  assert.match(composerSource, /disabled=\{composerAddMenuDisabled\}/);
  assert.match(composerSource, /onSelect=\{onPickReadableFiles\}\s+disabled=\{uploadDisabled\}/);
  assert.match(composerSource, /onSelect=\{onPickWorkspaceFolder\}\s+disabled=\{uploadDisabled\}/);
  assert.match(composerSource, /chat\.upload\.files/);
  assert.match(composerSource, /chat\.upload\.folder/);
  assert.match(composerSource, /<FolderOpen/);
  assert.doesNotMatch(composerSource, /chat\.upload\.filesAndFolders/);
  assert.match(composerSource, /<CommandSafetyModeSelector/);
  assert.ok(
    composerSource.indexOf("aria-label={addMenuTooltip}") <
      composerSource.indexOf("<CommandSafetyModeSelector"),
  );
  assert.ok(
    composerSource.indexOf("<CommandSafetyModeSelector") <
      composerSource.indexOf("<ComposerModelControls"),
  );
  assert.ok(
    composerSource.indexOf("<ComposerModelControls") < composerSource.indexOf("<GitBranchSelector"),
  );
  assert.doesNotMatch(headerSource, /model-selector-trigger|Popover\.Root|currentModelLabel/);

  for (const source of pickerSources) {
    assert.match(source, /aria-label=\{t\("chat\.runtime\.controls"\)\}/);
    assert.match(source, /nativeWebSearchEnabled: !chatRuntimeControls\.nativeWebSearchEnabled/);
    assert.match(source, /thinkingEnabled: !chatRuntimeControls\.thinkingEnabled/);
    assert.match(source, /thinkingEnabled: true, reasoning: level/);
    assert.match(source, /thinkingEnabled: false/);
    assert.match(source, /model-runtime-effort/);
    assert.match(source, /type="range"/);
    assert.match(source, /aria-valuetext=\{formatLevel\(value\)\}/);
    assert.doesNotMatch(source, /role="radio"/);
    assert.doesNotMatch(source, /from "@liveagent\/ui\/components\/ui\/select"/);
    assert.doesNotMatch(source, /from "@liveagent\/ui\/components\/ui\/switch"/);
  }
});

test("branch selector reuses the model trigger visual language", () => {
  assert.match(branchSelectorSource, /COMPOSER_CONTROL_TRIGGER_CLASS/);
  assert.match(branchSelectorSource, /COMPOSER_CONTROL_LABEL_CLASS/);
  assert.match(branchSelectorSource, /data-\[popup-open\]:bg-muted\/60/);
  assert.match(branchSelectorSource, /menuOpen && "rotate-180"/);
  assert.doesNotMatch(branchSelectorSource, /border-emerald|bg-emerald/);
});

test("compact composer controls remain equal-width centered icon buttons", () => {
  assert.match(composerSource, /composer-glass-card @container/);
  assert.match(composerControlStylesSource, /@max-\[480px\]:w-8/);
  assert.match(composerControlStylesSource, /@max-\[480px\]:justify-center/);
  assert.match(composerControlStylesSource, /@max-\[480px\]:gap-0/);
  assert.match(composerControlStylesSource, /@max-\[480px\]:px-0/);
  assert.match(composerControlStylesSource, /@max-\[480px\]:hidden/);
});

test("composer separates input actions from the stacked runtime control deck", () => {
  assert.match(composerSource, /composer-input-surface/);
  assert.match(composerSource, /composer-control-deck/);
  assert.ok(
    composerSource.indexOf("composer-input-surface") <
      composerSource.indexOf("composer-control-deck"),
  );
  assert.ok(
    composerSource.indexOf("composer-control-deck") <
      composerSource.indexOf("<CommandSafetyModeSelector"),
  );
  assert.match(composerSource, /<ArrowUp className="h-4 w-4"/);
  assert.doesNotMatch(composerSource, /<Send className=/);
});

test("composer dropdown portals stay above the composer surface", () => {
  assert.match(popoverSource, /className="layer-popover isolate"/);
  assert.match(selectSource, /className="layer-popover"/);
  assert.match(baseStylesSource, /--layer-popover: 10000;/);
  assert.match(baseStylesSource, /--layer-modal: 10000;/);
});

test("DeepSeek provider icon uses the logo-only mark", () => {
  assert.match(iconSetSource, /~icons\/logos\/deepseek-icon/);
  assert.doesNotMatch(iconSetSource, /~icons\/logos\/deepseek["']/);
});
