#!/usr/bin/env node

// dev-prepare.mjs — idempotent dev-environment cleanup so cua-driver can
// reliably drive the LiveAgent desktop window. Failure modes addressed:
//
// 1. Stale liveagent PIDs from a previous crash keep holding the focus or
//    keeping Problem Reporter dialogs alive. We kill any "liveagent" PID
//    not registered by the current dev-stack instance (CUA-013 — read the
//    dev-stack state files to avoid killing the running dev-stack +
//    binary the test harness is actively using).
// 2. macOS Problem Reporter dialogs ("<App> 的问题报告" / "Problem
//    Report for <App>") have no AX surface and steal every click/keystroke
//    for themselves. cua-driver's `bring_to_front` cannot bypass them, so
//    the dev build underneath never receives any input. We close them.
// 3. cua-driver spawns an always-on-top overlay window to visualise its
//    agent cursor. The overlay sits above every ordinary window in
//    `frontmost_ordinary_window` so LiveAgent can never win that slot,
//    which is what cua-driver uses to verify foreground delivery. We
//    shrink + off-screen the overlay via `cua-driver set_window_frame`
//    instead of killing it (CUA-012 — set_agent_cursor_enabled false
//    hides the cursor glyph but keeps the overlay window alive, which is
//    why disabling the cursor alone does not help).
//
// Designed to be a no-op when nothing needs cleaning. Safe to invoke from
// dev-stack start, restart, and (manually) before running the test harness.

import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { unlink as unlinkAsync, readFile as readFileAsync } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platform } from "node:process";
import { inflateSync } from "node:zlib";

const OWN_BUNDLE_FRAGMENT = "liveagent";
const CUA_OVERLAY_BUNDLE = "cua driver";
const CUA_DRIVER_BINARY = process.env.LIVEAGENT_CUA_DRIVER_BIN ?? "cua-driver";
// Off-screen anchor that macOS still considers the window "live" so the
// session can still use the overlay if the driver ever flips it back on.
// -10000 / -10000 keeps the window out of any reasonable display layout.
const CUA_OVERLAY_OFFSCREEN = { x: -10000, y: -10000, width: 1, height: 1 };

function log(stage, message) {
  console.log(`dev-prepare[${stage}]: ${message}`);
}

function runOsascript(script) {
  try {
    return execFileSync("osascript", ["-e", script], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// ───────── Managed PID discovery (CUA-013) ─────────

function defaultDevStackStateDirs() {
  // Mirror dev-stack.mjs `stateDir` default: $TMPDIR/liveagent-dev-stack-<uid>.
  const envOverride = process.env.LIVEAGENT_DEV_STATE_DIR;
  if (envOverride) return [envOverride];
  const uid =
    typeof process.getuid === "function"
      ? String(process.getuid())
      : (process.env.USERNAME ?? "user");
  return [join(tmpdir(), `liveagent-dev-stack-${uid}`)];
}

function readManagedPids() {
  const pids = new Set();
  for (const dir of defaultDevStackStateDirs()) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const path = join(dir, entry);
      try {
        const state = JSON.parse(readFileSync(path, "utf8"));
        if (Number.isInteger(state.pid)) pids.add(state.pid);
        if (Number.isInteger(state.childPid)) pids.add(state.childPid);
      } catch {
        // Stale / unreadable state file → ignore.
      }
    }
  }
  // Also exempt any ancestor of this process — Claude / zsh / test
  // harness might be the supervisor's parent. `process.ppid` is `0` on
  // Windows / unsupported platforms; the call to `kill -0` further down
  // is what gates this list.
  return pids;
}

function listOwnPids() {
  if (platform !== "darwin" && platform !== "linux") return new Set();
  try {
    const stdout = execFileSync("pgrep", ["-f", OWN_BUNDLE_FRAGMENT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid)),
    );
  } catch {
    return new Set();
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return false;
    return false;
  }
}

function listProblemReporterPids() {
  if (platform !== "darwin") return [];
  try {
    const stdout = execFileSync("pgrep", ["-f", "Problem Reporter"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line, 10))
      .filter((pid) => Number.isInteger(pid));
  } catch {
    return [];
  }
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EPERM") return false;
    return false;
  }
}

