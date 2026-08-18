import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gatewayAppViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);
const baseChatStyles = readFileSync(
  new URL("../src/styles/base-chat.css", import.meta.url),
  "utf8",
);
const responsiveStyles = readFileSync(
  new URL("../src/styles/responsive.css", import.meta.url),
  "utf8",
);

test("gateway mounts workbench chrome outside the shared application view", () => {
  assert.match(gatewayAppViewSource, /<main className="gateway-main-shell">/);
  assert.match(
    gatewayAppViewSource,
    /<AppWorkbenchChrome[\s\S]*?<ApplicationView/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /chat=\{\{[\s\S]*?headerOverlay:/);
  assert.match(baseChatStyles, /\.gateway-main-shell \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
});

test("mobile sidebar stays above the interactive workbench header", () => {
  assert.match(
    responsiveStyles,
    /@media \(max-width: 820px\) \{[\s\S]*?\.gateway-main-shell \[data-app-workbench-chrome\] \{\s*z-index: var\(--layer-raised\);/,
  );
  assert.match(
    responsiveStyles,
    /@media \(max-width: 820px\) \{[\s\S]*?\.gateway-editor-host > \.chat-history-sidebar \{[\s\S]*?z-index: var\(--layer-panel\);/,
  );
});
