#!/usr/bin/env node
// Builds the debug desktop binary the E2E suite launches: the production
// frontend bundle embedded into a debug (LIVEAGENT_DEV_HOME-aware) Rust build,
// without installers. Sidecars that tauri-build requires but the suite does not
// use are stubbed; kn itself is supplied at run time via LIVEAGENT_KBRAIN_BINARY.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appBinary, catalogUrl, guiDir, hostTriple } from "../support/env.mjs";

const triple = hostTriple();
const suffix = process.platform === "win32" ? ".exe" : "";
const binaries = join(guiDir, "src-tauri", "binaries");
mkdirSync(binaries, { recursive: true });
for (const name of ["k-brain", "k-brain-computer", "liveagent-gateway"]) {
  const path = join(binaries, `${name}-${triple}${suffix}`);
  if (existsSync(path)) continue;
  writeFileSync(path, "#!/bin/sh\necho 'desktop E2E stub sidecar' >&2\nexit 1\n");
  chmodSync(path, 0o755);
  console.log(`stubbed ${path}`);
}

function run(command, args, env = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, { cwd: guiDir, stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// The runtime model catalog URL is a build-time setting; point it at the fake
// provider so the app never reaches the public catalog during tests.
const frontendEnv = { VITE_LIVEAGENT_MODEL_CATALOG_URL: catalogUrl };
if (!process.env.E2E_SKIP_FRONTEND_BUILD) run("pnpm", ["build"], frontendEnv);

run(
  "pnpm",
  ["tauri", "build", "--debug", "--no-bundle", "--config", JSON.stringify({ build: { beforeBuildCommand: "" } })],
  {
    // Line tables keep backtraces readable at a fraction of full debuginfo cost.
    CARGO_PROFILE_DEV_DEBUG: process.env.CARGO_PROFILE_DEV_DEBUG ?? "line-tables-only",
  },
);
console.log(`built ${appBinary()}`);
