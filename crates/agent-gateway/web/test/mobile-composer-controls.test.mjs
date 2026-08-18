import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesSource = readFileSync(new URL("../src/styles/base-chat.css", import.meta.url), "utf8");
const controlStylesSource = readFileSync(
  new URL("../../../agent-ui/src/lib/chat/composerControlStyles.ts", import.meta.url),
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
