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

test("memory organizer schedule runs at the wall-clock time of the default time zone", () => {
  const daily = { frequency: "daily", timeLocal: "03:00", weekday: 1, timezone: "UTC" };
  // 2026-09-29 12:00 UTC = 20:00 in Shanghai, so the next 03:00 there is 2026-09-30 03:00 +08.
  const from = Date.parse("2026-09-29T12:00:00Z");
  assert.equal(
    settings.computeNextMemoryOrganizerRunAt(daily, from, "Asia/Shanghai"),
    Date.parse("2026-09-29T19:00:00Z"),
  );
  assert.equal(
    settings.computeNextMemoryOrganizerRunAt(daily, from, "America/New_York"),
    Date.parse("2026-09-30T07:00:00Z"),
  );
  // Weekly on Monday (1): 2026-09-29 is a Tuesday, so the next run is Monday 2026-10-05.
  const weekly = { ...daily, frequency: "weekly", weekday: 1 };
  assert.equal(
    settings.computeNextMemoryOrganizerRunAt(weekly, from, "Asia/Shanghai"),
    Date.parse("2026-10-04T19:00:00Z"),
  );
  // DST: New York leaves daylight saving on 2026-11-01; 03:00 that day is EST (-05:00).
  assert.equal(
    settings.computeNextMemoryOrganizerRunAt(
      daily,
      Date.parse("2026-11-01T05:00:00Z"),
      "America/New_York",
    ),
    Date.parse("2026-11-01T08:00:00Z"),
  );
  assert.equal(settings.computeNextMemoryOrganizerRunAt({ ...daily, frequency: "none" }, from), undefined);
});

test("changing the default time zone reschedules the pending memory organizer run", () => {
  const base = settings.getDefaultSettings();
  const now = Date.parse("2026-09-29T12:00:00Z");
  const enabled = {
    ...base,
    memory: {
      ...base.memory,
      organizerEnabled: true,
      organizerSchedule: { frequency: "daily", timeLocal: "03:00", weekday: 1, timezone: "Asia/Shanghai" },
      organizerNextRunAt: Date.parse("2026-09-29T19:00:00Z"),
    },
  };
  assert.equal(settings.rescheduleOrganizerForTimeZone(enabled, "Asia/Shanghai", now), null);
  const moved = settings.rescheduleOrganizerForTimeZone(enabled, "America/New_York", now);
  assert.equal(moved.memory.organizerSchedule.timezone, "America/New_York");
  assert.equal(moved.memory.organizerNextRunAt, Date.parse("2026-09-30T07:00:00Z"));
  // Disabled or unscheduled organizers are left alone.
  const disabled = { ...enabled, memory: { ...enabled.memory, organizerEnabled: false } };
  assert.equal(settings.rescheduleOrganizerForTimeZone(disabled, "America/New_York", now), null);
});
