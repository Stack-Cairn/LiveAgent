import assert from "node:assert/strict";
import test from "node:test";

import { biomeInvocation, selectChangedSourceFiles } from "./check-biome-changed.mjs";

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

test("CI warning gate uses installed pnpm without dropping strict checks", () => {
  const ci = biomeInvocation("@liveagent/ui", ["src/sidebar/store.ts"], true);
  const local = biomeInvocation("@liveagent/ui", ["src/sidebar/store.ts"], false);
  assert.equal(ci.command, "pnpm");
  assert.deepEqual(local, { command: "mise", args: ["exec", "--", "pnpm", ...ci.args] });
  assert.ok(ci.args.includes("--error-on-warnings"));
  assert.ok(ci.args.includes("--line-ending=lf"));
  assert.ok(ci.args.includes("src/sidebar/store.ts"));
});
