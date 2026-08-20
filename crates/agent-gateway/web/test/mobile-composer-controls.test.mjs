import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesSource = readFileSync(new URL("../src/styles/base-chat.css", import.meta.url), "utf8");
const controlStylesSource = readFileSync(
  new URL("../../../agent-ui/src/lib/chat/composerControlStyles.ts", import.meta.url),
  "utf8",
);
const safetySelectorSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/CommandSafetyModeSelector.tsx", import.meta.url),
  "utf8",
);
const modelControlsSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ComposerModelControls.tsx", import.meta.url),
  "utf8",
);
const composerSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);

test("mobile composer model and branch controls keep truncated labels visible", () => {
  assert.match(
    stylesSource,
    /@media \(max-width: 480px\) \{[\s\S]*?\.composer-model-trigger \{[\s\S]*?flex: 1 1 0;[\s\S]*?width: auto;[\s\S]*?min-width: 0;/,
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 480px\) \{[\s\S]*?\.composer-model-label \{\s*display: block;/,
  );
  assert.match(controlStylesSource, /composer-model-label min-w-0 truncate/);
  assert.match(
    stylesSource,
    /@media \(max-width: 480px\) \{[\s\S]*?\.composer-model-trigger > svg:last-child \{\s*display: block;/,
  );
});

test("sandbox control is icon-only and sits before the model picker", () => {
  assert.match(safetySelectorSource, /composer-safety-trigger/);
  assert.match(safetySelectorSource, /w-8 justify-center gap-0 px-0/);
  assert.doesNotMatch(safetySelectorSource, /COMPOSER_CONTROL_LABEL_CLASS/);
  assert.doesNotMatch(safetySelectorSource, /ChevronDown/);
  assert.ok(
    composerSource.indexOf("<CommandSafetyModeSelector") <
      composerSource.indexOf("<ComposerModelControls"),
  );
  assert.match(
    stylesSource,
    /@media \(max-width: 480px\) \{[\s\S]*?\.composer-safety-trigger \{[\s\S]*?width: 2rem;[\s\S]*?padding-inline: 0;/,
  );
});

test("model picker does not autofocus search on touch", () => {
  assert.match(modelControlsSource, /initialFocus=\{resolveModelPickerInitialFocus\}/);
  assert.match(modelControlsSource, /openType === "touch"/);
  assert.match(modelControlsSource, /\(hover: none\) and \(pointer: coarse\)/);
  assert.match(modelControlsSource, /return popoverContentRef\.current \?\? false;/);
  assert.match(modelControlsSource, /return searchInputRef\.current;/);
});
