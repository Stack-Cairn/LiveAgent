#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = {
  "x86_64-pc-windows-msvc": ["windows", "amd64"],
  "aarch64-pc-windows-msvc": ["windows", "arm64"],
  "x86_64-pc-windows-gnu": ["windows", "amd64"],
  "x86_64-apple-darwin": ["darwin", "amd64"],
  "aarch64-apple-darwin": ["darwin", "arm64"],
  "x86_64-unknown-linux-gnu": ["linux", "amd64"],
  "aarch64-unknown-linux-gnu": ["linux", "arm64"],
  "x86_64-unknown-linux-musl": ["linux", "amd64"],
  "aarch64-unknown-linux-musl": ["linux", "arm64"],
};

export function gatewayTarget(triple) {
  const target = targets[triple];
  if (!target) throw new Error(`Unsupported Gateway sidecar target: ${triple}`);
  const [goos, goarch] = target;
  return {
    triple,
    goos,
    goarch,
    filename: `liveagent-gateway-${triple}${goos === "windows" ? ".exe" : ""}`,
  };
}

export function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      windowsHide: true,
      ...options,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

async function hostTriple() {
  let output = "";
  await new Promise((resolveHost, reject) => {
    const child = spawn("rustc", ["--version", "--verbose"], {
      stdio: ["ignore", "pipe", "inherit"],
      windowsHide: true,
    });
    child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveHost() : reject(new Error("rustc host detection failed")));
  });
  const host = /^host: (.+)$/m.exec(output)?.[1]?.trim();
  if (!host) throw new Error("rustc did not report a host target");
  return host;
}

export async function prepareGateway({ root = repoRoot, triple, execute = run, env = process.env }) {
  const target = gatewayTarget(triple);
  const gatewayRoot = join(root, "crates", "agent-gateway");
  const outputDir = join(root, "crates", "agent-gui", "src-tauri", "binaries");
  const output = join(outputDir, target.filename);
  const temporary = `${output}.${process.pid}.tmp`;

  // Always build first: a dev-stack embed stub or another checkout's dist must
  // never silently become the WebUI shipped in the desktop application.
  // Only this fixed pnpm command uses a shell, for Windows' pnpm.cmd shim.
  const windowsPnpm = process.platform === "win32";
  await execute(windowsPnpm ? "pnpm --filter @liveagent/gateway-webui build" : "pnpm", windowsPnpm ? [] : ["--filter", "@liveagent/gateway-webui", "build"], {
    cwd: root,
    env,
    shell: windowsPnpm,
  });
  const index = await readFile(join(gatewayRoot, "web", "dist", "index.html"), "utf8");
  if (!/<script\b[^>]*\bsrc=["'][^"']+\.js["']/i.test(index)) {
    throw new Error("Gateway WebUI build contains no JavaScript entry (embed stub rejected)");
  }
  await mkdir(outputDir, { recursive: true });
  try {
    await execute("go", ["build", "-trimpath", "-o", temporary, "./cmd/gateway"], {
      cwd: gatewayRoot,
      env: { ...env, CGO_ENABLED: "0", GOOS: target.goos, GOARCH: target.goarch },
    });
    if ((await stat(temporary)).size === 0) throw new Error("Gateway sidecar is empty");
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

async function main(args) {
  let triple = process.env.TAURI_ENV_TARGET_TRIPLE;
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== "--target" || !args[i + 1]) throw new Error("Usage: node scripts/prepare-gateway.mjs [--target <rust-triple>]");
    triple = args[++i];
  }
  const output = await prepareGateway({ triple: triple || await hostTriple() });
  console.log(`Gateway sidecar ready: ${output}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`prepare-gateway: ${error.message}`);
    process.exitCode = 1;
  });
}
