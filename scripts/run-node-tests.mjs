#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage() {
  console.log(`Usage: node scripts/run-node-tests.mjs [options] <directory> [...directories]

Options:
  --exclude-dir NAME       Skip directories with this exact name. Repeatable.
  --include-prefix PREFIX  Run only test files whose basename starts with PREFIX.`);
}

export function parseArguments(args) {
  const roots = [];
  const excludedDirectories = new Set();
  let includePrefix;

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "-h" || value === "--help") return { help: true };
    if (value === "--exclude-dir" || value === "--include-prefix") {
      const optionValue = args[index + 1];
      if (!optionValue || optionValue.startsWith("--")) {
        throw new Error(`${value} requires a value`);
      }
      if (value === "--exclude-dir") excludedDirectories.add(optionValue);
      else includePrefix = optionValue;
      index += 1;
      continue;
    }
    if (value.startsWith("--")) throw new Error(`unknown option: ${value}`);
    roots.push(value);
  }

  if (roots.length === 0) throw new Error("at least one test directory is required");
  return { excludedDirectories, help: false, includePrefix, roots };
}

async function collectDirectory(directory, options, files) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!options.excludedDirectories.has(entry.name)) {
        await collectDirectory(entryPath, options, files);
      }
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".test.mjs")) continue;
    if (options.includePrefix && !basename(entry.name).startsWith(options.includePrefix)) continue;
    files.push(entryPath);
  }
}

export async function discoverTestFiles(options, cwd = process.cwd()) {
  const files = [];
  for (const root of options.roots) {
    await collectDirectory(resolve(cwd, root), options, files);
  }
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

const WINDOWS_COMMAND_LENGTH_LIMIT = 8_000;

export function splitTestFilesIntoBatches(
  files,
  maxCommandLength = process.platform === "win32"
    ? WINDOWS_COMMAND_LENGTH_LIMIT
    : Number.POSITIVE_INFINITY,
) {
  const batches = [];
  let batch = [];
  let commandLength = 0;

  for (const file of files) {
    const argumentLength = file.length + 1;
    if (batch.length > 0 && commandLength + argumentLength > maxCommandLength) {
      batches.push(batch);
      batch = [];
      commandLength = 0;
    }
    batch.push(file);
    commandLength += argumentLength;
  }

  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function runTestBatch(files) {
  return await new Promise((resolveExitCode) => {
    const child = spawn(process.execPath, ["--test", ...files], {
      shell: false,
      stdio: "inherit",
    });
    child.once("error", (error) => {
      console.error(`run-node-tests: ${error.message}`);
      resolveExitCode(127);
    });
    child.once("close", (code) => resolveExitCode(code ?? 1));
  });
}

async function runTests(files) {
  for (const batch of splitTestFilesIntoBatches(files)) {
    const exitCode = await runTestBatch(batch);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  const files = await discoverTestFiles(options);
  if (files.length === 0) throw new Error("no .test.mjs files discovered");
  console.log(`Discovered ${files.length} Node test files.`);
  process.exitCode = await runTests(files);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`run-node-tests: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
