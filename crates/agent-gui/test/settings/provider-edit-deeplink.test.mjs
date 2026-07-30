import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSources = [
  readFileSync(new URL("../../src/App.tsx", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../../agent-gateway/web/src/app/GatewayApp.tsx", import.meta.url),
    "utf8",
  ),
];

const settingsPageSources = [
  readFileSync(new URL("../../src/pages/SettingsPage.tsx", import.meta.url), "utf8"),
  readFileSync(
    new URL("../../../agent-gateway/web/src/pages/SettingsPage.tsx", import.meta.url),
    "utf8",
  ),
];

const providersSectionSources = [
  readFileSync(
    new URL("../../src/pages/settings/ProvidersSection.tsx", import.meta.url),
    "utf8",
  ),
  readFileSync(
    new URL("../../../agent-gateway/web/src/pages/settings/ProvidersSection.tsx", import.meta.url),
    "utf8",
  ),
];

test("settings overlays carry a requested provider id", () => {
  for (const source of appSources) {
    assert.match(source, /settingsProviderId/);
    assert.match(
      source,
      /setSettingsProviderId\(section === "providers" \? providerId : undefined\)/,
    );
    assert.match(source, /initialProviderId=\{settingsProviderId\}/);
  }
});

test("settings pages forward and consume provider deep links", () => {
  for (const source of settingsPageSources) {
    assert.match(source, /pendingProviderId/);
    assert.match(source, /initialProviderId=\{pendingProviderId\}/);
    assert.match(source, /onInitialProviderHandled=\{\(\) => setPendingProviderId\(undefined\)\}/);
  }
});

test("providers sections open the requested provider editor once", () => {
  for (const source of providersSectionSources) {
    assert.match(source, /openedInitialProviderIdRef/);
    assert.match(
      source,
      /settings\.customProviders\.find\(\(item\) => item\.id === providerId\)/,
    );
    assert.match(source, /setActiveTab\(provider\.type\)/);
    assert.match(source, /setEditingProvider\(provider\)/);
    assert.match(source, /setModalOpen\(true\)/);
    assert.match(source, /onInitialProviderHandled\?\.\(\)/);
  }
});
