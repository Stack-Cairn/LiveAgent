import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const guiRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const repoRoot = path.resolve(guiRoot, "../..");
const manifestScript = path.join(
  repoRoot,
  "scripts/release/create-tauri-updater-manifest.mjs",
);

function writeAssetPair(dir, name, signature) {
  writeFileSync(path.join(dir, name), "package");
  writeFileSync(path.join(dir, `${name}.sig`), `${signature}\n`);
}

test("release updater manifest embeds generated notes and platform signatures", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-release-"));
  try {
    writeAssetPair(dir, "LiveAgent-v9.9.9-macOS-aarch64.app.tar.gz", "sig-mac-arm");
    writeAssetPair(dir, "LiveAgent-v9.9.9-macOS-x64.app.tar.gz", "sig-mac-x64");
    writeAssetPair(dir, "LiveAgent-v9.9.9-Windows-x64-Setup.exe", "sig-win");
    writeAssetPair(dir, "LiveAgent-v9.9.9-Linux-x86_64.AppImage", "sig-linux");

    const notesPath = path.join(dir, "release-notes.md");
    const outputPath = path.join(dir, "latest.json");
    writeFileSync(notesPath, "## What's Changed\n\n- Fix updater checks.\n");

    const result = spawnSync(
      process.execPath,
      [manifestScript, dir, outputPath, notesPath],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "Stack-Cairn/LiveAgent",
          RELEASE_TAG: "v9.9.9",
        },
        encoding: "utf8",
      },
    );

    assert.equal(
      result.status,
      0,
      `manifest script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const manifest = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(manifest.version, "9.9.9");
    assert.equal(manifest.notes, "## What's Changed\n\n- Fix updater checks.");
    assert.equal(
      manifest.platforms["darwin-aarch64-app"].url,
      "https://github.com/Stack-Cairn/LiveAgent/releases/download/v9.9.9/LiveAgent-v9.9.9-macOS-aarch64.app.tar.gz",
    );
    assert.equal(manifest.platforms["darwin-aarch64-app"].signature, "sig-mac-arm");
    assert.deepEqual(
      manifest.platforms["darwin-aarch64"],
      manifest.platforms["darwin-aarch64-app"],
    );
    assert.equal(manifest.platforms["darwin-x86_64-app"].signature, "sig-mac-x64");
    assert.equal(manifest.platforms["windows-x86_64-nsis"].signature, "sig-win");
    assert.deepEqual(
      manifest.platforms["windows-x86_64"],
      manifest.platforms["windows-x86_64-nsis"],
    );
    assert.equal(manifest.platforms["linux-x86_64-appimage"].signature, "sig-linux");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("release updater manifest uses MSI for generic Windows fallback when NSIS is missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "liveagent-release-"));
  try {
    writeAssetPair(dir, "LiveAgent-v9.9.9-Windows-x64.msi", "sig-win-msi");

    const outputPath = path.join(dir, "latest.json");
    const result = spawnSync(
      process.execPath,
      [manifestScript, dir, outputPath],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GITHUB_REPOSITORY: "Stack-Cairn/LiveAgent",
          RELEASE_TAG: "v9.9.9",
        },
        encoding: "utf8",
      },
    );

    assert.equal(
      result.status,
      0,
      `manifest script failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );

    const manifest = JSON.parse(readFileSync(outputPath, "utf8"));
    assert.equal(manifest.platforms["windows-x86_64-msi"].signature, "sig-win-msi");
    assert.deepEqual(
      manifest.platforms["windows-x86_64"],
      manifest.platforms["windows-x86_64-msi"],
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
