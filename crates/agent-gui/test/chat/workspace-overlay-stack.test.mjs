import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("../../", import.meta.url)),
  mocks: {
    "../components/MacOsTitleBarSpacer": { MacOsTitleBarSpacer: () => null },
    "../lib/system/clipboardText": { readClipboardText: async () => null },
  },
});

const { workspaceOverlayStackClassName } = loader.loadModule(
  "@liveagent/adapters/workspacePreview",
);

test("desktop workspace overlays stay above desktop chrome", () => {
  assert.equal(workspaceOverlayStackClassName, "z-50");
});
