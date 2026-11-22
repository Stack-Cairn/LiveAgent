#!/usr/bin/env node
// Transcript performance benchmark driver.
//
//   CHROME_PATH=/path/to/chrome node crates/agent-gui/perf/run.mjs \
//     [--scenarios=stream,find,scroll,editdiff,gitdiff] [--throttle=1,4] \
//     [--no-build] [--plain] [--repeat=1] [--out=results.json] [--shots=dir] [--chars=24000]
//
// Builds perf/transcript.html (production build + React profiling renderer;
// --plain uses the regular production renderer: no commit counts, but CPU
// numbers without the profiler's own bookkeeping),
// serves it locally, drives headless Chromium over raw CDP and prints one
// result row per scenario. All data is synthetic (perf/fixtures.ts).
// Temporary browser profiles go under $TMPDIR.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient } from "../../../scripts/testing/session-sync-cdp.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  }),
);
const scenarios = (args.scenarios ?? "stream,find,scroll,editdiff,gitdiff").split(",");
const throttles = (args.throttle ?? "1,4").split(",").map(Number);
const repeat = Number(args.repeat ?? 1);

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const cache = path.join(os.homedir(), "Library/Caches/ms-playwright");
  const candidates = [
    "chromium-1243/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell",
  ].map((candidate) => path.join(cache, candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Set CHROME_PATH to a Chromium binary");
  return found;
}

function build() {
  const result = spawnSync(
    path.join(appRoot, "node_modules/.bin/vite"),
    ["build", "--config", "perf/vite.config.ts"],
    {
      cwd: appRoot,
      stdio: "inherit",
      env: { ...process.env, ...(args.plain ? { PERF_PLAIN: "1" } : {}) },
    },
  );
  if (result.status !== 0) throw new Error("harness build failed");
}

function serve(root) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".ttf": "font/ttf", ".woff": "font/woff" };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function launchChrome() {
  const profile = mkdtempSync(path.join(os.tmpdir(), "la-perf-chrome-"));
  const child = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--window-size=1280,900",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-experimental-web-platform-features",
      // CI runners (Ubuntu 24.04) restrict the unprivileged user namespaces
      // Chromium's sandbox needs; the page is a local synthetic harness.
      ...(process.env.CI === "true" ? ["--no-sandbox"] : []),
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const endpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("chrome did not start")), 20_000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk;
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });
  const port = new URL(endpoint).port;
  let page;
  for (let attempt = 0; attempt < 100 && !page; attempt += 1) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = targets.find((target) => target.type === "page");
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!page) {
    child.kill("SIGTERM");
    throw new Error("chrome exposed no page target");
  }
  const client = await CdpClient.connect(page.webSocketDebuggerUrl, 900_000);
  client.timeoutMs = 900_000;
  return {
    client,
    close: () => {
      child.kill("SIGTERM");
      setTimeout(() => rmSync(profile, { recursive: true, force: true }), 500);
    },
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function open(client, baseUrl, mode) {
  await client.request("Emulation.setCPUThrottlingRate", { rate: 1 });
  // --reducedMotion: no typewriter reveal (text draws as it arrives).
  await client.request("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: args.reducedMotion ? "reduce" : "no-preference" }],
  });
  await client.request("Page.navigate", { url: `${baseUrl}/transcript.html?mode=${mode}` });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await delay(50);
    const ready = await client.evaluate("Boolean(window.__perf && window.__perf.mode)").catch(() => false);
    if (ready) {
      // --noAnim: diagnostics only — freezes the CSS animations of the turn chrome.
      // --css=rule: diagnostics only — injects an extra stylesheet.
      const css = [args.noAnim ? "*{animation:none!important}" : "", args.css ?? ""].join("");
      if (css) {
        await client.evaluate(
          `document.head.insertAdjacentHTML("beforeend", ${JSON.stringify(`<style>${css}</style>`)})`,
        );
      }
      return;
    }
  }
  throw new Error(`harness did not load (${mode})`);
}

async function metrics(client) {
  const { metrics: list } = await client.request("Performance.getMetrics");
  return Object.fromEntries(list.map((entry) => [entry.name, entry.value]));
}

async function measured(client, throttle, run) {
  await client.evaluate("window.__perf.resetCommits()");
  await client.request("Emulation.setCPUThrottlingRate", { rate: throttle });
  const before = await metrics(client);
  const result = await run();
  const after = await metrics(client);
  await client.request("Emulation.setCPUThrottlingRate", { rate: 1 });
  const commits = await client.evaluate("({...window.__commits})");
  return {
    ...result,
    taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
    scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
    layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
    styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
    commits: commits.n,
    commitMs: Math.round(commits.actual),
  };
}

