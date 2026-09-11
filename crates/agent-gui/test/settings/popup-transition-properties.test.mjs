import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../../package.json", import.meta.url));

test("popup transitions include Tailwind v4's independent scale and translate properties", async () => {
  const sources = [
    ["../../../agent-ui/src/components/ui/popover.tsx", ["scale", "opacity"]],
    ["../../../agent-ui/src/components/git/GitBranchSelector.tsx", ["scale", "translate", "opacity"]],
  ];
  for (const [path, properties] of sources) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    const candidates = source.match(/transition-\[[^\]]+\]/g) ?? [];
    const result = await require("postcss")([
      require("@tailwindcss/postcss")({ optimize: false }),
    ]).process(
      '@import "tailwindcss" source(none);\n@source inline(' + JSON.stringify(candidates.join(" ")) + ');',
      { from: new URL("../../src/popup-transition-check.css", import.meta.url).pathname },
    );
    const transitions = [];
    result.root.walkDecls("transition-property", (decl) => transitions.push(decl.value.split(",").map((v) => v.trim())));
    assert.ok(transitions.some((values) => properties.every((p) => values.includes(p))),
      `${path}: exiting popup must transition ${properties.join(", ")}`);
  }
});
