import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runBenchmarkRequests } from "./session-sync-benchmark.mjs";
import { runAcpSessionList } from "./session-sync-acp.mjs";
import { CdpClient } from "./session-sync-cdp.mjs";
import { buildEdgeArguments } from "./session-sync-launch-edge.mjs";

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

test("dataset CLI writes a manifest that identifies the exact fixture", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "session-sync-cli-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const result = await run(process.execPath, [
    "scripts/testing/session-sync-generate-dataset.mjs",
    "--root",
    root,
    "--count",
    "2",
    "--bytes",
    "12000",
    "--seed",
    "cli-test",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const manifest = JSON.parse(await readFile(join(root, "session-sync-dataset.json"), "utf8"));
  assert.equal(manifest.sessionCount, 2);
  assert.equal(manifest.transcriptBytes, 12000);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/);
});

test("Windows sampler records cumulative process counters as JSON lines", async (context) => {
  if (process.platform !== "win32") return context.skip("Windows-only process counters");
  const root = await mkdtemp(join(tmpdir(), "session-sync-sample-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  const pidMap = join(root, "pids.json");
  const output = join(root, "samples.jsonl");
  await writeFile(pidMap, JSON.stringify({ roles: { harness: [process.pid] } }));
  const result = await run("pwsh", [
    "-NoProfile",
    "-NonInteractive",
    "-File",
    resolve("scripts/testing/session-sync-sample.ps1"),
    "-PidMapPath",
    pidMap,
    "-OutputPath",
    output,
    "-DurationSeconds",
    "1",
    "-IntervalMilliseconds",
    "250",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const samples = (await readFile(output, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(samples.length >= 2, true);
  assert.equal(samples[0].processes[0].role, "harness");
  assert.equal(Number.isFinite(samples[0].processes[0].readBytes), true);
  assert.equal(Number.isFinite(samples[0].processes[0].privateBytes), true);
});

test("runBenchmarkRequests records latency, status, and response shape", async (context) => {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ total_count: 248, sessions: [{ id: "one" }] }));
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  context.after(() => new Promise((resolvePromise) => server.close(resolvePromise)));
  const address = server.address();
  assert.equal(typeof address, "object");

  const rows = await runBenchmarkRequests({
    url: `http://127.0.0.1:${address.port}/v1/sessions`,
    bursts: 2,
    requestsPerBurst: 3,
    intervalMs: 1,
  });
  assert.equal(requestCount, 6);
  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((row) => [row.status, row.totalCount, row.sessionCount]),
    Array(6).fill([200, 248, 1]),
  );
  assert.equal(rows.every((row) => row.elapsedMs >= 0 && row.responseBytes > 0), true);
});

test("mock model serves deterministic OpenAI chat and model discovery responses", async (context) => {
  const child = spawn(process.execPath, [
    "scripts/testing/session-sync-mock-model.mjs",
    "--port",
    "0",
  ], { windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  context.after(() => {
    if (!child.killed) child.kill();
  });
  const line = await new Promise((resolvePromise, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error(`mock model startup timed out: ${stderr}`)), 5_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        clearTimeout(timeout);
        resolvePromise(stdout.slice(0, newline));
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`mock model exited ${code}: ${stderr}`)));
  });
  const ready = JSON.parse(line);
  const models = await fetch(`${ready.baseUrl}/models`).then((response) => response.json());
  assert.equal(models.data[0].id, "session-sync-model");
  const response = await fetch(`${ready.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "session-sync-model", stream: true, messages: [] }),
  });
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /session sync fixture response/);
  assert.match(body, /data: \[DONE\]/);
});

test("runAcpSessionList speaks ACP initialize and session/list over stdio", async (context) => {
  const fixture = join(process.cwd(), "scripts", "testing", "fixtures", "fake-acp-agent.mjs");
  const output = await runAcpSessionList({ binary: process.execPath, args: [fixture], cwd: process.cwd() });
  assert.equal(output.initialize.agentInfo.name, "fixture-agent");
  assert.deepEqual(output.sessions.map((session) => session.sessionId), ["fixture-session"]);
});

test("CdpClient evaluates expressions over the actual CDP wire protocol", async (context) => {
  const socket = {
    sent: [],
    send(data) {
      this.sent.push(data);
      const request = JSON.parse(data);
      queueMicrotask(() =>
        this.onmessage({ data: JSON.stringify({ id: request.id, result: { result: { value: { ok: true } } } }) }),
      );
    },
    close() {},
  };
  const client = new CdpClient(socket, 1_000);
  let event;
  client.on("Runtime.exceptionThrown", (params) => (event = params));
  socket.onmessage({ data: JSON.stringify({ method: "Runtime.exceptionThrown", params: { id: 4 } }) });
  assert.deepEqual(await client.evaluate("({ok:true})"), { ok: true });
  assert.equal(JSON.parse(socket.sent[0]).method, "Runtime.evaluate");
  assert.deepEqual(event, { id: 4 });
});

test("buildEdgeArguments uses one headless startup target; extra pages are created over CDP", () => {
  assert.deepEqual(buildEdgeArguments({ profile: "C:/tmp/profile", port: 9330, url: "http://x/", pages: 2 }), [
    "--headless=new",
    "--remote-debugging-port=9330",
    "--user-data-dir=C:/tmp/profile",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-sync",
    "--no-first-run",
    "http://x/",
  ]);
});
