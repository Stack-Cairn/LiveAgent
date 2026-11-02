import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultLock, platformFor, readLock } from "./prepare-kbrain.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const defaultConfigDir = join(root, "crates/agent-gui/src-tauri");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export async function verifyTauriConfiguration(configDir = defaultConfigDir) {
  const base = await readJson(join(configDir, "tauri.conf.json"));
  const externalBin = base.bundle?.externalBin ?? [];
  if (!externalBin.includes("binaries/k-brain") || !externalBin.includes("binaries/k-brain-computer")) {
    throw new Error("Tauri externalBin must include both k-brain and k-brain-computer");
  }
  if (!base.build?.beforeDevCommand?.includes("prepare:kbrain") || !base.build?.beforeBuildCommand?.includes("prepare:kbrain")) {
    throw new Error("Tauri dev/build hooks must prepare K-brain binaries");
  }
  for (const name of ["tauri.macos.release.conf.json", "tauri.windows.release.conf.json", "tauri.linux.release.conf.json"]) {
    const release = await readJson(join(configDir, name));
    if (!release.bundle) throw new Error(`${name} does not merge a bundle configuration`);
    for (const binary of externalBin) {
      if (release.bundle.externalBin && !release.bundle.externalBin.includes(binary)) {
        throw new Error(`${name} overrides externalBin without ${binary}`);
      }
    }
  }
  return { externalBin, beforeDevCommand: base.build.beforeDevCommand, beforeBuildCommand: base.build.beforeBuildCommand };
}

export async function verifyPreparedBinaries({ binaryDir, target, lock = defaultLock }) {
  const manifest = await readLock(lock);
  const platform = platformFor(manifest, target);
  const directory = resolve(binaryDir);
  const backendName = `k-brain-${target}${platform.goos === "windows" ? ".exe" : ""}`;
  const computerName = `k-brain-computer-${target}${platform.goos === "windows" ? ".exe" : ""}`;
  const receipt = await readJson(join(directory, `${backendName}.json`));
  if (receipt.sourceRevision !== manifest.sourceRevision || receipt.protocol !== manifest.protocol || receipt.target !== target) {
    throw new Error("Prepared K-brain receipt does not match the lock");
  }
  if (receipt.assets?.backend !== platform.assets.backend || receipt.assets?.computer !== platform.assets.computer) {
    throw new Error("Prepared K-brain receipt does not contain both locked assets");
  }
  const backendPath = join(directory, backendName);
  const computerPath = join(directory, computerName);
  const [backend, computer, backendStat, computerStat] = await Promise.all([readFile(backendPath), readFile(computerPath), stat(backendPath), stat(computerPath)]);
  if (!isExecutable(backendPath, backendStat, platform) || !isExecutable(computerPath, computerStat, platform)) {
    throw new Error(`Prepared K-brain backend and computer helper must be executable for ${target}`);
  }
  const hashes = { backend: createHash("sha256").update(backend).digest("hex"), computer: createHash("sha256").update(computer).digest("hex") };
  if (hashes.backend !== receipt.sha256?.backend || hashes.computer !== receipt.sha256?.computer) throw new Error("Prepared K-brain SHA-256 receipt mismatch");
  return {
    target,
    sourceRevision: manifest.sourceRevision,
    protocol: manifest.protocol,
    assets: platform.assets,
    backend: join(directory, backendName),
    computer: join(directory, computerName),
    hashes,
  };
}

async function collectFiles(directory, names, found = []) {
  let files;
  try { files = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return found; throw error; }
  for (const entry of files) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(path, names, found);
    else if (names.includes(entry.name)) found.push(path);
  }
  return found;
}

function expectedBundleNames(platform, layout) {
  const extension = platform.goos === "windows" ? ".exe" : "";
  if (layout === "portable" && platform.goos !== "windows") throw new Error("Portable K-brain layout is Windows-only");
  return layout === "portable"
    ? { backend: `k-brain${extension}`, computer: `k-brain-computer${extension}` }
    : { backend: `k-brain${extension}`, computer: `k-brain-computer${extension}` };
}

function isExecutable(path, fileStat, platform) {
  if (platform.goos === "windows" && path.toLowerCase().endsWith(".exe")) return true;
  return (fileStat.mode & 0o111) !== 0;
}

export async function verifyBundle(bundleDir, target, lock = defaultLock, receipt = undefined, options = {}) {
  const manifest = await readLock(lock);
  const platform = platformFor(manifest, target);
  const names = expectedBundleNames(platform, options.layout || (platform.goos === "windows" ? "portable" : "app"));
  const paths = await collectFiles(resolve(bundleDir), Object.values(names));
  const backendPaths = paths.filter((path) => path.endsWith(`/${names.backend}`) || path.endsWith(`\\${names.backend}`));
  const computerPaths = paths.filter((path) => path.endsWith(`/${names.computer}`) || path.endsWith(`\\${names.computer}`));
  if (backendPaths.length !== 1 || computerPaths.length !== 1) {
    throw new Error(`Bundle must contain exactly one backend and one computer helper for ${target} (found ${backendPaths.length}/${computerPaths.length})`);
  }
  const backendPath = backendPaths[0];
  const computerPath = computerPaths[0];
  const backendStat = await stat(backendPath);
  const computerStat = await stat(computerPath);
  if (!isExecutable(backendPath, backendStat, platform) || !isExecutable(computerPath, computerStat, platform)) {
    throw new Error(`Bundle K-brain backend and computer helper must be executable for ${target}`);
  }
  const [backend, computer] = await Promise.all([readFile(backendPath), readFile(computerPath)]);
  const hashes = { backend: createHash("sha256").update(backend).digest("hex"), computer: createHash("sha256").update(computer).digest("hex") };
  if (!/^[a-f0-9]{64}$/.test(hashes.backend) || !/^[a-f0-9]{64}$/.test(hashes.computer)) throw new Error("Bundled K-brain hashes are invalid");
  if (receipt) {
    const expected = receipt.hashes || receipt.sha256;
    if (!expected?.backend || !expected?.computer) throw new Error("Bundle verification requires backend/helper SHA-256 receipt");
    if (hashes.backend !== expected.backend || hashes.computer !== expected.computer) throw new Error("Bundled K-brain SHA-256 does not match prepared receipt");
  }
  return { backend: backendPath, computer: computerPath, hashes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const value = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
    const target = value("--target");
    const binaryDir = value("--binary-dir");
    if (!target || !binaryDir) throw new Error("Usage: verify-kbrain-packaging.mjs --target TARGET --binary-dir DIR [--bundle-dir DIR]");
    const lock = value("--lock") || defaultLock;
    await verifyTauriConfiguration(value("--config-dir") || defaultConfigDir);
    const prepared = await verifyPreparedBinaries({ binaryDir, target, lock });
    if (value("--bundle-dir")) await verifyBundle(value("--bundle-dir"), target, lock, args.includes("--no-receipt-hash") ? undefined : prepared, { layout: value("--layout") });
    console.log(`Verified K-brain packaging for ${target}`);
  } catch (error) {
    console.error(`K-brain packaging verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
