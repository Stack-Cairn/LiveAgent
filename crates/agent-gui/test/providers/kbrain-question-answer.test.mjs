import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createKBrainClient } = loader.loadModule("src/lib/kbrain/client.ts");

function response(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

test("production K-brain client posts an AskUserQuestion answer with run/session correlation", async () => {
  const calls = [];
  const client = createKBrainClient({
    baseUrl: "http://kbrain.test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ ok: true });
    },
  });
  await client.resolveQuestion("session-1", "question-1", "run-1", [
    { question_id: "q1", selected_label: "Fast", custom: false },
  ]);
  assert.equal(new URL(calls[0].url).pathname, "/v1/sessions/session-1/questions/question-1");
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    conversation_id: "session-1",
    question_id: "question-1",
    run_id: "run-1",
    answers: [{ question_id: "q1", selected_label: "Fast", custom: false }],
  });
});

for (const mode of ["answered", "timeout", "cancelled"]) {
  test(`production conversation turn uses the question card answer path: ${mode}`, async () => {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    };
    const projectedResults = [];
    const ui = {
      updateLiveRound: (rounds, number, apply) => rounds.map((round) => round.round === number ? apply(round) : round),
      collapseThinking: (round) => round,
      upsertToolCallToRound: (round) => round,
      attachToolResultToRound: (round, _call, result) => { projectedResults.push(result); return round; },
      appendTextDeltaToRound: (round) => round,
      appendThinkingDeltaToRound: (round) => round,
      upsertHostedSearchToRound: (round) => round,
    };
    const production = createTsModuleLoader({ mocks: {
      "../../../lib/chat/messages/uiMessages": ui,
      "../../../lib/chat/conversation/conversationState": { appendMessagesToConversation: (state, messages) => ({ ...state, messages }) },
      "../../../lib/chat/history/chatHistory": { buildConversationStateFromWindow: (window) => window },
      "../../../lib/kbrain/history": { getKBrainHistoryWindow: async () => ({ messages: [] }) },
      "../../../lib/kbrain/runtimeConnection": { getConfiguredKBrainConnection: () => ({ baseUrl: "http://question.test" }) },
      "./runtimeConnection": {
        getConfiguredKBrainConnection: () => ({ baseUrl: "http://question.test" }),
        resolveKBrainClientOptions: (options) => ({ ...options, baseUrl: options.baseUrl ?? "http://question.test" }),
        getKBrainRuntimeConnection: () => undefined,
      },
    } });
    const questions = production.loadModule("src/lib/tools/askUserQuestionTools.ts");
    const { runKBrainConversationTurn } = production.loadModule("src/pages/chat/turns/runKBrainConversationTurn.ts");
    const posted = [];
    const events = [];
    const request = {
      question_id: "question-1", tool_call_id: "call-1", run_id: "run-1",
      deadline_at: Date.now() + 180_000,
      questions: [{ id: "q1", prompt: "Which?", options: [{ label: "Fast", recommended: true }, { label: "Slow" }] }],
    };
    let controller;
    let seq = 1;
    const emit = (type, payload) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({
      version: "kbrain.agent.v1", seq: ++seq, conversation_id: "session-1", run_id: "run-1", type, payload,
    })}\n\n`));
    const finish = (answers) => {
      const result = { ...request, kind: "ask_user_question", answers, timed_out: mode === "timeout", cancelled: mode === "cancelled" };
      emit("question.resolved", result);
      emit("tool.result", { tool_result: { id: "call-1", name: "AskUserQuestion", output: JSON.stringify(result) } });
      emit("assistant.text.delta", { text: "Answer received" });
      emit(mode === "cancelled" ? "run.cancelled" : "run.completed", {});
      controller.close();
    };
    const unsubscribe = questions.subscribeAskUserQuestionsForConversation("ui-conversation", () => {
      if (!questions.hasPendingAskUserQuestion("call-1")) return;
      assert.equal(questions.getAskUserQuestionDeadlineAt("call-1"), request.deadline_at);
      if (mode === "answered") {
        assert.equal(questions.answerAskUserQuestion("call-1", [{ questionId: "q1", selectedLabel: "wrong session" , custom: true }], { conversationId: "other" }).ok, false);
        assert.equal(questions.answerAskUserQuestion("call-1", [{ questionId: "q1", selectedLabel: "my custom choice", custom: true }], { conversationId: "ui-conversation" }).ok, true);
      } else {
        queueMicrotask(() => finish(mode === "timeout" ? [{ question_id: "q1", prompt: "Which?", selected_label: "Fast" }] : []));
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/v1/sessions") return response({ id: "session-1" });
      if (path.endsWith("/runs")) return response({ version: "kbrain.agent.v1", conversation_id: "session-1", run_id: "run-1", accepted_seq: 1 }, 202);
      if (path.endsWith("/events")) return new Response(new ReadableStream({ start(value) {
        controller = value;
        emit("question.requested", request);
      } }), { headers: { "content-type": "text/event-stream" } });
      if (path.endsWith("/questions/question-1")) {
        const body = JSON.parse(init.body);
        posted.push({ path, body });
        finish(body.answers.map((answer) => ({ ...answer, prompt: "Which?" })));
        return response({ ok: true });
      }
      if (path.endsWith("/cancel")) return response({ ok: true });
      throw new Error(`unexpected URL ${url}`);
    };
    let rounds = [];
    try {
      await runKBrainConversationTurn({
        conversationId: "ui-conversation", sessionId: "host-1", trajectoryMessageId: "turn-1",
        runtime: {}, selectedModel: {}, providerId: "fixture", model: "fixture",
        cancellation: { userStop: new AbortController() },
        buildPreparedContext: () => ({ messages: [{ role: "user", content: "ask" }] }),
        getNextConversationState: () => ({ messages: [] }),
        batchLiveRoundsUpdate: (apply) => { rounds = apply(rounds); },
        gatewayBridgeEvents: { queueEvent: (event) => events.push(event), queueToken() {}, queueToolStatus() {}, emitError: (error) => assert.fail(error) },
        hookLifecycle: { startAgent() {}, startTurn() {}, ensureMessageEnded() {}, endTurn() {}, endAgent() {} },
        updateToolStatus() {}, applyConversationState() {}, freezeGatewayFinalProjection() {}, settleLiveTranscript() {},
        persistConversationWithHistorySync: async () => {},
      });
      assert.equal(questions.hasPendingAskUserQuestion("call-1"), false);
      const call = events.find((event) => event.type === "tool_call");
      assert.equal(call.name, "AskUserQuestion");
      assert.equal(call.arguments.__askUserQuestionDeadlineAt, request.deadline_at);
      assert.equal(events.some((event) => event.type === "tool_result"), true);
      const details = projectedResults.at(-1).details;
      assert.equal(details.kind, "ask_user_question");
      assert.equal(details.timedOut, mode === "timeout");
      assert.equal(details.cancelled, mode === "cancelled");
      assert.equal(details.answers.length, mode === "cancelled" ? 0 : 1);
      assert.equal(posted.length, mode === "answered" ? 1 : 0);
      if (mode === "answered") assert.deepEqual(posted[0], {
        path: "/v1/sessions/session-1/questions/question-1",
        body: { conversation_id: "session-1", question_id: "question-1", run_id: "run-1", answers: [{ question_id: "q1", selected_label: "my custom choice", custom: true }] },
      });
    } finally {
      unsubscribe();
      globalThis.fetch = originalFetch;
      questions.cancelPendingAskUserQuestionsForConversation("ui-conversation");
    }
  });
}