const LONG_TASKS = `
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) window.__longTasks.push(entry.duration);
  }).observe({ type: "longtask", buffered: false });
`;

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const SCENARIOS = {
  // 24k chars streamed 4 chars / 8 ms into a 200-message conversation.
  async stream(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(200, 2048)");
    await delay(1500);
    const chars = Number(args.chars ?? 24000);
    const result = await measured(client, throttle, () =>
      client.evaluate(`window.__perf.startStream({ chars: ${chars}, chunk: 4, intervalMs: 8 })`),
    );
    const signatures = await client.evaluate("window.__signatures");
    if (args.signatures) {
      const top = Object.entries(signatures).sort((a, b) => b[1] - a[1]).slice(0, 12);
      for (const [key, count] of top) console.error(`${count}\t${key}`);
    }
    return {
      ...result,
      wallMs: Math.round(result.wallMs),
      commitsPerFrame: Number((result.commits / Math.max(1, result.frames)).toFixed(2)),
    };
  },

  // Streamed reply markup, to diff two builds: stream, then hash the live row.
  async markup(client, baseUrl) {
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(20, 2048)");
    await delay(500);
    const chars = Number(args.chars ?? 6000);
    await client.evaluate(`window.__perf.startStream({ chars: ${chars}, chunk: 4, intervalMs: 8 })`);
    const html = await client.evaluate("window.__perf.liveHtml()");
    if (args.html) writeFileSync(args.html, html);
    const { createHash } = await import("node:crypto");
    return { length: html.length, sha1: createHash("sha1").update(html).digest("hex") };
  },

  // CPU profile of a short stream: top self-time functions (diagnostics).
  async profile(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(200, 2048)");
    await delay(1500);
    const chars = Number(args.chars ?? 6000);
    await client.request("Profiler.enable");
    await client.request("Profiler.setSamplingInterval", { interval: 200 });
    await client.request("Emulation.setCPUThrottlingRate", { rate: throttle });
    await client.request("Profiler.start");
    await client.evaluate(`window.__perf.startStream({ chars: ${chars}, chunk: 4, intervalMs: 8 })`);
    const { profile } = await client.request("Profiler.stop");
    await client.request("Emulation.setCPUThrottlingRate", { rate: 1 });
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const self = new Map();
    const dt = profile.timeDeltas;
    profile.samples.forEach((id, index) => {
      const node = byId.get(id);
      const frame = node.callFrame;
      const key = `${frame.functionName || "(anon)"} ${frame.url.split("/").pop()}:${frame.lineNumber}:${frame.columnNumber}`;
      self.set(key, (self.get(key) ?? 0) + (dt[index] ?? 0) / 1000);
    });
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(args.top ?? 40));
    if (args.profileOut) writeFileSync(args.profileOut, JSON.stringify(profile));
    return { top: top.map(([key, ms]) => `${ms.toFixed(0)}ms ${key}`) };
  },

  // Main-thread time by trace event during a short stream (diagnostics).
  async trace(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(200, 2048)");
    await delay(1500);
    const chars = Number(args.chars ?? 6000);
    const events = [];
    client.on("Tracing.dataCollected", (params) => events.push(...params.value));
    const done = new Promise((resolve) => client.on("Tracing.tracingComplete", resolve));
    await client.request("Tracing.start", {
      categories:
        "devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,v8.execute" +
        (args.invalidations ? ",disabled-by-default-devtools.timeline.invalidationTracking" : ""),
      transferMode: "ReportEvents",
    });
    await client.request("Emulation.setCPUThrottlingRate", { rate: throttle });
    await client.evaluate(`window.__perf.startStream({ chars: ${chars}, chunk: 4, intervalMs: 8 })`);
    await client.request("Emulation.setCPUThrottlingRate", { rate: 1 });
    await client.request("Tracing.end");
    await done;
    // Self time per event name on the renderer main thread.
    const main = events.find((event) => event.name === "thread_name" && event.args?.name === "CrRendererMain");
    const complete = events
      .filter((event) => event.ph === "X" && event.tid === main?.tid && event.pid === main?.pid && event.dur)
      .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const self = new Map();
    const stack = [];
    for (const event of complete) {
      while (stack.length && stack.at(-1).end <= event.ts) stack.pop();
      const parent = stack.at(-1);
      if (parent) parent.child += event.dur;
      const entry = { name: event.name, end: event.ts + event.dur, dur: event.dur, child: 0 };
      stack.push(entry);
      entry.flush = () => self.set(entry.name, (self.get(entry.name) ?? 0) + entry.dur - entry.child);
      (event.__entries ??= []).push(entry);
    }
    for (const event of complete) for (const entry of event.__entries) entry.flush();
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
    const styles = complete.filter((event) => event.name === "UpdateLayoutTree");
    const elementCounts = styles.map((event) => event.args?.elementCount ?? 0).sort((a, b) => a - b);
    // Forced style/layout: who in JS asked for it.
    const forced = new Map();
    for (const event of complete) {
      if (event.name !== "UpdateLayoutTree" && event.name !== "Layout") continue;
      const frames = event.args?.beginData?.stackTrace;
      if (!frames?.length) continue;
      const key = `${event.name} <- ${frames.slice(0, 3).map((frame) => frame.functionName || "(anon)").join(" < ")}`;
      const entry = forced.get(key) ?? { count: 0, us: 0 };
      entry.count += 1;
      entry.us += event.dur;
      forced.set(key, entry);
    }
    // Style invalidations by reason and element (needs --invalidations).
    const invalidations = new Map();
    for (const event of events) {
      if (!event.name.includes("Invalidat")) continue;
      const data = event.args?.data ?? {};
      const frames = data.stackTrace ?? [];
      const key = `${event.name} ${data.reason ?? data.invalidationSet?.[0]?.classes ?? ""} ${data.nodeName ?? ""} <- ${frames
        .slice(0, 2)
        .map((frame) => frame.functionName || "(anon)")
        .join(" < ")}`;
      invalidations.set(key, (invalidations.get(key) ?? 0) + 1);
    }
    const forcedTop = [...forced.entries()].sort((a, b) => b[1].us - a[1].us).slice(0, 12);
    return {
      invalidations: [...invalidations.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([key, count]) => `x${count} ${key}`),
      forced: forcedTop.map(([key, entry]) => `${(entry.us / 1000).toFixed(0)}ms x${entry.count} ${key}`),
      top: top.map(([name, us]) => `${(us / 1000).toFixed(0)}ms ${name}`),
      styleRecalcs: styles.length,
      styleElementsP50: elementCounts[Math.floor(elementCounts.length / 2)] ?? 0,
      styleElementsMax: elementCounts.at(-1) ?? 0,
    };
  },

  // Floor: the live tail is shown (isSending) but nothing streams for `idleMs`.
  async idle(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(200, 2048)");
    await delay(1500);
    const idleMs = Number(args.idleMs ?? 10000);
    return measured(client, throttle, () =>
      client.evaluate(`(async () => {
        window.__perf.setSending(true);
        await new Promise((r) => setTimeout(r, ${idleMs}));
        return { idleMs: ${idleMs} };
      })()`),
    );
  },

  // Find bar open on 1500 x 2KB messages: cold query, then a short stream.
  async find(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    // 1500 assistant replies of 2KB: more markdown than the old 4 MB strip cache held.
    await client.evaluate(`window.__perf.load(${Number(args.findCount ?? 3000)}, 2048)`);
    await delay(2000);
    await client.evaluate(LONG_TASKS);
    await client.request("Emulation.setCPUThrottlingRate", { rate: throttle });
    await client.request("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 4 });
    await client.request("Input.dispatchKeyEvent", { type: "keyUp", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 4 });
    await delay(300);
    const coldMs = await client.evaluate(`(async () => {
      const input = document.querySelector("[data-transcript-find] input");
      const status = document.querySelector("[data-transcript-find-status]");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      const started = performance.now();
      setter.call(input, "cache");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      while (!/\\d/.test(status.textContent || "")) await new Promise((r) => requestAnimationFrame(r));
      return performance.now() - started;
    })()`);
    const status = await client.evaluate(`document.querySelector("[data-transcript-find-status]").textContent`);
    await client.request("Emulation.setCPUThrottlingRate", { rate: 1 });
    await delay(500);
    await client.evaluate("window.__longTasks = []");
    const result = await measured(client, throttle, () =>
      client.evaluate("window.__perf.startStream({ chars: 3000, chunk: 4, intervalMs: 8 })"),
    );
    const longTasks = await client.evaluate("window.__longTasks");
    return {
      coldMs: Math.round(coldMs),
      status,
      taskMs: result.taskMs,
      wallMs: Math.round(result.wallMs),
      commits: result.commits,
      longTaskP50: Math.round(percentile(longTasks, 50)),
      longTaskMax: Math.round(Math.max(0, ...longTasks)),
      longTasks: longTasks.length,
    };
  },

  // Project a 2000-message history (createTranscriptProjection) on a fresh
  // page, then once more: the second load reuses the same message objects,
  // the way a re-projection after a history refresh would.
  async projection(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    const result = await measured(client, throttle, async () => {
      const first = await client.evaluate("window.__perf.load(2000, 1024, { agent: true })");
      const again = await client.evaluate(
        "window.__perf.load(2000, 1024, { agent: true, reuse: true })",
      );
      return {
        items: first.items,
        projectionMs: Math.round(first.projectionMs),
        reprojectionMs: Math.round(again.projectionMs),
      };
    });
    return result;
  },

  // 2000 messages, scroll up 150px per frame for 240 frames.
  async scroll(client, baseUrl, throttle) {
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(2000, 1024)");
    await delay(3000);
    // Wheel input (programmatic scrollTop is re-pinned by follow mode, a
    // wheel breaks it like a user would): 240 notches of 150px upwards, about
    // one per frame, while the page records its frame intervals.
    const center = await client.evaluate(`(() => {
      const viewport = [...document.querySelectorAll("[data-scroll-viewport]")].sort(
        (a, b) => b.scrollHeight - a.scrollHeight,
      )[0];
      window.__scrollViewport = viewport;
      window.__scrollStart = viewport.scrollTop;
      const rect = viewport.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    const result = await measured(client, throttle, async () => {
      await client.evaluate(`(() => {
        window.__frames = [];
        window.__recording = true;
        let last = performance.now();
        const tick = (now) => {
          window.__frames.push(now - last);
          last = now;
          if (window.__recording) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      })()`);
      for (let index = 0; index < 240; index += 1) {
        await client.request("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: center.x,
          y: center.y,
          deltaX: 0,
          deltaY: -150,
        });
        await delay(16);
      }
      await delay(300);
      return client.evaluate(`(() => {
        window.__recording = false;
        return {
          frames: window.__frames.slice(1),
          scrolledPx: Math.round(window.__scrollStart - window.__scrollViewport.scrollTop),
        };
      })()`);
    });
    const frames = result.frames;
    delete result.frames;
    return {
      ...result,
      frameP50: Number(percentile(frames, 50).toFixed(1)),
      frameP95: Number(percentile(frames, 95).toFixed(1)),
      frameMax: Number(Math.max(...frames).toFixed(1)),
    };
  },

  // Edit diff: mount 20k lines; stream a 2k-line edit over 200 ticks.
  async editdiff(client, baseUrl, throttle) {
    await open(client, baseUrl, "editdiff");
    const mount = await measured(client, throttle, () =>
      client.evaluate(`(async () => {
        const started = performance.now();
        const { renderMs } = window.__perf.mountDiff(20000);
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
        return { renderMs, firstFrameMs: performance.now() - started };
      })()`),
    );
    const domNodes = await client.evaluate("window.__perf.domNodes()");
    // Expanding a collapsed diff (when the build has the control), then
    // scrolling through it.
    const expand = await client.evaluate(`(async () => {
      const button = document.querySelector("[data-diff-expand]");
      if (!button) return null;
      const started = performance.now();
      button.click();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      const expandMs = performance.now() - started;
      const viewport = document.querySelector("[data-scroll-viewport]");
      const frames = [];
      let last = performance.now();
      let peak = 0;
      while (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 2) {
        viewport.scrollTop += 600;
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        frames.push(now - last);
        last = now;
        peak = Math.max(peak, document.getElementsByTagName("*").length);
      }
      frames.sort((a, b) => a - b);
      return {
        expandMs,
        expandedNodes: peak,
        scrollStepP95: frames[Math.floor(frames.length * 0.95)] ?? 0,
        scrollSteps: frames.length,
      };
    })()`);
    await open(client, baseUrl, "editdiff");
    const stream = await measured(client, throttle, () =>
      client.evaluate("window.__perf.streamDiff(2000, 200, 16)"),
    );
    return {
      mountMs: Math.round(mount.firstFrameMs),
      domNodes20k: domNodes,
      ...(expand
        ? {
            expandMs: Math.round(expand.expandMs),
            expandedPeakNodes: expand.expandedNodes,
            expandedScrollP95: Number(expand.scrollStepP95.toFixed(1)),
            expandedScrollSteps: expand.scrollSteps,
          }
        : {}),
      streamSyncMsPerTick: Number(stream.syncMsPerTick.toFixed(1)),
      streamTaskMs: stream.taskMs,
      streamWallMs: Math.round(stream.wallMs),
    };
  },

  // Screenshots for review (--shots=dir): a long edit diff collapsed and
  // expanded, and the live sparkle while a reply streams.
  async screens(client, baseUrl) {
    const dir = args.shots ?? path.join(here, "shots");
    const capture = async (name, selector) => {
      const clip = await client.evaluate(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        const pad = 12;
        return { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad),
          width: rect.width + pad * 2, height: Math.min(innerHeight, rect.height + pad * 2), scale: 2 };
      })()`);
      const result = await client.request("Page.captureScreenshot", { format: "png", clip });
      writeFileSync(path.join(dir, name), Buffer.from(result.data, "base64"));
    };
    await client.request("Emulation.setDeviceMetricsOverride", { width: 760, height: 640, deviceScaleFactor: 2, mobile: false });
    await open(client, baseUrl, "editdiff");
    await client.evaluate("window.__perf.mountDiff(420)");
    await delay(500);
    await client.evaluate(`document.querySelector("[data-diff-expand]").scrollIntoView({ block: "end" })`);
    await delay(300);
    await capture("perf-edit-diff-collapsed.png", "[data-scroll-viewport]");
    await client.evaluate(`document.querySelector("[data-diff-expand]").click()`);
    await delay(300);
    await client.evaluate(`document.querySelector("[data-diff-expand]").scrollIntoView({ block: "end" })`);
    await delay(600);
    await capture("perf-edit-diff-expanded.png", "[data-scroll-viewport]");
    await open(client, baseUrl, "transcript");
    await client.evaluate("window.__perf.load(4, 400)");
    await delay(800);
    await client.evaluate("window.__perf.startStream({ chars: 4000, chunk: 4, intervalMs: 40 })");
    await delay(2500);
    // Mid-stream: the live row's typewriter reveal and markdown (unchanged
    // look, now driven by the shared frame clock).
    await capture("perf-transcript-streaming.png", "[data-scroll-viewport]");
    await client.request("Emulation.clearDeviceMetricsOverride");
    return { dir };
  },

  // Git review: 60 files x 120 lines, scrolled top to bottom.
  async gitdiff(client, baseUrl, throttle) {
    await open(client, baseUrl, "gitdiff");
    await client.evaluate("window.__perf.mountPatch(60, 120)");
    await delay(1000);
    const initialNodes = await client.evaluate("window.__perf.domNodes()");
    const result = await measured(client, throttle, () =>
      client.evaluate(`(async () => {
        const candidates = [...document.querySelectorAll("*")].filter(
          (el) => el.scrollHeight > el.clientHeight + 100 && /(auto|scroll)/.test(getComputedStyle(el).overflowY),
        );
        const viewport = candidates.sort((a, b) => b.scrollHeight - a.scrollHeight)[0];
        const frames = [];
        let last = performance.now();
        let peak = 0;
        while (viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 2) {
          viewport.scrollTop += 400;
          await new Promise((r) => requestAnimationFrame(r));
          await new Promise((r) => setTimeout(r, 30));
          const now = performance.now();
          frames.push(now - last);
          last = now;
          peak = Math.max(peak, document.getElementsByTagName("*").length);
        }
        return { frames, peakNodes: peak, endNodes: document.getElementsByTagName("*").length };
      })()`),
    );
    return {
      initialNodes,
      peakNodes: result.peakNodes,
      endNodes: result.endNodes,
      scrollTaskMs: result.taskMs,
      stepP95: Number(percentile(result.frames, 95).toFixed(1)),
    };
  },
};

async function main() {
  if (args["no-build"] !== "true") build();
  const server = await serve(path.join(here, args.plain ? "dist-plain" : "dist"));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { client, close } = await launchChrome();
  await client.request("Page.enable");
  await client.request("Performance.enable");
  const results = [];
  try {
    for (const scenario of scenarios) {
      for (const throttle of throttles) {
        for (let run = 0; run < repeat; run += 1) {
          const result = await SCENARIOS[scenario](client, baseUrl, throttle);
          const row = { scenario, throttle, run, ...result };
          if (args.shots && scenario !== "screens") await client.screenshot(path.join(args.shots, `${scenario}-${throttle}x.png`));
          results.push(row);
          console.log(JSON.stringify(row));
        }
      }
    }
  } finally {
    close();
    server.close();
  }
  if (args.out) writeFileSync(args.out, `${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
