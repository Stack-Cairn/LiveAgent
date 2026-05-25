#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [assetDir, outputPath] = process.argv.slice(2);

if (!assetDir || !outputPath) {
  console.error("Usage: create-tauri-updater-manifest.mjs <asset-dir> <output-path>");
  process.exit(1);
}

const releaseTag = process.env.RELEASE_TAG?.trim();
const repository = process.env.GITHUB_REPOSITORY?.trim();

if (!releaseTag) {
  console.error("RELEASE_TAG is required.");
  process.exit(1);
}

if (!repository) {
  console.error("GITHUB_REPOSITORY is required.");
  process.exit(1);
}

const files = new Set(readdirSync(assetDir));
const platforms = {};

function targetForArtifact(filename) {
  if (/macOS-x64\.app\.tar\.gz$/i.test(filename)) return "darwin-x86_64-app";
  if (/macOS-aarch64\.app\.tar\.gz$/i.test(filename)) return "darwin-aarch64-app";
  if (/Windows-x64-nsis\.zip$/i.test(filename)) return "windows-x86_64-nsis";
  if (/Windows-x64-msi\.zip$/i.test(filename)) return "windows-x86_64-msi";
  if (/Linux-x86_64\.AppImage\.tar\.gz$/i.test(filename)) return "linux-x86_64-appimage";
  if (/Linux-x86_64\.deb\.tar\.gz$/i.test(filename)) return "linux-x86_64-deb";
  if (/Linux-x86_64\.rpm\.tar\.gz$/i.test(filename)) return "linux-x86_64-rpm";
  return null;
}

function releaseAssetUrl(filename) {
  return `https://github.com/${repository}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(filename)}`;
}

for (const file of files) {
  if (!file.endsWith(".sig")) continue;

  const artifact = basename(file.slice(0, -".sig".length));
  if (!files.has(artifact)) continue;

  const target = targetForArtifact(artifact);
  if (!target) continue;

  const signature = readFileSync(join(assetDir, file), "utf8").trim();
  if (!signature) {
    console.error(`Signature file is empty: ${file}`);
    process.exit(1);
  }

  platforms[target] = {
    signature,
    url: releaseAssetUrl(artifact),
  };

  if (target === "darwin-x86_64-app") {
    platforms["darwin-x86_64"] = platforms[target];
  } else if (target === "darwin-aarch64-app") {
    platforms["darwin-aarch64"] = platforms[target];
  }
}

if (Object.keys(platforms).length === 0) {
  console.error("No updater artifacts with matching .sig files were found.");
  process.exit(1);
}

const manifest = {
  version: releaseTag.replace(/^v/i, ""),
  notes: `LiveAgent ${releaseTag}`,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote updater manifest with ${Object.keys(platforms).length} platform entries: ${outputPath}`);
