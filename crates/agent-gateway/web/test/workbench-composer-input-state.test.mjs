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
  assert.match(handler, /if \(composerInputDisabled \|\| gatewayDisconnected\) return;/);
  assert.doesNotMatch(handler, /workbenchHasMultiplePanes\s*\?/);
});

test("a send that is not accepted puts the draft back instead of losing it", () => {
  const source = readFileSync(`${rootDir}/src/app/GatewayAppView.tsx`, "utf8");
  const handler = source.match(
    /const handlePrimaryComposerSend = useCallback\(\(\) => \{[\s\S]*?\n  \}, \[/,
  )?.[0];
  assert.ok(handler);
  // The composer is cleared before the command is acknowledged, so a failed
  // or skipped outcome (connection dropped, already pending) must restore it.
  assert.match(handler, /restoreUnsentComposerDraft\(composerRef\.current, draft\)/);
  assert.match(handler, /if \(!outcome \|\| outcome\.kind === "failed"\) restoreDraft\(\);/);
  const actions = readFileSync(`${rootDir}/src/app/gatewayChatCommandActions.ts`, "utf8");
  // The cached draft is only dropped after the Gateway took the command.
  assert.match(
    actions,
    /await chatCommandPipeline\.submit\([\s\S]*?if \(outcome\.kind !== "failed"\) clearCachedComposerDraft\(activeConversationId\);/,
  );
  // Background panes block sends while reconnecting too.
  const paneHost = readFileSync(`${rootDir}/src/app/workbench/GatewayConversationPaneHost.tsx`, "utf8");
  assert.match(paneHost, /context\.transportInputDisabled \|\| context\.sendBlockedReason/);
  assert.match(paneHost, /sendBlockedReason=\{context\.sendBlockedReason\}/);
  assert.match(paneHost, /restoreUnsentComposerDraft\(composerRef\.current, draft\)/);
});

test("restoring an unsent draft never overwrites newer typing", () => {
  const { restoreUnsentComposerDraft } = loader.loadModule("src/app/unsentComposerDraft.ts");
  const restored = [];
  const composer = (hasContent) => ({ hasContent: () => hasContent, setDraft: (d) => restored.push(d) });
  restoreUnsentComposerDraft(composer(false), { segments: [{ type: "text", text: "kept" }] });
  restoreUnsentComposerDraft(composer(true), { segments: [{ type: "text", text: "lost" }] });
  restoreUnsentComposerDraft(composer(false), null);
  assert.deepEqual(restored, [{ segments: [{ type: "text", text: "kept" }] }]);
});
