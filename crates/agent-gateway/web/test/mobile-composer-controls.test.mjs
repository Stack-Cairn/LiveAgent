import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

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
    controlStylesSource,
    /web:max-480:w-auto[^"\n]*web:max-480:min-w-0[^"\n]*web:max-480:flex-1/,
  );
  assert.match(
    controlStylesSource,
    /web:max-480:block/,
  );
  assert.match(controlStylesSource, /min-w-0 truncate/);
  assert.match(
    controlStylesSource,
    /web:max-480:\[&_>svg:last-child\]:block/,
  );
});

test("sandbox control is icon-only and sits before the model picker", () => {
  assert.match(safetySelectorSource, /web:max-480:flex-none/);
  assert.match(safetySelectorSource, /w-8 justify-center gap-0 px-0/);
  assert.doesNotMatch(safetySelectorSource, /COMPOSER_CONTROL_LABEL_CLASS/);
  assert.doesNotMatch(safetySelectorSource, /ChevronDown/);
  assert.ok(
    composerSource.indexOf("<CommandSafetyModeSelector") <
      composerSource.indexOf("<ComposerModelControls"),
  );
  assert.match(
    safetySelectorSource,
    /web:max-480:w-8[^"\n]*web:max-480:px-0/,
  );
});

test("model picker does not autofocus search on touch", () => {
  assert.match(modelControlsSource, /initialFocus=\{resolveModelPickerInitialFocus\}/);
  assert.match(modelControlsSource, /openType === "touch"/);
  assert.match(modelControlsSource, /\(hover: none\) and \(pointer: coarse\)/);
  assert.match(modelControlsSource, /return popoverContentRef\.current \?\? false;/);
  assert.match(modelControlsSource, /return searchInputRef\.current;/);
});
