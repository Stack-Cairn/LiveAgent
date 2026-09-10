import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockSource = readFileSync(new URL("../../../agent-ui/src/components/project-tools/RightDockPanel.tsx", import.meta.url), "utf8");

test("WebUI right dock hides the native tabs scrollbar behind its custom scrollbar", () => {
  assert.match(dockSource, /project-tools-panel-tabs[^"\n]*\[scrollbar-width:none\]/);
  assert.match(dockSource, /project-tools-panel-tabs[^"\n]*\[-ms-overflow-style:none\]/);
  assert.match(dockSource, /project-tools-panel-tabs[^"\n]*\[&::-webkit-scrollbar\]:hidden/);
  assert.match(dockSource, /project-tools-panel-tabs-scrollbar-thumb[^"\n]*min-w-28px/);
  assert.match(dockSource, /scrollbar\.visible && "opacity-100 pointer-events-auto"/);
});
