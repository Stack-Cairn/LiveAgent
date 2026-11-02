import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSource } from "./build-kbrain-source.mjs";
import { readLock, resolveTarget } from "./prepare-kbrain.mjs";

test("source build pins checkout and hashes both sidecars", async () => {
  const output = await mkdtemp(join(tmpdir(), "kbrain-build-test-"));
  try {
    const lock = await readLock();
    const calls = [];
    const record = await buildSource({ output, sourceDir: output, run(command, args, options) {
      calls.push({ command, args, options });
      if (command === "go") writeFileSync(args[args.indexOf("-o") + 1], args.at(-1));
    } });
    assert.equal(calls[1].args.at(-1), lock.sourceRevision);
    assert.equal(calls[2].options.env.CGO_ENABLED, "0");
    assert.deepEqual(calls.filter(c => c.command === "go").map(c => c.args.at(-1)), ["./cmd/kn", "./cmd/k-brain-computer"]);
    assert.match(record.platforms[resolveTarget()].sha256.backend, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(await readFile(join(output, "kbrain-artifact.json"))), record);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test("failed build removes stale artifact receipt", async () => {
  const output = await mkdtemp(join(tmpdir(), "kbrain-build-fail-"));
  try {
    await writeFile(join(output, "kbrain-artifact.json"), "{}");
    await assert.rejects(buildSource({ output, run() { throw new Error("checkout failed"); } }), /checkout failed/);
    await assert.rejects(readFile(join(output, "kbrain-artifact.json")), { code: "ENOENT" });
  } finally { await rm(output, { recursive: true, force: true }); }
});
