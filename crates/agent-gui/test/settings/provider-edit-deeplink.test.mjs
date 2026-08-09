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

const settingsPageSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/SettingsPage.tsx", import.meta.url),
  "utf8",
);

const providersSectionSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/ProvidersSection.tsx", import.meta.url),
  "utf8",
);

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
  assert.match(settingsPageSource, /pendingProviderId/);
  assert.match(settingsPageSource, /initialProviderId=\{pendingProviderId\}/);
  assert.match(
    settingsPageSource,
    /onInitialProviderHandled=\{\(\) => setPendingProviderId\(undefined\)\}/,
  );
});

test("the shared providers section opens the requested provider editor once", () => {
  assert.match(providersSectionSource, /openedInitialProviderIdRef/);
  assert.match(
    providersSectionSource,
    /settings\.customProviders\.find\(\(item\) => item\.id === providerId\)/,
  );
  assert.match(providersSectionSource, /setActiveTab\(provider\.type\)/);
  assert.match(providersSectionSource, /setEditingProvider\(provider\)/);
  assert.match(providersSectionSource, /setModalOpen\(true\)/);
  assert.match(providersSectionSource, /onInitialProviderHandled\?\.\(\)/);
});
