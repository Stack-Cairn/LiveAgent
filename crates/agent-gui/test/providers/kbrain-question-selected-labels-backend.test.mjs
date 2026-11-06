import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { getKBrainBinary } from "../helpers/kbrain-binary.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// A multi-select answer whose labels contain ", " against the real K-brain backend.
// With capability question_selected_labels (Stack-Cairn/K-brain#168) the answer goes as
// selected_labels and history replays it exactly from question_answers; an older backend
// gets the joined custom text it accepts, and history splits it back best-effort.
const questionArgs = {
  questions: [
    { header: "Stack", question: "Which stack?", options: [{ label: "Go" }, { label: "Rust" }] },
    {
      header: "Extras",
      question: "Add what?",
      multiple: true,
      options: [{ label: "Search" }, { label: "filter" }, { label: "Search, filter" }, { label: "CI" }],
    },
  ],
};

test("multi-select answers round-trip through K-brain history", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "question-labels-"));
  const home = path.join(root, "home");
  const workdir = path.join(root, "workspace");
  await mkdir(home);
  await mkdir(workdir);
  // The scripted model only decides to call `question` once; K-brain does the rest.
  const upstream = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (!body.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "[]" }, finish_reason: "stop" }] }));
      return;
    }
    const tools = (body.tools ?? []).map((tool) => tool.function.name);
    const asked = body.messages.some((message) => message.role === "assistant" && message.tool_calls?.length);
    const call = { index: 0, id: "fixture-question", type: "function", function: { name: "question", arguments: JSON.stringify(questionArgs) } };
    const delta = asked || !tools.includes("question") ? { content: "done" } : { tool_calls: [call] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  let child;
  t.after(async () => {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const config = path.join(home, "config.json");
  await writeFile(config, JSON.stringify({
    defaultModel: "fixture-model",
    aiApproval: { mode: "off" },
    providers: { fixture: { api: "openai-completions", apiKey: "fixture-key", baseUrl: `http://127.0.0.1:${upstream.address().port}`, models: [{ id: "fixture-model", contextWindow: 32768, maxTokens: 256 }] } },
  }));
  child = spawn(await getKBrainBinary(), ["backend", "-listen", "127.0.0.1:0", "-token", "labels-token", "-config", config, "-session-dir", path.join(root, "sessions")], {
    cwd: workdir, env: { ...process.env, HOME: home, LIVEAGENT_HOME: home, K_BRAIN_HOME: "" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stderr.on("data", (data) => { logs += data; });
  const baseUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`backend readiness: ${logs}`)), 20_000);
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`backend exit ${code}: ${logs}`)); });
    child.stdout.on("data", (data) => {
      logs += data;
      const match = logs.match(/k-brain backend listening on (http:\/\/\S+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  const health = await fetch(`${baseUrl}/v1/health`, { headers: { Authorization: "Bearer labels-token" } }).then((res) => res.json());
  const structured = health.capabilities?.question_selected_labels === 1;

  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const loader = createTsModuleLoader();
  const shared = loader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts");
  const turn = loader.loadModule("src/lib/kbrain/turn.ts");
  const history = loader.loadModule("src/lib/kbrain/history.ts");
  const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

  const posts = [];
  const recordingFetch = async (url, init = {}) => {
    const response = await fetch(url, init);
    const pathname = new URL(String(url)).pathname;
    if (/\/questions\//.test(pathname)) posts.push({ pathname, status: response.status, body: JSON.parse(init.body) });
    return response;
  };
  const questionResults = [];
  const result = await turn.runKBrainTurn({
    conversationId: "conversation-labels", sessionId: "host-labels", cwd: workdir,
    model: { provider: "fixture", model: "fixture-model" },
    prompt: "Ask me what to add", context: { messages: [{ role: "user", content: "Ask me what to add", timestamp: 1 }] },
    signal: AbortSignal.timeout(60_000), baseUrl, token: "labels-token", fetch: recordingFetch,
    options: { mode: "agent", approval_policy: "ask", workspace_roots: [{ path: workdir, access: "write" }] },
    onTextDelta() {}, onThinkingDelta() {}, onToolCall() {},
    onToolResult: (_call, value) => { if (value.toolName === "AskUserQuestion") questionResults.push(value); },
    onQuestionRequest: async (request) => {
      const questions = shared.parseAskUserQuestionItems(request.questions);
      return [
        shared.kbrainQuestionAnswerPayload({ questionId: "q1", prompt: questions[0].prompt, selectedLabel: "Go" }),
        shared.kbrainQuestionAnswerPayload(shared.buildMultiSelectAnswer(questions[1], ["Search", "filter"], "a badge")),
      ];
    },
  });
  assert.equal(result.stopReason, "stop", `${result.errorMessage ?? ""}\n${logs}`);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].status, 200);
  assert.deepEqual(posts[0].body.answers, [
    { question_id: "q1", selected_label: "Go" },
    structured
      ? { question_id: "q2", selected_labels: ["Search", "filter"], selected_label: "a badge", custom: true }
      : { question_id: "q2", selected_label: "Search, filter, a badge", custom: true },
  ]);

  const expected = structured ? ["Search", "filter"] : ["Search, filter"];
  const live = shared.parseAskUserQuestionResultDetails(questionResults.at(-1).details).answers[1];
  assert.deepEqual(live.selectedLabels, expected);
  assert.equal(live.customText, "a badge");

  // Reload the session from K-brain history, as the desktop does after a restart.
  const sessionId = posts[0].pathname.split("/")[3];
  const client = createKBrainClient({ baseUrl, token: "labels-token" });
  const page = await client.getHistory(sessionId, { maxMessages: 50 });
  const call = page.session.messages.flatMap((message) => message.tool_calls ?? []).find((item) => item.name === "question");
  if (structured) {
    assert.deepEqual(call.question_answers.map((answer) => answer.selected_labels ?? null), [null, ["Search", "filter"]]);
  } else {
    assert.equal(call.question_answers, undefined);
  }
  const replayed = history.convertMessages(page.session.messages).find((message) => message.role === "toolResult" && message.toolName === "AskUserQuestion");
  const settled = shared.parseAskUserQuestionResultDetails(replayed.details).answers;
  assert.equal(settled[0].selectedLabel, "Go");
  // Without question_answers the joined text is split on the longest listed label,
  // which reads "Search" + "filter" as the one option "Search, filter".
  assert.deepEqual(settled[1].selectedLabels, expected);
  assert.equal(settled[1].customText, "a badge");
});
