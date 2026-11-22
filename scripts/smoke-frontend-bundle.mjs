#!/usr/bin/env node
// Loads a production frontend bundle (`vite build` output) in a real browser
// engine and fails when it does not boot cleanly.
//
// This is the check that catches chunking regressions which only show up in a
// release build: a module-graph split that breaks CommonJS interop
// ("require_cjs$N is not a function") or creates an ESM cycle
// ("Class extends value undefined") renders a black screen, while `vite dev`
// keeps working because it never chunks.
//
// What it does:
//   1. serves the dist directory over loopback HTTP (SPA fallback, no cache);
//   2. answers the K-brain endpoint the browser host talks to with a minimal
//      fake (or forwards to --kbrain-url) and blocks every non-loopback host;
//   3. waits for the startup screen to hand over to the main UI;
//   4. imports every emitted JS chunk (lazy routes included) so a chunk that
//      throws while evaluating fails the run even if no route reached it;
//   5. fails on uncaught page errors, error boundaries or console errors.
//
// Usage:
//   node scripts/smoke-frontend-bundle.mjs [--app gui|webui] [--dist DIR]
//     [--browser chromium|webkit|all] [--runs N] [--kbrain-url URL]
//     [--json out.json] [--screenshot out.png] [--cpu-throttle 4 (chromium)]
// Playwright is not a workspace dependency: install it next to the script
// runner (`npm i --no-save playwright-core`) or point PLAYWRIGHT_CORE at its
// entry module. Browsers come from `npx playwright install chromium webkit`.
//
// `--app gui` (default) boots the desktop frontend against the fake K-brain
// and waits for the main UI. `--app webui` boots the Gateway WebUI: its
// same-origin API answers 401, so the run waits for the login screen (the
// lazy chat/workbench chunks are still evaluated by the import pass).
//
// CI runs this for both apps in the Frontend Bundles job
// (.github/workflows/ci.yml, Playwright set up by
// .github/actions/setup-playwright); see docs/testing/ci-checks.md.

import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Per-app defaults: where the build lands, what "booted" means, and which
// same-origin paths are a backend API (answered instead of the SPA fallback).
export const APPS = {
  gui: { dist: "crates/agent-gui/dist", readySelector: "", apiPrefixes: [] },
  webui: {
    dist: "crates/agent-gateway/web/dist",
    // The login screen's token field: no gateway session in a smoke run.
    readySelector: "#access-token",
    apiPrefixes: ["/api/", "/ws", "/image-proxy"],
  },
};

export function parseArguments(argv) {
  const options = {
    app: "gui",
    dist: "",
    browsers: ["chromium"],
    runs: 1,
    kbrainUrl: "",
    json: "",
    screenshot: "",
    timeoutMs: 60_000,
    cpuThrottle: 1,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const take = () => {
      if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return value;
    };
    if (flag === "--app") options.app = take();
    else if (flag === "--dist") options.dist = path.resolve(take());
    else if (flag === "--browser") {
      const browser = take();
      options.browsers = browser === "all" ? ["chromium", "webkit"] : [browser];
    } else if (flag === "--runs") options.runs = Math.max(1, Number(take()) || 1);
    else if (flag === "--kbrain-url") options.kbrainUrl = take().replace(/\/+$/, "");
    else if (flag === "--json") options.json = path.resolve(take());
    else if (flag === "--screenshot") options.screenshot = path.resolve(take());
    else if (flag === "--timeout") options.timeoutMs = Number(take());
    else if (flag === "--cpu-throttle") options.cpuThrottle = Math.max(1, Number(take()) || 1);
    else throw new Error(`unknown option: ${flag}`);
  }
  for (const browser of options.browsers) {
    if (browser !== "chromium" && browser !== "webkit") {
      throw new Error(`unsupported browser: ${browser}`);
    }
  }
  const app = APPS[options.app];
  if (!app) throw new Error(`unsupported app: ${options.app} (expected gui or webui)`);
  if (!options.dist) options.dist = path.join(repoRoot, app.dist);
  options.readySelector = app.readySelector;
  options.apiPrefixes = app.apiPrefixes;
  return options;
}

async function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE, "playwright-core", "playwright"].filter(Boolean);
  const require = createRequire(path.join(process.cwd(), "noop.js"));
  for (const candidate of candidates) {
    try {
      const resolved = candidate.startsWith("/") ? candidate : require.resolve(candidate);
      return await import(pathToFileURL(resolved).href);
    } catch {
      // try the next candidate
    }
  }
  throw new Error(
    "playwright-core is not installed; run `npm i --no-save playwright-core` or set PLAYWRIGHT_CORE",
  );
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

