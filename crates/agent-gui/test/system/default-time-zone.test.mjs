import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const sync = loader.loadModule("@liveagent/ui/lib/settings/sync.ts");

test("defaultTimeZone defaults to automatic", () => {
  assert.equal(settings.getDefaultSettings().system.defaultTimeZone, "");
  assert.equal(settings.normalizeSystemSettings({}).defaultTimeZone, "");
});

test("defaultTimeZone normalization trims valid zones and drops invalid ones", () => {
  assert.equal(settings.normalizeDefaultTimeZone(" Asia/Shanghai "), "Asia/Shanghai");
  assert.equal(settings.normalizeDefaultTimeZone("UTC"), "UTC");
  assert.equal(settings.normalizeDefaultTimeZone("Mars/Olympus"), "");
  assert.equal(settings.normalizeDefaultTimeZone("   "), "");
  assert.equal(settings.normalizeDefaultTimeZone(8), "");
  assert.equal(settings.normalizeDefaultTimeZone(null), "");
  assert.equal(
    settings.normalizeSystemSettings({ defaultTimeZone: "Not/AZone" }).defaultTimeZone,
    "",
  );
});

test("resolvedTimeZone passes through only when it is a non-empty string", () => {
  assert.equal(
    settings.normalizeSystemSettings({ resolvedTimeZone: " Europe/Berlin " }).resolvedTimeZone,
    "Europe/Berlin",
  );
  assert.equal(
    Object.hasOwn(settings.normalizeSystemSettings({ resolvedTimeZone: "" }), "resolvedTimeZone"),
    false,
  );
  assert.equal(
    Object.hasOwn(settings.normalizeSystemSettings({ resolvedTimeZone: 3 }), "resolvedTimeZone"),
    false,
  );
});

test("resolveDefaultTimeZone prefers the setting, then the desktop zone, then the runtime", () => {
  assert.equal(
    settings.resolveDefaultTimeZone({
      defaultTimeZone: "America/New_York",
      resolvedTimeZone: "Asia/Tokyo",
    }),
    "America/New_York",
  );
  assert.equal(
    settings.resolveDefaultTimeZone({ defaultTimeZone: "", resolvedTimeZone: "Asia/Tokyo" }),
    "Asia/Tokyo",
  );
  assert.equal(
    settings.resolveDefaultTimeZone({ defaultTimeZone: "" }),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
});

test("updateSystem keeps a chosen defaultTimeZone and the derived desktop zone", () => {
  const base = settings.normalizeSettings({
    ...settings.getDefaultSettings(),
    system: { ...settings.getDefaultSettings().system, resolvedTimeZone: "Asia/Tokyo" },
  });
  const next = settings.updateSystem(base, { defaultTimeZone: "Europe/Paris" });
  assert.equal(next.system.defaultTimeZone, "Europe/Paris");
  assert.equal(next.system.resolvedTimeZone, "Asia/Tokyo");
});

test("changing only defaultTimeZone produces a settings-sync patch with system", () => {
  const prev = settings.normalizeSettings(settings.getDefaultSettings());
  const next = settings.updateSystem(prev, { defaultTimeZone: "Asia/Shanghai" });
  const update = sync.buildGatewaySettingsSyncUpdatePayload(prev, next);
  assert.deepEqual(Object.keys(update), ["system"]);
  assert.equal(update.system.defaultTimeZone, "Asia/Shanghai");
});

test("incoming settings-sync payload carries defaultTimeZone and resolvedTimeZone", () => {
  const current = settings.getDefaultSettings();
  const next = sync.applyGatewaySettingsSyncPayload(current, {
    system: {
      ...current.system,
      defaultTimeZone: "Europe/London",
      resolvedTimeZone: "Asia/Shanghai",
    },
  });
  assert.equal(next.system.defaultTimeZone, "Europe/London");
  assert.equal(next.system.resolvedTimeZone, "Asia/Shanghai");
});
