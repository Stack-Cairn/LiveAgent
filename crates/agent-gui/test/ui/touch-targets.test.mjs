import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readUi = (path) =>
  readFileSync(new URL(`../../../agent-ui/src/${path}`, import.meta.url), "utf8");

// Rules nested under `@media (pointer: coarse)` inside the given cascade layer.
function coarseRules(css, layer) {
  const start = css.indexOf(`@layer ${layer} {\n  @media (pointer: coarse) {`);
  assert.notEqual(start, -1, `coarse-pointer block in @layer ${layer}`);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index++) {
    if (css[index] === "{") depth++;
    if (css[index] === "}" && --depth === 0) return css.slice(start, index + 1);
  }
  throw new Error("unbalanced CSS block");
}

test("coarse pointers get 44px hit areas without resizing the controls", () => {
  const css = readUi("styles/base.css");
  const base = coarseRules(css, "base");
  assert.match(base, /--touch-target-min:\s*2\.75rem/);
  // The hit area is an invisible ::before centred on the control, and never on
  // a host kept static (it would anchor to some ancestor instead).
  assert.match(
    base,
    /:is\(\.touch-hit, \.composer-toolbar-action\):not\(\.static\)::before\s*\{\s*content: "";\s*position: absolute;\s*inset: min\(0px, calc\(50% - var\(--touch-target-min\) \/ 2\)\);/,
  );
  assert.doesNotMatch(base, /background|border|box-shadow/, "the hit area stays invisible");

  // Edge-to-edge sidebar rows grow instead of overlapping each other.
  assert.match(
    css,
    /@utility sidebar-list-row \{\s*height: max\(var\(--touch-target-min, 0px\), calc\(/,
  );

  const utilities = coarseRules(css, "utilities");
  assert.match(utilities, /column-gap: 0\.75rem/, "neighbouring icon buttons spread apart");
  assert.match(utilities, /\.composer-control-deck[\s\S]*?min-height: var\(--touch-target-min\)/);
  assert.match(
    utilities,
    /\.mention-composer:is\(\[role="textbox"\]\) \{\s*font-size: max\(1rem, var\(--text-sm\)\);/,
    "16px composer text keeps mobile browsers from zooming on focus",
  );
});

test("shared buttons and sidebar actions opt into the touch hit area", () => {
  assert.match(readUi("components/ui/button.tsx"), /cva\(\s*"touch-hit /);
  const sidebar = readUi("components/ui/sidebar.tsx");
  assert.equal(sidebar.match(/"touch-hit /g)?.length, 3, "group label, group action, menu action");
  // Row actions stay in flow but positioned, so their hit area anchors to them.
  const rows = readUi("components/chat/ChatHistorySidebarRows.tsx");
  assert.doesNotMatch(rows, /PROJECT_ICON_BUTTON_CLASS, "static after:hidden"/);
});

test("the empty-state greeting wraps and its suggestions are content-sized", () => {
  const source = readUi("components/chat/ChatEmptyState.tsx");
  const greeting = source.match(/<div className="([^"]*)">\s*\{t\("chat\.greetingTemplate"\)/)?.[1];
  assert.ok(greeting, "greeting element");
  assert.doesNotMatch(greeting, /whitespace-nowrap|truncate/);
  assert.match(greeting, /text-balance/);
  assert.match(source, /flex w-full max-w-640px flex-wrap justify-center/);
  assert.doesNotMatch(source, /grid-cols-3/);
});
