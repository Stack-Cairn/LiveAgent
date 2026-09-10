import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const overlay = loader.loadModule(
  "@liveagent/ui/components/chat/MentionComposerOverlays.tsx",
);
const { resolveMentionPopupHorizontalLayout } = loader.loadModule(
  "@liveagent/ui/lib/chat/mentionPopupLayout.ts",
);
const source = readFileSync(
  new URL(
    "../../../agent-ui/src/components/chat/MentionComposerOverlays.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("mention popup list stays compact and adapts to the room above the composer", () => {
  assert.equal(overlay.resolveMentionPopupListMaxHeight(1_000), 240);
  assert.equal(overlay.resolveMentionPopupListMaxHeight(170), 116);
  assert.equal(overlay.resolveMentionPopupListMaxHeight(80), 76);
});

test("mention popup rows keep file names aligned with their icons", () => {
  assert.match(source, /group flex h-38px[^"\n]*text-left/);
  assert.doesNotMatch(source, /mention-popup-item/);
  assert.doesNotMatch(source, /max-h-320px/);
});

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

test("popup utilities leave its width to the measured composer layout", () => {
  const popup = source.match(/className=\{cn\([\s\S]*?\)\}/)?.[0] ?? "";
  assert.match(popup, /origin-bottom min-w-0/);
  assert.doesNotMatch(popup, /(?:min-w-|w-)380px/);
});