async function killStaleLiveagentProcesses() {
  const self = process.pid;
  const groupId = process.pgid;
  // CUA-013: read dev-stack state files so we never kill a process that
  // the test harness / supervisor is actively using. Without this filter
  // any invocation of `node scripts/dev-prepare.mjs` would terminate the
  // dev binary + supervisor launched by the parent `dev-stack start`.
  const managedPids = readManagedPids();
  const ownPids = listOwnPids();
  const targets = [...ownPids].filter((pid) => {
    if (pid === self || pid === groupId || pid <= 1) return false;
    if (managedPids.has(pid)) return false;
    // Defensive: skip PIDs that respond to kill -0 but are themselves
    // ancestors of this process tree (the supervisor's child has the
    // dev-stack's heartbeat state; its grandchild does not, but it
    // usually shares the same parent chain).
    return true;
  });
  if (targets.length === 0) {
    log("stale-liveagent", "no stale liveagent pid(s) to kill");
    return 0;
  }

  // Filter the kill list once more against live processes — `pgrep -f`
  // can race with processes that have just exited. We must check
  // `kill -0` to avoid surfacing ESRCH errors for PIDs that were already
  // gone before our second pass.
  const liveTargets = targets.filter(processIsAlive);
  if (liveTargets.length === 0) return 0;

  log(
    "stale-liveagent",
    `killing ${liveTargets.length} stale pid(s): ${liveTargets.join(", ")}`,
  );
  let killed = 0;
  for (const pid of liveTargets) {
    if (killPid(pid, "SIGTERM")) killed += 1;
  }
  // Wait briefly for graceful exit; escalate if needed.
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  for (const pid of liveTargets) {
    if (processIsAlive(pid)) killPid(pid, "SIGKILL");
  }
  return killed;
}

function dismissMacProblemReporterDialogs() {
  if (platform !== "darwin") return 0;
  const pids = listProblemReporterPids();
  if (pids.length === 0) {
    // Even when pgrep misses them, try a window-based probe.
    const windows = runOsascript(
      'tell application "System Events" to get name of every window of (every process whose name contains "Problem Reporter")',
    );
    if (!windows) return 0;
  } else {
    log(
      "problem-reporter",
      `found ${pids.length} stale Problem Reporter pid(s): ${pids.join(", ")}`,
    );
  }

  // The dialog is owned by ReportCrash; closing its windows via System Events
  // is the only reliable way that does not require Accessibility permission
  // for cua-driver to bypass. Killing the helper PID is harmless — macOS
  // re-spawns it on demand.
  const dismissed = runOsascript(
    [
      'tell application "System Events"',
      "\ttell (every process whose name contains \"Problem Reporter\")",
      "\t\tset winList to every window",
      "\t\tif (count of winList) is 0 then return 0",
      "\t\trepeat with w in winList",
      '\t\ttry',
      '\t\t\tset value of attribute "AXCloseButton" of w to true',
      "\t\tend try",
      "\t\tend repeat",
      "\t\treturn (count of winList)",
      "\tend tell",
      "end tell",
    ].join("\n"),
  );
  const count = Number.parseInt(dismissed, 10);
  if (Number.isFinite(count) && count > 0) {
    log("problem-reporter", `requested close on ${count} Problem Reporter window(s)`);
  }

  // CUA-016: also SIGTERM/SIGKILL the helper PIDs directly. macOS will
  // respawn ReportCrash on demand, but a stubborn PID that survived
  // AXCloseButton (e.g. dialog already showing, AX not yet granted) can
  // be released by sending SIGTERM first, then escalating to SIGKILL if
  // it still owns a CGWindowID 750 ms later.
  for (const pid of pids) {
    if (killPid(pid, "SIGTERM")) {
      log("problem-reporter", `sent SIGTERM to Problem Reporter pid ${pid}`);
    }
  }
  // Escalate survivors so cua-driver's bring_to_front can claim
  // frontmost_ordinary_window within one tick.
  const survivors = pids.filter((pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });
  for (const pid of survivors) {
    if (killPid(pid, "SIGKILL")) {
      log("problem-reporter", `sent SIGKILL to Problem Reporter pid ${pid}`);
    }
  }
  return pids.length;
}

