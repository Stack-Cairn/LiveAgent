import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const { shouldRestorePageComposerDraft } = loader.loadModule(
  "src/app/workbench/pageComposerDraftRestore.ts",
);

test("workbench pane remains the sole draft owner after converging to one pane", () => {
  assert.equal(
    shouldRestorePageComposerDraft({
      workbenchEnabled: true,
      targetConversationId: "conversation-b",
      ownerConversationId: "conversation-a",
      composerHasContent: true,
    }),
    false,
  );
});

test("legacy page composer restores only for a changed owner or empty input", () => {
  assert.equal(
    shouldRestorePageComposerDraft({
      workbenchEnabled: false,
      targetConversationId: "conversation-b",
      ownerConversationId: "conversation-a",
      composerHasContent: true,
    }),
    true,
  );
  assert.equal(
    shouldRestorePageComposerDraft({
      workbenchEnabled: false,
      targetConversationId: "conversation-b",
      ownerConversationId: "conversation-b",
      composerHasContent: true,
    }),
    false,
  );
});
