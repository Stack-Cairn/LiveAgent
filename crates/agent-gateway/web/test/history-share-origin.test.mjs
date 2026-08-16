import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const gatewayAppSource = readFileSync(
  new URL("../src/app/GatewayAppView.tsx", import.meta.url),
  "utf8",
);

test("WebUI share modals use the browser origin", () => {
  const historyShareModal = gatewayAppSource.match(
    /<HistoryShareModal[\s\S]*?\/>/,
  )?.[0];
  const sharedHistoryManagerModal = gatewayAppSource.match(
    /<SharedHistoryManagerModal[\s\S]*?\/>/,
  )?.[0];

  assert.ok(historyShareModal);
  assert.ok(sharedHistoryManagerModal);
  assert.doesNotMatch(historyShareModal, /shareOrigin(?:Port)?=/);
  assert.doesNotMatch(sharedHistoryManagerModal, /shareOrigin(?:Port)?=/);
});
