import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const sync = loader.loadModule("@liveagent/ui/lib/settings/sync.ts");

test("notification switches default to on for old settings", () => {
  const normalized = settings.normalizeSettings({ customSettings: {} });
  assert.deepEqual(normalized.customSettings.notifications, {
    enabled: true,
    calendar: true,
    cron: true,
  });
});

test("only an explicit false turns a notification switch off", () => {
  assert.deepEqual(
    settings.normalizeNotificationSettings({ enabled: false, calendar: "no", cron: 0 }),
    { enabled: false, calendar: true, cron: true },
  );
  assert.deepEqual(settings.normalizeNotificationSettings(null), {
    enabled: true,
    calendar: true,
    cron: true,
  });
});

test("updateNotificationSettings patches one switch and keeps identity when unchanged", () => {
  const base = settings.normalizeSettings({ customSettings: {} });
  const next = settings.updateNotificationSettings(base, { cron: false });
  assert.deepEqual(next.customSettings.notifications, {
    enabled: true,
    calendar: true,
    cron: false,
  });
  assert.equal(settings.updateNotificationSettings(next, { cron: false }), next);
});

test("gateway settings sync keeps this device's notification switches", () => {
  const local = settings.updateNotificationSettings(
    settings.normalizeSettings({ customSettings: {} }),
    { enabled: false },
  );
  const merged = sync.applyGatewaySettingsSyncPayload(local, {
    customSettings: { notifications: { enabled: true, calendar: false, cron: false } },
  });
  assert.deepEqual(merged.customSettings.notifications, {
    enabled: false,
    calendar: true,
    cron: true,
  });
});

test("outgoing gateway sync payload never carries real notification switches", () => {
  const local = settings.updateNotificationSettings(
    settings.normalizeSettings({ customSettings: {} }),
    { enabled: false, cron: false },
  );
  const payload = sync.buildGatewaySettingsSyncPayload(local);
  assert.deepEqual(payload.customSettings.notifications, {
    enabled: true,
    calendar: true,
    cron: true,
  });
});
