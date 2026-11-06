import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// What WebUI reads from K-brain's question tool and permission previews, on the desktop
// sync and on the Gateway's direct link (crates/agent-gateway/internal/kbrain).
const rootDir = fileURLToPath(new URL("../", import.meta.url));
const loader = createWebModuleLoader({ rootDir });
const shared = loader.loadModule("@liveagent/ui/lib/chat/askUserQuestion.ts");
const approvalArgs = loader.loadModule("@liveagent/ui/lib/chat/toolApprovalArgs.ts");
const { toolCallArgsForDisplay } = loader.loadModule("@liveagent/ui/lib/chat/uiMessages.ts");

test("a multi-select answer from WebUI carries its labels for the Gateway", () => {
  const questions = shared.parseAskUserQuestionItems([
    { id: "q1", header: "Extras", prompt: "Add what?", multiple: true, options: [{ label: "Docs" }, { label: "CI" }, { label: "Tests" }] },
  ]);
  const answers = shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "q1", selectedLabels: ["Tests", "Docs"] },
  ]);
  const sent = JSON.parse(JSON.stringify(answers));
  assert.deepEqual(sent[0].selectedLabels, ["Docs", "Tests"]);
  assert.equal(sent[0].selectedLabel, "Docs, Tests");
});

test("a multi-select answer with typed text carries the labels and the text separately", () => {
  // The Gateway sends selectedLabels as selected_labels and customText as selected_label
  // when K-brain has question_selected_labels (Stack-Cairn/K-brain#168).
  const questions = shared.parseAskUserQuestionItems([
    { id: "q1", prompt: "Add what?", multiple: true, options: [{ label: "Search" }, { label: "filter" }, { label: "Search, filter" }] },
  ]);
  const [answer] = JSON.parse(JSON.stringify(shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "q1", selectedLabels: ["Search, filter"], customText: "a badge", custom: true },
  ])));
  assert.deepEqual(answer.selectedLabels, ["Search, filter"]);
  assert.equal(answer.customText, "a badge");
  assert.equal(answer.custom, true);
  assert.equal(answer.selectedLabel, "Search, filter, a badge");
});

test("question_answers from the Gateway settle the card with the exact labels", () => {
  // The details internal/kbrain builds from a call's question_answers (cardAnswer).
  const details = shared.parseAskUserQuestionResultDetails({
    kind: "ask_user_question",
    questions: [
      { id: "q1", prompt: "Which stack?", options: [{ label: "Go" }, { label: "Rust" }] },
      { id: "q2", prompt: "Add what?", multiple: true, options: [{ label: "Search" }, { label: "filter" }, { label: "Search, filter" }] },
    ],
    answers: [
      { questionId: "q1", prompt: "Which stack?", selectedLabel: "Go" },
      { questionId: "q2", prompt: "Add what?", selectedLabel: "Search, filter, a badge", selectedLabels: ["Search", "filter"], custom: true, customText: "a badge" },
    ],
  });
  assert.deepEqual(details.answers[0], { questionId: "q1", prompt: "Which stack?", selectedLabel: "Go" });
  assert.deepEqual(details.answers[1].selectedLabels, ["Search", "filter"]);
  assert.equal(details.answers[1].customText, "a badge");
  // Without selected_labels (an older backend) the joined text is still split.
  const old = shared.parseAskUserQuestionResultDetails({
    kind: "ask_user_question",
    questions: [{ id: "q2", prompt: "Add what?", multiple: true, options: [{ label: "Docs" }, { label: "Search, filter" }] }],
    answers: [{ questionId: "q2", prompt: "Add what?", selectedLabel: "Docs, Search, filter" }],
  });
  assert.deepEqual(old.answers[0].selectedLabels, ["Docs", "Search, filter"]);
});

test("the Gateway's direct-link approval preview shows K-brain's diff rows", () => {
  const item = approvalArgs.pendingToolApprovalFromToolCall({
    id: "edit-1",
    name: "edit",
    arguments: {
      path: "/w/a.go",
      __toolApprovalPending: true,
      __toolApprovalPreview: { path: "/w/a.go", before: "", after: "", diff: "3 - a\n3 + b", newFile: false, truncated: false },
    },
  });
  assert.deepEqual(item.preview, { path: "/w/a.go", before: "", after: "", truncated: false, diff: "3 - a\n3 + b" });
});

test("the original question arguments stay out of the displayed tool arguments", () => {
  const display = toolCallArgsForDisplay({
    type: "toolCall",
    id: "ask",
    name: "AskUserQuestion",
    arguments: { questions: [], [shared.KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG]: { question: "Proceed?" } },
  });
  assert.equal(shared.KBRAIN_QUESTION_ORIGINAL_ARGUMENTS_ARG in display, false);
});
