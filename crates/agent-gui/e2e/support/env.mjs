// Paths, ports and isolated-home seeding shared by the wdio config and specs.
import { existsSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAKE_MODEL_ID, FAKE_PROVIDER_ID } from "./fake-provider.mjs";

export const e2eDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const guiDir = resolve(e2eDir, "..");
export const repoRoot = resolve(guiDir, "../..");

/** `tauri` drives the real desktop binary; `web` drives the browser host against kn. */
export const target = process.env.E2E_TARGET === "web" ? "web" : "tauri";

export const ports = {
  provider: Number(process.env.E2E_FAKE_PROVIDER_PORT || 47390),
  backend: Number(process.env.E2E_KBRAIN_PORT || 47391),
  vite: Number(process.env.E2E_VITE_PORT || 47392),
  tauriDriver: Number(process.env.E2E_TAURI_DRIVER_PORT || 4444),
  mcpBridge: Number(process.env.E2E_MCP_BRIDGE_PORT || 47393),
};

/** Per-run scratch space: isolated homes, workspaces and the tool marker file. */
export const runDir = resolve(process.env.E2E_RUN_DIR || join(e2eDir, ".run"));
/** Screenshots, app logs and the fake provider request log end up here. */
export const artifactsDir = resolve(process.env.E2E_ARTIFACTS_DIR || join(e2eDir, ".artifacts"));
export const toolMarkerFile = join(runDir, "tool-marker.txt");

/** Fake provider route serving a tiny model catalog so the app never fetches the public one. */
export const catalogPath = "/__e2e/model-catalog.json";
export const catalogUrl = `http://127.0.0.1:${ports.provider}${catalogPath}`;

export function hostTriple() {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "linux") return `${arch}-unknown-linux-gnu`;
  if (process.platform === "darwin") return `${arch}-apple-darwin`;
  return `${arch}-pc-windows-msvc`;
}

export function appBinary() {
  if (process.env.E2E_APP_BINARY) return resolve(process.env.E2E_APP_BINARY);
  const name = process.platform === "win32" ? "liveagent.exe" : "liveagent";
  return join(repoRoot, "target", "debug", name);
}

/**
 * kn comes from LIVEAGENT_KBRAIN_BINARY when set; otherwise from the pinned,
 * checksum-verified release the packaging helper places in src-tauri/binaries.
 */
export async function resolveKBrainBinary() {
  const explicit = process.env.LIVEAGENT_KBRAIN_BINARY;
  if (explicit) {
    if (!isAbsolute(explicit)) throw new Error("LIVEAGENT_KBRAIN_BINARY must be an absolute path");
    if (!existsSync(explicit)) throw new Error(`LIVEAGENT_KBRAIN_BINARY does not exist: ${explicit}`);
    return explicit;
  }
  const suffix = process.platform === "win32" ? ".exe" : "";
  const prepared = join(guiDir, "src-tauri", "binaries", `k-brain-${hostTriple()}${suffix}`);
  // build-app.mjs may have left a tiny stub there; only a real binary counts.
  if (existsSync(prepared) && statSync(prepared).size > 1024 * 1024) return prepared;
  const { prepare } = await import("../../../../scripts/release/prepare-kbrain.mjs");
  const result = await prepare({ release: true, artifactDir: false });
  return result.binary;
}

/** K-brain config that points the default model at the fake provider. */
export function kbrainConfig() {
  return {
    defaultProvider: FAKE_PROVIDER_ID,
    defaultModel: FAKE_MODEL_ID,
    providers: {
      [FAKE_PROVIDER_ID]: {
        name: "E2E Fake",
        api: "openai-completions",
        apiKey: "e2e-key",
        baseUrl: `http://127.0.0.1:${ports.provider}/v1`,
        models: [{ id: FAKE_MODEL_ID, contextWindow: 32000, maxTokens: 1024 }],
      },
    },
  };
}

/**
 * Creates a fresh home for one spec file. Everything the app persists lives
 * under it: `<home>/.liveagent` (kn data and config), XDG dirs (WebView storage,
 * Tauri app data) and a workspace folder used as the working directory.
 */
export async function createIsolatedHome(name) {
  const base = join(runDir, "homes", name.replace(/[^a-zA-Z0-9_-]+/g, "-"));
  await rm(base, { recursive: true, force: true });
  const home = join(base, "home");
  const dataRoot = join(home, ".liveagent");
  const workspace = join(base, "workspace");
  const xdg = {
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
  };
  for (const dir of [dataRoot, workspace, ...Object.values(xdg)]) await mkdir(dir, { recursive: true });
  await writeFile(join(dataRoot, "config.json"), `${JSON.stringify(kbrainConfig(), null, 2)}\n`);
  return { base, home, dataRoot, workspace, xdg };
}

/**
 * Environment for processes that must stay off the network except for loopback:
 * every proxy-aware client (reqwest, Go net/http, WebKit) is pointed at a
 * closed port, so an accidental call to a public host fails fast instead of
 * leaving the machine.
 */
export function offlineEnv() {
  const blackhole = "http://127.0.0.1:9";
  return {
    HTTP_PROXY: blackhole,
    HTTPS_PROXY: blackhole,
    ALL_PROXY: blackhole,
    http_proxy: blackhole,
    https_proxy: blackhole,
    all_proxy: blackhole,
    NO_PROXY: "127.0.0.1,localhost,::1",
    no_proxy: "127.0.0.1,localhost,::1",
  };
}