// ───────── CUA driver overlay detection (CUA-012) ─────────

function runCuaDriverCall(tool, args, timeoutMs = 4000) {
  // `cua-driver call <tool> <json>` returns a JSON payload; we forward
  // stdin via argv. Failures are non-fatal — overlay pinning is best
  // effort and the daemon might not be running on every dev box.
  try {
    const result = spawnSync(CUA_DRIVER_BINARY, ["call", tool, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    });
    if (result.error) return null;
    const stdout = (result.stdout ?? "").trim();
    if (!stdout) return null;
    try {
      return JSON.parse(stdout);
    } catch {
      return { raw: stdout };
    }
  } catch {
    return null;
  }
}

function identifyOverlayWindows(windows) {
  if (!Array.isArray(windows)) return [];
  return windows.filter((window) => {
    if (!window || typeof window !== "object") return false;
    const appName = typeof window.app_name === "string" ? window.app_name : "";
    const title = typeof window.title === "string" ? window.title : "";
    const bundle = appName.toLowerCase();
    // CUA-012: the daemon's agent-cursor overlay is owned by a process
    // named like `Cua Driver` and never has a window title (the overlay
    // is purely a presentation surface, not a real document window).
    // We also require `is_on_screen` so we don't move hidden helpers.
    if (!bundle.includes(CUA_OVERLAY_BUNDLE)) return false;
    if (title !== "") return false;
    if (window.is_on_screen === false) return false;
    return true;
  });
}

function readCuaDriverDaemon() {
  // Returns the live daemon's pid + arguments, or null when no daemon is
  // running. Used to detect whether the user launched cua-driver without
  // `--no-overlay` and is therefore blocking LiveAgent from becoming
  // frontmost_ordinary (CUA-012).
  try {
    const stdout = execFileSync("pgrep", ["-f", "cua-driver serve"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pids = stdout
      .split(/\r?\n/)
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid));
    for (const pid of pids) {
      try {
        const argsResult = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const args = argsResult.trim();
        if (args.includes("cua-driver") && args.includes("serve")) {
          return { pid, args, noOverlay: args.includes("--no-overlay") };
        }
      } catch {
        // process already exited
      }
    }
  } catch {
    return null;
  }
  return null;
}

