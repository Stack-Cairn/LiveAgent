import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const low = { risk: "low", sandbox: "low", sensitive_data: "low", model_behavior: "low", injection: "low", reason: "Fixture workspace operation" };

test("LiveAgent modes authorize actual K-brain tools and return approval events", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "permission-modes-"));
  const home = path.join(root, "home");
  const workdir = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workdir);
  let current;
  let reviews = 0;
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) {
      if (body.model === "review-model") reviews++;
      const content = body.model === "review-model" ? JSON.stringify(current.review) : "[]";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }));
      return;
    }
    const toolNames = (body.tools ?? []).map(tool => tool.function.name);
    const invoked = body.messages.some(message => message.role === "assistant" && message.tool_calls?.length);
    const call = { index: 0, id: "fixture-tool", type: "function", function: { name: current.tool, arguments: JSON.stringify(current.args) } };
    const delta = invoked || !toolNames.includes(current.tool) ? { content: "done" } : { tool_calls: [call] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = path.join(home, "config.json");
  await writeFile(config, JSON.stringify({
    defaultModel: "fixture-model",
    aiApproval: { mode: "off", provider: "fixture", model: "review-model" },
    providers: { fixture: { api: "openai-completions", apiKey: "fixture-key", baseUrl: `http://127.0.0.1:${upstream.address().port}`, models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }, { id: "review-model", contextWindow: 32768, maxTokens: 256 }] } },
  }));
  child = spawn(await getKBrainBinary(), ["backend", "-listen", "127.0.0.1:0", "-token", "modes-token", "-config", config, "-session-dir", path.join(root, "sessions")], {
    cwd: workdir, env: { ...process.env, LIVEAGENT_HOME: home, K_BRAIN_HOME: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", data => { logs += data; });
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`backend readiness: ${logs}`)), 20_000);
    child.once("exit", code => { clearTimeout(timeout); reject(new Error(`backend exit ${code}: ${logs}`)); });
    child.stdout.on("data", data => {
      logs += data;
      const match = logs.match(/k-brain backend listening on (http:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const health = await fetch(`${baseUrl}/v1/health`, { headers: { Authorization: "Bearer modes-token" } }).then(res => res.json());
  if (!health.capabilities?.permission_modes?.includes("auto_review")) {
    t.skip("requires K-brain permission modes; set LIVEAGENT_KBRAIN_BINARY to the matching build");
    return;
  }
  const loader = createTsModuleLoader();
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client");
  const { resolveKBrainPermissionMode } = loader.loadModule("@liveagent/ui/lib/chat/permissionModes");
  const client = createKBrainClient({ baseUrl, token: "modes-token" });
  const cases = [
    { name: "confirm-reject", mode: "ask", permission: true, changed: false },
    { name: "confirm-allow", mode: "ask", decision: "allow_once", permission: true, changed: true },
    { name: "plan", mode: "always", plan: true, permission: false, changed: false },
    { name: "auto-edit", mode: "autoEdit", permission: false, changed: true },
    { name: "auto-edit-command", mode: "autoEdit", bash: true, permission: true, changed: false },
    { name: "full-access", mode: "auto", bash: true, permission: false, changed: true },
    { name: "always", mode: "always", bash: true, permission: false, changed: true },
    { name: "review-low", mode: "autoReview", permission: false, changed: true, reviewed: true },
    { name: "review-unknown", mode: "autoReview", review: { ...low, risk: "unknown" }, permission: true, changed: false, reviewed: true },
  ];
  for (const tc of cases) {
    await t.test(tc.name, async () => {
      const target = path.join(workdir, `${tc.name}.txt`);
      current = { tool: tc.bash ? "Bash" : "Write", args: tc.bash ? { command: `printf changed > '${target}'` } : { path: target, content: "changed" }, review: tc.review ?? low };
      const before = reviews;
      const session = await client.createSession({ cwd: workdir, model: { provider: "fixture", model: "fixture-model" } });
      const accepted = await client.startRun({ conversation_id: session.id, client_request_id: `modes-${tc.name}`, prompt: "Write changed to the fixture marker in this workspace", options: { mode: "agent", approval_policy: "ask", permission_mode: resolveKBrainPermissionMode(tc.mode, tc.plan), workspace_roots: [{ path: workdir, access: "write" }] } });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15_000);
      const events = [];
      const answers = [];
      try {
        await client.subscribe(session.id, 0, { onEvent(event) {
          events.push(event);
          if (event.type === "permission.requested") answers.push(client.resolvePermission(session.id, event.payload.permission_id, tc.decision ?? "reject", accepted.run_id));
          if (event.type === "run.completed" || event.type === "run.failed") controller.abort();
        }, onError(error) { throw error; } }, controller.signal).catch(error => { if (!controller.signal.aborted) throw error; });
        await Promise.all(answers);
      } finally { clearTimeout(timer); }
      assert.ok(events.some(event => event.type === "run.completed"), JSON.stringify(events));
      assert.equal(events.some(event => event.type === "permission.requested"), tc.permission);
      const content = await readFile(target, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
      assert.equal(content === "changed", tc.changed);
      assert.equal(reviews > before, Boolean(tc.reviewed));
    });
  }
});
