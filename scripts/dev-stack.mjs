#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const scriptPath = resolve(import.meta.filename);
const repoRoot = resolve(import.meta.dirname, "..");
const agentGuiDir = join(repoRoot, "crates/agent-gui");
const devPrepareScript = resolve(import.meta.dirname, "dev-prepare.mjs");

// Detect whether `mise` is on PATH once at startup. The CLI uses mise to
// pin Node/pnpm/go versions; on machines without mise we fall back to
// direct binary invocation. `LIVEAGENT_DEV_MISE` overrides detection so
// the test harness can force either path.
function detectMise() {
  const override = process.env.LIVEAGENT_DEV_MISE;
  if (override === "0" || override === "false") return null;
  if (override) return override;
  const found = spawnSync("which", ["mise"], { encoding: "utf8", shell: false });
  if (found.status === 0 && found.stdout.trim()) return "mise";
  return null;
}
const miseBinary = detectMise();
const userKey =
  typeof process.getuid === "function" ? String(process.getuid()) : (process.env.USERNAME ?? "user");
const stateDir = resolve(
  process.env.LIVEAGENT_DEV_STATE_DIR ?? join(tmpdir(), `liveagent-dev-stack-${userKey}`),
);
const gatewayDataDir = resolve(
  process.env.LIVEAGENT_GATEWAY_DATA_DIR ?? join(homedir(), ".liveagent/gateway"),
);
const ports = {
  desktop: Number(process.env.LIVEAGENT_DEV_DESKTOP_PORT ?? 1420),
  gateway: Number(process.env.LIVEAGENT_DEV_GATEWAY_PORT ?? 50052),
  webui: Number(process.env.LIVEAGENT_DEV_WEBUI_PORT ?? 5173),
};
const mcpBridgePort = Number(process.env.LIVEAGENT_DEV_MCP_BRIDGE_PORT ?? 9223);
const gatewayToken = process.env.LIVEAGENT_GATEWAY_TOKEN ?? process.env.DEV_GATEWAY_TOKEN ?? "dev-token";
const urls = Object.fromEntries(
  Object.entries(ports).map(([service, port]) => [service, `http://localhost:${port}`]),
);
const services = ["gateway", "webui", "desktop"];
const heartbeatMaxAgeMs = 10_000;

function usage() {
  console.log(`Usage: node scripts/dev-stack.mjs <start|stop|restart|status|logs> [desktop|gateway|webui|all]

Environment variables:
  LIVEAGENT_GATEWAY_TOKEN       Gateway token (default: dev-token)
  LIVEAGENT_GATEWAY_DATA_DIR    Gateway data directory
  LIVEAGENT_DEV_GATEWAY_PORT    Gateway HTTP port (default: 50052)
  LIVEAGENT_DEV_WEBUI_PORT      WebUI Vite port (default: 5173)
  LIVEAGENT_DEV_DESKTOP_PORT    Desktop Vite port (default: 1420)
  LIVEAGENT_DEV_MCP_BRIDGE_PORT MCP Bridge port (default: 9223)
  LIVEAGENT_DEV_STATE_DIR       State and log directory`);
}

function fail(message) {
  throw new Error(`dev-stack: ${message}`);
}

function validateConfiguration() {
  for (const [name, port] of [...Object.entries(ports), ["mcp-bridge", mcpBridgePort]]) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail(`invalid ${name} port: ${port}`);
  }
}

function statePath(service) {
  return join(stateDir, `${service}.json`);
}

function logPath(service) {
  return join(stateDir, `${service}.log`);
}

function readState(service) {
  try {
    const state = JSON.parse(readFileSync(statePath(service), "utf8"));
    if (
      state.service !== service ||
      !Number.isInteger(state.pid) ||
      typeof state.token !== "string" ||
      typeof state.heartbeatAt !== "number"
    ) {
      return undefined;
    }
    return state;
  } catch {
    return undefined;
  }
}

