import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  discoverTestFiles,
  parseArguments,
  selectShard,
  splitTestFilesIntoBatches,
} from "./run-node-tests.mjs";

test("parseArguments accepts repeatable excludes and a prefix", () => {
  const options = parseArguments([
    "--exclude-dir",
    "backend",
    "--exclude-dir",
    "generated",
    "--include-prefix",
    "release-",
    "test",
  ]);

  assert.deepEqual(options.roots, ["test"]);
  assert.deepEqual([...options.excludedDirectories], ["backend", "generated"]);
  assert.equal(options.includePrefix, "release-");
});

test("discoverTestFiles recursively finds, filters, deduplicates, and sorts tests", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "liveagent-node-tests-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "test", "backend"), { recursive: true });
  await mkdir(join(root, "test", "nested"), { recursive: true });
  await writeFile(join(root, "test", "z.test.mjs"), "");
  await writeFile(join(root, "test", "nested", "a.test.mjs"), "");
  await writeFile(join(root, "test", "nested", "not-a-test.mjs"), "");
  await writeFile(join(root, "test", "backend", "release-one.test.mjs"), "");

  const options = parseArguments(["--exclude-dir", "backend", "test", "test/nested"]);
  const files = await discoverTestFiles(options, root);

  assert.deepEqual(files, [
    join(root, "test", "nested", "a.test.mjs"),
    join(root, "test", "z.test.mjs"),
  ]);
});

test("discoverTestFiles applies basename prefixes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "liveagent-node-tests-prefix-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "test"), { recursive: true });
  await writeFile(join(root, "test", "release-one.test.mjs"), "");
  await writeFile(join(root, "test", "other.test.mjs"), "");

  const files = await discoverTestFiles(
    parseArguments(["--include-prefix", "release-", "test"]),
    root,
  );

  assert.deepEqual(files, [join(root, "test", "release-one.test.mjs")]);
});

test("splitTestFilesIntoBatches keeps every batch under the command limit", () => {
  const files = ["a.test.mjs", "b.test.mjs", "c.test.mjs", "d.test.mjs"];

  assert.deepEqual(splitTestFilesIntoBatches(files, 20), [
    ["a.test.mjs"],
    ["b.test.mjs"],
    ["c.test.mjs"],
    ["d.test.mjs"],
  ]);
  assert.deepEqual(splitTestFilesIntoBatches(files, 24), [
    ["a.test.mjs", "b.test.mjs"],
    ["c.test.mjs", "d.test.mjs"],
  ]);
});

test("parseArguments accepts a 1-based shard and rejects malformed ones", () => {
  assert.deepEqual(parseArguments(["test", "--shard", "2/3"]).shard, { index: 2, total: 3 });
  assert.equal(parseArguments(["test"]).shard, undefined);

  for (const value of ["0/2", "3/2", "1/0", "1", "a/b", "-1/2", "1/2/3"]) {
    assert.throws(() => parseArguments(["--shard", value, "test"]), /--shard expects INDEX\/TOTAL/);
  }
  assert.throws(() => parseArguments(["test", "--shard"]), /--shard requires a value/);
});

test("selectShard splits files round-robin and the shards cover every file once", () => {
  const files = ["a", "b", "c", "d", "e"].map((name) => `${name}.test.mjs`);

  assert.deepEqual(selectShard(files, undefined), files);
  assert.deepEqual(selectShard(files, { index: 1, total: 2 }), ["a.test.mjs", "c.test.mjs", "e.test.mjs"]);
  assert.deepEqual(selectShard(files, { index: 2, total: 2 }), ["b.test.mjs", "d.test.mjs"]);

  for (const total of [1, 2, 3, 7]) {
    const shards = Array.from({ length: total }, (_, index) => selectShard(files, { index: index + 1, total }));
    assert.deepEqual(shards.flat().sort(), files);
  }
});
