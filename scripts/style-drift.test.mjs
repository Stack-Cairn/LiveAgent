import assert from "node:assert/strict";
import test from "node:test";
import { compactClasses } from "./lib/style-classes.mjs";
import { newStyleIssues } from "./check-style-drift.mjs";
import { tokenGroups } from "./sync-style-tokens.mjs";

test("exact shorthands preserve prefixes and avoid overlapping axes", () => {
  assert.equal(compactClasses("hover:px-4 hover:py-4 gap-x-2 gap-y-2").value, "hover:p-4 gap-2");
  assert.equal(compactClasses("top-0 bottom-0 left-0 right-0").value, "inset-0");
  assert.equal(compactClasses("[&>svg]:h-full! [&>svg]:w-full!").value, "[&>svg]:size-full!");
  for (const value of [
    "px-4 py-4 pt-2",
    "h-4 md:w-4",
    "h-4 w-4!",
    "gap-x-2 gap-y-3",
    "left-0 right-0 start-2",
    "px-4 py-4 p-1",
  ])
    assert.equal(compactClasses(value).value, value);
});
test("incremental checks report additions without requiring unrelated cleanup", () => {
  const before = 'const a = "h-4 w-4";';
  assert.deepEqual(
    newStyleIssues("crates/agent-ui/src/a.tsx", before, before + '\nconst b = "flex";'),
    [],
  );
  assert.equal(
    newStyleIssues("crates/agent-ui/src/a.tsx", before, before + '\nconst b = "h-4 w-4";').length,
    1,
  );
  assert.equal(newStyleIssues("crates/agent-ui/src/a.tsx", "", 'const a="text-[14px]";').length, 1);
});
test("animation location and primitive aliases have explicit contracts", () => {
  const frame = "@keyframes hello {to{opacity:1}}";
  assert.equal(newStyleIssues("crates/agent-ui/src/styles/local.css", "", frame).length, 1);
  assert.equal(newStyleIssues("crates/agent-ui/src/styles/animations.css", "", frame).length, 0);
  assert.equal(
    newStyleIssues(
      "crates/agent-ui/src/styles/tokens.css",
      "",
      ":root{--ui-duration-a:120ms;--ui-duration-b:120ms}",
    ).length,
    1,
  );
  assert.equal(
    newStyleIssues(
      "crates/agent-ui/src/styles/tokens.css",
      "",
      ":root{--ui-duration-a:120ms;--ui-duration-b:var(--ui-duration-a)}",
    ).length,
    0,
  );
});
test("new theme names are discovered without adding merger prefixes", () => {
  assert.deepEqual(
    tokenGroups(
      "@theme inline{--shadow-new-menu:0 1px red;--background-image-new-fill:linear-gradient(red,blue);--drop-shadow-new-icon:0 1px red}:root{--shadow-private:0 2px red}",
    ),
    { shadow: ["new-menu"], backgroundImage: ["new-fill"], dropShadow: ["new-icon"] },
  );
});
