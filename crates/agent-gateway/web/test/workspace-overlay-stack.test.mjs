import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { workspaceOverlayStackClassName } = loader.loadModule(
  "@liveagent/adapters/workspacePreview",
);

test("web workspace overlays keep the web shell stacking level", () => {
  assert.equal(workspaceOverlayStackClassName, "z-40");
});
