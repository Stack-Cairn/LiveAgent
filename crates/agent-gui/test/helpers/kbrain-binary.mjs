import { prepare } from "../../../../scripts/release/prepare-kbrain.mjs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { after } from "node:test";

let prepared;
let directory;

after(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function prepareBinary() {
  directory = await mkdtemp(join(tmpdir(), "kbrain-release-test-"));
  return prepare({ release: true, artifactDir: false, output: directory });
}

// Use the same pinned, checksum-verified release binaries as desktop packaging.
export async function getKBrainBinary() {
  const sourceBinary = process.env.LIVEAGENT_KBRAIN_BINARY;
  if (sourceBinary) {
    if (!isAbsolute(sourceBinary)) throw new Error("LIVEAGENT_KBRAIN_BINARY must be absolute");
    await access(sourceBinary);
    return sourceBinary;
  }
  prepared ??= prepareBinary();
  return (await prepared).binary;
}
