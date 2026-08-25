import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");

test("retryErrorSettings defaults to every Cloudflare 5xx preset enabled, no custom patterns", () => {
  const normalized = settings.normalizeRetryErrorSettings({});
  assert.deepEqual([...normalized.presetStatusCodes].sort(), [520, 521, 522, 523, 525, 526, 527]);
  assert.deepEqual(normalized.customPatterns, []);
});

test("presetStatusCodes are validated against the known preset list and deduped", () => {
  const normalized = settings.normalizeRetryErrorSettings({
    presetStatusCodes: [525, 525, 520, 999, "521", null],
  });
  // 999 is unknown → dropped; "521"/null are non-numbers → dropped; 525 deduped.
  assert.deepEqual(normalized.presetStatusCodes.sort((a, b) => a - b), [520, 525]);
});

test("a present-but-empty presetStatusCodes is respected (user opts out of all presets)", () => {
  const normalized = settings.normalizeRetryErrorSettings({ presetStatusCodes: [] });
  assert.deepEqual(normalized.presetStatusCodes, []);
});

test("a missing presetStatusCodes field falls back to all presets (legacy snapshot)", () => {
  const normalized = settings.normalizeRetryErrorSettings({ customPatterns: ["x"] });
  assert.deepEqual([...normalized.presetStatusCodes].sort(), [520, 521, 522, 523, 525, 526, 527]);
});

test("customPatterns are trimmed, de-duped case-insensitively, and empties dropped", () => {
  const normalized = settings.normalizeRetryErrorSettings({
    customPatterns: ["SSL handshake failed", "  ssl handshake failed  ", "", "  ", "525"],
  });
  assert.deepEqual(normalized.customPatterns, ["SSL handshake failed", "525"]);
});

test("normalizeSettings carries retryErrorSettings and normalizes a raw snapshot", () => {
  const normalized = settings.normalizeSettings({
    retryErrorSettings: {
      presetStatusCodes: [525, 999, 525],
      customPatterns: ["x", "x"],
    },
  });
  assert.deepEqual(normalized.retryErrorSettings.presetStatusCodes, [525]);
  assert.deepEqual(normalized.retryErrorSettings.customPatterns, ["x"]);
});

test("normalizeSettings fills retryErrorSettings defaults when the field is absent (legacy)", () => {
  const normalized = settings.normalizeSettings({});
  assert.deepEqual(
    [...normalized.retryErrorSettings.presetStatusCodes].sort(),
    [520, 521, 522, 523, 525, 526, 527],
  );
  assert.deepEqual(normalized.retryErrorSettings.customPatterns, []);
});
