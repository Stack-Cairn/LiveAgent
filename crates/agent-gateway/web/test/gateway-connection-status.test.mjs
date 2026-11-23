// A dropped Gateway connection is connection status, not a chat error: the
// banner is a translated live region with a manual retry, the avatar dot stops
// claiming "online", and the raw WebSocket close text is never shown.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const icon = () => null;
const loader = createWebModuleLoader({
  rootDir,
  mocks: {
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
  },
});
const { GatewayConnectionBannerView } = loader.loadModule("src/app/GatewayConnectionBanner.tsx");
const transportErrors = loader.loadModule("src/lib/gatewayTransportErrors.ts");
const { WEBUI_TRANSLATION_OVERRIDES } = loader.loadModule("src/i18n/config.ts");

function renderBanner(props) {
  return renderToStaticMarkup(
    jsxRuntime.jsx(GatewayConnectionBannerView, {
      label: "",
      retryLabel: "Retry now",
      ...props,
    }),
  );
}

test("the disconnected banner is a polite status region with a retry button", () => {
  const html = renderBanner({
    state: "disconnected",
    label: "Connection lost. Reconnecting…",
    onRetryNow() {},
  });
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Connection lost\. Reconnecting…/);
  assert.match(html, /<button[^>]*>Retry now<\/button>/);
  assert.doesNotMatch(html, /code=1006|WebSocket/);
});

test("the reconnected flash has no retry button and the idle region stays mounted", () => {
  const reconnected = renderBanner({ state: "reconnected", label: "Reconnected", onRetryNow() {} });
  assert.match(reconnected, /Reconnected/);
  assert.doesNotMatch(reconnected, /<button/);
  const hidden = renderBanner({ state: "hidden" });
  assert.match(hidden, /role="status"/);
  assert.doesNotMatch(hidden, /Reconnect/);
});

test("connection strings are translated in both locales", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const key of [
      "gatewayWeb.connection.lost",
      "gatewayWeb.connection.reconnected",
      "gatewayWeb.connection.retryNow",
      "gatewayWeb.connection.reconnecting",
      "gatewayWeb.connection.sendBlocked",
    ]) {
      assert.ok(WEBUI_TRANSLATION_OVERRIDES[locale][key], `${locale} ${key}`);
    }
  }
  assert.equal(
    WEBUI_TRANSLATION_OVERRIDES["en-US"]["gatewayWeb.connection.lost"],
    "Connection lost. Reconnecting…",
  );
});

test("socket-level failures are classified as transport failures, server errors are not", () => {
  for (const message of [
    "Gateway WebSocket disconnected (code=1006 clean=false)",
    "Gateway WebSocket is not connected",
    "Gateway WebSocket connection timed out",
    "Gateway WebSocket auth timed out",
    "Gateway transport stalled",
    transportErrors.GATEWAY_RECONNECTING_NOTICE,
  ]) {
    assert.equal(transportErrors.isGatewayTransportFailure(new Error(message)), true, message);
  }
  for (const message of ["agent offline", "model rejected the request", ""]) {
    assert.equal(transportErrors.isGatewayTransportFailure(new Error(message)), false, message);
  }
  // The reconnect notice is an internal sentinel, not user-facing Chinese copy.
  assert.doesNotMatch(transportErrors.GATEWAY_RECONNECTING_NOTICE, /[一-鿿]/);
});

test("the avatar dot is grey and says reconnecting while the connection is down", () => {
  const { UserMenu } = loader.loadModule("src/app/UserMenu.tsx");
  const render = (agentStatus) =>
    renderToStaticMarkup(
      jsxRuntime.jsx(UserMenu, {
        open: false,
        onOpenChange() {},
        userMenuLabel: "Account",
        userAvatarLabel: "A",
        agentStatus,
        onLogout() {},
      }),
    );
  const reconnecting = render("reconnecting");
  assert.doesNotMatch(reconnecting, /bg-success/);
  assert.match(reconnecting, /bg-muted-foreground\/50/);
  assert.match(reconnecting, /title="Account · (正在重新连接…|Reconnecting…)"/);
  assert.match(render("online"), /bg-success/);
});
