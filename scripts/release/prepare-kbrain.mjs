import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const defaultLock = join(root, "scripts/release/kbrain.lock.json");
export const defaultOutput = join(root, "crates/agent-gui/src-tauri/binaries");
export const defaultArtifact = join(root, ".liveagent/kbrain-artifact");
const digest = (data) => createHash("sha256").update(data).digest("hex");

export async function readLock(path = defaultLock) {
  const lock = JSON.parse(await readFile(path, "utf8"));
  if (lock.schemaVersion !== 1 || lock.repository !== "https://github.com/Stack-Cairn/K-brain" ||
      !/^[a-f0-9]{40}$/.test(lock.sourceRevision) || lock.protocol !== "kbrain.agent.v1" ||
      !lock.requiredBackendFlags?.includes("-parent-stdio")) {
    throw new Error("Invalid K-brain lock: repository, full source revision and protocol are required");
  }
  return lock;
}

export function resolveTarget(explicit, env = process.env, platform = process.platform, arch = process.arch) {
  const target = explicit || env.TAURI_ENV_TARGET_TRIPLE || env.CARGO_BUILD_TARGET;
  if (target) return target;
  const os = env.TAURI_ENV_PLATFORM || platform;
  const cpu = env.TAURI_ENV_ARCH || arch;
  const normalized = { x64: "x86_64", arm64: "aarch64" }[cpu] || cpu;
  const suffix = { darwin: "apple-darwin", macos: "apple-darwin", linux: "unknown-linux-gnu", win32: "pc-windows-msvc", windows: "pc-windows-msvc" }[os];
  if (!suffix) throw new Error(`Unsupported K-brain platform: ${os}/${cpu}`);
  return `${normalized}-${suffix}`;
}

export function platformFor(lock, target) {
  const platform = lock.platforms?.[target];
  if (!platform || !platform.assets?.backend || !platform.assets?.computer ||
      !/^[a-zA-Z0-9_.-]+$/.test(platform.assets.backend) || !/^[a-zA-Z0-9_.-]+$/.test(platform.assets.computer)) {
    throw new Error(`Unsupported K-brain target or incomplete helper assets: ${target}`);
  }
  return platform;
}

async function atomicWrite(path, data, executable = false) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data);
    if (executable) await chmod(temporary, 0o755);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function checkHash(data, expected, label) {
  if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error(`Missing or invalid SHA-256 for ${label}`);
  const actual = digest(data);
  if (actual !== expected) throw new Error(`SHA-256 mismatch for ${label}: expected ${expected}, got ${actual}`);
}

