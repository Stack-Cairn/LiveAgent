import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { getKBrainBinary } from "./kbrain-binary.mjs";

function stream(response, delta, finishReason) {
  response.setHeader("Content-Type", "text/event-stream");
  response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [], usage: {
      prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 },
    } })}\n\ndata: [DONE]\n\n`);
}

function toolCall(response, name, args, id) {
  stream(response, { tool_calls: [{ index: 0, id, type: "function", function: {
    name, arguments: JSON.stringify(args),
  } }] }, "tool_calls");
}

// The provider is scripted; sessions, Agent/tools, journal, and HTTP projections are real. This
// deliberately covers foreground child runs only; background scheduling and non-trajectory
// backend capabilities remain outside this focused test.
export async function startTrajectoryFixture(t, { includeChild = false } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "trajectory-backend-"));
  let stopBackend;
  let upstream;
  const failures = [];
  t.after(async () => {
    try {
      await stopBackend?.();
    } finally {
      try {
        if (upstream) {
          upstream.closeAllConnections();
          await new Promise((resolve) => upstream.close(resolve));
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    assert.deepEqual(failures, [], "deterministic upstream must accept every provider request");
  });
  const binary = await getKBrainBinary();
  const workspace = path.join(directory, "workspace");
  await mkdir(workspace);
  const marker = `trajectory-real-tool-output-${randomUUID()}`;
  const requests = [];
  upstream = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/chat/completions");
      assert.equal(request.headers.authorization, "Bearer fixture-key");
      let body = "";
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      const names = input.tools?.map((tool) => tool.function.name) ?? [];
      if (names.includes("SubmitMemoryPlan")) {
        toolCall(response, "SubmitMemoryPlan", { decisions: [] }, "memory-plan");
        return;
      }
      assert.equal(input.model, "fixture-model");
      const child = JSON.stringify(input.messages[0]).includes("You are a subagent inside k-brain");
      requests.push({ child, input });
      const last = input.messages.at(-1);
      if (last.role === "tool") {
        stream(response, { content: child ? "child tool handled" : "trajectory command handled" }, "stop");
      } else if (includeChild && !child) {
        assert.ok(names.includes("subagent"));
        toolCall(response, "subagent", {
          description: "foreground worker", prompt: "perform child bash", background: false,
        }, "delegate-call");
      } else {
        assert.ok(names.includes("bash"));
        toolCall(response, "bash", {
          command: `printf '${marker}\\n' # request-${input.messages.length}`,
        }, child ? "child-bash" : "trajectory-call");
      }
    } catch (error) {
      failures.push(error);
      response.statusCode = 500;
      response.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const config = path.join(directory, "config.json");
  await writeFile(config, JSON.stringify({
    defaultModel: "fixture-model",
    worktreeSubagents: false,
    providers: { fixture: {
      api: "openai-completions",
      baseUrl: `http://127.0.0.1:${upstream.address().port}`,
      apiKey: "fixture-key",
      models: [{ id: "fixture-model", contextWindow: 131072, maxTokens: 1024 }],
    } },
  }));
  const child = spawn(binary, ["backend", "-listen", "127.0.0.1:0", "-parent-stdio",
    "-token", "owner", "-config", config, "-session-dir", path.join(directory, "sessions")], {
    cwd: workspace,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  stopBackend = async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const result = await closed;
    clearTimeout(timer);
    assert.deepEqual(result, { code: 0, signal: null }, `backend shutdown: ${output}`);
  };
  const baseUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Backend startup timeout:\n${output}`)), 20_000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    child.once("error", fail);
    child.once("exit", (code) => fail(new Error(`Backend exited (${code}):\n${output}`)));
    child.stdout.on("data", () => {
      const match = output.match(/k-brain backend listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  return { baseUrl, workspace, marker, requests, directory };
}

export async function runTrajectoryPrompt(client, conversationId, prompt, decision = "allow_once") {
  const accepted = await client.startRun({
    conversation_id: conversationId, client_request_id: randomUUID(), prompt,
  });
  const events = [];
  const approvals = [];
  const errors = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Run SSE timed out")), 30_000);
  try {
    await client.subscribe(conversationId, accepted.accepted_seq - 1, {
      onEvent(event) {
        events.push(event);
        if (event.type === "permission.requested") {
          approvals.push(client.resolvePermission(conversationId, event.payload.permission_id,
            decision, accepted.run_id).catch((error) => { errors.push(error); controller.abort(error); }));
        }
      },
    }, controller.signal);
    await Promise.all(approvals);
    assert.deepEqual(errors, []);
    assert.equal(controller.signal.aborted, false, "SSE must finish without timing out");
    assert.equal(events.at(-1)?.type, "run.completed", JSON.stringify(events.at(-1)));
    assert.ok(events.every((event) => event.run_id === accepted.run_id));
    return events;
  } finally {
    clearTimeout(timer);
  }
}
