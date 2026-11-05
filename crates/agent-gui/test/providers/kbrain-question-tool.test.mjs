import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// K-brain's own `question` tool (Stack-Cairn/K-brain#162): multi-question asks with
// headers, multi-select answers, the plain-text result read back in history, and how a
// shell command ran (exit code / timeout / duration).
const loader = createTsModuleLoader();
const shared = loader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts");
const runInfo = loader.loadModule("@liveagent/ui/lib/chat/toolRunInfo.ts");
const history = loader.loadModule("src/lib/kbrain/history.ts");
const turn = loader.loadModule("src/lib/kbrain/turn.ts");

const questionArgs = {
  questions: [
    { header: "Stack", question: "Which stack?", options: [{ label: "Go" }, { label: "Rust" }] },
    {
      header: "Extras",
      question: "Add what?",
      multiple: true,
      options: [{ label: "Docs" }, { label: "Tests, unit" }, { label: "CI" }],
    },
  ],
};

test("question tool arguments become AskUserQuestion questions in both forms", () => {
  const normalized = shared.normalizeKBrainQuestionToolArguments({ ...questionArgs, __marker: 1 });
  assert.equal(normalized.__marker, 1);
  assert.deepEqual(
    normalized.questions.map((question) => [question.id, question.header, question.prompt, question.multiple]),
    [
      ["q1", "Stack", "Which stack?", undefined],
      ["q2", "Extras", "Add what?", true],
    ],
  );
  const single = shared.normalizeKBrainQuestionToolArguments({
    question: "Proceed?",
    options: [{ label: "Yes" }, { label: "No" }],
    multiple: true,
  });
  assert.deepEqual(single.questions, [
    { options: [{ label: "Yes" }, { label: "No" }], multiple: true, id: "q1", prompt: "Proceed?" },
  ]);
});

test("question tool results read back into settled card answers", () => {
  const answered = shared.parseKBrainQuestionToolResult(
    questionArgs,
    "The user answered:\n1. Which stack?\n   → Rust\n2. Add what?\n   → Docs, Tests, unit",
    false,
  );
  assert.equal(answered.kind, "ask_user_question");
  assert.equal(answered.timedOut, undefined);
  assert.deepEqual(answered.answers[0], { questionId: "q1", prompt: "Which stack?", selectedLabel: "Rust" });
  // A label holding the separator still splits back into the listed options.
  assert.deepEqual(answered.answers[1].selectedLabels, ["Docs", "Tests, unit"]);
  assert.equal(answered.answers[1].custom, undefined);

  const typed = shared.parseKBrainQuestionToolResult(
    { question: "Proceed?", options: [{ label: "Yes" }, { label: "No" }] },
    'User answered "Proceed?": After lunch',
    false,
  );
  assert.deepEqual(typed.answers, [
    { questionId: "q1", prompt: "Proceed?", selectedLabel: "After lunch", custom: true },
  ]);

  const timedOut = shared.parseKBrainQuestionToolResult(
    questionArgs,
    "The user answered:\n1. Which stack?\n   → (no answer)\n2. Add what?\n   → (no answer)",
    false,
  );
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.answers.length, 0);
  assert.equal(
    shared.parseKBrainQuestionToolResult(questionArgs, "the user dismissed the question", true).cancelled,
    true,
  );
  assert.equal(shared.parseKBrainQuestionToolResult(questionArgs, "invalid arguments", true), null);
});

