import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";

import { CdpClient, findTargets } from "./session-sync-cdp.mjs";

const delay = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(probe, description, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await delay(50);
  }
  throw new Error(`${description} timed out; last=${JSON.stringify(last)}`);
}

const options = Object.fromEntries(process.argv.slice(2).reduce((pairs, key, index, args) =>
  index % 2 === 0 ? [...pairs, [key.replace(/^--/, ""), args[index + 1]]] : pairs, []));
if (!options.output || !options.binary || !options.gateway) {
  throw new Error("--output, --binary and --gateway are required");
}
const root = resolve(options.output);
const binary = resolve(options.binary);
const gatewayBinary = resolve(options.gateway);
const backendPort = Number(options.backendPort ?? 47441);
const proxyPort = Number(options.proxyPort ?? 47442);
const gatewayPort = Number(options.gatewayPort ?? 47443);
const cdpPort = Number(options.cdpPort ?? 9441);
const backendURL = `http://127.0.0.1:${backendPort}`;
const gatewayURL = `http://127.0.0.1:${gatewayPort}`;
const backendToken = randomUUID();
const gatewayToken = randomUUID();
const children = new Set();
const peers = [];
const browserClients = [];
const results = [];
const counters = { requests: {}, activeChanges: 0, maxActiveChanges: 0 };
let backend;
let gateway;
let capabilityOverride = options.capability === undefined ? undefined : Number(options.capability);
let denyBackend = false;
let proxy;
let wire;

await mkdir(root, { recursive: false });
await mkdir(resolve(root, "data"));
await mkdir(resolve(root, "work-a"));
await mkdir(resolve(root, "work-b"));
const configPath = resolve(root, "config.json");
await writeFile(configPath, JSON.stringify({ defaultModel: "fixture-model", providers: {
  fixture: { api: "openai-completions", apiKey: "fixture-key", baseUrl: "http://127.0.0.1:1/v1",
    models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }] },
} }));

