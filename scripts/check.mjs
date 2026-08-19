#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "..");
const gatewayDir = join(repoRoot, "crates/agent-gateway");
const profile = process.argv[2] ?? "fast";
const keepGoing = process.env.LIVEAGENT_CHECK_KEEP_GOING === "1";
const userKey =
  typeof process.getuid === "function" ? String(process.getuid()) : (process.env.USERNAME ?? "user");
const logRoot = resolve(
  process.env.LIVEAGENT_CHECK_LOG_DIR ?? join(tmpdir(), `liveagent-check-${userKey}`),
);
const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "")}-${profile}-${process.pid}`;
const runDir = join(logRoot, runId);
const logPath = join(runDir, "check.log");
const commandEnvironment = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? join(runDir, "go-cache"),
  GOLANGCI_LINT_CACHE: process.env.GOLANGCI_LINT_CACHE ?? join(runDir, "golangci-cache"),
};

function usage() {
  console.log(`Usage: node scripts/check.mjs <fast|all|strict>

Profiles:
  fast    Build GUI/WebUI/Rust and run CI-aligned linters, boundaries and Go tests.
  all     Run fast plus frontend/release/Rust tests and protobuf contract checks.
  strict  Run all plus shared UI lint, rustfmt and warnings-as-errors checks.

Environment variables:
  LIVEAGENT_CHECK_KEEP_GOING=1  Continue after failures and report every failed step.
  LIVEAGENT_CHECK_LOG_DIR=PATH  Parent directory for the run log.`);
}

function commandStep(name, command, args, cwd = repoRoot) {
  return { args, command, cwd, name };
}

function miseStep(name, tool, args, cwd = repoRoot) {
  return commandStep(name, "mise", ["exec", "--", tool, ...args], cwd);
}

function biomeStep(name, workspace) {
  return miseStep(name, "pnpm", [
    "--filter",
    workspace,
    "exec",
    "biome",
    "check",
    "src/",
    "--error-on-warnings",
  ]);
}

function buildSteps() {
  const strict = profile === "strict";
  const steps = [
    commandStep("Diff hygiene", "git", ["diff", "--check", "HEAD"]),
    miseStep("Shared UI boundaries", "pnpm", ["check:ui-boundaries"]),
    miseStep("GUI TypeScript and Vite build", "pnpm", ["build:gui"]),
    miseStep("WebUI TypeScript and Vite build", "pnpm", ["build:webui"]),
    miseStep("Tauri Rust check", "cargo", ["check", "--workspace", "--tests"]),
  ];

  if (strict) {
    steps.push(
      biomeStep("Shared UI lint (warnings are errors)", "@liveagent/ui"),
      biomeStep("GUI lint (warnings are errors)", "liveagent"),
      biomeStep("WebUI lint (warnings are errors)", "@liveagent/gateway-webui"),
    );
  } else {
    steps.push(
      miseStep("GUI lint", "pnpm", ["lint:gui"]),
      miseStep("WebUI lint", "pnpm", ["lint:webui"]),
    );
  }

  steps.push(
    miseStep("Gateway golangci-lint", "golangci-lint", ["run", "./..."], gatewayDir),
    miseStep("Gateway Go tests", "go", ["test", "./..."], gatewayDir),
  );

  if (profile === "all" || strict) {
    steps.push(
      miseStep("GUI frontend tests", "pnpm", ["test:gui"]),
      miseStep("WebUI tests", "pnpm", ["test:webui"]),
      miseStep("Release script tests", "pnpm", ["--dir", "crates/agent-gui", "test:release"]),
      miseStep("Tauri Rust library tests", "cargo", ["test", "--workspace", "--lib"]),
      miseStep("Proto lint", "buf", ["lint"], gatewayDir),
      miseStep(
        "Proto breaking check",
        "buf",
        [
          "breaking",
          "--against",
          process.env.BUF_BREAKING_AGAINST ?? "../../.git#subdir=crates/agent-gateway",
        ],
        gatewayDir,
      ),
    );
  }

  if (strict) {
    steps.push(
      miseStep("Rust format", "cargo", ["fmt", "--all", "--", "--check"]),
      miseStep("Rust Clippy (warnings are errors)", "cargo", [
        "clippy",
        "--workspace",
        "--all-targets",
        "--",
        "-D",
        "warnings",
      ]),
    );
  }
  return steps;
}

function formatCommand(step) {
  return [step.command, ...step.args]
    .map((value) => (/^[A-Za-z0-9_./:=@#-]+$/.test(value) ? value : JSON.stringify(value)))
    .join(" ");
}

async function runStep(step, index, log) {
  const startedAt = Date.now();
  const heading = `\n[${index}] ${step.name}\ncommand: ${formatCommand(step)}\ncwd: ${relative(repoRoot, step.cwd) || "."}\n\n`;
  process.stdout.write(heading);
  log.write(heading);

  const exitCode = await new Promise((resolveExitCode) => {
    const child = spawn(step.command, step.args, {
      cwd: step.cwd,
      env: commandEnvironment,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let resolved = false;
    const finish = (code) => {
      if (resolved) return;
      resolved = true;
      resolveExitCode(code);
    };
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    child.once("error", (error) => {
      const message = `Failed to start ${step.command}: ${error.message}\n`;
      process.stderr.write(message);
      log.write(message);
      finish(127);
    });
    child.once("close", (code) => finish(code ?? 1));
  });

  const status = exitCode === 0 ? "PASS" : "FAIL";
  const duration = Math.ceil((Date.now() - startedAt) / 1000);
  const result = `[${index}] ${status}: ${step.name} (${duration}s)\n`;
  process.stdout.write(result);
  log.write(result);
  return { exitCode, name: step.name, status };
}

async function main() {
  if (["-h", "--help", "help"].includes(profile)) {
    usage();
    return;
  }
  if (!["fast", "all", "strict"].includes(profile)) {
    usage();
    process.exitCode = 2;
    return;
  }
  if (![undefined, "0", "1"].includes(process.env.LIVEAGENT_CHECK_KEEP_GOING)) {
    throw new Error("LIVEAGENT_CHECK_KEEP_GOING must be 0 or 1");
  }

  mkdirSync(commandEnvironment.GOCACHE, { recursive: true });
  mkdirSync(commandEnvironment.GOLANGCI_LINT_CACHE, { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  const header = `LiveAgent check profile: ${profile}\nPlatform: ${process.platform} ${process.arch}\nLog: ${logPath}\nKeep going after failures: ${keepGoing ? "1" : "0"}\n`;
  process.stdout.write(header);
  log.write(header);

  const results = [];
  for (const [index, step] of buildSteps().entries()) {
    const result = await runStep(step, index + 1, log);
    results.push(result);
    if (result.exitCode !== 0 && !keepGoing) break;
  }

  const summary = [
    "",
    `LiveAgent check profile: ${profile}`,
    `Platform: ${process.platform} ${process.arch}`,
    ...results.map(
      (result, index) => `${String(index + 1).padEnd(3)} ${result.status.padEnd(5)} ${result.name}`,
    ),
    `Log: ${logPath}`,
    "",
  ].join("\n");
  process.stdout.write(summary);
  log.write(summary);
  await new Promise((resolveClosed) => log.end(resolveClosed));

  if (results.some((result) => result.exitCode !== 0)) {
    console.error(`Check failed. Log: ${logPath}`);
    process.exitCode = 1;
  } else {
    console.log(`Check passed. Log: ${logPath}`);
  }
}

main().catch((error) => {
  console.error(`check: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