function serveDist(dist, apiPrefixes = []) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (apiPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end('{"error":"unauthorized"}');
      return;
    }
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) {
      response.writeHead(403).end();
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, "index.html");
    response.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(response);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

export function listJsChunks(dist) {
  const assets = path.join(dist, "assets");
  if (!existsSync(assets)) return [];
  return readdirSync(assets)
    .filter((name) => name.endsWith(".js") && !/\.worker-|worker\.js$/.test(name))
    .map((name) => `assets/${name}`)
    .sort();
}

// The browser host talks to K-brain at this fixed loopback URL unless the
// build baked VITE_KBRAIN_URL in; the smoke run answers it either way.
const DEFAULT_KBRAIN_ORIGIN = "http://127.0.0.1:47321";

const FAKE_HEALTH = { status: "ok", version: "kbrain.agent.v1" };

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "*",
  "access-control-allow-methods": "*",
};

async function answerBackend(route, url, kbrainUrl) {
  if (route.request().method() === "OPTIONS") {
    await route.fulfill({ status: 204, headers: CORS_HEADERS });
    return;
  }
  if (kbrainUrl) {
    const response = await route.fetch({ url: `${kbrainUrl}${url.pathname}${url.search}` });
    await route.fulfill({ response, headers: { ...response.headers(), ...CORS_HEADERS } });
    return;
  }
  if (url.pathname === "/v1/health") {
    await route.fulfill({ status: 200, headers: CORS_HEADERS, json: FAKE_HEALTH });
    return;
  }
  await route.fulfill({ status: 404, headers: CORS_HEADERS, json: { error: "not found" } });
}

async function routeBackend(context, kbrainUrl, appOrigin) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    try {
      if (url.origin === appOrigin || url.protocol === "data:" || url.protocol === "blob:") {
        await route.continue();
      } else if (url.origin === DEFAULT_KBRAIN_ORIGIN) {
        await answerBackend(route, url, kbrainUrl);
      } else {
        // No third-party traffic from a smoke run (live catalogs, fonts, telemetry).
        await route.abort("blockedbyclient");
      }
    } catch {
      // The page closed while a long-poll was in flight.
    }
  });
}

// Errors that only say a request was blocked/404'd by this harness, not that
// the bundle is broken.
const BENIGN_CONSOLE = [
  /Failed to load resource/i,
  /net::ERR_/i,
  /blockedbyclient/i,
  /404/,
  /Fetch API cannot load/i,
  /access control checks/i,
  /due to access control/i,
  /K-brain|kbrain/i,
  /catalog/i,
  /NetworkError|Load failed|Failed to fetch/i,
  // The fake backend answers every route but /v1/health with 404 "not found".
  /not found/i,
];

const FATAL_PATTERNS = [
  /is not a function/,
  /is not a constructor/,
  /Class extends value/,
  /before initialization/,
  /is not defined/,
  /Cannot read properties of undefined/,
  /undefined is not an object/,
];

function classifyConsole(text) {
  if (FATAL_PATTERNS.some((pattern) => pattern.test(text))) return "fatal";
  if (BENIGN_CONSOLE.some((pattern) => pattern.test(text))) return "benign";
  return "error";
}

