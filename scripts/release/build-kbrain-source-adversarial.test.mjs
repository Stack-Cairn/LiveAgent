// Adversarial review (S1/K0): K-brain now reports build.version / build.revision /
// build.channel from `-X main.version` and `-X main.revision`. This producer was
// not updated: it still injects the commit as main.version and no main.revision,
// so a `pnpm build:kbrain:source` sidecar reports
// {version: "<40-hex>", channel: "stable"} with no revision, and the new About
// row shows "K-brain 51c827d3… (stable)".
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSource } from "./build-kbrain-source.mjs";
import { readLock } from "./prepare-kbrain.mjs";

test("source build injects the locked commit as main.revision, not as the release version", async () => {
  const output = await mkdtemp(join(tmpdir(), "kbrain-build-adversarial-"));
  try {
    const lock = await readLock();
    const builds = [];
    await buildSource({
      output,
      sourceDir: output,
      run(command, args) {
        if (command !== "go") return;
        builds.push(args);
        writeFileSync(args[args.indexOf("-o") + 1], args.at(-1));
      },
    });
    const backend = builds.find((args) => args.at(-1) === "./cmd/kn");
    const ldflags = backend[backend.indexOf("-ldflags") + 1];
    assert.match(ldflags, new RegExp(`-X main\\.revision=${lock.sourceRevision}\\b`), ldflags);
    assert.doesNotMatch(ldflags, new RegExp(`-X main\\.version=${lock.sourceRevision}\\b`), ldflags);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
