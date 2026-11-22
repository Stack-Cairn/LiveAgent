// WebdriverIO config for the desktop end-to-end suite.
//
// E2E_TARGET=tauri (default) drives the debug desktop binary through
// tauri-driver + WebKitWebDriver (Linux). E2E_TARGET=web drives the browser
// host (Vite dev server talking straight to kn) in headless Chrome, which is a
// quick local smoke on any OS but does not exercise the native shell.
//
// Every spec file gets its own isolated home with a K-brain config that points
// at the fake OpenAI-compatible provider started in onPrepare.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { startFakeProvider } from "./support/fake-provider.mjs";
import {
  appBinary,
  artifactsDir,
  catalogPath,
  catalogUrl,
  createIsolatedHome,
  guiDir,
  offlineEnv,
  ports,
  resolveKBrainBinary,
  runDir,
  target,
  toolMarkerFile,
} from "./support/env.mjs";
import { startProcess, waitForHttp, waitForPort } from "./support/processes.mjs";

const isCI = process.env.CI === "true";
const backendToken = "e2e-token";

// Launcher-process state.
let provider;
let vite;
// Worker-process state (one spec file per worker session).
let driver;
let backend;
let specHome;
let specName;

function specArtifactsDir() {
  return join(artifactsDir, specName ?? "unknown");
}

function slug(text) {
  return text.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

/** Copies log files the app and kn wrote inside the isolated home. */
async function collectHomeLogs(home, destination) {
  const queue = [home];
  while (queue.length > 0) {
    const dir = queue.pop();
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // WebKit caches and storage are large and not useful for triage.
        if (!/^(WebKitCache|CacheStorage|IndexedDB|node_modules)$/i.test(entry.name)) queue.push(path);
      } else if (/\.(log|jsonl)$/i.test(entry.name) || /(^|\/)logs\//.test(path)) {
        const info = await stat(path);
        if (info.size > 20 * 1024 * 1024) continue;
        const out = join(destination, relative(home, path));
        await mkdir(join(out, ".."), { recursive: true });
        await cp(path, out);
      }
    }
  }
}

// No browserName: WebKitWebDriver rejects any value other than its own, and
// tauri-driver only needs the application path.
const tauriCapabilities = {
  "tauri:options": { application: appBinary() },
  "wdio:maxInstances": 1,
};

const webCapabilities = {
  browserName: "chrome",
  "wdio:maxInstances": 1,
  ...(process.env.E2E_CHROME_CACHE_DIR ? { "wdio:cacheDir": process.env.E2E_CHROME_CACHE_DIR } : {}),
  "goog:chromeOptions": {
    args: [
      ...(process.env.E2E_HEADED ? [] : ["--headless=new"]),
      "--window-size=1400,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      // Loopback bypasses proxies by default, so only public hosts are refused.
      "--proxy-server=http://127.0.0.1:9",
    ],
  },
};

