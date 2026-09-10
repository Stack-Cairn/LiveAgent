import { readStyleSource } from "../../../../scripts/test-style-values.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stylesSource = readStyleSource(new URL("../src/styles/base-chat.css", import.meta.url));
const dockSource = readFileSync(new URL("../../../agent-ui/src/components/project-tools/RightDockPanel.tsx", import.meta.url), "utf8");

test("WebUI right dock hides the native tabs scrollbar behind its custom scrollbar", () => {
  assert.match(
    stylesSource,
    /html\[data-liveagent-webui="gateway"\] \.project-tools-panel-tabs\s*{[^}]*scrollbar-width:\s*none;[^}]*-ms-overflow-style:\s*none;[^}]*}/s,
  );
  assert.match(
    stylesSource,
    /html\[data-liveagent-webui="gateway"\] \.project-tools-panel-tabs::\-webkit-scrollbar\s*{[^}]*display:\s*none;[^}]*width:\s*0;[^}]*height:\s*0;[^}]*}/s,
  );
  assert.ok(
    stylesSource.indexOf('html[data-liveagent-webui="gateway"] .project-tools-panel-tabs {') >
      stylesSource.indexOf('html[data-liveagent-webui="gateway"] * {'),
    "the tabs override must follow the WebUI-wide scrollbar rule",
  );
  assert.match(dockSource, /scrollbar\.visible && "opacity-100 pointer-events-auto"/);
});
