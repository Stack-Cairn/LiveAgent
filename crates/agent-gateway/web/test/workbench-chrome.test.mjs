import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gatewayAppViewSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);

test("gateway mounts workbench chrome outside the shared application view", () => {
  assert.match(gatewayAppViewSource, /<main className="gateway-main-shell">/);
  assert.match(
    gatewayAppViewSource,
    /<AppWorkbenchChrome[\s\S]*?<ApplicationView/,
  );
  assert.doesNotMatch(gatewayAppViewSource, /chat=\{\{[\s\S]*?headerOverlay:/);
});
