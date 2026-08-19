import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { discoverTestFiles, parseArguments } from "./run-node-tests.mjs";

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
