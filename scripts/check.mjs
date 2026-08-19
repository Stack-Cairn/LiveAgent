#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

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
const reportPath = resolve(process.env.LIVEAGENT_CHECK_REPORT_PATH ?? join(runDir, "report.json"));
const commandEnvironment = {
  ...process.env,
  GOCACHE: process.env.GOCACHE ?? join(runDir, "go-cache"),
  GOLANGCI_LINT_CACHE: process.env.GOLANGCI_LINT_CACHE ?? join(runDir, "golangci-cache"),
};

function usage() {
  console.log(`Usage: node scripts/check.mjs <fast|all|strict>

Profiles:
  fast    Run script/UI checks, builds, complete lint diagnostics and Go tests.
  all     Run fast plus discovered frontend/release/Rust tests and protobuf checks.
  strict  Run all plus rustfmt, Clippy and warnings-as-errors lint checks.

Environment variables:
  LIVEAGENT_CHECK_KEEP_GOING=1  Continue after failures and report every failed step.
  LIVEAGENT_CHECK_LOG_DIR=PATH  Parent directory for the run log.
  LIVEAGENT_CHECK_REPORT_PATH=PATH  JSON report path (default: beside check.log).`);
}

function commandStep(name, command, args, cwd = repoRoot) {
  return { args, command, cwd, name };
}

function miseStep(name, tool, args, cwd = repoRoot) {
  return commandStep(name, "mise", ["exec", "--", tool, ...args], cwd);
}

function biomeStep(name, workspace, strict = false) {
  const args = [
    "--filter",
    workspace,
    "exec",
    "biome",
    "check",
    "src/",
    "--max-diagnostics=none",
  ];
  if (strict) args.push("--error-on-warnings");
  return miseStep(name, "pnpm", args);
}

function buildSteps() {
  const strict = profile === "strict";
  const steps = [
    commandStep("Diff hygiene", "git", ["diff", "--check", "HEAD"]),
    miseStep("Check script tests", "pnpm", ["check:script-tests"]),
    miseStep("Shared UI boundaries", "pnpm", ["check:ui-boundaries"]),
    miseStep("Shared UI TypeScript check", "pnpm", ["typecheck:ui"]),
    miseStep("GUI TypeScript and Vite build", "pnpm", ["build:gui"]),
    miseStep("WebUI TypeScript and Vite build", "pnpm", ["build:webui"]),
    miseStep("Tauri Rust check", "cargo", ["check", "--workspace", "--tests"]),
  ];

  if (strict) {
    steps.push(
      biomeStep("Shared UI lint (warnings are errors)", "@liveagent/ui", true),
      biomeStep("GUI lint (warnings are errors)", "liveagent", true),
      biomeStep("WebUI lint (warnings are errors)", "@liveagent/gateway-webui", true),
    );
  } else {
    steps.push(
      biomeStep("Shared UI lint", "@liveagent/ui"),
      biomeStep("GUI lint", "liveagent"),
      biomeStep("WebUI lint", "@liveagent/gateway-webui"),
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
      miseStep("Tauri Rust all-target tests", "cargo", ["test", "--workspace", "--all-targets"]),
      miseStep("Tauri Rust doc tests", "cargo", ["test", "--workspace", "--doc"]),
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
  const startedAt = new Date();
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
  const endedAt = new Date();
  const durationMs = endedAt.getTime() - startedAt.getTime();
  const duration = Math.ceil(durationMs / 1000);
  const result = `[${index}] ${status}: ${step.name} (${duration}s)\n`;
  process.stdout.write(result);
  log.write(result);
  return {
    args: step.args,
    command: step.command,
    cwd: relative(repoRoot, step.cwd) || ".",
    durationMs,
    endedAt: endedAt.toISOString(),
    exitCode,
    index,
    name: step.name,
    startedAt: startedAt.toISOString(),
    status: status.toLowerCase(),
  };
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

  const startedAt = new Date();
  mkdirSync(runDir, { recursive: true });
  mkdirSync(commandEnvironment.GOCACHE, { recursive: true });
  mkdirSync(commandEnvironment.GOLANGCI_LINT_CACHE, { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  const log = createWriteStream(logPath, { flags: "w" });
  const header = `LiveAgent check profile: ${profile}\nPlatform: ${process.platform} ${process.arch}\nLog: ${logPath}\nReport: ${reportPath}\nKeep going after failures: ${keepGoing ? "1" : "0"}\n`;
  process.stdout.write(header);
  log.write(header);

  const results = [];
  for (const [index, step] of buildSteps().entries()) {
    const result = await runStep(step, index + 1, log);
    results.push(result);
    if (result.exitCode !== 0 && !keepGoing) break;
  }

  const failed = results.some((result) => result.exitCode !== 0);
  const endedAt = new Date();
  const report = {
    schemaVersion: 1,
    profile,
    status: failed ? "failed" : "passed",
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
    platform: { arch: process.arch, os: process.platform },
    keepGoing,
    logPath,
    reportPath,
    totals: {
      failed: results.filter((result) => result.status === "fail").length,
      passed: results.filter((result) => result.status === "pass").length,
      steps: results.length,
    },
    steps: results,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const summary = [
    "",
    `LiveAgent check profile: ${profile}`,
    `Platform: ${process.platform} ${process.arch}`,
    ...results.map(
      (result) =>
        `${String(result.index).padEnd(3)} ${result.status.toUpperCase().padEnd(5)} ${result.name}`,
    ),
    `Log: ${logPath}`,
    `Report: ${reportPath}`,
    "",
  ].join("\n");
  process.stdout.write(summary);
  log.write(summary);
  await new Promise((resolveClosed) => log.end(resolveClosed));

  if (failed) {
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
