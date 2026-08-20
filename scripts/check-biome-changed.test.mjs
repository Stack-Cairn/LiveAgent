import assert from "node:assert/strict";
import test from "node:test";

import { selectChangedSourceFiles } from "./check-biome-changed.mjs";

test("selectChangedSourceFiles keeps supported source files and sorts without duplicates", () => {
  assert.deepEqual(
    selectChangedSourceFiles("crates/agent-ui", [
      "crates/agent-ui/src/z.tsx",
      "crates/agent-ui/package.json",
      "crates/agent-ui/src/a.css",
      "crates/agent-ui/src/z.tsx",
      "crates/agent-gui/src/foreign.ts",
      "crates/agent-ui/src/image.png",
    ]),
    ["crates/agent-ui/src/a.css", "crates/agent-ui/src/z.tsx"],
  );
});
