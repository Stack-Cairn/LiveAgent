// A browser whose selected Agent is offline gets an actionable status row:
// which target is offline and a one-click switch to a working target, never
// the raw "agent offline" / settings.get timeout text.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import * as jsxRuntime from "react/jsx-runtime";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const icon = () => null;
const loader = createWebModuleLoader({
  rootDir,
  mocks: {
    react: React,
    "react/jsx-runtime": jsxRuntime,
    "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => icon }),
  },
});
const banners = loader.loadModule("src/app/GatewayChatStatusBanners.tsx");
const { WEBUI_TRANSLATION_OVERRIDES } = loader.loadModule("src/i18n/config.ts");

const desktop = { agent_id: "agent-desktop", name: "Studio desktop", online: false };
const relay = { agent_id: "kbrain-relay", name: "K-brain", online: true, agent_ready: true };
const offlineStatus = { agent_id: "agent-desktop", online: false };

function render(element) {
  return renderToStaticMarkup(element);
}

function bannersFor(props) {
  return render(
    jsxRuntime.jsx(banners.GatewayChatStatusBanners, {
      api: {
        retryConnectionNow() {},
        setActiveAgent() {},
        getActiveAgent: () => "",
        subscribeAgents: () => () => {},
        listAgents: async () => [],
      },
      gatewayDisconnected: false,
      targetOffline: null,
      onSwitchAgent() {},
      statusError: null,
      chatProtocolIncompatibleMessage: null,
      settingsSyncError: null,
      chatError: null,
      ...props,
    }),
  );
}

test("an offline stored target offers the online chat target", () => {
  const target = banners.resolveGatewayTargetOffline({
    agents: [desktop, relay],
    activeAgentId: "agent-desktop",
    status: offlineStatus,
    gatewayDisconnected: false,
  });
  assert.deepEqual(target, {
    name: "Studio desktop",
    alternative: { id: "kbrain-relay", name: "K-brain" },
  });
  const html = bannersFor({
    targetOffline: target,
    statusError: "agent offline",
    settingsSyncError: "Gateway WebSocket request timed out: settings.get",
  });
  assert.match(html, /role="status"/);
  assert.match(html, /Studio desktop/);
  assert.match(html, /<button[^>]*>[^<]*K-brain<\/button>/);
  assert.doesNotMatch(html, /agent offline|settings\.get|Update LiveAgent/);
});

test("without an alternative the row says what to do", () => {
  const target = banners.resolveGatewayTargetOffline({
    agents: [desktop],
    activeAgentId: "agent-desktop",
    status: offlineStatus,
    gatewayDisconnected: false,
  });
  assert.equal(target.alternative, null);
  const html = bannersFor({ targetOffline: target });
  assert.doesNotMatch(html, /<button/);
  assert.match(html, /Studio desktop/);
});

test("an online target, or a dropped Gateway connection, is not an offline target", () => {
  const base = { agents: [desktop, relay], activeAgentId: "kbrain-relay", gatewayDisconnected: false };
  assert.equal(banners.resolveGatewayTargetOffline({ ...base, status: relay }), null);
  assert.equal(
    banners.resolveGatewayTargetOffline({
      ...base,
      activeAgentId: "agent-desktop",
      status: offlineStatus,
      gatewayDisconnected: true,
    }),
    null,
    "while reconnecting the last status is stale; the connection banner explains it",
  );
});

test("unrelated runtime errors are still shown when the target is online", () => {
  const html = bannersFor({ statusError: "model rejected the request" });
  assert.match(html, /model rejected the request/);
  const transport = bannersFor({
    statusError: "Gateway WebSocket disconnected (code=1006 clean=false)",
    gatewayDisconnected: true,
  });
  assert.doesNotMatch(transport, /code=1006/);
});

test("offline target strings exist in both locales", () => {
  for (const locale of ["en-US", "zh-CN"]) {
    for (const key of [
      "gatewayWeb.target.offline",
      "gatewayWeb.target.offlineWithAlternative",
      "gatewayWeb.target.switchTo",
    ]) {
      const text = WEBUI_TRANSLATION_OVERRIDES[locale][key];
      assert.ok(text?.includes("{name}"), `${locale} ${key}`);
    }
  }
});

test("a stored target that reports offline loads the Agent directory for the banner", async (t) => {
  // A stored target skips the startup agent_list, so without this fetch the
  // banner has neither the target's name nor an alternative to offer.
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  const restore = [];
  for (const key of ["window", "document", "navigator", "HTMLElement", "Element", "Node"]) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value: dom.window[key] });
    restore.push(() =>
      original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key],
    );
  }
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  t.after(() => {
    for (const undo of restore) undo();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
  });

  const listeners = new Set();
  let listCalls = 0;
  const api = {
    getActiveAgent: () => "agent-desktop",
    setActiveAgent() {},
    subscribeAgents(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async listAgents() {
      listCalls += 1;
      for (const listener of listeners) listener([desktop, relay]);
      return [desktop, relay];
    },
  };
  const seen = { current: null };
  function Probe({ offline }) {
    const agents = banners.useGatewayAgentDirectory(api, offline);
    seen.current = banners.resolveGatewayTargetOffline({
      agents,
      activeAgentId: "agent-desktop",
      status: offline ? offlineStatus : { ...offlineStatus, online: true },
      gatewayDisconnected: false,
    });
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(React.createElement(Probe, { offline: false })));
  assert.equal(listCalls, 0, "an online target needs no directory fetch");
  await act(async () => root.render(React.createElement(Probe, { offline: true })));
  await act(async () => {
    await Promise.resolve();
  });
  assert.equal(listCalls, 1);
  assert.deepEqual(seen.current, {
    name: "Studio desktop",
    alternative: { id: "kbrain-relay", name: "K-brain" },
  });
  await act(async () => root.unmount());
});
