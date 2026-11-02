import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultArtifact, platformFor, readLock, resolveTarget } from "./prepare-kbrain.mjs";

// Build a detached checkout, never the developer's uncommitted working tree.
export async function buildSource(options = {}) {
  const lock = await readLock(options.lock);
  const target = resolveTarget(options.target);
  const platform = platformFor(lock, target);
  const output = resolve(options.output || defaultArtifact);
  const temporary = await mkdtemp(join(tmpdir(), "liveagent-kbrain-"));
  const source = join(temporary, "source");
  const run = options.run || execFileSync;
  try {
    await mkdir(output, { recursive: true });
    await rm(join(output, "kbrain-artifact.json"), { force: true });
    run("git", ["clone", "--no-checkout", "--no-hardlinks", "--", options.sourceDir ? resolve(options.sourceDir) : lock.repository, source], { stdio: "inherit" });
    run("git", ["-C", source, "checkout", "--detach", lock.sourceRevision], { stdio: "inherit" });
    const env = { ...process.env, CGO_ENABLED: "0", GOOS: platform.goos, GOARCH: platform.goarch };
    const sha256 = {};
    for (const [kind, command] of [["backend", "./cmd/kn"], ["computer", "./cmd/k-brain-computer"]]) {
      const destination = join(output, platform.assets[kind]);
      run("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=dev -X main.revision=${lock.sourceRevision}`, "-o", destination, command], { cwd: source, env, stdio: "inherit" });
      sha256[kind] = createHash("sha256").update(await readFile(destination)).digest("hex");
    }
    const record = { schemaVersion: 1, repository: lock.repository, sourceRevision: lock.sourceRevision, protocol: lock.protocol, platforms: { [target]: { assets: platform.assets, sha256 } } };
    await writeFile(join(output, "kbrain-artifact.json"), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      lock: { type: "string" }, target: { type: "string" }, "source-dir": { type: "string" }, "output-dir": { type: "string" },
    } });
    await buildSource({ lock: values.lock, target: values.target, sourceDir: values["source-dir"], output: values["output-dir"] });
    console.log("Built locked K-brain source artifact. Run pnpm prepare:kbrain to install the sidecars.");
  } catch (error) {
    console.error(`K-brain source build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