export const config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [target === "tauri" ? tauriCapabilities : webCapabilities],
  ...(target === "tauri" ? { hostname: "127.0.0.1", port: ports.tauriDriver } : {}),
  logLevel: process.env.E2E_LOG_LEVEL || "warn",
  outputDir: join(artifactsDir, "wdio-logs"),
  bail: 0,
  waitforTimeout: 15_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: Number(process.env.E2E_TEST_TIMEOUT || 180_000),
    // One retry in CI absorbs rare WebKit timing flakes; a real regression still
    // fails twice and is reported.
    retries: Number(process.env.E2E_RETRIES ?? (isCI ? 1 : 0)),
  },

  async onPrepare() {
    // Empty rather than remove: either directory may be a bind mount.
    for (const dir of [runDir, artifactsDir]) {
      await mkdir(dir, { recursive: true });
      for (const entry of await readdir(dir)) {
        // wdio-logs is opened by the launcher before this hook runs.
        if (entry === "wdio-logs") continue;
        await rm(join(dir, entry), { recursive: true, force: true });
      }
    }
    if (target === "tauri" && !existsSync(appBinary())) {
      throw new Error(`desktop binary not found at ${appBinary()}; run \`pnpm --filter @liveagent/desktop-e2e build:app\``);
    }
    provider = await startFakeProvider({
      port: ports.provider,
      markerFile: toolMarkerFile,
      catalogPath,
    });
    if (target === "web") {
      vite = await startProcess(
        "pnpm",
        ["exec", "vite", "--host", "127.0.0.1", "--port", String(ports.vite), "--strictPort"],
        {
          cwd: guiDir,
          env: {
            ...process.env,
            VITE_KBRAIN_URL: `http://127.0.0.1:${ports.backend}`,
            VITE_KBRAIN_TOKEN: backendToken,
            VITE_LIVEAGENT_MODEL_CATALOG_URL: catalogUrl,
            // Specs never race the first-run guide (the onboarding spec is desktop-only).
            VITE_LIVEAGENT_SKIP_ONBOARDING: "1",
          },
          logFile: join(artifactsDir, "vite.log"),
          name: "vite",
        },
      );
      await waitForHttp(`http://127.0.0.1:${ports.vite}/`, { timeoutMs: 120_000 });
    }
  },

  async onComplete() {
    if (provider) {
      await writeFile(join(artifactsDir, "fake-provider-requests.json"), `${JSON.stringify(provider.requests, null, 2)}\n`);
      await provider.close();
    }
    await vite?.stop();
  },

  async beforeSession(_config, capabilities, specs) {
    specName = basename(specs[0] ?? "spec").replace(/\.e2e\.mjs$/, "");
    await mkdir(specArtifactsDir(), { recursive: true });
    specHome = await createIsolatedHome(specName);
    const kn = await resolveKBrainBinary();
    const env = {
      ...process.env,
      ...offlineEnv(),
      ...specHome.xdg,
      HOME: specHome.home,
      LIVEAGENT_DEV_HOME: specHome.home,
      LIVEAGENT_KBRAIN_BINARY: kn,
      LIVEAGENT_DEV_MCP_BRIDGE_PORT: String(ports.mcpBridge),
      // The first-run guide stays off so it never covers the app mid-spec; the
      // onboarding spec keeps it to check the real startup decision.
      ...(specName.includes("onboarding") ? {} : { LIVEAGENT_SKIP_ONBOARDING: "1" }),
      // Keep WebKitGTK quiet and deterministic under Xvfb.
      WEBKIT_DISABLE_COMPOSITING_MODE: "1",
      NO_AT_BRIDGE: "1",
    };
    if (target === "tauri") {
      driver = await startProcess("tauri-driver", ["--port", String(ports.tauriDriver)], {
        cwd: specHome.workspace,
        env,
        logFile: join(specArtifactsDir(), "app.log"),
        name: "tauri-driver",
      });
      await waitForPort(ports.tauriDriver, { process: driver, timeoutMs: 30_000 });
    } else {
      // A profile per spec file keeps browser storage as isolated as the home.
      const chromeOptions = capabilities["goog:chromeOptions"];
      chromeOptions.args = [
        ...chromeOptions.args.filter((arg) => !arg.startsWith("--user-data-dir=")),
        `--user-data-dir=${join(specHome.base, "chrome-profile")}`,
      ];
      backend = await startProcess(
        kn,
        ["backend", "-listen", `127.0.0.1:${ports.backend}`, "-token", backendToken, "-data-dir", specHome.dataRoot],
        {
          cwd: specHome.workspace,
          env: { ...env, LIVEAGENT_HOME: specHome.dataRoot },
          logFile: join(specArtifactsDir(), "kbrain.log"),
          name: "kn",
        },
      );
      await waitForHttp(`http://127.0.0.1:${ports.backend}/v1/health`, {
        headers: { authorization: `Bearer ${backendToken}` },
        timeoutMs: 30_000,
      });
    }
  },

  async before() {
    if (target === "web") {
      await browser.url(`http://127.0.0.1:${ports.vite}/`);
    }
    const { waitForLaunch } = await import("./support/app.mjs");
    await waitForLaunch();
    globalThis.e2e = { home: specHome, target };
  },

  async afterTest(test, _context, { passed }) {
    const always = process.env.E2E_SCREENSHOTS === "always";
    if (passed && !always) return;
    const name = `${passed ? "pass" : "FAIL"}-${slug(test.parent)}-${slug(test.title)}`;
    try {
      await browser.saveScreenshot(join(specArtifactsDir(), `${name}.png`));
    } catch (error) {
      console.warn(`screenshot failed: ${error.message}`);
    }
    if (!passed) {
      try {
        const html = await browser.execute(() => document.documentElement.outerHTML);
        await writeFile(join(specArtifactsDir(), `${name}.html`), html);
      } catch {
        // The page may be gone if the app crashed; the app log covers that case.
      }
    }
  },

  async afterSession() {
    await driver?.stop();
    await backend?.stop();
    if (specHome) await collectHomeLogs(specHome.home, join(specArtifactsDir(), "home-logs"));
  },
};
