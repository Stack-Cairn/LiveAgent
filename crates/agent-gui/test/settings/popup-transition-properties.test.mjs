import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(new URL("../../package.json", import.meta.url));

test("popup transitions include Tailwind v4's independent scale and translate properties", async () => {
  const sources = [
    ["../../../agent-ui/src/components/ui/popover.tsx", ["scale", "opacity"]],
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


test("branch menu inherits shared dropdown animation without a second transition", () => {
  const source = readFileSync(new URL("../../../agent-ui/src/components/git/GitBranchSelector.tsx", import.meta.url), "utf8");
  const popup = source.slice(source.indexOf("<DropdownMenuContent"), source.indexOf("</DropdownMenuContent>"));
  assert.doesNotMatch(popup, /data-\[starting-style\]|data-\[ending-style\]/);
  const primitive = readFileSync(new URL("../../../agent-ui/src/components/ui/dropdown-menu.tsx", import.meta.url), "utf8");
  assert.match(primitive, /data-\[open\]:animate-in/);
  assert.match(primitive, /data-\[closed\]:animate-out/);
});
