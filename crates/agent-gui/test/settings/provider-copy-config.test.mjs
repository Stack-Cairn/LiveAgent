import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const importLoader = createTsModuleLoader({
  mocks: {
    "../../src-tauri/icons/custom/ccswitch.png": { default: "ccswitch.png" },
    "../../src-tauri/icons/custom/cherrystudio.png": { default: "cherrystudio.png" },
  },
});
const providerImports = importLoader.loadModule("src/agent-ui-adapters/providerSettings.tsx");

const providersSectionSource = readFileSync(
  new URL("../../../agent-ui/src/pages/settings/ProvidersSection.tsx", import.meta.url),
  "utf8",
);
const guiAdapterSource = readFileSync(
  new URL("../../src/agent-ui-adapters/providerSettings.tsx", import.meta.url),
  "utf8",
);
const gatewayAdapterSource = readFileSync(
  new URL("../../../agent-gateway/web/src/agent-ui-adapters/providerSettings.tsx", import.meta.url),
  "utf8",
);
// Settings copy of one locale: the core table plus the lazily loaded settings namespace.
const settingsSource = (core, namespace) =>
  [`../../../agent-ui/src/i18n/translations/${core}`, `../../../agent-ui/src/i18n/namespaces/${namespace}`]
    .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n");
const zhSettingsSource = settingsSource("zhCNSettings.ts", "settingsZhCN.ts");
const enSettingsSource = settingsSource("enUSSettings.ts", "settingsEnUS.ts");

test("desktop copy payload puts Base URL and API Key on separate lines", () => {
  assert.equal(
    providerImports.formatProviderCopyConfig({
      baseUrl: " https://api.example.com/v1 ",
      apiKey: " sk-test ",
    }),
    "https://api.example.com/v1\nsk-test",
  );
});

test("desktop copy payload omits blank Base URL or API Key", () => {
  assert.equal(
    providerImports.formatProviderCopyConfig({ baseUrl: "https://api.example.com", apiKey: "  " }),
    "https://api.example.com",
  );
  assert.equal(
    providerImports.formatProviderCopyConfig({ baseUrl: "", apiKey: "sk-only" }),
    "sk-only",
  );
  assert.equal(providerImports.formatProviderCopyConfig({ baseUrl: "  ", apiKey: "" }), "");
});

test("the shared provider card places the copy button immediately before refresh usage", () => {
  assert.match(
    providersSectionSource,
    /<ProviderCopyConfigButton provider=\{provider\} \/>\s*\{usageDisplay\.show \? \(/,
  );
  assert.match(providersSectionSource, /settings\.providerUsageRefresh/);
});

test("only the desktop adapter implements the copy button", () => {
  assert.match(guiAdapterSource, /export function ProviderCopyConfigButton/);
  assert.match(guiAdapterSource, /formatProviderCopyConfig\(provider\)/);
  assert.match(guiAdapterSource, /settings\.providerCopyConfig/);
  assert.match(guiAdapterSource, /settings\.providerCopyConfigCopied/);
  assert.match(gatewayAdapterSource, /export function ProviderCopyConfigButton/);
  assert.match(gatewayAdapterSource, /return null;/);
  assert.doesNotMatch(gatewayAdapterSource, /CopyButton/);
});

test("copy-config labels exist in both settings locales", () => {
  for (const source of [zhSettingsSource, enSettingsSource]) {
    assert.match(source, /"settings\.providerCopyConfig":/);
    assert.match(source, /"settings\.providerCopyConfigCopied":/);
  }
});