async function optionalJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function download(url) {
  let current = new URL(url);
  const signal = AbortSignal.timeout(120_000);
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (current.protocol !== "https:" && !(current.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(current.hostname))) {
      throw new Error("K-brain download requires HTTPS (HTTP is allowed only for loopback tests)");
    }
    const response = await fetch(current, { signal, redirect: "manual" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("K-brain download redirect has no location");
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) throw new Error(`K-brain download failed: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  throw new Error("K-brain download exceeded redirect limit");
}

async function prepareOne({ source, destination, expectedHash, url, cacheKey, label, allowDownload }) {
  let data;
  if (source) {
    data = await readFile(source);
    if (!data.length) throw new Error(`Local K-brain ${label} binary is empty`);
  } else if (expectedHash && cacheKey) {
    const cache = join(root, ".liveagent/kbrain-cache", expectedHash, cacheKey);
    try {
      data = await readFile(cache);
      checkHash(data, expectedHash, cache);
    } catch {
      await rm(cache, { force: true });
      if (!allowDownload || !url) throw new Error(`K-brain ${label} artifact cache is missing and no pinned download is available`);
      data = await download(url);
      checkHash(data, expectedHash, label);
      await atomicWrite(cache, data, true);
    }
  } else {
    throw new Error(`No K-brain ${label} source artifact is available`);
  }
  if (expectedHash) checkHash(data, expectedHash, label);
  await atomicWrite(destination, data, true);
  return { data, sha256: digest(data) };
}

export async function prepare(options = {}) {
  const lock = await readLock(options.lock);
  const target = resolveTarget(options.target);
  const platform = platformFor(lock, target);
  const output = resolve(options.output || defaultOutput);
  const backend = join(output, `k-brain-${target}${platform.goos === "windows" ? ".exe" : ""}`);
  const computer = join(output, `k-brain-computer-${target}${platform.goos === "windows" ? ".exe" : ""}`);
  const localBackend = options.localBinary || process.env.LIVEAGENT_KBRAIN_BINARY;
  const localComputer = options.localComputerBinary || process.env.LIVEAGENT_KBRAIN_COMPUTER_BINARY ||
    (localBackend ? join(dirname(localBackend), platform.assets.computer) : undefined);
  const release = options.release || process.env.LIVEAGENT_KBRAIN_RELEASE === "1";
  if (localBackend || localComputer) {
    if (release || process.env.CI === "true") throw new Error("Local K-brain binary overrides are forbidden in release/CI builds");
    if (!localBackend || !localComputer || !isAbsolute(localBackend) || !isAbsolute(localComputer)) {
      throw new Error("Backend and computer helper overrides must both be absolute development binary paths");
    }
  }
  try {
    // Release/CI always use pinned downloads; stale local builds must not override them.
    const explicitArtifact = options.artifactDir || process.env.LIVEAGENT_KBRAIN_ARTIFACT_DIR;
    const useDownload = release || process.env.CI === "true" || (!explicitArtifact && lock.downloads?.[target]);
    const artifactDirectory = options.artifactDir === false || useDownload ? null : resolve(explicitArtifact || defaultArtifact);
    const record = artifactDirectory ? await optionalJson(join(artifactDirectory, "kbrain-artifact.json")) : null;
    let assets;
    let checksums;
    let origin;
    if (localBackend) {
      const backendResult = await prepareOne({ source: localBackend, destination: backend, label: "backend" });
      const computerResult = await prepareOne({ source: localComputer, destination: computer, label: "computer" });
      checksums = { backend: backendResult.sha256, computer: computerResult.sha256 };
      origin = "development-override";
    } else if (record) {
      if (record.schemaVersion !== 1 || record.repository !== lock.repository || record.sourceRevision !== lock.sourceRevision || record.protocol !== lock.protocol) {
        throw new Error("K-brain artifact source revision/protocol does not match lock");
      }
      const entry = record.platforms?.[target];
      assets = entry?.assets;
      checksums = entry?.sha256;
      if (!assets || assets.backend !== platform.assets.backend || assets.computer !== platform.assets.computer) {
        throw new Error(`K-brain artifact asset/target mismatch: ${target}`);
      }
      const backendResult = await prepareOne({ source: join(artifactDirectory, assets.backend), destination: backend, expectedHash: checksums.backend, label: "backend" });
      const computerResult = await prepareOne({ source: join(artifactDirectory, assets.computer), destination: computer, expectedHash: checksums.computer, label: "computer" });
      checksums = { backend: backendResult.sha256, computer: computerResult.sha256 };
      origin = "source-artifact";
    } else {
      if (artifactDirectory && (options.artifactDir || process.env.LIVEAGENT_KBRAIN_ARTIFACT_DIR)) throw new Error(`K-brain artifact record missing: ${artifactDirectory}`);
      const entry = lock.downloads?.[target];
      assets = entry?.assets;
      checksums = entry?.sha256;
      if (!entry?.urls?.backend || !entry?.urls?.computer || !checksums?.backend || !checksums?.computer ||
          entry.sourceRevision !== lock.sourceRevision || assets?.backend !== platform.assets.backend || assets?.computer !== platform.assets.computer) {
        throw new Error("No pinned K-brain backend and computer artifacts are available. Provide the fixed CI artifact or both explicit development binaries; no runtime fallback is allowed.");
      }
      for (const url of Object.values(entry.urls)) if (/\/latest(?:\/|$)/i.test(new URL(url).pathname)) throw new Error("Floating latest K-brain downloads are forbidden");
      const backendResult = await prepareOne({ destination: backend, expectedHash: checksums.backend, url: entry.urls.backend, cacheKey: assets.backend, label: "backend", allowDownload: true });
      const computerResult = await prepareOne({ destination: computer, expectedHash: checksums.computer, url: entry.urls.computer, cacheKey: assets.computer, label: "computer", allowDownload: true });
      checksums = { backend: backendResult.sha256, computer: computerResult.sha256 };
      origin = "locked-download";
    }
    const receipt = { sourceRevision: lock.sourceRevision, protocol: lock.protocol, target, assets: platform.assets, sha256: checksums, origin };
    await atomicWrite(`${backend}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
    return { binary: backend, computerBinary: computer, ...receipt };
  } catch (error) {
    await rm(backend, { force: true });
    await rm(computer, { force: true });
    await rm(`${backend}.json`, { force: true });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      lock: { type: "string" }, target: { type: "string" }, "artifact-dir": { type: "string" },
      "local-binary": { type: "string" }, "local-computer-binary": { type: "string" }, "output-dir": { type: "string" }, release: { type: "boolean" },
    } });
    const result = await prepare({ lock: values.lock, target: values.target, artifactDir: values["artifact-dir"], localBinary: values["local-binary"], localComputerBinary: values["local-computer-binary"], output: values["output-dir"], release: values.release });
    console.log(`Prepared K-brain backend and computer helper ${result.sourceRevision} (${result.target}, ${result.origin}): ${result.binary}, ${result.computerBinary}`);
  } catch (error) {
    console.error(`K-brain preparation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
