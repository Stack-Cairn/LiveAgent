import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 斜杠指令、会话目标与 /loop 的跨仓库验收：K-brain 进程、会话、目标续跑与 cron 都是真实的，
// 只有模型供应商是脚本化的。客户端走 LiveAgent 自己的 client.ts、goalSettle.ts 与
// gatewayComposerActions.ts，验证的是两边合起来的行为，而不是任何一边的 mock。

function textOf(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.text ?? "").join("");
}

function sse(response, content) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(
    `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n",
  );
}

async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startBackend(t) {
  const binary = await getKBrainBinary();
  const root = await mkdtemp(path.join(tmpdir(), "kbrain-composer-"));
  const home = path.join(root, "home");
  const workdir = path.join(root, "workspace");
  await mkdir(path.join(home, "prompts"), { recursive: true });
  await mkdir(workdir);
  await writeFile(
    path.join(home, "prompts", "deploy.md"),
    "---\ndescription: Deploy a target\nargument-hint: target note\n---\nDEPLOY_TEMPLATE target=[$1] all=[$ARGUMENTS]\n",
  );

  // 每次主请求从 replies 队列取一个回复；回复可以是字符串，也可以是返回字符串的 Promise（用来卡住某一轮）。
  const model = { requests: [], replies: [] };
  const upstream = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const tools = body.tools?.map((tool) => tool.function.name) ?? [];
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] }));
      return;
    }
    if (tools.includes("SubmitMemoryPlan")) {
      sse(response, "");
      return;
    }
    const user = textOf(body.messages.filter((message) => message.role === "user").at(-1));
    model.requests.push(user);
    const next = model.replies.shift() ?? "ok";
    sse(response, await next);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const config = path.join(home, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      defaultModel: "fixture-model",
      providers: {
        fixture: {
          api: "openai-completions",
          baseUrl: `http://127.0.0.1:${upstream.address().port}`,
          apiKey: "fixture-key",
          models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }],
        },
      },
    }),
  );
  let logs = "";
  const child = spawn(
    binary,
    ["backend", "-listen", "127.0.0.1:0", "-token", "composer-token", "-config", config, "-session-dir", path.join(root, "sessions")],
    { cwd: workdir, env: { ...process.env, LIVEAGENT_HOME: home, K_BRAIN_HOME: "" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stderr.on("data", (data) => {
    logs += data;
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGTERM");
      await ended;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`backend readiness timeout: ${logs}`)), 20_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`backend exited ${code}: ${logs}`));
    });
    child.stdout.on("data", (data) => {
      logs += data;
      const match = logs.match(/k-brain backend listening on (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });

  const loader = createTsModuleLoader();
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({
    baseUrl,
    token: "composer-token",
    protocolVersion: "kbrain.agent.v1",
  });
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");
  const client = createKBrainClient();
  return { client, loader, model, workdir, baseUrl, logs: () => logs };
}

async function newSession({ client, workdir, model }) {
  model.replies.length = 0;
  return client.createSession({ cwd: workdir, model: { provider: "fixture", model: "fixture-model" } });
}

async function startGoal(client, sessionId, goal, clientRequestId = randomUUID()) {
  return client.postGoal(sessionId, {
    action: "set",
    goal,
    run: { client_request_id: clientRequestId, prompt: `/goal ${goal}` },
  });
}

async function settled(client, sessionId) {
  return waitFor(async () => {
    const state = await client.getGoal(sessionId);
    return ["active", "continuing"].includes(state.status) ? null : state;
  }, "goal to settle");
}

test("LiveAgent composer commands run against the K-brain backend it depends on", { timeout: 180_000 }, async (t) => {
  const backend = await startBackend(t);
  const { client, model, workdir } = backend;

  let commands;
  try {
    commands = await client.listCommands(workdir);
  } catch (error) {
    if (error?.status === 404) {
      t.skip("pinned K-brain predates the composer command API; build K-brain with session goals and set LIVEAGENT_KBRAIN_BINARY");
      return;
    }
    throw error;
  }

  await t.test("command catalog lists backend actions, builtin prompts and user templates", () => {
    const byName = new Map(commands.map((command) => [command.name, command]));
    for (const name of ["goal", "loop", "plan", "init", "review"]) assert.ok(byName.has(name), name);
    assert.equal(byName.get("goal").kind, "action");
    assert.deepEqual(
      { kind: byName.get("deploy")?.kind, source: byName.get("deploy")?.source, hint: byName.get("deploy")?.argument_hint },
      { kind: "prompt", source: "user", hint: "target note" },
    );
  });

  await t.test("prompt commands expand on the backend and tolerate plain apostrophes", async () => {
    const session = await newSession(backend);
    const before = model.requests.length;
    const accepted = await client.startRun({
      conversation_id: session.id,
      client_request_id: randomUUID(),
      prompt: "/deploy staging don't wait",
      prompt_command: true,
    });
    assert.ok(accepted.run_id);
    await waitFor(() => model.requests.length > before, "expanded prompt request");
    const sent = model.requests.at(-1);
    assert.match(sent, /DEPLOY_TEMPLATE target=\[staging\]/);
    assert.match(sent, /don't wait/);
  });

  await t.test("a met goal is not revived by retrying the same set request", async () => {
    const session = await newSession(backend);
    const requestId = randomUUID();
    model.replies.push("GOAL_MET shipped");
    const first = await startGoal(client, session.id, "ship it", requestId);
    assert.ok(first.run?.run_id);
    const done = await settled(client, session.id);
    assert.deepEqual([done.status, done.goal], ["met", ""], "met goal is cleared");
    const calls = model.requests.length;
    const retry = await startGoal(client, session.id, "ship it", requestId);
    assert.equal(retry.run?.run_id, first.run.run_id, "retry replays the original run");
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await client.getGoal(session.id);
    assert.deepEqual([after.status, after.goal], ["met", ""], "retry must not flip the goal back to active");
    assert.equal(model.requests.length, calls, "retry must not call the model again");
  });

  await t.test("negated GOAL_MET does not complete the goal", async () => {
    const session = await newSession(backend);
    model.replies.push("Not GOAL_MET yet, tests still fail", "GOAL_MET all green");
    const before = model.requests.length;
    await startGoal(client, session.id, "make tests green");
    const done = await settled(client, session.id);
    assert.equal(done.status, "met");
    assert.equal(model.requests.length - before, 2, "the negated reply must trigger another round");
  });

  await t.test("updating the goal mid-round keeps the old reply from completing the new goal", async () => {
    const session = await newSession(backend);
    let release;
    model.replies.push(new Promise((resolve) => (release = resolve)), "GOAL_MET B is done");
    const before = model.requests.length;
    await startGoal(client, session.id, "goal A original");
    await waitFor(() => model.requests.length > before, "round 1 of goal A");
    const updated = await client.postGoal(session.id, { action: "update", goal: "goal B replacement" });
    assert.equal(updated.goal, "goal B replacement");
    release("GOAL_MET A is done");
    await waitFor(() => model.requests.length > before + 1, "a round evaluated against goal B");
    assert.match(model.requests.at(-1), /goal B replacement/);
    const done = await settled(client, session.id);
    assert.equal(done.status, "met");
  });

  await t.test("stopping a goal turn pauses the backend loop and refreshes the goal bar", async () => {
    const session = await newSession(backend);
    let release;
    model.replies.push(new Promise((resolve) => (release = resolve)));
    const before = model.requests.length;
    await startGoal(client, session.id, "long running goal");
    await waitFor(() => model.requests.length > before, "goal round");
    const { settleGoalAfterTurn } = backend.loader.loadModule("src/lib/kbrain/goalSettle.ts");
    const published = [];
    await settleGoalAfterTurn({
      client,
      conversationId: "liveagent-conversation",
      sessionId: session.id,
      stopped: true,
      publish: (conversationId, state) => published.push([conversationId, state.status]),
    });
    release("still working");
    assert.deepEqual(published, [["liveagent-conversation", "paused"]]);
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(model.requests.length, before + 1, "no round may start after the user stopped");
    assert.equal((await client.getGoal(session.id)).status, "paused");
  });

  await t.test("pause without a goal is a 409 and leaves a plain run alone", async () => {
    const session = await newSession(backend);
    let release;
    model.replies.push(new Promise((resolve) => (release = resolve)));
    const before = model.requests.length;
    await client.startRun({ conversation_id: session.id, client_request_id: randomUUID(), prompt: "plain work" });
    await waitFor(() => model.requests.length > before, "plain run");
    await assert.rejects(client.postGoal(session.id, { action: "pause" }), (error) => error.status === 409);
    release("plain done");
    await waitFor(async () => {
      const history = await client.getHistory(session.id, { maxMessages: 20 });
      return (history.session.messages ?? []).some((message) => message.role === "assistant" && textOf(message).includes("plain done"));
    }, "plain run to finish instead of being cancelled");
  });

  await t.test("WebUI loop actions round-trip through the desktop handler", async () => {
    const session = await newSession(backend);
    const { runGatewayComposerAction } = backend.loader.loadModule("src/pages/chat/gateway/gatewayComposerActions.ts");
    const deps = { client, getKBrainSessionId: () => session.id };
    const base = { conversationId: "liveagent-conversation", kind: "loop", loopId: "", cron: "", interval: "", prompt: "", reasoning: "" };
    const created = await runGatewayComposerAction(
      { ...base, action: "create", interval: "90m", prompt: "check the build" },
      deps,
    );
    assert.equal(created.loops.length, 1);
    assert.match(created.loops[0].id, /^loop-/);
    assert.equal(created.loops[0].interval, "90m");
    await waitFor(async () => {
      const history = await client.getHistory(session.id, { maxMessages: 20 });
      return (history.session.messages ?? []).some((message) => textOf(message).includes(`[Loop ${created.loops[0].id}`));
    }, "immediate detached loop result in parent history");
    const listed = await runGatewayComposerAction({ ...base, action: "list" }, deps);
    assert.deepEqual(listed.loops.map((loop) => loop.id), [created.loops[0].id]);
    await assert.rejects(
      client.createLoop(session.id, { interval: "0s", prompt: "invalid" }),
      (error) => error.status === 422,
    );
    const cancelled = await runGatewayComposerAction({ ...base, action: "cancel", loopId: created.loops[0].id }, deps);
    assert.deepEqual(cancelled.loops, []);
    assert.deepEqual(await client.listLoops(session.id), []);
  });

  await t.test("command notes are written to history without calling the model", async () => {
    const session = await newSession(backend);
    const before = model.requests.length;
    await client.recordCommandNote(session.id, "/loop list", "No loops yet.");
    assert.equal(model.requests.length, before);
    const history = await client.getHistory(session.id, { maxMessages: 20 });
    assert.deepEqual(
      (history.session.messages ?? []).map((message) => [message.role, textOf(message)]),
      [
        ["user", "/loop list"],
        ["assistant", "No loops yet."],
      ],
    );
  });
});
