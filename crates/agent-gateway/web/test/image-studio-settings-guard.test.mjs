import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

test("WebUI settings close actions honor the image settings leave guard and release it on unmount", () => {
  let closes = 0;
  const loader = createWebModuleLoader({ mocks: {
    react: { useState: (value) => [value, () => {}], useRef: (value) => ({ current: value }), useCallback: (fn) => fn },
    "@liveagent/ui/lib/settings/useSettingsOverlay": { useSettingsOverlay: () => ({ closeSettingsOverlay: () => closes++ }) },
    "../historyUtils": { isMobileSidebarLayout: () => false },
  } });
  const { useGatewaySettingsOverlay } = loader.loadModule("src/app/hooks/useGatewaySettingsOverlay.ts");
  const overlay = useGatewaySettingsOverlay(() => {});
  const release = overlay.registerSettingsLeaveGuard(() => false);
  overlay.closeSettings();
  assert.equal(closes, 0);
  const releaseReplacement = overlay.registerSettingsLeaveGuard(() => false);
  release();
  overlay.closeSettings();
  assert.equal(closes, 0, "stale cleanup must not clear a new guard");
  releaseReplacement();
  overlay.closeSettings();
  assert.equal(closes, 1);
  overlay.registerSettingsLeaveGuard(() => true);
  overlay.closeSettings();
  assert.equal(closes, 2);
});
