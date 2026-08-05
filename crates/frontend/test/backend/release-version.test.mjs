import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");
const versionScript = path.join(
  repoRoot,
  "scripts/release/prepare-app-version-from-tag.mjs",
);

function runVersionScript(args, env = {}) {
  return spawnSync(process.execPath, [versionScript, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
    },
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("release version script resolves tag metadata without mutating package.json", () => {
  const packageJsonPath = path.join(guiRoot, "package.json");
  const before = readFileSync(packageJsonPath, "utf8");

  const result = runVersionScript(["refs/tags/v9.10.11-beta.2", "--json"]);

  assert.equal(
    result.status,
    0,
    `version script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const metadata = JSON.parse(result.stdout);
  assert.equal(metadata.releaseTag, "v9.10.11-beta.2");
  assert.equal(metadata.appVersion, "9.10.11-beta.2");
  assert.equal(metadata.isPrerelease, true);
  assert.equal(readFileSync(packageJsonPath, "utf8"), before);
});

test("release version script writes GitHub env, outputs, and Tauri config", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-version-"));
  try {
    const envPath = path.join(dir, "github-env");
    const outputPath = path.join(dir, "github-output");
    const tauriConfigPath = path.join(dir, "tauri.version.generated.conf.json");

    const result = runVersionScript([
      "v1.2.3",
      "--github-env",
      envPath,
      "--github-output",
      outputPath,
      "--tauri-config",
      tauriConfigPath,
    ]);

    assert.equal(
      result.status,
      0,
      `version script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    assert.match(readFileSync(envPath, "utf8"), /^LIVEAGENT_APP_VERSION=1\.2\.3$/m);
    assert.match(
      readFileSync(envPath, "utf8"),
      new RegExp(`^LIVEAGENT_TAURI_VERSION_CONFIG=${escapeRegExp(tauriConfigPath)}$`, "m"),
    );
    assert.match(readFileSync(outputPath, "utf8"), /^release_tag=v1\.2\.3$/m);
    assert.match(readFileSync(outputPath, "utf8"), /^is_prerelease=false$/m);
    assert.deepEqual(JSON.parse(readFileSync(tauriConfigPath, "utf8")), {
      version: "1.2.3",
    });
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("release version script rejects non-semver tags", () => {
  const result = runVersionScript(["v1.2"]);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /semver tag like v0\.1\.3/);
});
