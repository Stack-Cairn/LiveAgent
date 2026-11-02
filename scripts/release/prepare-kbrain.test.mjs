import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { defaultArtifact, defaultOutput, platformFor, prepare, readLock, resolveTarget, root } from "./prepare-kbrain.mjs";

const revision = "e6743be5600046f5c0fb3db256dbf2c49abf66af";
const baseLock = {
  schemaVersion: 1,
  repository: "https://github.com/Stack-Cairn/K-brain",
  sourceRevision: revision,
  protocol: "kbrain.agent.v1",
  requiredBackendFlags: ["-parent-stdio"],
  artifactPrefix: "kbrain-source-",
  platforms: {
    "x86_64-unknown-linux-gnu": { goos: "linux", goarch: "amd64", assets: { backend: "k-brain-linux-x64", computer: "k-brain-computer-linux-x64" } },
    "x86_64-pc-windows-msvc": { goos: "windows", goarch: "amd64", assets: { backend: "k-brain-windows-x64.exe", computer: "k-brain-computer-windows-x64.exe" } },
  },
  downloads: {},
};
const temporaryDirectories = [];
const cacheFiles = [];

async function fixtureLock(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), "liveagent-kbrain-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "lock.json");
  await writeFile(path, JSON.stringify({ ...baseLock, ...overrides }));
  return { directory, path };
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

let server;
let requests = 0;
function startServer(body, status = 200) {
  return new Promise((resolve) => {
    server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(status);
      response.end(body);
    }).listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}/k-brain`));
  });
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
  requests = 0;
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

after(async () => {
  await Promise.all(cacheFiles.splice(0).map((path) => rm(path, { force: true })));
});

test("maps the supported Tauri targets and rejects unsupported targets", () => {
  assert.equal(resolveTarget("aarch64-apple-darwin"), "aarch64-apple-darwin");
  assert.equal(resolveTarget(undefined, {}, "darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(resolveTarget(undefined, {}, "win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => platformFor(baseLock, "aarch64-unknown-linux-gnu"), /Unsupported K-brain target/);
});

test("downloads a pinned HTTP fixture, verifies it, and reuses its checksum cache", async () => {
  const backendBody = Buffer.from("fixture k-brain backend and computer\n");
  const computerBody = backendBody;
  const backendUrl = await startServer(backendBody);
  const backendHash = sha256(backendBody);
  const computerHash = sha256(computerBody);
  const lock = await fixtureLock({ downloads: {
    "x86_64-unknown-linux-gnu": { sourceRevision: revision, assets: { backend: "k-brain-linux-x64", computer: "k-brain-computer-linux-x64" }, urls: { backend: backendUrl, computer: backendUrl }, sha256: { backend: backendHash, computer: backendHash } },
  } });
  const firstOutput = join(lock.directory, "first");
  const secondOutput = join(lock.directory, "second");
  const first = await prepare({ lock: lock.path, target: "x86_64-unknown-linux-gnu", artifactDir: false, output: firstOutput });
  const second = await prepare({ lock: lock.path, target: "x86_64-unknown-linux-gnu", artifactDir: false, output: secondOutput });
  const staleArtifact = join(lock.directory, "stale-artifact");
  await mkdir(staleArtifact);
  await writeFile(join(staleArtifact, "kbrain-artifact.json"), JSON.stringify({ sourceRevision: "stale" }));
  const release = await prepare({ lock: lock.path, target: "x86_64-unknown-linux-gnu", artifactDir: staleArtifact, release: true, output: join(lock.directory, "release") });
  assert.equal(release.origin, "locked-download");
  assert.equal(release.sha256.backend, backendHash);
  assert.equal(requests, 2);
  assert.equal(await readFile(first.binary, "utf8"), backendBody.toString());
  assert.equal(await readFile(first.computerBinary, "utf8"), computerBody.toString());
  assert.equal(await readFile(second.computerBinary, "utf8"), computerBody.toString());
  assert.equal(first.sha256.computer, computerHash);
  cacheFiles.push(join(root, ".liveagent", "kbrain-cache", backendHash, "k-brain-linux-x64"), join(root, ".liveagent", "kbrain-cache", backendHash, "k-brain-computer-linux-x64"));
});

test("uses an explicit absolute local development binary and refuses it for release", async () => {
  const lock = await fixtureLock();
  const local = join(lock.directory, "local-k-brain");
  await writeFile(local, "local fixture");
  const helper = join(lock.directory, "k-brain-computer-linux-x64");
  await writeFile(helper, "local helper fixture");
  const output = join(lock.directory, "output");
  const options = { lock: lock.path, target: "x86_64-unknown-linux-gnu", artifactDir: false, output, localBinary: local, localComputerBinary: helper };
  // Overrides are a development-only path: the CI environment itself must refuse them,
  // so the development half runs with CI unset (the suite runs on CI too).
  const previousCI = process.env.CI;
  try {
    delete process.env.CI;
    const result = await prepare(options);
    assert.equal(result.origin, "development-override");
    process.env.CI = "true";
    await assert.rejects(() => prepare(options), /forbidden/);
  } finally {
    if (previousCI === undefined) delete process.env.CI;
    else process.env.CI = previousCI;
  }
  await assert.rejects(() => prepare({ ...options, release: true }), /forbidden/);
});

test("blocks checksum mismatches and failed downloads without leaving a runtime fallback", async () => {
  const body = Buffer.from("unexpected fixture binary\n");
  const url = await startServer(body);
  const mismatch = await fixtureLock({ downloads: {
    "x86_64-unknown-linux-gnu": { sourceRevision: revision, assets: { backend: "k-brain-linux-x64", computer: "k-brain-computer-linux-x64" }, urls: { backend: url, computer: url }, sha256: { backend: "0".repeat(64), computer: "0".repeat(64) } },
  } });
  const output = join(mismatch.directory, "output");
  await assert.rejects(() => prepare({ lock: mismatch.path, target: "x86_64-unknown-linux-gnu", artifactDir: false, output, release: true }), /SHA-256 mismatch/);
  await assert.rejects(() => access(join(output, "k-brain-x86_64-unknown-linux-gnu")));
  await new Promise((resolve) => server.close(resolve));
  server = undefined;
  const failed = await fixtureLock({ downloads: {
    "x86_64-unknown-linux-gnu": { sourceRevision: revision, assets: { backend: "k-brain-linux-x64", computer: "k-brain-computer-linux-x64" }, urls: { backend: "https://example.invalid/k-brain", computer: "https://example.invalid/k-brain-computer" }, sha256: { backend: "0".repeat(64), computer: "0".repeat(64) } },
  } });
  await assert.rejects(() => prepare({ lock: failed.path, target: "x86_64-unknown-linux-gnu", artifactDir: false, output: join(failed.directory, "output") }), /download failed|fetch failed|ENOTFOUND|network/i);
  const noDownloads = await fixtureLock();
  await assert.rejects(() => prepare({ lock: noDownloads.path, target: "x86_64-unknown-linux-gnu", artifactDir: false, output: join(noDownloads.directory, "output") }), /No pinned K-brain backend and computer artifacts/);
});

test("rejects an invalid lock before downloading", async () => {
  const lock = await fixtureLock({ sourceRevision: "not-a-revision" });
  await assert.rejects(() => readLock(lock.path), /Invalid K-brain lock/);
});

void defaultArtifact;
void defaultOutput;
