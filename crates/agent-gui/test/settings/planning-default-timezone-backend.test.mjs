import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("fresh real backend defaults to automatic across browser reads and backend restarts without overwriting custom zones", { timeout: 180_000 }, async (t) => {
  const binary = await getKBrainBinary();
  const directory = await mkdtemp(path.join(tmpdir(), "planning-default-zone-"));
  const config = path.join(directory, "config.json");
  let stop;
  t.after(async () => {
    try { await stop?.(); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  await writeFile(config, JSON.stringify({ defaultModel: "fixture", providers: { fixture: {
    api: "openai-completions", baseUrl: "http://127.0.0.1:1", apiKey: "fixture",
    models: [{ id: "fixture", contextWindow: 4096, maxTokens: 256 }],
  } } }));

  async function start(zone) {
    const child = spawn(binary, ["backend", "-listen", "127.0.0.1:0", "-parent-stdio",
      "-config", config, "-session-dir", path.join(directory, "sessions")], {
      cwd: directory, env: { ...process.env, TZ: zone, LIVEAGENT_HOME: directory }, stdio: ["pipe", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    stop = async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try { assert.equal((await closed)[0], 0); } finally { clearTimeout(timer); }
      stop = undefined;
    };
    let output = "";
    child.stderr.on("data", data => { output += data; });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`backend startup timeout: ${output}`)), 20_000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", code => { clearTimeout(timer); reject(new Error(`backend exited ${code}: ${output}`)); });
      child.stdout.on("data", data => {
        output += data;
        const match = output.match(/k-brain backend listening on (http:\/\/127\.0\.0\.1:\d+)/);
        if (match) { clearTimeout(timer); resolve(match[1]); }
      });
    });
  }

  const loader = createTsModuleLoader();
  const runtime = loader.loadModule("src/lib/kbrain/runtimeConnection.ts");
  const { requestPlanning } = loader.loadModule("src/lib/planning/kbrain.ts");
  const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let baseUrl;
  async function connect(zone) {
    baseUrl = await start(zone);
    runtime.setKBrainRuntimeConnection({ baseUrl, token: "", protocolVersion: "kbrain.agent.v1" });
  }
  const raw = async () => {
    const response = await fetch(baseUrl + "/v1/planning", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "timezone.get", input: {} }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await connect("Pacific/Auckland");
  assert.equal((await raw()).preference, "");
  assert.equal((await raw()).timeZone, "Pacific/Auckland");
  assert.equal((await requestPlanning("timezone.get")).preference, "");
  assert.equal((await requestPlanning("query")).timeZone, device);
  assert.equal((await raw()).timeZone, "Pacific/Auckland", "browser reads never write shared preference");
  await stop();
  await connect("America/New_York");
  assert.equal((await raw()).preference, "");
  assert.equal((await raw()).timeZone, "America/New_York");
  assert.equal((await requestPlanning("query")).timeZone, device);
  await requestPlanning("timezone", { preference: "Europe/Paris" });
  await stop();
  await connect("Asia/Tokyo");
  const custom = await requestPlanning("timezone.get");
  assert.equal(custom.preference, "Europe/Paris");
  assert.equal(custom.timeZone, "Europe/Paris");
  assert.equal((await requestPlanning("query")).timeZone, "Europe/Paris");
});
