#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolveRepoRoot();

function resolveRepoRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: false,
  });
  const toplevel = result.status === 0 ? result.stdout.trim() : "";
  return toplevel || resolve(import.meta.dirname, "..");
}

function git(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    shell: false,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return result.status === 0 ? result.stdout : undefined;
}

function verifiedCommit(ref) {
  const output = git(["rev-parse", "--verify", `${ref}^{commit}`], true);
  return output?.trim() || undefined;
}

function resolveBaseCommit() {
  const explicitRef = process.env.LIVEAGENT_CHECK_BASE_REF?.trim();
  if (explicitRef) {
    const commit = verifiedCommit(explicitRef);
    if (!commit) throw new Error(`LIVEAGENT_CHECK_BASE_REF is not a commit: ${explicitRef}`);
    return git(["merge-base", "HEAD", commit]).trim();
  }

  for (const ref of ["origin/main", "main"]) {
    const commit = verifiedCommit(ref);
    if (commit) return git(["merge-base", "HEAD", commit]).trim();
  }
  return verifiedCommit("HEAD");
}

/**
 * `git diff --check HEAD` 只看工作区，提交后的空白问题（CI 的 committed diff 检查）
 * 它看不见；因此这里额外比对一次 merge-base 到 HEAD 的提交区间。
 */
export function diffCheckTargets(base) {
  const targets = [["diff", "--check", "HEAD"]];
  if (base && base !== verifiedCommit("HEAD")) {
    targets.push(["diff", "--check", `${base}...HEAD`]);
  }
  return targets;
}

function main() {
  const base = resolveBaseCommit();
  const failures = [];

  for (const args of diffCheckTargets(base)) {
    const result = spawnSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      shell: false,
    });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
    if (result.status !== 0 && output) failures.push({ args, output });
  }

  if (failures.length === 0) {
    const scope = base ? `${base.slice(0, 7)}...HEAD` : "HEAD";
    console.log(`diff hygiene: clean (worktree + ${scope}).`);
    return;
  }

  for (const { args, output } of failures) {
    console.error(`git ${args.join(" ")}`);
    for (const line of output.split("\n")) console.error(`  ${line}`);
  }
  process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (error) {
    console.error(`check-diff-hygiene: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