test("multi-select answers keep their labels and go to K-brain as joined custom text", () => {
  const questions = shared.parseAskUserQuestionItems(
    shared.normalizeKBrainQuestionToolArguments(questionArgs).questions,
  );
  const multi = questions[1];
  const answer = shared.buildMultiSelectAnswer(multi, ["CI", "Docs"], "and a changelog");
  assert.deepEqual(answer.selectedLabels, ["Docs", "CI"]);
  assert.equal(answer.selectedLabel, "Docs, CI, and a changelog");
  assert.equal(answer.custom, true);
  assert.equal(shared.askUserQuestionAnswerIsCustomForBackend(answer), true);

  const resolved = shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "q1", selectedLabel: "Go" },
    { questionId: "q2", selectedLabels: ["Docs", "CI"] },
  ]);
  assert.equal(resolved[1].selectedLabel, "Docs, CI");
  assert.equal(shared.askUserQuestionAnswerIsCustomForBackend(resolved[0]), false);
  // Several labels are not one listed option, so K-brain only accepts them as custom.
  assert.equal(shared.askUserQuestionAnswerIsCustomForBackend(resolved[1]), true);
  const one = shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "q1", selectedLabel: "Go" },
    { questionId: "q2", selectedLabels: ["CI"] },
  ]);
  assert.equal(shared.askUserQuestionAnswerIsCustomForBackend(one[1]), false);
  // A label that is not listed is refused unless it is typed text.
  assert.equal(
    shared.resolveAskUserQuestionAnswers(questions, [
      { questionId: "q1", selectedLabel: "Go" },
      { questionId: "q2", selectedLabels: ["Docs", "Nope"] },
    ]),
    null,
  );
});

test("history replays question calls as the question card and keeps run info", () => {
  const messages = history.convertMessages([
    {
      role: "assistant",
      tool_calls: [
        { id: "ask-1", name: "question", arguments: questionArgs },
        { id: "sh-1", name: "Bash", arguments: { command: "false" }, exit_code: 1, duration_ms: 2300 },
        { id: "sh-2", name: "Bash", arguments: { command: "sleep 99" }, timed_out: true, duration_ms: 30000 },
      ],
    },
    {
      role: "tool",
      tool_call_id: "ask-1",
      name: "question",
      content: [{ type: "text", text: "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → CI" }],
    },
    { role: "tool", tool_call_id: "sh-1", name: "Bash", stop_reason: "error", content: [{ type: "text", text: "exit 1" }] },
    { role: "tool", tool_call_id: "sh-2", name: "Bash", stop_reason: "error", content: [{ type: "text", text: "killed" }] },
  ]);
  const [assistant, question, failed, killed] = messages;
  const call = assistant.content.find((part) => part.id === "ask-1");
  assert.equal(call.name, "AskUserQuestion");
  assert.deepEqual(
    call.arguments.questions.map((item) => item.header),
    ["Stack", "Extras"],
  );
  assert.equal(question.toolName, "AskUserQuestion");
  assert.deepEqual(
    question.details.answers.map((answer) => answer.selectedLabel),
    ["Go", "CI"],
  );
  assert.deepEqual(runInfo.readToolRunInfo(failed.details), { exitCode: 1, durationMs: 2300 });
  assert.equal(runInfo.formatToolRunInfo(runInfo.readToolRunInfo(failed.details)), "exit 1 · 2.3s");
  assert.equal(runInfo.formatToolRunInfo(runInfo.readToolRunInfo(killed.details)), "timed out · 30.0s");

  // Sent back to K-brain (a new session from this transcript), the call keeps its own name.
  const [, back] = turn.contextToKBrainMessages({ messages: [{ role: "user", content: "hi", timestamp: 0 }, ...messages] });
  assert.equal(back.tool_calls[0].name, "question");
  assert.deepEqual(back.tool_calls[0].arguments, questionArgs);
  const backResult = turn.contextToKBrainMessages({ messages }).find((message) => message.tool_call_id === "ask-1");
  assert.equal(backResult.name, "question");
});

test("run info is only kept for shell tools and formats compactly", () => {
  assert.equal(runInfo.withToolRunInfo("Read", undefined, { duration_ms: 5 }), undefined);
  assert.deepEqual(runInfo.withToolRunInfo("Bash", { kept: true }, { exit_code: 0, duration_ms: 40 }), {
    kept: true,
    kbrainRun: { exitCode: 0, durationMs: 40 },
  });
  assert.equal(runInfo.withToolRunInfo("Bash", undefined, {}), undefined);
  assert.equal(runInfo.formatToolRunInfo({ exitCode: 0, durationMs: 40 }), "exit 0 · 40ms");
  assert.equal(runInfo.formatToolRunDuration(125_000), "2m5s");
  assert.equal(
    runInfo.formatToolRunInfo({ exitCode: 3 }, { exitCode: "退出码 {code}", timedOut: "已超时" }),
    "退出码 3",
  );
  assert.equal(runInfo.formatToolRunInfo(null), "");
});

