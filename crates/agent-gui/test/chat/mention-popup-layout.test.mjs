import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { resolveMentionPopupHorizontalLayout } = createTsModuleLoader().loadModule(
  "@liveagent/ui/lib/chat/mentionPopupLayout.ts",
);

test("narrow workbench panes keep the popup at the composer width", () => {
  assert.deepEqual(resolveMentionPopupHorizontalLayout({ left: 16, width: 288 }, 1200), {
    left: 16,
    width: 288,
  });
});

test("the rightmost pane is clamped inside the viewport", () => {
  assert.deepEqual(resolveMentionPopupHorizontalLayout({ left: 930, width: 288 }, 1200), {
    left: 900,
    width: 288,
  });
});

test("extremely narrow viewports still return a renderable layout", () => {
  const layout = resolveMentionPopupHorizontalLayout({ left: 0, width: 380 }, 8);
  assert.deepEqual(layout, { left: 3.5, width: 1 });
  assert.ok(layout.left + layout.width <= 8);
});

test("popup CSS no longer overrides the measured composer width", () => {
  const css = readFileSync(
    new URL("../../../agent-ui/src/styles/common-settings.css", import.meta.url),
    "utf8",
  );
  const rule = css.match(/\.mention-popup-enter \{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(rule, /min-width:\s*0/);
  assert.doesNotMatch(rule, /380px/);
});