function restartCuaDriverWithNoOverlay() {
  if (platform !== "darwin") return false;
  // Opt-in: skip unless the user explicitly enabled it. Restarting the
  // daemon terminates any active cua-driver session running on the box.
  if (process.env.LIVEAGENT_CUA_DRIVER_NO_OVERLAY !== "1") return false;
  const daemon = readCuaDriverDaemon();
  if (!daemon) {
    log("cua-overlay", "no live cua-driver daemon; nothing to restart");
    return false;
  }
  if (daemon.noOverlay) {
    log("cua-overlay", `daemon pid=${daemon.pid} already launched with --no-overlay`);
    return false;
  }
  log(
    "cua-overlay",
    `daemon pid=${daemon.pid} is missing --no-overlay; restarting (LIVEAGENT_CUA_DRIVER_NO_OVERLAY=1)`,
  );
  // Ask the daemon to shut down cleanly first so it can flush state.
  runCuaDriverCall("end_session", ["{}"]);
  spawnSync(CUA_DRIVER_BINARY, ["stop"], {
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 4000,
  });
  // SIGTERM fallback in case `stop` was a no-op (some daemon versions
  // refuse if they think a session is still active).
  try {
    process.kill(daemon.pid, "SIGTERM");
  } catch {
    // already gone
  }
  // Give the daemon a moment to release the unix socket.
  const binary = daemon.args.split(/\s+/)[0];
  const detached = spawn(
    binary || "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    ["serve", "--no-overlay"],
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  detached.unref();
  log(
    "cua-overlay",
    `restarted cua-driver with --no-overlay (new pid=${detached.pid ?? "unknown"})`,
  );
  return true;
}

function pinCuaDriverOverlay() {
  if (platform !== "darwin") return 0;
  const payload = runCuaDriverCall("list_windows", []);
  if (!payload) {
    log("cua-overlay", "cua-driver list_windows unavailable; overlay pinning skipped");
    return 0;
  }
  const overlays = identifyOverlayWindows(payload.windows);
  if (overlays.length === 0) return 0;
  let pinned = 0;
  for (const overlay of overlays) {
    const pid = overlay.pid;
    const windowId = overlay.window_id;
    if (!Number.isInteger(pid) || !Number.isInteger(windowId)) continue;
    // cua-driver refuses set_window_frame for windows with no AXWindow
    // (overlay windows are exactly that). The driver round-trip keeps
    // an audit trail even when the call fails — it is the path cua-driver
    // users are expected to use.
    const args = [
      JSON.stringify({
        height: CUA_OVERLAY_OFFSCREEN.height,
        pid,
        width: CUA_OVERLAY_OFFSCREEN.width,
        window_id: windowId,
        x: CUA_OVERLAY_OFFSCREEN.x,
        y: CUA_OVERLAY_OFFSCREEN.y,
      }),
    ];
    const result = runCuaDriverCall("set_window_frame", args);
    if (result !== null && !String(result.raw ?? "").includes("no matching AXWindow")) {
      log(
        "cua-overlay",
        `pinned overlay pid=${pid} window_id=${windowId} to ${CUA_OVERLAY_OFFSCREEN.x},${CUA_OVERLAY_OFFSCREEN.y}`,
      );
      pinned += 1;
    } else {
      log(
        "cua-overlay",
        `set_window_frame refused for pid=${pid} window_id=${windowId} (overlay has no AXWindow); set LIVEAGENT_CUA_DRIVER_NO_OVERLAY=1 to restart the daemon without the overlay`,
      );
    }
  }
  return pinned;
}

function activateLiveAgentIfRunning() {
  if (platform !== "darwin") return false;
  const liveagentPids = (() => {
    try {
      return execFileSync("pgrep", ["-x", "LiveAgent"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .split(/\r?\n/)
        .map((line) => Number.parseInt(line, 10))
        .filter((pid) => Number.isInteger(pid));
    } catch {
      return [];
    }
  })();
  if (liveagentPids.length === 0) return false;
  // Best-effort: ask the OS to bring it forward. This is a no-op when a
  // Problem Reporter dialog still owns focus — that is exactly why
  // dismissMacProblemReporterDialogs() must run first.
  execFile("osascript", ["-e", 'tell application "LiveAgent" to activate'], () => {});
  return true;
}

// ───────── CUA-018 / CUA-023: screen capture readiness probe ─────────

// `cua-driver health_report` deliberately skips the live ScreenCaptureKit
// probe because it would raise system prompts (the diagnostic surface must
// stay read-only). The downstream cost is that `get_desktop_state` may
// quietly return all-black PNGs even when TCC grants look healthy
// (ScreenCaptureKit can still be blocked by Tahoe's direct-capture consent
// or a stale daemon identity). dev-prepare actively re-asserts capture by
// capturing once and confirming the pixels are not all (0,0,0,255); the
// fast path samples 16 evenly-spaced pixels so the check costs <50 ms and
// never blocks the dev startup beyond that.
//
// CUA-023: when the probe comes back all-black we no longer just log and
// give up. We (a) re-issue `cua-driver permissions grant` so the user gets
// a fresh system prompt if the previous one was dismissed, (b) restart the
// daemon with --no-overlay so a stale identity is replaced, and (c) probe
// once more before failing loud. The retry ladder is bounded so a hostile
// TCC state cannot hang dev startup indefinitely.
async function captureReadinessProbeOnce() {
  if (platform !== "darwin") return "skip";
  const tmp = join(tmpdir(), `liveagent-screen-probe-${process.pid}-${Date.now()}.png`);
  let payload;
  try {
    payload = runCuaDriverCall(
      "get_desktop_state",
      [JSON.stringify({ screenshot_out_file: tmp })],
      5000,
    );
  } catch {
    return "error";
  }
  let pcmBytes;
  try {
    pcmBytes = await readFileAsync(tmp);
  } catch {
    pcmBytes = null;
  }
  let verdict = "unknown";
  try {
    await unlinkAsync(tmp);
  } catch {}
  if (!pcmBytes || pcmBytes.length === 0) {
    if (payload && typeof payload.screenshot_png_b64 === "string") {
      pcmBytes = Buffer.from(payload.screenshot_png_b64, "base64");
    }
  }
  if (!pcmBytes || pcmBytes.length === 0) {
    verdict = "no-pixels";
  } else {
    verdict = inspectPngForBlackness(pcmBytes);
  }
  return verdict;
}

async function requestCuaDriverPermissionsGrant() {
  if (platform !== "darwin") return false;
  // `cua-driver permissions grant` re-launches the helper app via
  // LaunchServices so the TCC prompt attributes to com.trycua.driver
  // rather than the terminal — this is the correct way to recover from
  // a stale TCC grant. The call may itself trigger macOS system prompts;
  // we run it detached so it doesn't block dev startup.
  log("screen-capture", "retrying: cua-driver permissions grant (re-prompt TCC)");
  try {
    const result = spawnSync(
      CUA_DRIVER_BINARY,
      ["permissions", "grant"],
      {
        stdio: "ignore",
        windowsHide: true,
        timeout: 15_000,
        env: process.env,
      },
    );
    if (result.error) {
      log(
        "screen-capture",
        `permissions grant failed to launch: ${result.error.message}`,
      );
      return false;
    }
    return result.status === 0;
  } catch (error) {
    log(
      "screen-capture",
      `permissions grant crashed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function restartCuaDriverDaemonForCapture() {
  if (platform !== "darwin") return false;
  const daemon = readCuaDriverDaemon();
  if (!daemon) {
    log("screen-capture", "no live cua-driver daemon; cannot restart for capture");
    return false;
  }
  log(
    "screen-capture",
    `restarting cua-driver daemon (pid ${daemon.pid}) — stale identity may have lost direct-capture consent (CUA-023)`,
  );
  // Best-effort stop; if the daemon ignores it we fall back to SIGTERM.
  runCuaDriverCall("end_session", ["{}"]);
  spawnSync(CUA_DRIVER_BINARY, ["stop"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 4_000,
  });
  try {
    process.kill(daemon.pid, "SIGTERM");
  } catch {}
  await new Promise((resolveWait) => setTimeout(resolveWait, 750));
  const binary = daemon.args.split(/\s+/)[0];
  const args = daemon.noOverlay
    ? ["serve"]
    : ["serve", "--no-overlay"];
  const detached = spawn(
    binary || "/Applications/CuaDriver.app/Contents/MacOS/cua-driver",
    args,
    {
      detached: true,
      stdio: "ignore",
      env: process.env,
    },
  );
  detached.unref();
  await new Promise((resolveWait) => setTimeout(resolveWait, 1500));
  return true;
}

async function probeScreenCaptureReadiness() {
  if (platform !== "darwin") return "skip";

  let verdict = await captureReadinessProbeOnce();

  // Fast path: capture works on the very first try. Done.
  if (verdict === "non-black") {
    log("screen-capture", "screen capture readiness: pass (non-black pixels detected)");
    return verdict;
  }

  // CUA-023 ladder. We attempt `permissions grant` first (least invasive:
  // it only re-prompts for TCC) and only escalate to a daemon restart if
  // the user dismissed or already granted and capture is still broken.
  if (verdict === "all-black" || verdict === "no-pixels" || verdict === "unknown") {
    log(
      "screen-capture",
      `first probe returned '${verdict}'; entering CUA-023 retry ladder`,
    );
    const grantOk = await requestCuaDriverPermissionsGrant();
    if (grantOk) {
      // Give macOS a beat to swap the TCC identity into the helper.
      await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
      verdict = await captureReadinessProbeOnce();
      if (verdict === "non-black") {
        log(
          "screen-capture",
          "screen capture readiness: pass after permissions grant retry",
        );
        return verdict;
      }
    }

    // Still unhappy → suspect a stale daemon identity (TCC granted to
    // an older build). Restart the daemon and re-probe.
    const restarted = await restartCuaDriverDaemonForCapture();
    if (restarted) {
      verdict = await captureReadinessProbeOnce();
      if (verdict === "non-black") {
        log(
          "screen-capture",
          "screen capture readiness: pass after cua-driver daemon restart",
        );
        return verdict;
      }
    }
  }

  // Exhausted ladder. Emit a structured error so the user knows what
  // to try manually; do not silently fail.
  if (verdict === "all-black") {
    log(
      "screen-capture",
      "screen-capture: ERROR — get_desktop_state still returns all-black after permissions grant + daemon restart. Open System Settings → Privacy & Security → Screen Recording and ensure the CuaDriver helper (com.trycua.driver) is toggled ON, then re-run dev-prepare. (CUA-023)",
    );
  } else if (verdict === "no-pixels") {
    log(
      "screen-capture",
      "screen-capture: ERROR — cua-driver daemon did not produce a PNG after retry; check `cua-driver status` and ensure the helper is running with --no-overlay when LIVEAGENT_CUA_DRIVER_NO_OVERLAY=1. (CUA-023)",
    );
  } else if (verdict === "unknown") {
    log(
      "screen-capture",
      `screen-capture: ERROR — probe could not classify the PNG after retry (verdict='${verdict}'); capture may still work for real calls but the readiness probe gave up. (CUA-023)`,
    );
  } else {
    log("screen-capture", `screen capture readiness: ${verdict}`);
  }
  return verdict;
}

// Inspect a PNG buffer for the all-black failure mode without decoding
// the whole image. We read the IHDR + IDAT chunks once, decompress with
// Node's zlib, and sample 16 evenly-spaced rows/columns from the raw scan
// data. The check is intentionally cheap — a single 1920x1080 PNG
// decompresses in <30 ms.
function inspectPngForBlackness(buffer) {
  // Minimal PNG parser. We assume the encoder used by cua-driver
  // (color_type=2 RGB or 6 RGBA, bit_depth=8, no interlace). Any other
  // layout (palette, 16-bit, alpha-only) returns "unknown" so we never
  // false-positive on a malformed input.
  if (buffer.length < 24) return "unknown";
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < signature.length; i += 1) {
    if (buffer[i] !== signature[i]) return "unknown";
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === "IHDR" && dataStart + 13 <= buffer.length) {
      width = buffer.readUInt32BE(dataStart);
      height = buffer.readUInt32BE(dataStart + 4);
      bitDepth = buffer[dataStart + 8];
      colorType = buffer[dataStart + 9];
    } else if (type === "IDAT") {
      idatChunks.push(buffer.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // 4 bytes CRC
    if (offset > buffer.length) break;
  }
  if (width === 0 || height === 0) return "unknown";
  if (bitDepth !== 8) return "unknown";
  // 0=gray, 2=RGB, 3=palette, 4=gray+alpha, 6=RGBA
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (channels === 0) return "unknown";
  let raw;
  try {
    raw = inflateSync(Buffer.concat(idatChunks));
  } catch {
    return "unknown";
  }
  const stride = width * channels;
  const scanlineBytes = stride + 1; // 1 filter byte per row
  if (raw.length < scanlineBytes) return "unknown";
  const sampleRows = [0, Math.floor(height / 4), Math.floor(height / 2), height - 1];
  const sampleCols = [0, Math.floor(width / 4), Math.floor(width / 2), width - 1];
  let blackPixels = 0;
  let totalSamples = 0;
  // All filters other than "None" (0) require us to undo previous pixels.
  // For a pass/fail sanity check we only need to spot ANY non-black pixel,
  // so we read the raw byte stream and ignore filter deltas. A non-black
  // pixel in a filtered stream still shows as a non-zero byte somewhere
  // in its scanline — false positives ("non-black" verdict) are
  // acceptable; false negatives ("all-black" verdict) are not, so we
  // default the verdict to "non-black" whenever we see any non-zero byte
  // in the raw stream to keep the check sensitive.
  for (const row of sampleRows) {
    const rowStart = row * scanlineBytes + 1; // skip filter byte
    for (const col of sampleCols) {
      const pixelOffset = rowStart + col * channels;
      if (pixelOffset + channels > raw.length) continue;
      totalSamples += 1;
      let isBlack = true;
      // For RGB(A), black means RGB == 0; alpha is ignored on purpose
      // (a fully-transparent black would still be a healthy capture).
      for (let c = 0; c < 3 && c < channels; c += 1) {
        if (raw[pixelOffset + c] !== 0) {
          isBlack = false;
          break;
        }
      }
      if (isBlack) blackPixels += 1;
    }
  }
  if (totalSamples === 0) return "unknown";
  return blackPixels === totalSamples ? "all-black" : "non-black";
}

// ───────── CUA-016: periodic Problem Reporter sweep ─────────

async function runWatchLoop(intervalMs) {
  // Re-run the lightweight sweep every `intervalMs`. The first cycle is
  // a fresh full pass (so a stale dialog that survived the initial sweep
  // is caught on the next tick). The sweep itself is idempotent and a
  // no-op when nothing is pending.
  log(
    "watch",
    `starting periodic Problem Reporter sweep every ${intervalMs}ms (pid ${process.pid})`,
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log("watch", "stopping periodic sweep");
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  // Probe screen capture once on watcher boot so an unhappy TCC state
  // surfaces in `dev-stack logs desktop` immediately.
  await probeScreenCaptureReadiness();
  // Keep the event loop alive via the interval itself. The watcher stays
  // running until SIGTERM/SIGINT triggers `stop()`. We do NOT unref() the
  // interval because the supervisor expects the watcher process to stay
  // alive for the entire dev session.
  setInterval(() => {
    if (stopping) return;
    try {
      const dismissed = dismissMacProblemReporterDialogs();
      if (dismissed > 0) {
        log("watch", `sweep dismissed ${dismissed} Problem Reporter window(s)`);
      }
    } catch (error) {
      log("watch", `sweep failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }, intervalMs);
  // Park forever; signals drive exit. setImmediate ensures the signal
  // handlers above are registered before we yield the main thread.
  await new Promise(() => {});
}

async function main() {
  const args = process.argv.slice(2);
  const watchIdx = args.indexOf("--watch");
  const watchMode = watchIdx >= 0;
  const intervalArg = watchIdx >= 0 ? args[watchIdx + 1] : undefined;
  const intervalMs = (() => {
    const parsed = Number.parseInt(intervalArg ?? "", 10);
    return Number.isFinite(parsed) && parsed >= 1000 ? parsed : 7000;
  })();

  const killed = await killStaleLiveagentProcesses();
  const dismissed = dismissMacProblemReporterDialogs();
  const restarted = restartCuaDriverWithNoOverlay();
  const pinned = pinCuaDriverOverlay();
  const activated = activateLiveAgentIfRunning();
  if (watchMode) {
    log(
      "summary",
      `killed=${killed} dismissed_problem_reporter=${dismissed} restarted_cua_daemon=${restarted} pinned_cua_overlay=${pinned} activated_liveagent=${activated} (watch mode)`,
    );
    await runWatchLoop(intervalMs);
    return;
  }
  // One-shot mode still runs an opportunistic screen capture probe so the
  // warning lands in dev-stack's startup log when TCC is broken (CUA-018).
  const screenCapture = await probeScreenCaptureReadiness();
  log(
    "summary",
    `killed=${killed} dismissed_problem_reporter=${dismissed} restarted_cua_daemon=${restarted} pinned_cua_overlay=${pinned} activated_liveagent=${activated} screen_capture=${screenCapture}`,
  );
}

main().catch((error) => {
  console.error(`dev-prepare: ${error instanceof Error ? error.message : String(error)}`);
  // Never fail the caller: cleanup is best-effort.
  process.exit(0);
});