function sse(seq, type, payload) {
  return `data: ${JSON.stringify({
    version: "kbrain.agent.v1", seq, conversation_id: "backend-q", run_id: "run-q", type, payload,
  })}\n\n`;
}

test("a live question tool asks on the card, settles from question.resolved and Bash results carry run info", async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const request = {
    question_id: "question-1", tool_call_id: "ask-1", run_id: "run-q", deadline_at: Date.now() + 60_000,
    questions: [
      { id: "q1", header: "Stack", prompt: "Which stack?", options: [{ label: "Go" }, { label: "Rust" }] },
      { id: "q2", header: "Extras", prompt: "Add what?", multiple: true, options: [{ label: "Docs" }, { label: "CI" }] },
    ],
  };
  let controller;
  const posted = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/sessions") return new Response(JSON.stringify({ id: "backend-q", messages: [], last_seq: 0 }));
    if (path.endsWith("/runs")) {
      return new Response(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "backend-q", run_id: "run-q", accepted_seq: 1 }), { status: 202 });
    }
    if (path.endsWith("/events")) {
      return new Response(new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode(
          sse(2, "tool.call", { tool_call: { id: "ask-1", name: "question", arguments: questionArgs } }) +
          sse(3, "question.requested", request),
        ));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/questions/question-1")) {
      posted.push(JSON.parse(init.body));
      const answers = [
        { question_id: "q1", prompt: "Which stack?", selected_label: "Go" },
        { question_id: "q2", prompt: "Add what?", selected_label: "Docs, CI", custom: true },
      ];
      controller.enqueue(new TextEncoder().encode(
        sse(4, "question.resolved", { ...request, kind: "ask_user_question", answers }) +
        sse(5, "tool.result", { tool_result: { id: "ask-1", name: "question", output: "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Docs, CI" } }) +
        sse(6, "tool.call", { tool_call: { id: "sh-1", name: "Bash", arguments: { command: "make" } } }) +
        sse(7, "tool.result", { tool_result: { id: "sh-1", name: "Bash", output: "make: *** Error 2", failed: true, exit_code: 2, duration_ms: 1500 } }) +
        sse(8, "run.completed", {}),
      ));
      controller.close();
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected ${path}`);
  };
  const calls = [];
  const results = [];
  const result = await turn.runKBrainTurn({
    conversationId: "conversation-q", sessionId: "host-q", cwd: "/tmp/w", model: { provider: "fixture", model: "m" },
    prompt: "ask", context: { messages: [{ role: "user", content: "ask", timestamp: 1 }] },
    signal: new AbortController().signal, fetch,
    onTextDelta() {}, onThinkingDelta() {},
    onToolCall: (call) => calls.push(call),
    onToolResult: (_call, value) => results.push(value),
    onQuestionRequest: async () => [
      { question_id: "q1", selected_label: "Go" },
      { question_id: "q2", selected_label: "Docs, CI", custom: true },
    ],
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(posted.length, 1);
  const askCalls = calls.filter((call) => call.id === "ask-1");
  assert.equal(askCalls.every((call) => call.name === "AskUserQuestion"), true);
  assert.deepEqual(askCalls.at(-1).arguments.questions.map((question) => question.header), ["Stack", "Extras"]);
  // The model's own call is kept for a transcript sent back to K-brain.
  assert.deepEqual(askCalls.at(-1).arguments.__kbrainQuestionArguments, questionArgs);
  const question = results.filter((value) => value.toolCallId === "ask-1").at(-1);
  const shell = results.find((value) => value.toolCallId === "sh-1");
  assert.equal(question.toolName, "AskUserQuestion");
  // The card reads the joined custom labels K-brain stored back as the options picked.
  const settled = shared.parseAskUserQuestionResultDetails(question.details);
  assert.deepEqual(settled.answers[1].selectedLabels, ["Docs", "CI"]);
  assert.equal(settled.answers[1].customText, undefined);
  assert.deepEqual(runInfo.readToolRunInfo(shell.details), { exitCode: 2, durationMs: 1500 });
});