function launch(name, executable, args, env = {}) {
  const child = spawn(executable, args, {
    windowsHide: true, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  const record = (chunk) => { output = (output + chunk.toString()).slice(-50_000); };
  child.stdout.on("data", record);
  child.stderr.on("data", record);
  child.logs = () => output.replaceAll(backendToken, "[backend-token]").replaceAll(gatewayToken, "[gateway-token]");
  child.label = name;
  return child;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  await until(() => child.exitCode !== null || child.signalCode !== null, `${child.label} exit`, 5000).catch(() => {});
}

async function startBackend() {
  backend = launch("backend", binary, ["backend", "-listen", `127.0.0.1:${backendPort}`, "-token", backendToken,
    "-config", configPath, "-data-dir", resolve(root, "data")], { LIVEAGENT_HOME: resolve(root, "data"), K_BRAIN_HOME: "" });
  await until(async () => {
    if (backend.exitCode !== null) throw new Error(`backend exited: ${backend.logs()}`);
    try { return (await fetch(`${backendURL}/v1/health`, { headers: { Authorization: `Bearer ${backendToken}` } })).ok; }
    catch { return false; }
  }, "backend readiness");
}

async function backendRequest(path, method = "GET", body) {
  const response = await fetch(`${backendURL}${path}`, {
    method, headers: { Authorization: `Bearer ${backendToken}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`backend ${method} ${path}: ${response.status} ${raw}`);
  return raw ? JSON.parse(raw) : undefined;
}

async function startGateway() {
  gateway = launch("gateway", gatewayBinary, ["-http-addr", `127.0.0.1:${gatewayPort}`, "-agent-db", resolve(root, "gateway.sqlite"),
    "-kbrain-url", `http://127.0.0.1:${proxyPort}`, "-kbrain-agent-id", "relay-test", "-request-timeout", "5s",
    "-kbrain-provider", "fixture", "-kbrain-model", "fixture-model"],
  { LIVEAGENT_GATEWAY_TOKEN: gatewayToken, LIVEAGENT_GATEWAY_KBRAIN_TOKEN: backendToken });
  await until(async () => {
    if (gateway.exitCode !== null) throw new Error(`gateway exited: ${gateway.logs()}`);
    try { return (await fetch(gatewayURL)).ok; } catch { return false; }
  }, "gateway readiness");
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.pending = new Map();
    this.events = [];
    this.projection = new Map();
    this.generation = "";
    this.seq = 0;
    socket.binaryType = "arraybuffer";
    socket.onmessage = (event) => {
      const frame = wire.decodeServerFrameBinary(event.data);
      const decoded = wire.decodeServerFrame(frame, { agentOnline: true });
      if (!decoded) return;
      if (decoded.kind === "ping") return socket.send(wire.encodePongFrame(decoded.timestamp));
      if (decoded.kind === "event") {
        if (this.events.length >= 3000) this.events.shift();
        this.events.push(decoded);
        if (decoded.type === "history.sync_status") this.status = decoded.payload;
        if (decoded.type === "history.event" && decoded.payload.generation === this.generation) {
          const value = decoded.payload;
          this.seq = value.delivery_seq;
          if (value.kind === "delete") this.projection.delete(value.conversation_id);
          else this.projection.set(value.conversation_id, value.conversation);
        }
      }
      if (decoded.requestId && this.pending.has(decoded.requestId)) {
        const { done, fail, timer } = this.pending.get(decoded.requestId);
        clearTimeout(timer);
        this.pending.delete(decoded.requestId);
        if (decoded.kind === "error" || (decoded.kind === "hello" && !decoded.ok)) fail(new Error(decoded.message));
        else done(decoded.payload ?? decoded);
      }
    };
  }
  async request(type, input = {}) {
    const id = randomUUID();
    const promise = new Promise((done, fail) => {
      const timer = setTimeout(() => { this.pending.delete(id); fail(new Error(`${type} timed out`)); }, 10_000);
      this.pending.set(id, { done, fail, timer });
    });
    this.socket.send(type === "hello" ? wire.encodeHelloFrame(id, gatewayToken) : wire.encodeRequestFrame(id, type, input, "relay-test"));
    return promise;
  }
  async recover() {
    const snapshot = await this.request("history.resync", { resync_token: this.status?.resync_token ?? "", limit: 500 });
    this.projection = new Map(snapshot.conversations.map((value) => [value.id, value]));
    this.generation = snapshot.generation;
    this.seq = snapshot.cut_delivery_seq;
    await this.request("history.resync_ack", {
      source_id: snapshot.source_id, generation: snapshot.generation,
      resync_token: snapshot.resync_token, applied_delivery_seq: snapshot.cut_delivery_seq,
    });
    return snapshot;
  }
  close() { this.socket.close(); }
  static async connect() {
    const socket = new WebSocket(`${gatewayURL.replace("http", "ws")}/ws/v2`, "liveagent.v2.pb");
    await new Promise((done, fail) => { socket.onopen = done; socket.onerror = fail; });
    const peer = new Peer(socket);
    peers.push(peer);
    await peer.request("hello");
    return peer;
  }
}

async function check(name, action) {
  const start = Date.now();
  try {
    const details = await action();
    results.push({ name, passed: true, elapsedMs: Date.now() - start, ...(details ? { details } : {}) });
    console.log(JSON.stringify({ name, passed: true, elapsedMs: Date.now() - start }));
  } catch (error) {
    results.push({ name, passed: false, elapsedMs: Date.now() - start, error: error.message });
    console.log(JSON.stringify({ name, passed: false, error: error.message }));
  }
  await writeFile(resolve(root, "results.json"), JSON.stringify({ results, counters }, null, 2));
}

async function assertProjected(peersToCheck, id, matches, description, timeout = 3000) {
  await until(() => peersToCheck.every((peer) => matches(peer.projection.get(id))), description, timeout);
}

async function rowMenu(client, id, text) {
  await client.request("Page.bringToFront");
  await client.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.innerText.trim() === '取消')?.click(); true`);
  await until(() => client.evaluate(`(() => {
    const row = document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(id)}) + ']');
    const trigger = row?.querySelector('[aria-haspopup="menu"]');
    return !!row && (!trigger || !trigger.disabled);
  })()`), "previous row mutation settled");
  const dropdownOpened = await client.evaluate(`(() => {
    const row = document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(id)}) + ']');
    const trigger = row?.querySelector('[aria-haspopup="menu"]');
    if (!trigger || trigger.disabled) return false;
    trigger.click();
    return true;
  })()`);
  const point = await client.evaluate(`(() => {
    const row = document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(id)}) + ']');
    if (!row) return null;
    const button = row.querySelector('button');
    const bounds = button.getBoundingClientRect();
    return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  })()`);
  assert.ok(point, `row ${id} must be visible for menu interaction`);
  if (!dropdownOpened) await client.evaluate(`(() => {
    const row = document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(id)}) + ']');
    row?.querySelector('button')?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: ${point.x}, clientY: ${point.y}, button: 2,
    }));
    return true;
  })()`);
  try {
    await until(() => client.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => item.innerText.trim() === ${JSON.stringify(text)} && item.getAttribute('aria-disabled') !== 'true' && !item.hasAttribute('data-disabled'))`), `enabled menu ${text}`);
  } catch (error) {
    await writeFile(resolve(root, `menu-${text}-diagnostic.json`), JSON.stringify(await client.evaluate(`({
      body: document.body.innerText, width: innerWidth,
      menuitems: Array.from(document.querySelectorAll('[role="menuitem"]')).map(item => item.innerText),
      row: document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(id)}) + ']')?.outerHTML
    })`), null, 2));
    throw error;
  }
  await client.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.innerText.trim() === ${JSON.stringify(text)}).click(); true`);
}

try {
  const bundlePath = resolve(root, "gateway-wire.mjs");
  await build({ entryPoints: [resolve("crates/agent-gateway/web/src/lib/gatewaySocketV2/adapters.ts")],
    bundle: true, platform: "node", format: "esm", outfile: bundlePath,
    tsconfig: resolve("crates/agent-gateway/web/tsconfig.json"), logLevel: "silent" });
  wire = await import(pathToFileURL(bundlePath).href);
  await startBackend();
  const initial = await backendRequest("/v1/sessions", "POST", {
    title: "relay-initial", cwd: resolve(root, "work-a").replaceAll("\\", "/"),
    model: { provider: "fixture", model: "fixture-model" },
    messages: [{ role: "user", content: [{ type: "text", text: "relay fixture message" }] }],
  });
  proxy = createServer((request, response) => {
    const path = new URL(request.url, "http://proxy.invalid").pathname;
    counters.requests[`${request.method} ${path}`] = (counters.requests[`${request.method} ${path}`] ?? 0) + 1;
    const isChanges = path === "/v1/sessions/changes";
    if (isChanges) {
      counters.activeChanges += 1;
      counters.maxActiveChanges = Math.max(counters.maxActiveChanges, counters.activeChanges);
      response.once("close", () => { counters.activeChanges -= 1; });
    }
    if (denyBackend) { response.writeHead(401); response.end('{"error":"injected unauthorized"}'); return; }
    const upstream = httpRequest(`${backendURL}${request.url}`, { method: request.method, headers: request.headers }, (source) => {
      if (path === "/v1/health" && capabilityOverride !== undefined) {
        let raw = "";
        source.on("data", (data) => { raw += data; });
        source.on("end", () => {
          const body = JSON.parse(raw);
          body.capabilities = { ...body.capabilities, session_changes: capabilityOverride };
          response.writeHead(source.statusCode, { "Content-Type": "application/json" }); response.end(JSON.stringify(body));
        });
      } else { response.writeHead(source.statusCode, source.headers); source.pipe(response); }
    });
    upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end(); });
    response.once("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((done) => proxy.listen(proxyPort, "127.0.0.1", done));
  await startGateway();
  const pair = [await Peer.connect(), await Peer.connect()];
  if (options.legacy === "true") {
    await check("legacy or incomplete capability keeps unary lists without enabling history v2", async () => {
      for (const peer of pair) {
        const page = await peer.request("history.list", { page: 1, page_size: 80 });
        assert.equal(page.conversations.length, 1);
        assert.equal(page.conversations[0].id, initial.id);
      }
      assert.equal(counters.requests["POST /v1/sessions/snapshots"] ?? 0, 0);
      assert.equal(counters.requests["GET /v1/sessions/changes"] ?? 0, 0);
      await assert.rejects(pair[0].recover(), /unavailable|not available|not ready|synchron|stale history resync/i);
    });
    await check("legacy Relay metadata mutations remain visible to both list consumers", async () => {
      await pair[0].request("history.rename", { conversation_id: initial.id, title: "relay-legacy-renamed" });
      for (const pinned of [true, false]) {
        await pair[0].request("history.pin", { conversation_id: initial.id, is_pinned: pinned });
        for (const peer of pair) {
          const page = await peer.request("history.list", { page: 1, page_size: 80 });
          assert.equal(page.conversations[0].title, "relay-legacy-renamed");
          assert.equal(page.conversations[0].is_pinned, pinned);
        }
      }
      const movedCwd = resolve(root, "work-b").replaceAll("\\", "/");
      await pair[0].request("history.set_cwd", { conversation_id: initial.id, cwd: movedCwd });
      for (const peer of pair) {
        assert.equal((await peer.request("history.list", { page: 1, page_size: 80 })).conversations[0].cwd.replaceAll("\\", "/"), movedCwd);
      }
    });
    await check("legacy Relay delete persists and does not claim a healthy v2 producer", async () => {
      await pair[0].request("history.delete", { conversation_id: initial.id });
      for (const peer of pair) {
        assert.equal((await peer.request("history.list", { page: 1, page_size: 80 })).conversations.length, 0);
        assert.ok(!peer.status?.available);
      }
    });
  } else {
  await check("new Gateway direct Relay initial snapshot and two authenticated real WebSockets", async () => {
    for (const peer of pair) {
      await until(async () => {
        try { const snapshot = await peer.recover(); assert.equal(snapshot.conversations.length, 1); return true; }
        catch { return false; }
      }, "initial Relay snapshot");
    }
    await assertProjected(pair, initial.id, (value) => value?.title === "relay-initial", "initial projection");
    assert.equal(counters.maxActiveChanges, 1);
    return { backendSessions: 1, webSockets: 2, maxConcurrentChangesRequests: counters.maxActiveChanges };
  });
  await check("Relay rename broadcasts one ordered change to both WebSocket clients", async () => {
    await pair[0].request("history.rename", { conversation_id: initial.id, title: "relay-renamed" });
    await assertProjected(pair, initial.id, (value) => value?.title === "relay-renamed", "rename fanout");
  });
  for (const pinned of [true, false]) await check(`Relay pin=${pinned} broadcasts to both clients`, async () => {
    await pair[0].request("history.pin", { conversation_id: initial.id, is_pinned: pinned });
    await assertProjected(pair, initial.id, (value) => value?.is_pinned === pinned, "pin fanout");
  });
  await check("Relay get opens saved session with real message content", async () => {
    const history = await pair[0].request("history.get", { conversation_id: initial.id, max_messages: 20 });
    assert.ok(JSON.stringify(history).includes("relay fixture message"));
  });
  await check("Relay set_cwd supports moving between workdirs", async () => {
    const cwd = resolve(root, "work-b").replaceAll("\\", "/");
    await pair[0].request("history.set_cwd", { conversation_id: initial.id, cwd });
    await assertProjected(pair, initial.id, (value) => value?.cwd?.replaceAll("\\", "/") === cwd, "move fanout");
  });
  await check("Relay reports invalid cwd and retains the authoritative workdir", async () => {
    await assert.rejects(pair[0].request("history.set_cwd", { conversation_id: initial.id, cwd: "" }), /400|absolute|directory/i);
    const snapshot = await pair[0].recover();
    assert.equal(snapshot.workdirs.length, 1);
    assert.equal(snapshot.workdirs[0].conversationCount, 1);
  });
  await check("backend token rejection invalidates Relay and restores authority after credentials recover", async () => {
    const previousGeneration = pair[0].generation;
    denyBackend = true;
    try {
      await backendRequest(`/v1/sessions/${initial.id}`, "PATCH", { title: "relay-after-auth-recovery" });
      await until(() => pair.every((peer) => peer.status?.available === false), "permission failure must invalidate synchronization", 10_000);
      await assert.rejects(pair[0].request("history.list", { page: 1, page_size: 80 }), /401|unauthorized/i);
    } finally {
      denyBackend = false;
    }
    await until(() => pair.every((peer) => peer.status?.available && peer.status.generation !== previousGeneration), "authenticated Relay recovery", 10_000);
    for (const peer of pair) await peer.recover();
    await assertProjected(pair, initial.id, (value) => value?.title === "relay-after-auth-recovery", "latest title after auth recovery");
  });
  await check("Relay delete removes the authority and both clients without polling lists", async () => {
    await pair[0].request("history.delete", { conversation_id: initial.id });
    await assertProjected(pair, initial.id, (value) => value === undefined, "delete fanout");
    const third = await Peer.connect();
    assert.equal((await third.recover()).conversations.length, 0, "new browser cannot recover a deleted ghost");
  });
  await check("K-brain process restart changes epoch and Relay recovers current authority", async () => {
    const oldGeneration = pair[0].generation;
    await stop(backend);
    await startBackend();
    await until(() => pair.every((peer) => peer.status?.available && peer.status.generation !== oldGeneration), "Relay epoch recovery", 20_000);
    for (const peer of pair) assert.equal((await peer.recover()).conversations.length, 0);
  });
  }
  if (options.browser === "true") {
    const createBrowserSession = async () => {
      const item = await backendRequest("/v1/sessions", "POST", {
        title: "relay-browser-visible", cwd: resolve(root, "work-a").replaceAll("\\", "/"),
        model: { provider: "fixture", model: "fixture-model" },
        messages: [{ role: "user", content: [{ type: "text", text: "browser fixture" }] }],
      });
      await backendRequest(`/v1/sessions/${item.id}`, "PATCH", { pinned: true });
      return item;
    };
    let browserItem = options.legacy === "true" ? await createBrowserSession() : undefined;
    const edge = launch("edge", options.edge ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--no-first-run",
      `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${resolve(root, "browser")}`, gatewayURL,
    ]);
    await until(async () => { try { return (await findTargets(cdpPort, gatewayURL)).length >= 1; } catch { return false; } }, "browser target");
    const first = await CdpClient.connect((await findTargets(cdpPort, gatewayURL))[0].webSocketDebuggerUrl);
    await first.request("Target.createTarget", { url: gatewayURL });
    first.close();
    await until(async () => (await findTargets(cdpPort, gatewayURL)).length >= 2, "second browser target");
    for (const target of (await findTargets(cdpPort, gatewayURL)).slice(0, 2)) {
      const client = await CdpClient.connect(target.webSocketDebuggerUrl);
      browserClients.push(client);
      await client.request("Emulation.setDeviceMetricsOverride", {
        width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
      });
      await until(async () => {
        try { return await client.evaluate(`location.origin === ${JSON.stringify(gatewayURL)} && Boolean(localStorage)`); }
        catch { return false; }
      }, "WebUI same-origin document");
      await client.evaluate(`localStorage.setItem('liveagent.gateway.token', ${JSON.stringify(gatewayToken)}); location.reload(); true`);
    }
    await check("two actual direct Relay WebUI pages display a new backend session", async () => {
      browserItem ??= await createBrowserSession();
      for (const client of browserClients) {
        await client.request("Page.bringToFront");
        await until(() => client.evaluate(`Boolean(document.querySelector('button[aria-label="打开边栏"], [data-sidebar="sidebar"]')) || /Live Agent/.test(document.body.innerText)`), "WebUI login and sidebar control");
        const activeAgent = await client.evaluate("localStorage.getItem('liveagent.gateway.activeAgent')");
        if (activeAgent !== "relay-test") {
          await client.evaluate(`Array.from(document.querySelectorAll('button')).find(button => /在线|离线/.test(button.innerText))?.click(); true`);
          await until(() => client.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(item => /K-brain|relay-test/.test(item.innerText))`), "Relay target selection");
          await client.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => /K-brain|relay-test/.test(item.innerText)).click(); true`);
        }
        await until(() => client.evaluate(`localStorage.getItem('liveagent.gateway.activeAgent') === 'relay-test'`), "selected Relay target");
        await client.evaluate(`document.querySelector('button[aria-label="打开边栏"]')?.click(); true`);
        try {
          await until(() => client.evaluate(`document.body.innerText.includes('relay-browser-visible')`), "real WebUI row", 15_000);
        } finally {
          await writeFile(resolve(root, `browser-${browserClients.indexOf(client)}-body.txt`),
            await client.evaluate("document.body.innerText"));
          await client.screenshot(resolve(root, `browser-${browserClients.indexOf(client)}.png`));
        }
      }
      return { id: browserItem.id, browserPages: browserClients.length, processId: edge.pid };
    });
    if (options.legacy !== "true") {
      await check("actual WebUI context-menu rename converges without an error alert", async () => {
        const client = browserClients[0];
        await rowMenu(client, browserItem.id, "修改标题");
        await until(() => client.evaluate("Boolean(document.querySelector('input[aria-label=\"重命名聊天\"]'))"), "rename dialog input");
        await client.evaluate(`(() => {
          const input = document.querySelector('input[aria-label="重命名聊天"]');
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'relay-menu-renamed');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
          return true;
        })()`);
        await client.evaluate(`Array.from(document.querySelectorAll('[role="dialog"] button')).find(button => button.innerText.trim() === '保存').click(); true`);
        await until(async () => (await backendRequest(`/v1/sessions/${browserItem.id}`)).title === "relay-menu-renamed", "menu rename persisted");
        for (const other of browserClients) {
          await other.request("Page.bringToFront");
          await until(() => other.evaluate("document.body.innerText.includes('relay-menu-renamed')"), "menu rename visible");
          assert.equal(await other.evaluate("document.querySelectorAll('[role=alert]').length"), 0);
        }
      });
      await check("actual WebUI unpin and pin menus preserve the session and synchronize metadata", async () => {
        const client = browserClients[0];
        await writeFile(resolve(root, "pre-unpin.json"), JSON.stringify({
          backend: await backendRequest(`/v1/sessions/${browserItem.id}`),
          dom: await client.evaluate(`({row:document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(browserItem.id)}) + ']')?.outerHTML,body:document.body.innerText})`),
        }, null, 2));
        await rowMenu(client, browserItem.id, "取消置顶");
        await until(async () => (await backendRequest(`/v1/sessions/${browserItem.id}`)).pinned !== true, "menu unpin persisted");
        await client.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.innerText.trim() === 'work-a' && button.getAttribute('aria-expanded') === 'false')?.click(); true`);
        await until(() => client.evaluate(`Boolean(document.querySelector('[data-conversation-id=' + CSS.escape(${JSON.stringify(browserItem.id)}) + ']'))`), "unpinned workspace session");
        await rowMenu(client, browserItem.id, "置顶对话");
        await until(async () => (await backendRequest(`/v1/sessions/${browserItem.id}`)).pinned === true, "menu pin persisted");
      });
      await check("actual WebUI deletion confirmation removes the row in both pages", async () => {
        const client = browserClients[0];
        await rowMenu(client, browserItem.id, "删除对话");
        await until(() => client.evaluate(`Array.from(document.querySelectorAll('button')).some(button => button.innerText.trim() === '删除')`), "delete confirmation");
        await client.evaluate(`Array.from(document.querySelectorAll('button')).find(button => button.innerText.trim() === '删除').click(); true`);
        for (const other of browserClients) {
          await other.request("Page.bringToFront");
          await until(() => other.evaluate("!document.body.innerText.includes('relay-menu-renamed')"), "deleted row gone");
          assert.equal(await other.evaluate("document.querySelectorAll('[role=alert]').length"), 0);
        }
      });
    }
  }
} finally {
  for (const peer of peers) peer.close();
  for (const client of browserClients) client.close();
  for (const child of [...children].reverse()) {
    await stop(child);
    await writeFile(resolve(root, `${child.label}-${child.pid}.log`), child.logs());
  }
  if (proxy) { proxy.closeAllConnections(); await new Promise((done) => proxy.close(done)); }
  const hash = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
  await writeFile(resolve(root, "manifest.json"), JSON.stringify({
    generatedAt: new Date().toISOString(), binary, backendSha256: await hash(binary),
    gatewayBinary, gatewaySha256: await hash(gatewayBinary), results,
    counters, peerStatus: peers.map((peer) => ({ generation: peer.generation, seq: peer.seq,
      status: peer.status, eventCounts: Object.fromEntries([...new Set(peer.events.map((event) => event.type))]
        .map((type) => [type, peer.events.filter((event) => event.type === type).length])) })),
    ports: { backendPort, proxyPort, gatewayPort, cdpPort },
  }, null, 2));
}
if (results.some((value) => !value.passed)) process.exitCode = 1;
