// Throwaway CDP driver for scroll-follow-probe.html. Drives a headless
// Chromium (Edge) already listening on CDP_PORT, replays wheel gestures on the
// real WebUI transcript stack and records every programmatic scroll write with
// its owner, so a visible jump can be attributed to a concrete writer.
//
//   node test/browser/scroll-follow-probe.cdp.mjs [wheel|growth|all]
//
// Env: CDP_PORT (9333), PROBE_URL, PROBE_OUT (.codex-artifacts/scroll-probe)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.CDP_PORT ?? 9333);
const PAGE_URL =
  process.env.PROBE_URL ?? "http://127.0.0.1:5173/test/browser/scroll-follow-probe.html";
const OUT_DIR = process.env.PROBE_OUT ?? join(process.cwd(), ".codex-artifacts", "scroll-probe");
const SCENARIO = process.argv[2] ?? "all";
const WHEEL_STEP = Number(process.env.PROBE_WHEEL_STEP ?? 100);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getPageTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error(`no CDP page target on port ${PORT}`);
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.consoleLog = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }
  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${JSON.stringify(result.exceptionDetails).slice(0, 800)}`);
    }
    return result.result.value;
  }
}

async function connect() {
  const target = await getPageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type === "error" || params.type === "warning") {
      cdp.consoleLog.push({
        type: params.type,
        text: params.args
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ")
          .slice(0, 400),
      });
    }
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    cdp.consoleLog.push({
      type: "exception",
      text: (
        params.exceptionDetails.exception?.description ??
        params.exceptionDetails.text ??
        ""
      ).slice(0, 600),
    });
  });
  return cdp;
}

async function loadPage(cdp, url) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.navigate", { url });
  await loaded;
  const started = Date.now();
  while (Date.now() - started < 240_000) {
    const ready = await cdp
      .eval("Boolean(window.__probe && window.__probe.ready)")
      .catch(() => false);
    if (ready) return;
    await sleep(500);
  }
  throw new Error("probe page never became ready (check the Vite log / console errors)");
}

const metrics = (cdp) => cdp.eval("window.__probe.metrics()");
const writesSince = (cdp, from) => cdp.eval(`window.__probe.writes.slice(${from})`);
const writeCount = (cdp) => cdp.eval("window.__probe.writes.length");

async function wheel(cdp, x, y, deltaY) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
}

async function center(cdp) {
  const rect = await cdp.eval("window.__probe.viewportRect()");
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

function brief(write) {
  return {
    kind: write.kind,
    who: write.who,
    from: write.from,
    to: write.to,
    t: write.t,
    top: write.top,
  };
}

// On-screen movement of the row under the reader's eyes (negative = content
// moved up). This is the number the user perceives; scrollTop deltas alone
// cannot tell a real jump from an origin rebase that moves no pixels.
const anchorBefore = (cdp) => cdp.eval("window.__probe.visibleAnchor()");
async function visualDelta(cdp, anchor) {
  if (!anchor) return null;
  const top = await cdp.eval(`window.__probe.anchorTop(${JSON.stringify(anchor.key)})`);
  return top === null ? null : Math.round((top - anchor.top) * 10) / 10;
}

// Scenario 1: detach with wheel-up, then wheel back down to the bottom one
// step at a time. Any step that moves further than the wheel delta is a jump.
async function scenarioWheelToBottom(cdp) {
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(300);
  const { x, y } = await center(cdp);
  const start = await metrics(cdp);
  for (let i = 0; i < 14; i += 1) {
    await wheel(cdp, x, y, -120);
    await sleep(60);
  }
  await sleep(800);
  const detached = await metrics(cdp);
  const steps = [];
  let clampedSteps = 0;
  for (let i = 0; i < 120; i += 1) {
    const before = await metrics(cdp);
    const anchor = await anchorBefore(cdp);
    const from = await writeCount(cdp);
    await wheel(cdp, x, y, WHEEL_STEP);
    await sleep(160);
    const after = await metrics(cdp);
    const visual = await visualDelta(cdp, anchor);
    const writes = await writesSince(cdp, from);
    const delta = Math.round((after.scrollTop - before.scrollTop) * 10) / 10;
    steps.push({
      i,
      before: { scrollTop: before.scrollTop, gap: before.gap, following: before.following },
      after: { scrollTop: after.scrollTop, gap: after.gap, following: after.following },
      delta,
      visual,
      jump: delta > WHEEL_STEP + 4,
      writes: writes.map(brief),
    });
    if (after.gap <= 1) clampedSteps += 1;
    else clampedSteps = 0;
    if (clampedSteps >= 2) break;
  }
  return { start, detached, steps, jumps: steps.filter((step) => step.jump) };
}

// Scenario 2: detached reader parked `gapPx` above the clamp (latch expired),
// then the last row grows. A moving scrollTop means some writer dragged the
// reader along.
async function scenarioDetachedGrowth(cdp, gapPx) {
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(300);
  const { x, y } = await center(cdp);
  for (let i = 0; i < 5; i += 1) {
    await wheel(cdp, x, y, -120);
    await sleep(60);
  }
  await sleep(800);
  const afterDetach = await metrics(cdp);
  await cdp.eval(`window.__probe.setGap(${gapPx})`);
  await sleep(700);
  const positioned = await metrics(cdp);
  const anchor = await anchorBefore(cdp);
  const from = await writeCount(cdp);
  await cdp.eval("window.__probe.growLastRow(900)");
  await sleep(800);
  const grown = await metrics(cdp);
  const visual = await visualDelta(cdp, anchor);
  const writes = await writesSince(cdp, from);
  return {
    gapPx,
    afterDetach,
    positioned,
    grown,
    visual,
    moved: Math.round((grown.scrollTop - positioned.scrollTop) * 10) / 10,
    scrollHeightDelta: grown.scrollHeight - positioned.scrollHeight,
    writes: writes.map(brief),
  };
}

// Scenario 3: detached reader parked `gapPx` above the clamp, then a whole new
// user+assistant turn arrives (count change + first measurement of new rows).
async function scenarioAppendTurn(cdp, gapPx) {
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(300);
  const { x, y } = await center(cdp);
  for (let i = 0; i < 5; i += 1) {
    await wheel(cdp, x, y, -120);
    await sleep(60);
  }
  await sleep(800);
  const afterDetach = await metrics(cdp);
  await cdp.eval(`window.__probe.setGap(${gapPx})`);
  await sleep(700);
  const positioned = await metrics(cdp);
  const from = await writeCount(cdp);
  const appendedKeys = await cdp.eval("window.__probe.appendTurn()");
  await sleep(900);
  const grown = await metrics(cdp);
  const writes = await writesSince(cdp, from);
  return {
    gapPx,
    appendedKeys,
    afterDetach,
    positioned,
    grown,
    moved: Math.round((grown.scrollTop - positioned.scrollTop) * 10) / 10,
    scrollHeightDelta: grown.scrollHeight - positioned.scrollHeight,
    writes: writes.map(brief),
  };
}

const pick = (m) => ({
  scrollTop: m.scrollTop,
  gap: m.gap,
  following: m.following,
  lastRowHeight: m.lastRowHeight,
});
const r1 = (value) => Math.round(value * 10) / 10;

function diffHeights(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[key];
    const b = after[key];
    if (a === undefined || b === undefined) {
      changed.push(`${key}:${a ?? "unmounted"}->${b ?? "unmounted"}`);
    } else if (Math.abs(a - b) > 0.5) {
      changed.push(`${key}:${a}->${b}`);
    }
  }
  return changed;
}

// Ask-mode scenario A: pinned at the bottom of a live turn parked on a pending
// AskUserQuestion card, wheel up 60px at a time and dwell 1.3s per step so the
// per-second timers (elapsed label, countdown) tick while the reader is inside
// the bottom band. A step whose scrollTop moved by anything other than the
// wheel delta had a programmatic writer.
async function scenarioAskScrollUp(cdp) {
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(600);
  const { x, y } = await center(cdp);
  const start = await metrics(cdp);
  const steps = [];
  for (let i = 0; i < 14; i += 1) {
    const before = await metrics(cdp);
    const heightsBefore = await cdp.eval("window.__probe.rowHeights()");
    const anchor = await anchorBefore(cdp);
    const from = await writeCount(cdp);
    await wheel(cdp, x, y, -60);
    await sleep(1300);
    const after = await metrics(cdp);
    const visual = await visualDelta(cdp, anchor);
    const heightsAfter = await cdp.eval("window.__probe.rowHeights()");
    const writes = await writesSince(cdp, from);
    const delta = r1(after.scrollTop - before.scrollTop);
    steps.push({
      i,
      before: pick(before),
      after: pick(after),
      delta,
      visual,
      unexpected: Math.abs(delta + 60) > 4,
      writes: writes.map(brief),
      rowChanges: diffHeights(heightsBefore, heightsAfter),
    });
  }
  return { start: pick(start), steps, unexpected: steps.filter((step) => step.unexpected) };
}

// Arrival scenario (?ask=2): the live turn shows prose only; park the reader
// (detached) `gapPx` above the clamp, then the AskUserQuestion tool_call
// arrives and the card mounts. `gapPx === null` keeps the reader following at
// the bottom (the expected pin case).
async function scenarioAskArrive(cdp, gapPx) {
  // Fresh page per run: arriveAsk() is one-shot (the tool_call stays in the
  // rows), so each sub-scenario must start from the prose-only live turn.
  await loadPage(cdp, PAGE_URL);
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(500);
  const { x, y } = await center(cdp);
  if (gapPx !== null) {
    for (let i = 0; i < 5; i += 1) {
      await wheel(cdp, x, y, -120);
      await sleep(60);
    }
    await sleep(800);
    await cdp.eval(`window.__probe.setGap(${gapPx})`);
    await sleep(500);
  }
  const positioned = await metrics(cdp);
  const heightsBefore = await cdp.eval("window.__probe.rowHeights()");
  const anchor = await anchorBefore(cdp);
  const from = await writeCount(cdp);
  await cdp.eval("window.__probe.arriveAsk()");
  const samples = [];
  for (let i = 0; i < 6; i += 1) {
    await sleep(150);
    samples.push(pick(await metrics(cdp)));
  }
  await sleep(600);
  const settled = await metrics(cdp);
  const visual = await visualDelta(cdp, anchor);
  const heightsAfter = await cdp.eval("window.__probe.rowHeights()");
  const writes = await writesSince(cdp, from);
  return {
    gapPx,
    positioned: pick(positioned),
    samples,
    settled: pick(settled),
    visual,
    moved: r1(settled.scrollTop - positioned.scrollTop),
    scrollHeightDelta: settled.scrollHeight - positioned.scrollHeight,
    writes: writes.map(brief),
    rowChanges: diffHeights(heightsBefore, heightsAfter),
  };
}

// Ask-mode scenario B: from the detached position, wheel back down toward the
// card 60px at a time (300ms dwell) until clamped.
async function scenarioAskScrollDown(cdp) {
  const { x, y } = await center(cdp);
  const state = await metrics(cdp);
  if (state.following || state.gap < 600) {
    for (let i = 0; i < 14; i += 1) {
      await wheel(cdp, x, y, -60);
      await sleep(60);
    }
    await sleep(800);
  }
  const steps = [];
  let clamped = 0;
  for (let i = 0; i < 60; i += 1) {
    const before = await metrics(cdp);
    const anchor = await anchorBefore(cdp);
    const from = await writeCount(cdp);
    await wheel(cdp, x, y, 60);
    await sleep(300);
    const after = await metrics(cdp);
    const visual = await visualDelta(cdp, anchor);
    const writes = await writesSince(cdp, from);
    const delta = r1(after.scrollTop - before.scrollTop);
    steps.push({
      i,
      before: pick(before),
      after: pick(after),
      delta,
      visual,
      jump: delta > 64,
      writes: writes.map(brief),
    });
    if (after.gap <= 1) clamped += 1;
    else clamped = 0;
    if (clamped >= 2) break;
  }
  return { steps, jumps: steps.filter((step) => step.jump) };
}

// Ask-mode scenario C: park detached `gapPx` above the clamp and do nothing
// for 4s; any movement comes from timers/animations, not from input.
async function scenarioAskHold(cdp, gapPx) {
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(400);
  const { x, y } = await center(cdp);
  for (let i = 0; i < 5; i += 1) {
    await wheel(cdp, x, y, -120);
    await sleep(60);
  }
  await sleep(800);
  await cdp.eval(`window.__probe.setGap(${gapPx})`);
  await sleep(500);
  const positioned = await metrics(cdp);
  const from = await writeCount(cdp);
  const samples = [];
  for (let i = 0; i < 8; i += 1) {
    await sleep(500);
    samples.push(pick(await metrics(cdp)));
  }
  const writes = await writesSince(cdp, from);
  return {
    gapPx,
    positioned: pick(positioned),
    samples,
    moved: r1(samples[samples.length - 1].scrollTop - positioned.scrollTop),
    writes: writes.map(brief),
  };
}

// Approval variant (?approval=2): the pending tool_call that arrives carries
// the approval markers; afterwards the composer grows by `barPx` the way the
// real approval bar does, and the bottom spacer follows.
async function scenarioApprovalArrive(cdp, gapPx, barPx = 72) {
  const arrival = await scenarioAskArrive(cdp, gapPx);
  const positioned = await metrics(cdp);
  const anchor = await anchorBefore(cdp);
  const from = await writeCount(cdp);
  const composer = await cdp.eval(`window.__probe.growComposer(${barPx})`);
  await sleep(700);
  const settled = await metrics(cdp);
  const visual = await visualDelta(cdp, anchor);
  const writes = await writesSince(cdp, from);
  return {
    ...arrival,
    composerGrowth: {
      barPx,
      composer,
      positioned: pick(positioned),
      settled: pick(settled),
      visual,
      moved: r1(settled.scrollTop - positioned.scrollTop),
      scrollHeightDelta: settled.scrollHeight - positioned.scrollHeight,
      writes: writes.map(brief),
    },
  };
}

// Diagnostic: does growLastRow actually grow the mounted row and the sizer?
async function scenarioGrowthDiag(cdp) {
  await cdp.eval("window.__probe.reset()");
  await cdp.eval("window.__probe.stickToBottom()");
  await sleep(300);
  const before = await cdp.eval("window.__probe.lastRowDiag()");
  await cdp.eval("window.__probe.growLastRow(900)");
  await sleep(900);
  const after = await cdp.eval("window.__probe.lastRowDiag()");
  const writes = await writesSince(cdp, 0);
  return { before, after, writes: writes.map(brief) };
}

function formatWrites(writes) {
  return writes.map((w) => `${w.who}:${w.kind}(${w.from}->${w.to})`).join(" ") || "none";
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const cdp = await connect();
  await loadPage(cdp, PAGE_URL);
  const info = await cdp.eval("window.__probe.info()");
  const results = { url: PAGE_URL, info, scenarios: {} };
  if (SCENARIO === "diag") {
    results.scenarios.growthDiag = await scenarioGrowthDiag(cdp);
    console.log(JSON.stringify(results.scenarios.growthDiag, null, 2));
  }
  if (SCENARIO === "approve") {
    results.scenarios.approveGap120 = await scenarioApprovalArrive(cdp, 120);
    results.scenarios.approveGap400 = await scenarioApprovalArrive(cdp, 400);
    results.scenarios.approveFollowing = await scenarioApprovalArrive(cdp, null);
  }
  if (SCENARIO === "arrive") {
    results.scenarios.arriveGap120 = await scenarioAskArrive(cdp, 120);
    results.scenarios.arriveGap400 = await scenarioAskArrive(cdp, 400);
    results.scenarios.arriveFollowing = await scenarioAskArrive(cdp, null);
  }
  if (SCENARIO === "ask") {
    results.scenarios.askScrollUp = await scenarioAskScrollUp(cdp);
    results.scenarios.askScrollDown = await scenarioAskScrollDown(cdp);
    results.scenarios.askHold120 = await scenarioAskHold(cdp, 120);
    results.scenarios.askHold400 = await scenarioAskHold(cdp, 400);
  }
  if (SCENARIO === "wheel" || SCENARIO === "all") {
    results.scenarios.wheelToBottom = await scenarioWheelToBottom(cdp);
  }
  if (SCENARIO === "growth" || SCENARIO === "all") {
    results.scenarios.growthGap100 = await scenarioDetachedGrowth(cdp, 100);
    results.scenarios.growthGap400 = await scenarioDetachedGrowth(cdp, 400);
  }
  if (SCENARIO === "append" || SCENARIO === "all") {
    results.scenarios.appendGap100 = await scenarioAppendTurn(cdp, 100);
    results.scenarios.appendGap400 = await scenarioAppendTurn(cdp, 400);
  }
  results.console = cdp.consoleLog;
  const outPath = join(OUT_DIR, `result-${SCENARIO}-${Date.now()}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));

  console.log(`probe info: ${JSON.stringify(info)}`);
  const wheelResult = results.scenarios.wheelToBottom;
  if (wheelResult) {
    console.log(
      `wheel: start gap=${wheelResult.start.gap} following=${wheelResult.start.following}; detached gap=${wheelResult.detached.gap} following=${wheelResult.detached.following}; steps=${wheelResult.steps.length}`,
    );
    for (const step of wheelResult.steps) {
      const tag = step.jump ? "JUMP" : "    ";
      console.log(
        `${tag} #${String(step.i).padStart(3)} gap ${String(step.before.gap).padStart(6)} -> ${String(step.after.gap).padStart(6)}  delta ${String(step.delta).padStart(7)}  visual ${String(step.visual).padStart(7)}  following ${step.before.following}->${step.after.following}  ${formatWrites(step.writes)}`,
      );
    }
  }
  const askUp = results.scenarios.askScrollUp;
  if (askUp) {
    console.log(
      `askScrollUp: start gap=${askUp.start.gap} following=${askUp.start.following} lastRowHeight=${askUp.start.lastRowHeight}`,
    );
    for (const step of askUp.steps) {
      const tag = step.unexpected ? "MOVE" : "    ";
      console.log(
        `${tag} #${String(step.i).padStart(3)} gap ${String(step.before.gap).padStart(6)} -> ${String(step.after.gap).padStart(6)}  delta ${String(step.delta).padStart(7)}  visual ${String(step.visual).padStart(7)}  following ${step.before.following}->${step.after.following}  ${formatWrites(step.writes)}${step.rowChanges.length ? `  rows: ${step.rowChanges.join(" ")}` : ""}`,
      );
    }
  }
  for (const key of [
    "arriveGap120",
    "arriveGap400",
    "arriveFollowing",
    "approveGap120",
    "approveGap400",
    "approveFollowing",
  ]) {
    const arrive = results.scenarios[key];
    if (!arrive) continue;
    console.log(
      `${key}: parked gap=${arrive.positioned.gap} following=${arrive.positioned.following} -> tool_call arrives: scrollTop moved ${arrive.moved}px, VISUAL ${arrive.visual}px (scrollHeight +${arrive.scrollHeightDelta}) final gap=${arrive.settled.gap} following=${arrive.settled.following} writes=${formatWrites(arrive.writes)} rows: ${arrive.rowChanges.join(" ") || "none"}`,
    );
    const growth = arrive.composerGrowth;
    if (growth) {
      console.log(
        `${key} + composer grows ${growth.barPx}px: scrollTop moved ${growth.moved}px, VISUAL ${growth.visual}px (scrollHeight +${growth.scrollHeightDelta}) gap ${growth.positioned.gap}->${growth.settled.gap} following ${growth.positioned.following}->${growth.settled.following} writes=${formatWrites(growth.writes)}`,
      );
    }
  }
  const askDown = results.scenarios.askScrollDown;
  if (askDown) {
    console.log(`askScrollDown: steps=${askDown.steps.length}`);
    for (const step of askDown.steps) {
      const tag = step.jump ? "JUMP" : "    ";
      console.log(
        `${tag} #${String(step.i).padStart(3)} gap ${String(step.before.gap).padStart(6)} -> ${String(step.after.gap).padStart(6)}  delta ${String(step.delta).padStart(7)}  visual ${String(step.visual).padStart(7)}  following ${step.before.following}->${step.after.following}  ${formatWrites(step.writes)}`,
      );
    }
  }
  for (const key of ["askHold120", "askHold400"]) {
    const hold = results.scenarios[key];
    if (!hold) continue;
    console.log(
      `${key}: parked gap=${hold.positioned.gap} following=${hold.positioned.following} rowH=${hold.positioned.lastRowHeight} -> after 4s moved ${hold.moved}px, gaps=[${hold.samples.map((s) => s.gap).join(",")}] rowH=[${hold.samples.map((s) => s.lastRowHeight).join(",")}] writes=${formatWrites(hold.writes)}`,
    );
  }
  for (const key of ["growthGap100", "growthGap400", "appendGap100", "appendGap400"]) {
    const growth = results.scenarios[key];
    if (!growth) continue;
    console.log(
      `${key}: detached=${!growth.afterDetach.following} parkedGap=${growth.positioned.gap} following=${growth.positioned.following} -> after change scrollTop moved ${growth.moved}px, VISUAL ${growth.visual ?? "n/a"}px (scrollHeight +${growth.scrollHeightDelta}) gap=${growth.grown.gap} following=${growth.grown.following} writes=${formatWrites(growth.writes)}`,
    );
  }
  if (results.console.length) {
    console.log(`console (${results.console.length}):`);
    for (const entry of results.console.slice(0, 12)) console.log(`  [${entry.type}] ${entry.text}`);
  }
  console.log(`written: ${outPath}`);
  cdp.ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
