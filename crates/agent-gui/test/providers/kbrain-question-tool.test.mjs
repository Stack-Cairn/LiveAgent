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

// Stack-Cairn/K-brain#168: multi-select answers as selected_labels (capability
// question_selected_labels) and the question_answers K-brain records on the call.
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

// "Search" + "filter" joined reads the same as the option "Search, filter".
const commaQuestionArgs = {
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
const commaQuestions = shared.parseAskUserQuestionItems(
  shared.normalizeKBrainQuestionToolArguments(commaQuestionArgs).questions,
);

function health(capabilities) {
  return new Response(JSON.stringify({ status: "ok", version: "kbrain.agent.v1", capabilities }), {
    headers: { "content-type": "application/json" },
  });
}

test("card answers become K-brain answers: selected_labels for multi-select picks, single-select unchanged", () => {
  const [single, multi] = commaQuestions;
  const payload = shared.kbrainQuestionAnswerPayload;
  assert.deepEqual(payload({ questionId: "q1", prompt: single.prompt, selectedLabel: "Go" }), {
    question_id: "q1",
    selected_label: "Go",
  });
  assert.deepEqual(
    payload({ questionId: "q1", prompt: single.prompt, selectedLabel: "Deno", custom: true }),
    { question_id: "q1", selected_label: "Deno", custom: true },
  );
  assert.deepEqual(payload(shared.buildMultiSelectAnswer(multi, ["CI", "Search, filter"])), {
    question_id: "q2",
    selected_labels: ["Search, filter", "CI"],
  });
  assert.deepEqual(payload(shared.buildMultiSelectAnswer(multi, ["filter"], "  a badge  ")), {
    question_id: "q2",
    selected_labels: ["filter"],
    selected_label: "a badge",
    custom: true,
  });
  // Only typed text on a multi-select question is an ordinary custom answer.
  assert.deepEqual(payload(shared.buildMultiSelectAnswer(multi, [], "just this")), {
    question_id: "q2",
    selected_label: "just this",
    custom: true,
  });

  // Older backends get #1241's joined labels, custom when not one listed option.
  const legacy = shared.legacyKBrainQuestionAnswer;
  assert.deepEqual(legacy({ question_id: "q2", selected_labels: ["Search, filter", "CI"] }), {
    question_id: "q2",
    selected_label: "Search, filter, CI",
    custom: true,
  });
  assert.deepEqual(legacy({ question_id: "q2", selected_labels: ["CI"] }), {
    question_id: "q2",
    selected_label: "CI",
  });
  assert.deepEqual(
    legacy({ question_id: "q2", selected_labels: ["CI"], selected_label: "a badge", custom: true }),
    { question_id: "q2", selected_label: "CI, a badge", custom: true },
  );
  assert.deepEqual(legacy({ question_id: "q1", selected_label: "Go" }), {
    question_id: "q1",
    selected_label: "Go",
  });
});

for (const [name, capabilities, readable, structured] of [
  ["a backend with question_selected_labels", { question_selected_labels: 1 }, true, true],
  ["an older backend", { session_queue: 1 }, true, false],
  ["an unreadable health", {}, false, false],
]) {
  test(`resolveQuestion sends selected_labels only to a backend that supports them: ${name}`, async () => {
    const requests = [];
    const client = createKBrainClient({
      baseUrl: "http://kbrain.test",
      fetch: async (url, init = {}) => {
        const path = new URL(String(url)).pathname;
        requests.push({ path, body: init.body ? JSON.parse(init.body) : undefined });
        if (path === "/v1/health") {
          return readable ? health(capabilities) : new Response("unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }));
      },
    });
    const answers = [
      { question_id: "q1", selected_label: "Go" },
      { question_id: "q2", selected_labels: ["Search, filter", "CI"], selected_label: "a badge", custom: true },
    ];
    await client.resolveQuestion("session-1", "question-1", "run-1", answers);
    const posted = requests.find((request) => request.path.endsWith("/questions/question-1"));
    assert.deepEqual(
      posted.body.answers,
      structured
        ? answers
        : [
            { question_id: "q1", selected_label: "Go" },
            { question_id: "q2", selected_label: "Search, filter, CI, a badge", custom: true },
          ],
    );
    assert.equal(requests.filter((request) => request.path === "/v1/health").length, 1);

    // Answers without selected_labels never wait for the handshake.
    requests.length = 0;
    await client.resolveQuestion("session-1", "question-2", "run-1", [answers[0]]);
    assert.deepEqual(requests.map((request) => request.path), ["/v1/sessions/session-1/questions/question-2"]);
  });
}

test("history reads question_answers, so labels containing ', ' come back exactly", () => {
  // K-brain's text for the model; splitting it cannot tell "Search, filter" from two picks.
  const text =
    "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Search, filter; plus a badge (user-typed answer via Other, not a listed option)";
  const recorded = [
    { question_id: "q1", prompt: "Which stack?", selected_label: "Go" },
    { question_id: "q2", prompt: "Add what?", selected_labels: ["Search", "filter"], selected_label: "a badge", custom: true },
  ];
  const [, result] = history.convertMessages([
    { role: "assistant", tool_calls: [{ id: "ask-1", name: "question", arguments: commaQuestionArgs, question_answers: recorded }] },
    { role: "tool", tool_call_id: "ask-1", name: "question", content: [{ type: "text", text }] },
  ]);
  const settled = shared.parseAskUserQuestionResultDetails(result.details);
  assert.deepEqual(settled.answers[0], { questionId: "q1", prompt: "Which stack?", selectedLabel: "Go" });
  assert.deepEqual(settled.answers[1].selectedLabels, ["Search", "filter"]);
  assert.equal(settled.answers[1].customText, "a badge");
  assert.equal(settled.answers[1].custom, true);

  // The option that itself contains ", " stays one option.
  const [, single] = history.convertMessages([
    {
      role: "assistant",
      tool_calls: [{
        id: "ask-2", name: "question", arguments: commaQuestionArgs,
        question_answers: [recorded[0], { question_id: "q2", prompt: "Add what?", selected_label: "Search, filter", selected_labels: ["Search, filter"] }],
      }],
    },
    { role: "tool", tool_call_id: "ask-2", name: "question", content: [{ type: "text", text: "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Search, filter" }] },
  ]);
  const one = shared.parseAskUserQuestionResultDetails(single.details).answers[1];
  assert.deepEqual(one.selectedLabels, ["Search, filter"]);
  assert.equal(one.custom, undefined);

  // AskUserQuestion's result is the resolution JSON; its selected_labels are read too.
  const resolution = {
    kind: "ask_user_question",
    questions: shared.normalizeKBrainQuestionToolArguments(commaQuestionArgs).questions,
    answers: recorded,
  };
  const [, ask] = history.convertMessages([
    { role: "assistant", tool_calls: [{ id: "ask-3", name: "AskUserQuestion", arguments: { questions: resolution.questions }, question_answers: recorded }] },
    { role: "tool", tool_call_id: "ask-3", name: "AskUserQuestion", content: [{ type: "text", text: JSON.stringify(resolution) }] },
  ]);
  assert.deepEqual(shared.parseAskUserQuestionResultDetails(ask.details).answers[1].selectedLabels, ["Search", "filter"]);
});

test("old sessions without question_answers still split the joined text", () => {
  const [, result] = history.convertMessages([
    { role: "assistant", tool_calls: [{ id: "ask-1", name: "question", arguments: commaQuestionArgs }] },
    { role: "tool", tool_call_id: "ask-1", name: "question", content: [{ type: "text", text: "The user answered:\n1. Which stack?\n   → Rust\n2. Add what?\n   → CI, filter" }] },
  ]);
  const settled = shared.parseAskUserQuestionResultDetails(result.details);
  assert.equal(settled.answers[0].selectedLabel, "Rust");
  assert.deepEqual(settled.answers[1].selectedLabels, ["filter", "CI"]);
  // A timed-out question records no answers.
  assert.equal(
    shared.parseKBrainQuestionToolResult(commaQuestionArgs, "The user answered:\n1. Which stack?\n   → (no answer)\n2. Add what?\n   → (no answer)", false, []).timedOut,
    true,
  );
});

for (const withResolved of [true, false]) test(`a live question sends selected_labels and settles from the recorded answers${withResolved ? "" : " on tool.result alone"}`, async () => {
  const storage = new Map();
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const request = {
    question_id: "question-1", tool_call_id: "ask-1", run_id: "run-q", deadline_at: Date.now() + 60_000,
    questions: shared.normalizeKBrainQuestionToolArguments(commaQuestionArgs).questions,
  };
  let controller;
  const posted = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/health") return health({ question_selected_labels: 1 });
    if (path === "/v1/sessions") return new Response(JSON.stringify({ id: "backend-q", messages: [], last_seq: 0 }));
    if (path.endsWith("/runs")) {
      return new Response(JSON.stringify({ version: "kbrain.agent.v1", conversation_id: "backend-q", run_id: "run-q", accepted_seq: 1 }), { status: 202 });
    }
    if (path.endsWith("/events")) {
      return new Response(new ReadableStream({ start(value) {
        controller = value;
        controller.enqueue(new TextEncoder().encode(
          sse(2, "tool.call", { tool_call: { id: "ask-1", name: "question", arguments: commaQuestionArgs } }) +
          sse(3, "question.requested", request),
        ));
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (path.endsWith("/questions/question-1")) {
      const body = JSON.parse(init.body);
      posted.push(body);
      // K-brain records the validated answers with their prompts.
      const answers = body.answers.map((answer, index) => ({ ...answer, prompt: request.questions[index].prompt }));
      controller.enqueue(new TextEncoder().encode(
        (withResolved ? sse(4, "question.resolved", { ...request, kind: "ask_user_question", answers }) : "") +
        sse(withResolved ? 5 : 4, "tool.result", { tool_result: { id: "ask-1", name: "question", output: "The user answered:\n1. Which stack?\n   → Go\n2. Add what?\n   → Search, filter", question_answers: answers } }) +
        sse(withResolved ? 6 : 5, "run.completed", {}),
      ));
      controller.close();
      return new Response(JSON.stringify({ ok: true }));
    }
    throw new Error(`unexpected ${path}`);
  };
  const results = [];
  const [single, multi] = commaQuestions;
  const result = await turn.runKBrainTurn({
    conversationId: `conversation-labels-${withResolved}`, sessionId: "host-q", cwd: "/tmp/w", model: { provider: "fixture", model: "m" },
    prompt: "ask", context: { messages: [{ role: "user", content: "ask", timestamp: 1 }] },
    signal: new AbortController().signal, fetch,
    onTextDelta() {}, onThinkingDelta() {}, onToolCall() {},
    onToolResult: (_call, value) => results.push(value),
    onQuestionRequest: async () => [
      shared.kbrainQuestionAnswerPayload({ questionId: "q1", prompt: single.prompt, selectedLabel: "Go" }),
      shared.kbrainQuestionAnswerPayload(shared.buildMultiSelectAnswer(multi, ["Search", "filter"])),
    ],
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(posted[0].answers, [
    { question_id: "q1", selected_label: "Go" },
    { question_id: "q2", selected_labels: ["Search", "filter"] },
  ]);
  const asked = results.filter((value) => value.toolCallId === "ask-1");
  assert.equal(asked.length, withResolved ? 2 : 1);
  for (const value of asked) {
    const settled = shared.parseAskUserQuestionResultDetails(value.details);
    assert.deepEqual(settled.answers[1].selectedLabels, ["Search", "filter"]);
    assert.equal(settled.answers[1].custom, undefined);
  }
});
