#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");
const supportedExtensions = new Set([".css", ".js", ".json", ".jsonc", ".jsx", ".ts", ".tsx"]);
const workspaces = {
  gui: { filter: "liveagent", root: "crates/agent-gui" },
  ui: { filter: "@liveagent/ui", root: "crates/agent-ui" },
  webui: { filter: "@liveagent/gateway-webui", root: "crates/agent-gateway/web" },
};

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

export function selectChangedSourceFiles(workspaceRoot, paths) {
  const sourcePrefix = `${workspaceRoot}/src/`;
  return [...new Set(paths)]
    .filter((path) => path.startsWith(sourcePrefix) && supportedExtensions.has(extname(path)))
    .sort((left, right) => left.localeCompare(right));
}

function splitNul(output) {
  return output.split("\0").filter(Boolean);
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
  const head = verifiedCommit("HEAD");
  if (!head) throw new Error("HEAD is not a commit");
  return head;
}

function changedFiles(workspaceRoot) {
  const base = resolveBaseCommit();
  const tracked = splitNul(
    git(["diff", "--name-only", "-z", "--diff-filter=ACMR", base, "--", `${workspaceRoot}/src`]),
  );
  const untracked = splitNul(
    git(["ls-files", "--others", "--exclude-standard", "-z", "--", `${workspaceRoot}/src`]),
  );
  return { base, files: selectChangedSourceFiles(workspaceRoot, [...tracked, ...untracked]) };
}

async function runBiome(workspace, files) {
  const cwd = resolve(repoRoot, workspace.root);
  const workspaceFiles = files.map((path) => relative(cwd, resolve(repoRoot, path)));
  return await new Promise((resolveExitCode) => {
    const child = spawn(
      "mise",
      [
        "exec",
        "--",
        "pnpm",
        "--filter",
        workspace.filter,
        "exec",
        "biome",
        "check",
        ...workspaceFiles,
        "--max-diagnostics=none",
        "--error-on-warnings",
      ],
      { cwd: repoRoot, shell: false, stdio: "inherit" },
    );
    child.once("error", (error) => {
      console.error(`check-biome-changed: ${error.message}`);
      resolveExitCode(127);
    });
    child.once("close", (code) => resolveExitCode(code ?? 1));
  });
}

async function main() {
  const workspaceName = process.argv[2];
  const workspace = workspaces[workspaceName];
  if (!workspace) throw new Error("workspace must be ui, gui, or webui");
  const { base, files } = changedFiles(workspace.root);
  if (files.length === 0) {
    console.log(`${workspaceName}: no changed source files since ${base}; warning gate skipped.`);
    return;
  }
  console.log(`${workspaceName}: checking ${files.length} changed source files since ${base}.`);
  process.exitCode = await runBiome(workspace, files);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`check-biome-changed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
