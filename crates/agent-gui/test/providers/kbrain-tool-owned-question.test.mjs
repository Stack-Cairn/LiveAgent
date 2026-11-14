// A running K-brain tool asking its own question (SSHManager confirming an unknown host
// key, Stack-Cairn/K-brain#181): the call keeps its name and arguments, the question rides
// along as a synthetic argument while it is pending, the answer goes through the normal
// question route, and the tool's own result (the exec output) is what the row shows.
import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const EXEC_OUTPUT = [
  "session_id: s-1",
  "session_strategy: reuse_or_create",
  "session_reused: false",
  "session_created: true",
  "exit_code: 0",
  "timed_out: false",
  "",
  "stdout:",
  "Linux web 6.1.0",
  "",
  "stderr:",
  "(empty)",
].join("\n");

test("an SSHManager host-key question stays on the SSHManager call and its result is the exec output", async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
  const projected = [];
  const ui = {
    updateLiveRound: (rounds, number, apply) =>
      rounds.map((round) => (round.round === number ? apply(round) : round)),
    collapseThinking: (round) => round,
    upsertToolCallToRound: (round) => round,
    attachToolResultToRound: (round, call, result) => {
      projected.push({ call, result });
      return round;
    },
    appendTextDeltaToRound: (round) => round,
    appendThinkingDeltaToRound: (round) => round,
    upsertHostedSearchToRound: (round) => round,
  };
  const production = createTsModuleLoader({
    mocks: {
      "../../../lib/chat/messages/uiMessages": ui,
      "../../../lib/chat/conversation/conversationState": {
        appendMessagesToConversation: (state, messages) => ({ ...state, messages }),
      },
      "../../../lib/chat/history/chatHistory": { buildConversationStateFromWindow: (window) => window },
      "../../../lib/kbrain/history": { getKBrainHistoryWindow: async () => ({ messages: [] }) },
      "../../../lib/kbrain/runtimeConnection": {
        getConfiguredKBrainConnection: () => ({ baseUrl: "http://ssh-question.test" }),
      },
      "./runtimeConnection": {
        getConfiguredKBrainConnection: () => ({ baseUrl: "http://ssh-question.test" }),
        resolveKBrainClientOptions: (options) => ({
          ...options,
          baseUrl: options.baseUrl ?? "http://ssh-question.test",
        }),
        getKBrainRuntimeConnection: () => undefined,
      },
    },
  });
  const questions = production.loadModule("src/lib/tools/askUserQuestionTools.ts");
  const { runKBrainConversationTurn } = production.loadModule(
    "src/pages/chat/turns/runKBrainConversationTurn.ts",
  );
  const { readToolQuestionItems, TOOL_QUESTION_ARG } = production.loadModule(
    "@liveagent/ui/lib/chat/askUserQuestion.ts",
  );
  const { TOOL_APPROVAL_SYNTHETIC_ARG_KEYS } = production.loadModule(
    "@liveagent/ui/lib/chat/toolApprovalArgs.ts",
  );

  const execArgs = { action: "exec", host_id: "web-id", command: "uname -a" };
  const request = {
    question_id: "hostkey-1",
    tool_call_id: "call-ssh",
    run_id: "run-1",
    deadline_at: Date.now() + 120_000,
    questions: [
      {
        id: "host_key",
        header: "SSH host key",
        prompt:
          "The SSH host web (127.0.0.1:2222) is not known yet.\n\nAlgorithm: ssh-ed25519\nFingerprint: SHA256:abc\n\nTrust this host key?",
        options: [{ label: "Trust once" }, { label: "Trust and save" }, { label: "Reject", recommended: true }],
      },
    ],
  };
  const posted = [];
  const events = [];
  let controller;
  let seq = 1;
  const emit = (type, payload) =>
    controller.enqueue(
      new TextEncoder().encode(
        `data: ${JSON.stringify({ version: "kbrain.agent.v1", seq: ++seq, conversation_id: "session-1", run_id: "run-1", type, payload })}\n\n`,
      ),
    );
  let pendingQuestions = null;
  const unsubscribe = questions.subscribeAskUserQuestionsForConversation("ui-conversation", () => {
    if (!questions.hasPendingAskUserQuestion("call-ssh") || pendingQuestions) return;
    pendingQuestions = questions.getPendingAskUserQuestionItems("call-ssh");
    queueMicrotask(() => {
      assert.equal(
        questions.answerAskUserQuestion(
          "call-ssh",
          [{ questionId: "host_key", prompt: request.questions[0].prompt, selectedLabel: "Trust once" }],
          { conversationId: "ui-conversation" },
        ).ok,
        true,
      );
    });
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/v1/health")
      return response({ status: "ok", version: "kbrain.agent.v1", capabilities: { ssh_manager: 1 } });
    if (path === "/v1/sessions") return response({ id: "session-1" });
    if (path.endsWith("/runs"))
      return response(
        { version: "kbrain.agent.v1", conversation_id: "session-1", run_id: "run-1", accepted_seq: 1 },
        202,
      );
    if (path.endsWith("/events"))
      return new Response(
        new ReadableStream({
          start(value) {
            controller = value;
            emit("tool.call", { tool_call: { id: "call-ssh", name: "SSHManager", arguments: execArgs } });
            emit("question.requested", request);
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (path.endsWith("/questions/hostkey-1")) {
      const body = JSON.parse(init.body);
      posted.push(body);
      queueMicrotask(() => {
        emit("question.resolved", {
          ...request,
          answers: body.answers.map((answer) => ({ ...answer, prompt: request.questions[0].prompt })),
        });
        emit("tool.result", { tool_result: { id: "call-ssh", name: "SSHManager", output: EXEC_OUTPUT } });
        emit("run.completed", {});
        controller.close();
      });
      return response({ ok: true });
    }
    if (path.endsWith("/cancel")) return response({ ok: true });
    throw new Error(`unexpected URL ${url}`);
  };
  let rounds = [];
  try {
    await runKBrainConversationTurn({
      conversationId: "ui-conversation",
      sessionId: "host-1",
      trajectoryMessageId: "turn-1",
      runtime: {},
      selectedModel: {},
      providerId: "fixture",
      model: "fixture",
      cancellation: { userStop: new AbortController() },
      buildPreparedContext: () => ({ messages: [{ role: "user", content: "run uname" }] }),
      getNextConversationState: () => ({ segments: [{ messages: [{ role: "user", id: "user-1", content: "run uname" }] }] }),
      batchLiveRoundsUpdate: (apply) => {
        rounds = apply(rounds);
      },
      gatewayBridgeEvents: {
        queueEvent: (event) => events.push(event),
        queueToken() {},
        queueToolStatus() {},
        emitError: (error) => assert.fail(error),
      },
      hookLifecycle: { startAgent() {}, startTurn() {}, ensureMessageEnded() {}, endTurn() {}, endAgent() {} },
      updateToolStatus() {},
      applyConversationState() {},
      freezeGatewayFinalProjection() {},
      settleLiveTranscript() {},
      persistConversationWithHistorySync: async () => {},
    });

    // The question was registered under the SSHManager call and answered through the
    // question route with exactly one listed label (K-brain rejects anything else).
    assert.deepEqual(pendingQuestions?.map((item) => item.id), ["host_key"]);
    assert.deepEqual(posted, [
      {
        conversation_id: "session-1",
        question_id: "hostkey-1",
        run_id: "run-1",
        answers: [{ question_id: "host_key", selected_label: "Trust once" }],
      },
    ]);
    assert.equal(questions.hasPendingAskUserQuestion("call-ssh"), false);

    const callEvents = events.filter((event) => event.type === "tool_call" && event.id === "call-ssh");
    // Never renamed to AskUserQuestion.
    assert.equal(callEvents.every((event) => event.name === "SSHManager"), true);
    // The WebUI saw the question while it was pending, with the deadline...
    const pending = callEvents.find((event) => event.arguments[TOOL_QUESTION_ARG]);
    assert.ok(pending, "a tool_call event carries the question while pending");
    assert.equal(readToolQuestionItems(pending.arguments)[0].prompt, request.questions[0].prompt);
    assert.equal(pending.arguments.__askUserQuestionDeadlineAt, request.deadline_at);
    assert.equal(pending.arguments.command, "uname -a");
    // ...and the last push no longer carries it.
    assert.equal(TOOL_QUESTION_ARG in callEvents.at(-1).arguments, false);
    assert.ok(TOOL_APPROVAL_SYNTHETIC_ARG_KEYS.includes(TOOL_QUESTION_ARG));

    // The row's result is the exec output, not an AskUserQuestion answer.
    const final = projected.at(-1);
    assert.equal(final.call.name, "SSHManager");
    assert.equal(TOOL_QUESTION_ARG in final.call.arguments, false);
    assert.deepEqual(final.call.arguments, execArgs);
    assert.equal(final.result.toolName, "SSHManager");
    assert.match(JSON.stringify(final.result.content), /Linux web 6\.1\.0/);
    assert.notEqual(final.result.details?.kind, "ask_user_question");
    assert.equal(
      projected.some(({ result }) => result.details?.kind === "ask_user_question"),
      false,
    );
  } finally {
    unsubscribe();
    globalThis.fetch = originalFetch;
    questions.cancelPendingAskUserQuestionsForConversation("ui-conversation");
  }
});