async function runOnce(playwright, browserName, options, origin, chunks) {
  const browser = await playwright[browserName].launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await routeBackend(context, options.kbrainUrl, origin);
  const page = await context.newPage();
  if (options.cpuThrottle > 1 && browserName === "chromium") {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: options.cpuThrottle });
  }
  const problems = [];
  const consoleErrors = [];
  // A crashed startup never hands over to the main UI; stop waiting on the
  // first fatal error instead of running into the full timeout.
  let reportFatal = () => {};
  const fatal = new Promise((resolve) => {
    reportFatal = resolve;
  });
  page.on("pageerror", (error) => {
    problems.push(`pageerror: ${error.message}`);
    reportFatal();
  });
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    const kind = classifyConsole(text);
    consoleErrors.push({ kind, text: text.slice(0, 400) });
    if (kind !== "benign") problems.push(`console.error: ${text.slice(0, 400)}`);
    if (kind === "fatal") reportFatal();
  });
  await page.addInitScript(() => {
    window.__smoke = { longTasks: [], dcl: 0 };
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__smoke.longTasks.push(Math.round(entry.duration));
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {}
    document.addEventListener("DOMContentLoaded", () => {
      window.__smoke.dcl = performance.now();
    });
  });

  const started = Date.now();
  await page.goto(`${origin}/`, { waitUntil: "load", timeout: options.timeoutMs });
  // The startup screen is a static shell; main.tsx replaces it with the React
  // tree once K-brain answered and App loaded.
  let mainUi = true;
  try {
    const uiReady = page.waitForFunction(
      (readySelector) => {
        const root = document.getElementById("root");
        if (!root || root.querySelector("[data-static-boot-shell]")) return false;
        if (readySelector) return Boolean(root.querySelector(readySelector));
        return root.querySelectorAll("button").length >= 3;
      },
      options.readySelector,
      { timeout: options.timeoutMs },
    );
    uiReady.catch(() => {});
    await Promise.race([
      uiReady,
      fatal.then(() => {
        throw new Error("fatal error before the main UI rendered");
      }),
    ]);
  } catch {
    mainUi = false;
    problems.push("main UI did not render (startup screen never handed over)");
  }
  const uiReadyMs = Date.now() - started;
  const timing = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    const scripts = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith(".js"));
    const dcl = window.__smoke.dcl || nav.domContentLoadedEventStart;
    // Module scripts run before DOMContentLoaded: the gap after the last
    // eagerly fetched byte is (roughly) parse + evaluation of the entry graph.
    const eagerEnd = Math.max(
      0,
      ...scripts.filter((entry) => entry.responseEnd <= dcl).map((entry) => entry.responseEnd),
    );
    return {
      domContentLoadedMs: Math.round(dcl),
      entryEvalMs: Math.round(dcl - eagerEnd),
      jsRequestsBeforeUi: scripts.length,
      jsBytesBeforeUi: scripts.reduce(
        (sum, entry) => sum + (entry.encodedBodySize || entry.transferSize || 0),
        0,
      ),
      jsFilesBeforeUi: scripts.map((entry) => entry.name.replace(/^.*\/assets\//, "")),
      longTasks: window.__smoke.longTasks.slice(0, 12),
    };
  });
  // Give effects a moment to run (lazy panels, first data loads).
  await page.waitForTimeout(1500);
  const settled = await page.evaluate(() => {
    const scripts = performance
      .getEntriesByType("resource")
      .filter((entry) => entry.name.endsWith(".js"));
    return {
      jsRequestsSettled: scripts.length,
      jsBytesSettled: scripts.reduce(
        (sum, entry) => sum + (entry.encodedBodySize || entry.transferSize || 0),
        0,
      ),
    };
  });

  const errorBoundary = await page.evaluate(() => {
    const text = document.body.innerText;
    return /Something went wrong|出现错误|出错了|require_cjs/i.test(text) ? text.slice(0, 300) : "";
  });
  if (errorBoundary) problems.push(`error boundary visible: ${errorBoundary}`);

  if (options.screenshot && mainUi) {
    const file = options.screenshot.replace(/(\.png)?$/, `-${browserName}.png`);
    await page.screenshot({ path: file });
  }

  // Evaluate every chunk, lazy ones included.
  const chunkFailures = await page.evaluate(async (files) => {
    const failures = [];
    for (const file of files) {
      try {
        await import(`/${file}`);
      } catch (error) {
        failures.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return failures;
  }, chunks);
  for (const failure of chunkFailures) problems.push(`chunk import failed: ${failure}`);
  await page.waitForTimeout(300);

  await context.unrouteAll({ behavior: "ignoreErrors" });
  await context.close();
  await browser.close();
  return {
    browser: browserName,
    mainUi,
    uiReadyMs,
    ...timing,
    ...settled,
    consoleErrors,
    problems,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!existsSync(path.join(options.dist, "index.html"))) {
    throw new Error(`no index.html in ${options.dist}; build the frontend first`);
  }
  const playwright = await loadPlaywright();
  const server = await serveDist(options.dist, options.apiPrefixes);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chunks = listJsChunks(options.dist);
  const results = [];
  try {
    for (const browserName of options.browsers) {
      for (let run = 0; run < options.runs; run += 1) {
        const result = await runOnce(playwright, browserName, options, origin, chunks);
        results.push(result);
        const status = result.problems.length === 0 ? "ok" : "FAIL";
        console.log(
          `[${options.app} ${browserName} #${run + 1}] ${status} ui=${result.uiReadyMs}ms dcl=${result.domContentLoadedMs}ms entryEval=${result.entryEvalMs}ms js@ui=${result.jsRequestsBeforeUi} files/${(result.jsBytesBeforeUi / 1048576).toFixed(2)}MB js@settled=${result.jsRequestsSettled}/${(result.jsBytesSettled / 1048576).toFixed(2)}MB longTasks=[${result.longTasks.join(",")}] chunks=${chunks.length}`,
        );
        for (const problem of result.problems) console.log(`  - ${problem}`);
      }
    }
  } finally {
    server.close();
  }
  if (options.json) writeFileSync(options.json, `${JSON.stringify(results, null, 2)}\n`);
  const failed = results.some((result) => result.problems.length > 0);
  if (failed) {
    console.error("frontend bundle smoke check failed");
    process.exitCode = 1;
  }
  return results;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
