import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { cn } from "../../../agent-ui/src/lib/shared/utils.ts";
import styleTokenNames from "../../../agent-ui/src/lib/shared/style-token-names.generated.json" with {
  type: "json",
};
import { syncStyleTokens } from "../../../../scripts/sync-style-tokens.mjs";
const require = createRequire(new URL("../../package.json", import.meta.url));
test("every registered composite utility compiles and preserves caller colors", async () => {
  syncStyleTokens(true);
  const groups = [
    {
      names: styleTokenNames.shadow,
      prefix: "shadow",
      replacement: "shadow-none",
      color: "shadow-red-500",
    },
    {
      names: styleTokenNames.backgroundImage,
      prefix: "bg",
      replacement: "bg-none",
      color: "bg-red-500",
    },
    {
      names: styleTokenNames.dropShadow,
      prefix: "drop-shadow",
      replacement: "drop-shadow-none",
      color: "drop-shadow-red-500",
    },
  ];
  const candidates = groups.flatMap((g) => g.names.map((n) => g.prefix + "-" + n));
  const result = await require("postcss")([
    require("@tailwindcss/postcss")({ optimize: false }),
  ]).process(
    '@import "tailwindcss" source(none);\n@import "../../agent-ui/src/styles/tokens.css";\n@source inline(' +
      JSON.stringify(candidates.join(" ")) +
      ");",
    { from: new URL("../../src/style-token-contract.css", import.meta.url).pathname },
  );
  const selectors = new Set();
  result.root.walkRules((r) => selectors.add(r.selector));
  for (const g of groups)
    for (const name of g.names) {
      const utility = g.prefix + "-" + name;
      assert.ok(selectors.has("." + utility), utility + " must compile");
      assert.equal(cn(g.color, utility), g.color + " " + utility);
      assert.equal(cn(utility, g.replacement), g.replacement);
      assert.equal(cn(g.replacement, utility), utility);
    }
});
