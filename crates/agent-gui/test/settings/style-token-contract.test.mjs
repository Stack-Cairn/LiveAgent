import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cn } from "../../../agent-ui/src/lib/shared/utils.ts";
import styleTokenNames from "../../../agent-ui/src/lib/shared/style-token-names.generated.json" with {
  type: "json",
};
const require = createRequire(new URL("../../package.json", import.meta.url));
const postcss = require("postcss");
const tokenSource = readFileSync(
  new URL("../../../agent-ui/src/styles/tokens.css", import.meta.url),
  "utf8",
);

function tokenGroups(source) {
  const result = { shadow: [], backgroundImage: [], dropShadow: [] };
  const namespaces = {
    "--shadow-": "shadow",
    "--background-image-": "backgroundImage",
    "--drop-shadow-": "dropShadow",
  };
  postcss.parse(source).walkAtRules("theme", (theme) => {
    theme.walkDecls((declaration) => {
      for (const [prefix, group] of Object.entries(namespaces)) {
        if (declaration.prop.startsWith(prefix)) result[group].push(declaration.prop.slice(prefix.length));
      }
    });
  });
  return Object.fromEntries(
    Object.entries(result).map(([key, values]) => [key, [...new Set(values)].sort()]),
  );
}

test("every registered composite utility compiles and preserves caller colors", async () => {
  assert.deepEqual(styleTokenNames, tokenGroups(tokenSource));
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
  const result = await postcss([
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