function writeState(state) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(statePath(state.service), `${JSON.stringify(state)}\n`);
}

function removeState(service, token) {
  const state = readState(service);
  if (state && token && state.token !== token) return;
  try {
    unlinkSync(statePath(service));
  } catch {}
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return true;
    return false;
  }
}

function stateIsFresh(state) {
  return Date.now() - state.heartbeatAt <= heartbeatMaxAgeMs;
}

function managedState(service) {
  const state = readState(service);
  if (!state) return undefined;
  if (!processIsAlive(state.pid)) {
    removeState(service, state.token);
    return undefined;
  }
  return state;
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function portIsListening(port) {
  return await new Promise((resolveListening) => {
    const socket = createConnection({ host: "localhost", port });
    const finish = (listening) => {
      socket.destroy();
      resolveListening(listening);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function httpReady(service) {
  const url = service === "gateway" ? `${urls.gateway}/healthz` : `${urls[service]}/`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  } catch {
    return false;
  }
}

function ensureWebUiEmbedStub() {
  const distDir = join(repoRoot, "crates/agent-gateway/web/dist");
  const indexPath = join(distDir, "index.html");
  if (existsSync(indexPath)) return;
  mkdirSync(distDir, { recursive: true });
  writeFileSync(
    indexPath,
    '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>LiveAgent Gateway</title></head><body><p>WebUI embed stub. Start the WebUI dev server for the real SPA.</p></body></html>\n',
  );
}

function serviceCommand(service) {
  if (service === "gateway") {
    ensureWebUiEmbedStub();
    mkdirSync(gatewayDataDir, { recursive: true });
    return {
      // `mise exec -- go …` resolves the toolchain from .mise.toml; without
      // mise we fall back to a plain `go` invocation on PATH.
      directArgs: ["go", "-C", "crates/agent-gateway", "run", "./cmd/gateway"],
      miseArgs: ["exec", "--", "go", "-C", "crates/agent-gateway", "run", "./cmd/gateway"],
      cwd: repoRoot,
      env: {
        ...process.env,
        GOCACHE: process.env.GOCACHE ?? join(stateDir, "go-cache"),
        LIVEAGENT_GATEWAY_DATA_DIR: gatewayDataDir,
        LIVEAGENT_GATEWAY_HTTP_ADDR: `:${ports.gateway}`,
        LIVEAGENT_GATEWAY_TOKEN: gatewayToken,
      },
    };
  }
  if (service === "webui") {
    return {
      directArgs: [
        "node",
        "node_modules/vite/bin/vite.js",
        "--host",
        "localhost",
        "--port",
        String(ports.webui),
        "--strictPort",
      ],
      miseArgs: [
        "exec",
        "--",
        "node",
        "node_modules/vite/bin/vite.js",
        "--host",
        "localhost",
        "--port",
        String(ports.webui),
        "--strictPort",
      ],
      cwd: join(repoRoot, "crates/agent-gateway/web"),
      env: { ...process.env, npm_config_proxy_api: urls.gateway },
    };
  }
  return {
    directArgs: ["pnpm", "--dir", agentGuiDir, "tauri", "dev"],
    miseArgs: ["exec", "--", "pnpm", "--dir", agentGuiDir, "tauri", "dev"],
    // CUA-008: Vite must start from `crates/agent-gui` so unplugin-icons
    // can resolve @iconify-json/* via the workspace's node_modules. Starting
    // from the repo root leaves ~icons/* un-resolvable and the SPA falls
    // back to the ErrorOverlay, which then becomes invisible to cua-driver.
    cwd: agentGuiDir,
    env: {
      ...process.env,
      VITE_LIVEAGENT_SESSION_WORKBENCH: process.env.DEV_SESSION_WORKBENCH ?? "1",
    },
  };
}

function runDevPrepare() {
  try {
    const result = spawnSync(process.execPath, [devPrepareScript], {
      encoding: "utf8",
      stdio: ["ignore", "inherit", "inherit"],
      windowsHide: true,
    });
    if (result.error) {
      console.error(`dev-stack: dev-prepare failed: ${result.error.message}`);
    }
  } catch (error) {
    console.error(
      `dev-stack: dev-prepare crashed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

// CUA-016: dev binary crashes that happen AFTER startup can spawn fresh
// Problem Reporter dialogs that the one-shot dev-prepare sweep misses.
// Spawn dev-prepare in --watch mode as a detached supervisor so a stale
// dialog that appears 30 s after launch still gets cleaned up. The
// watcher is owned by the desktop state directory and dies with the
// dev-stack session.
function startProblemReporterWatcher() {
  // CUA-016 is only meaningful on macOS — Problem Reporter is a
  // macOS-specific ReportCrash helper. No-op on every other platform.
  if (process.platform !== "darwin") return null;
  mkdirSync(stateDir, { recursive: true });
  // Default sweep cadence: 7 s. Short enough that a freshly-spawned
  // dialog is dismissed within one tick, long enough that the sweep
  // doesn't fight ReportCrash's own respawn loop.
  const intervalMs = process.env.LIVEAGENT_PROBLEM_REPORTER_SWEEP_MS ?? "7000";
  const logFile = openSync(logPath("problem-reporter-watcher"), "a");
  const watcher = spawn(
    process.execPath,
    [devPrepareScript, "--watch", intervalMs],
    {
      detached: true,
      env: process.env,
      shell: false,
      stdio: ["ignore", logFile, logFile],
      windowsHide: true,
    },
  );
  closeSync(logFile);
  if (!watcher.pid) {
    console.error("dev-stack: failed to start Problem Reporter watcher");
    return null;
  }
  watcher.unref();
  console.log(
    `dev-stack: Problem Reporter watcher started (pid ${watcher.pid}, sweep every ${intervalMs}ms, log ${logPath("problem-reporter-watcher")})`,
  );
  return watcher.pid;
}

function stopProblemReporterWatcher() {
  if (process.platform !== "darwin") return;
  // pkill -f matches the full argv; --watch is unique enough to avoid
  // hitting dev-prepare's other invocations (which are short-lived).
  try {
    spawnSync("pkill", ["-f", `${devPrepareScript}.*--watch`], {
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {}
}

/// `mise exec` pins tool versions for the dev stack. When mise is not on
/// PATH (CI sandboxes, minimal local installs) we fall back to running the
/// underlying binary directly. The mapping here mirrors `serviceCommand`.
function spawnService(commandSpec) {
  if (miseBinary) {
    return spawn(miseBinary, commandSpec.miseArgs, {
      cwd: commandSpec.cwd,
      env: commandSpec.env,
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
  }
  return spawn(commandSpec.directArgs[0], commandSpec.directArgs.slice(1), {
    cwd: commandSpec.cwd,
    env: commandSpec.env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
}

async function runService(service, token) {
  process.title = `liveagent-dev-stack-${service}`;
  const command = serviceCommand(service);
  mkdirSync(join(stateDir, "go-cache"), { recursive: true });
  const child = spawnService(command);
  const startedAt = Date.now();
  const updateHeartbeat = () =>
    writeState({
      childPid: child.pid,
      heartbeatAt: Date.now(),
      pid: process.pid,
      service,
      startedAt,
      token,
    });
  updateHeartbeat();
  const heartbeat = setInterval(updateHeartbeat, 2000);
  heartbeat.unref();

  let stopping = false;
  const stopChild = () => {
    if (stopping) return;
    stopping = true;
    try {
      child.kill("SIGTERM");
    } catch {}
  };
  process.on("SIGTERM", stopChild);
  process.on("SIGINT", stopChild);

  const exitCode = await new Promise((resolveExitCode) => {
    child.once("error", (error) => {
      console.error(`Failed to start ${command.miseArgs[0] ?? "service"}: ${error.message}`);
      resolveExitCode(127);
    });
    child.once("exit", (code) => resolveExitCode(code ?? 1));
  });
  clearInterval(heartbeat);
  removeState(service, token);
  process.exitCode = exitCode;
}

function launchSupervisor(service) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(logPath(service), "");
  const log = openSync(logPath(service), "a");
  const token = randomUUID();
  const supervisor = spawn(process.execPath, [scriptPath, "__run", service, token], {
    detached: true,
    env: process.env,
    shell: false,
    stdio: ["ignore", log, log],
    windowsHide: true,
  });
  closeSync(log);
  if (!supervisor.pid) fail(`failed to launch ${service} supervisor`);
  writeState({
    heartbeatAt: Date.now(),
    pid: supervisor.pid,
    service,
    startedAt: Date.now(),
    token,
  });
  supervisor.unref();
  return { pid: supervisor.pid, token };
}

function tail(file, lineCount) {
  try {
    return readFileSync(file, "utf8").split(/\r?\n/).slice(-lineCount).join("\n");
  } catch {
    return "No managed log yet.";
  }
}

async function waitUntilReady(service, timeoutSeconds) {
  for (let elapsed = 0; elapsed < timeoutSeconds; elapsed += 1) {
    if (await httpReady(service)) return true;
    const state = managedState(service);
    if (!state || !stateIsFresh(state)) return false;
    await wait(1000);
  }
  return false;
}

async function startService(service) {
  // CUA-009: keep macOS desktop clean before the dev build opens a
  // window. Stale liveagent PIDs and Problem Reporter dialogs both keep
  // frontmost_ordinary_window off the LiveAgent window, which prevents
  // cua-driver from delivering input. Cleanup is idempotent and a no-op
  // when the desktop is already in shape.
  if (service === "desktop") {
    runDevPrepare();
    // CUA-016: a freshly-crashed dev binary can spawn a new Problem
    // Reporter AFTER the one-shot sweep above; the periodic watcher
    // keeps cleaning up so the dev window can win frontmost_ordinary.
    // The watcher is idempotent with other startService invocations
    // because `pkill` in stopService cleans up any prior instance and
    // pgrep ignores zombie watchers. We start it for both fresh and
    // already-running cases — multiple sweeps per dialog are harmless.
    startProblemReporterWatcher();
  }

  const state = managedState(service);
  if (state) {
    if (!stateIsFresh(state)) {
      console.error(`${service}: managed state is stale for pid ${state.pid}; refusing to replace it`);
      return false;
    }
    console.log(`${service}: already running (managed pid ${state.pid}, ${urls[service]})`);
    return true;
  }
  if (await portIsListening(ports[service])) {
    if (await httpReady(service)) {
      console.log(`${service}: already listening on port ${ports[service]} (external, ${urls[service]})`);
      return true;
    }
    console.error(`${service}: port ${ports[service]} has an unhealthy external listener; refusing to replace it`);
    return false;
  }

  const supervisor = launchSupervisor(service);
  const timeoutSeconds = service === "desktop" ? 180 : 60;
  if (await waitUntilReady(service, timeoutSeconds)) {
    console.log(`${service}: started (managed pid ${supervisor.pid}, ${urls[service]})`);
    return true;
  }
  console.error(`${service}: failed to become ready; last log lines:\n${tail(logPath(service), 30)}`);
  await stopService(service);
  return false;
}

function killProcessTree(pid, force = false) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    return result.status === 0;
  }
  try {
    process.kill(-pid, force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }
}

async function stopService(service) {
  const state = managedState(service);
  if (!state) {
    if (await portIsListening(ports[service])) {
      console.log(`${service}: external process is still running; left untouched`);
    } else {
      console.log(`${service}: stopped`);
    }
    return true;
  }
  if (!stateIsFresh(state)) {
    console.error(`${service}: managed heartbeat is stale for pid ${state.pid}; refusing to stop it`);
    return false;
  }

  killProcessTree(state.pid);
  for (let elapsed = 0; elapsed < 15 && processIsAlive(state.pid); elapsed += 1) await wait(1000);
  if (processIsAlive(state.pid)) {
    killProcessTree(state.pid, true);
    await wait(1000);
  }
  if (processIsAlive(state.pid)) {
    console.error(`${service}: did not stop within 16 seconds (pid ${state.pid})`);
    return false;
  }
  removeState(service, state.token);
  // CUA-016: the Problem Reporter watcher is only spawned for the
  // desktop service. Stopping it here guarantees it doesn't outlive the
  // dev stack when the user runs `dev-stack stop desktop`. The watcher
  // also dies with the desktop supervisor, so this is belt-and-braces.
  if (service === "desktop") stopProblemReporterWatcher();
  console.log(`${service}: stopped`);
  return true;
}

async function statusService(service) {
  const state = managedState(service);
  if (state) {
    if (!stateIsFresh(state)) {
      console.log(`${service}: stale managed state (pid ${state.pid}, port ${ports[service]})`);
    } else if (await httpReady(service)) {
      console.log(`${service}: ready (managed pid ${state.pid}, ${urls[service]})`);
    } else {
      console.log(`${service}: starting or unhealthy (managed pid ${state.pid}, port ${ports[service]})`);
    }
    return;
  }
  if (await portIsListening(ports[service])) {
    const stateLabel = (await httpReady(service)) ? "ready" : "unhealthy";
    console.log(`${service}: ${stateLabel} (external listener, ${urls[service]})`);
  } else {
    console.log(`${service}: stopped`);
  }
}

async function followLog(service) {
  const file = logPath(service);
  console.log(tail(file, 100));
  let position = existsSync(file) ? statSync(file).size : 0;
  await new Promise((resolveFollow) => {
    const stopFollowing = () => {
      unwatchFile(file);
      resolveFollow();
    };
    process.once("SIGINT", stopFollowing);
    process.once("SIGTERM", stopFollowing);
    watchFile(file, { interval: 500 }, (current) => {
      if (current.size < position) position = 0;
      if (current.size <= position) return;
      createReadStream(file, { end: current.size - 1, start: position }).pipe(process.stdout, {
        end: false,
      });
      position = current.size;
    });
  });
}

function targetServices(target, reverse = false) {
  if (target === "all") return reverse ? [...services].reverse() : services;
  if (!services.includes(target)) fail("target must be desktop, gateway, webui, or all");
  return [target];
}

async function main() {
  const action = process.argv[2] ?? "";
  const target = process.argv[3] ?? "all";
  if (["-h", "--help", "help", ""].includes(action)) {
    usage();
    return;
  }
  validateConfiguration();
  if (action === "__run") {
    if (!services.includes(target) || typeof process.argv[4] !== "string") fail("invalid supervisor arguments");
    await runService(target, process.argv[4]);
    return;
  }
  if (action === "start") {
    let failed = false;
    for (const service of targetServices(target)) failed = !(await startService(service)) || failed;
    console.log(`Runtime files: ${stateDir}`);
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "stop") {
    let failed = false;
    for (const service of targetServices(target, true)) failed = !(await stopService(service)) || failed;
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "restart") {
    let failed = false;
    for (const service of targetServices(target, true)) failed = !(await stopService(service)) || failed;
    for (const service of targetServices(target)) failed = !(await startService(service)) || failed;
    if (failed) process.exitCode = 1;
    return;
  }
  if (action === "status") {
    for (const service of targetServices(target)) await statusService(service);
    console.log(`mcp-bridge: ${(await portIsListening(mcpBridgePort)) ? "ready" : "stopped"} (port ${mcpBridgePort})`);
    return;
  }
  if (action === "logs") {
    if (target === "all") {
      for (const service of services) {
        console.log(`===== ${service}: ${logPath(service)} =====`);
        console.log(tail(logPath(service), 60));
      }
    } else {
      await followLog(targetServices(target)[0]);
    }
    return;
  }
  fail(`unknown action: ${action}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
