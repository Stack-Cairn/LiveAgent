import assert from "node:assert/strict";
import { test } from "node:test";
import { msiVersionFor, parseReleaseVersion, tauriVersionConfig } from "./release-version.mjs";

test("parseReleaseVersion reports the app version and prerelease flag", () => {
  assert.deepEqual(parseReleaseVersion("v1.3.6"), {
    appVersion: "1.3.6",
    isPrerelease: false,
    releaseTag: "v1.3.6",
  });
  assert.deepEqual(parseReleaseVersion("refs/tags/v1.3.6-beta.1"), {
    appVersion: "1.3.6-beta.1",
    isPrerelease: true,
    releaseTag: "v1.3.6-beta.1",
  });
});

test("tauriVersionConfig leaves stable versions to Tauri", () => {
  assert.deepEqual(tauriVersionConfig("1.3.6"), { version: "1.3.6" });
});

test("tauriVersionConfig leaves numeric-only prereleases to Tauri", () => {
  assert.deepEqual(tauriVersionConfig("1.3.6-1"), { version: "1.3.6-1" });
});

test("tauriVersionConfig injects a numeric MSI version for named prereleases", () => {
  assert.deepEqual(tauriVersionConfig("1.3.6-beta.1"), {
    version: "1.3.6-beta.1",
    bundle: {
      windows: {
        wix: {
          version: "1.3.6.1",
        },
      },
    },
  });
});

test("msiVersionFor derives the build number from the last numeric identifier", () => {
  assert.equal(msiVersionFor("1.3.6-rc.2"), "1.3.6.2");
  assert.equal(msiVersionFor("1.3.6-beta.1.hotfix.3"), "1.3.6.3");
  assert.equal(msiVersionFor("1.3.6-beta"), "1.3.6.0");
  assert.equal(msiVersionFor("1.3.6-rc"), "1.3.6.0");
});

test("msiVersionFor skips versions Tauri can already derive", () => {
  assert.equal(msiVersionFor("1.3.6"), undefined);
  assert.equal(msiVersionFor("1.3.6-7"), undefined);
  assert.equal(msiVersionFor("1.3.6+20260918"), undefined);
});

test("msiVersionFor clamps build numbers above the MSI field limit", () => {
  assert.equal(msiVersionFor("1.3.6-beta.70000"), "1.3.6.65535");
});

test("tauriVersionConfig rejects invalid app versions", () => {
  assert.throws(() => tauriVersionConfig("1.3"), /valid semver/);
});
