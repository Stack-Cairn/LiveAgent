import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { resolveWorkbenchComposerInputDisabled } = loader.loadModule(
  "src/app/workbench/composerInputState.ts",
);

function disabled(overrides = {}) {
  return resolveWorkbenchComposerInputDisabled({
    isPrimary: true,
    primaryInputDisabled: false,
    transportInputDisabled: false,
    conversationIsCompacting: false,
    ...overrides,
  });
}

test("primary workbench composer preserves page loading and transport locks", () => {
  assert.equal(disabled(), false);
  assert.equal(disabled({ primaryInputDisabled: true }), true);
  assert.equal(disabled({ transportInputDisabled: true }), true);
  assert.equal(disabled({ conversationIsCompacting: true }), true);
});

test("background workbench composer only inherits shared and per-conversation locks", () => {
  assert.equal(disabled({ isPrimary: false, primaryInputDisabled: true }), false);
  assert.equal(disabled({ isPrimary: false, transportInputDisabled: true }), true);
  assert.equal(disabled({ isPrimary: false, conversationIsCompacting: true }), true);
});

test("primary send handler cannot bypass the same page-level disabled state in multi Pane mode", () => {
  const source = readFileSync(`${rootDir}/src/app/GatewayAppView.tsx`, "utf8");
  const handler = source.match(
    /const handlePrimaryComposerSend = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
  )?.[0];
  assert.ok(handler);
  assert.match(handler, /if \(composerInputDisabled\) return;/);
  assert.doesNotMatch(handler, /workbenchHasMultiplePanes\s*\?/);
});
