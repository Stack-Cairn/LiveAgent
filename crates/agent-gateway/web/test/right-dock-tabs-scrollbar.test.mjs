import { styleDeclarations, styleRules } from "./helpers/style-rules.mjs";
import { readStyleSource } from "../../../../scripts/test-style-values.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesSource = readStyleSource(new URL("../src/styles/base-chat.css", import.meta.url));
const dockSource = readFileSync(new URL("../../../agent-ui/src/components/project-tools/RightDockPanel.tsx", import.meta.url), "utf8");

test("WebUI right dock hides the native tabs scrollbar behind its custom scrollbar", () => {
  const selector = 'html[data-liveagent-webui="gateway"] .project-tools-panel-tabs';
  const declarations = styleDeclarations(stylesSource, selector);
  assert.equal(declarations["scrollbar-width"], "none");
  assert.equal(declarations["-ms-overflow-style"], "none");
  const scrollbar = styleDeclarations(stylesSource, selector + "::-webkit-scrollbar");
  assert.equal(scrollbar.display, "none");
  assert.equal(scrollbar.width, "0");
  assert.equal(scrollbar.height, "0");
  assert.ok(
    styleRules(stylesSource, selector)[0].source.start.offset >
      styleRules(stylesSource, 'html[data-liveagent-webui="gateway"] *')[0].source.start.offset,
    "the tabs override must follow the WebUI-wide scrollbar rule",
  );
  assert.match(dockSource, /scrollbar\.visible && "opacity-100 pointer-events-auto"/);
});
