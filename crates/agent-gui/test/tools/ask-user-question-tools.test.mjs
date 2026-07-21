import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import * as typebox from "typebox";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function loadModules() {
  const loader = createTsModuleLoader({ mocks: { typebox } });
  return {
    shared: loader.loadModule("src/lib/chat/askUserQuestion.ts"),
    tools: loader.loadModule("src/lib/tools/askUserQuestionTools.ts"),
  };
}

function buildQuestionsArgs() {
  return {
    questions: [
      {
        id: "storage",
        header: "存储",
        prompt: "配置应当存放在哪里？",
        options: [
          { label: "应用数据目录", description: "不污染工作区", recommended: true },
          { label: "工作区根目录" },
          { label: "自定义路径" },
        ],
      },
      {
        prompt: "是否需要迁移旧数据？",
        options: [{ label: "迁移" }, { label: "不迁移", recommended: true }, { label: "稍后再说" }],
      },
    ],
  };
}

function createToolCall(argumentsValue, id = "call-ask-1") {
  return { type: "toolCall", id, name: "AskUserQuestion", arguments: argumentsValue };
}

test("AskUserQuestion schema accepts well-formed questions", () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const tool = bundle.tools.find((candidate) => candidate.name === "AskUserQuestion");
  assert.ok(tool);

  const args = validateToolArguments(tool, createToolCall(buildQuestionsArgs()));
  assert.equal(args.questions.length, 2);
});

test("parseAskUserQuestionItems enforces limits, ids, and single recommendation", () => {
  const { shared } = loadModules();

  assert.throws(() => shared.parseAskUserQuestionItems([]), /non-empty/);
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems(
        Array.from({ length: 5 }, (_, index) => ({
          prompt: `q${index}`,
          options: [{ label: "a" }, { label: "b" }],
        })),
      ),
    /at most 4 questions/,
  );
  assert.throws(
    () => shared.parseAskUserQuestionItems([{ prompt: "只有一个选项？", options: [{ label: "a" }] }]),
    /needs 2-6 options/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        {
          prompt: "重复推荐",
          options: [
            { label: "a", recommended: true },
            { label: "b", recommended: true },
          ],
        },
      ]),
    /at most one option as recommended/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        { prompt: "重复标签", options: [{ label: "same" }, { label: "same" }] },
      ]),
    /duplicate option label/,
  );
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        { id: "dup", prompt: "一", options: [{ label: "a" }, { label: "b" }] },
        { id: "dup", prompt: "二", options: [{ label: "a" }, { label: "b" }] },
      ]),
    /duplicate question id/,
  );

  // 同一轮各题选项数必须一致。
  assert.throws(
    () =>
      shared.parseAskUserQuestionItems([
        { prompt: "三个选项", options: [{ label: "a" }, { label: "b" }, { label: "c" }] },
        { prompt: "两个选项", options: [{ label: "x" }, { label: "y" }] },
      ]),
    /same number of options/,
  );

  const parsed = shared.parseAskUserQuestionItems(buildQuestionsArgs().questions);
  assert.deepEqual(
    parsed.map((question) => question.id),
    ["storage", "q2"],
  );
  assert.equal(parsed[0].options[0].recommended, true);
  // 推荐项固定排在第一位，其余保持原顺序。
  assert.deepEqual(
    parsed[1].options.map((option) => option.label),
    ["不迁移", "迁移", "稍后再说"],
  );
  assert.equal(parsed[1].options[0].recommended, true);
});

test("buildDefaultAskUserQuestionAnswers picks the recommended (or first) option", () => {
  const { shared } = loadModules();
  const questions = shared.parseAskUserQuestionItems([
    {
      prompt: "有推荐项",
      options: [{ label: "a" }, { label: "b", recommended: true }],
    },
    {
      prompt: "无推荐项",
      options: [{ label: "x" }, { label: "y" }],
    },
  ]);
  const defaults = shared.buildDefaultAskUserQuestionAnswers(questions);
  assert.deepEqual(
    defaults.map((answer) => answer.selectedLabel),
    ["b", "x"],
  );
  assert.match(
    shared.buildAskUserQuestionResultText(defaults, { timedOut: true }),
    /did not answer within the time limit/,
  );
});

test("sanitizeAskUserQuestionItems tolerates streaming partial arguments", () => {
  const { shared } = loadModules();
  assert.deepEqual(shared.sanitizeAskUserQuestionItems(undefined), []);
  assert.deepEqual(shared.sanitizeAskUserQuestionItems([{ prompt: "缺选项" }]), []);

  const partial = shared.sanitizeAskUserQuestionItems([
    { prompt: "已成形的问题", options: [{ label: "选项 A", recommended: true }, { label: "" }] },
    { prompt: "", options: [{ label: "x" }] },
  ]);
  assert.equal(partial.length, 1);
  assert.equal(partial[0].id, "q1");
  assert.deepEqual(partial[0].options, [{ label: "选项 A", recommended: true }]);
});

test("execute suspends until the user answers, then returns the selections", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const toolCall = createToolCall(buildQuestionsArgs(), "call-ask-answer");

  const resultPromise = bundle.executeToolCall(toolCall);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-answer"), true);

  // 非法应答（缺第二题）不落定，也不清挂起态。
  const invalid = tools.answerAskUserQuestion("call-ask-answer", [
    { questionId: "storage", selectedLabel: "应用数据目录" },
  ]);
  assert.equal(invalid.ok, false);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-answer"), true);

  // 选项必须来自问题定义。
  const wrongLabel = tools.answerAskUserQuestion("call-ask-answer", [
    { questionId: "storage", selectedLabel: "不存在的选项" },
    { questionId: "q2", selectedLabel: "迁移" },
  ]);
  assert.equal(wrongLabel.ok, false);

  const accepted = tools.answerAskUserQuestion("call-ask-answer", [
    { questionId: "storage", selectedLabel: "应用数据目录" },
    { questionId: "q2", selectedLabel: "不迁移" },
  ]);
  assert.equal(accepted.ok, true);

  const result = await resultPromise;
  assert.equal(result.isError, false);
  assert.equal(result.details.kind, "ask_user_question");
  assert.deepEqual(
    result.details.answers.map((answer) => answer.selectedLabel),
    ["应用数据目录", "不迁移"],
  );
  assert.match(result.content[0].text, /proceed accordingly/);
  assert.match(result.content[0].text, /应用数据目录/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-answer"), false);

  // 已落定的提问不能再次应答。
  const late = tools.answerAskUserQuestion("call-ask-answer", []);
  assert.equal(late.ok, false);
});

test("timeout auto-selects the recommended options and continues", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1", timeoutMs: 50 });
  const toolCall = createToolCall(buildQuestionsArgs(), "call-ask-timeout");

  const result = await bundle.executeToolCall(toolCall);
  assert.equal(result.isError, false);
  assert.equal(result.details.timedOut, true);
  assert.deepEqual(
    result.details.answers.map((answer) => answer.selectedLabel),
    ["应用数据目录", "不迁移"],
  );
  assert.match(result.content[0].text, /did not answer within the time limit/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-timeout"), false);

  // 超时落定后不能再应答。
  const late = tools.answerAskUserQuestion("call-ask-timeout", [
    { questionId: "storage", selectedLabel: "工作区根目录" },
    { questionId: "q2", selectedLabel: "迁移" },
  ]);
  assert.equal(late.ok, false);
});

test("abort settles a pending question as cancelled", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const controller = new AbortController();
  const toolCall = createToolCall(buildQuestionsArgs(), "call-ask-abort");

  const resultPromise = bundle.executeToolCall(toolCall, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();

  const result = await resultPromise;
  assert.equal(result.isError, true);
  assert.equal(result.details.cancelled, true);
  assert.deepEqual(result.details.answers, []);
  assert.match(result.content[0].text, /stopped the turn/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-abort"), false);
});

test("conversation disposal cancels its pending questions only", async () => {
  const { tools } = loadModules();
  const bundleA = tools.createAskUserQuestionTools({ conversationId: "conv-a" });
  const bundleB = tools.createAskUserQuestionTools({ conversationId: "conv-b" });

  const promiseA = bundleA.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-a"));
  const promiseB = bundleB.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-b"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  tools.cancelPendingAskUserQuestionsForConversation("conv-a");
  const resultA = await promiseA;
  assert.equal(resultA.details.cancelled, true);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-b"), true);

  const accepted = tools.answerAskUserQuestion("call-ask-b", [
    { questionId: "storage", selectedLabel: "工作区根目录" },
    { questionId: "q2", selectedLabel: "迁移" },
  ]);
  assert.equal(accepted.ok, true);
  const resultB = await promiseB;
  assert.equal(resultB.isError, false);
});

test("invalid arguments fail fast with a validation error result", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const result = await bundle.executeToolCall(
    createToolCall({ questions: [{ prompt: "选项不足", options: [{ label: "唯一" }] }] }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /needs 2-6 options/);
  assert.deepEqual(result.details, {});
});

test("result details round-trip through the transcript parser", () => {
  const { shared } = loadModules();
  const questions = shared.parseAskUserQuestionItems(buildQuestionsArgs().questions);
  const answers = shared.resolveAskUserQuestionAnswers(questions, [
    { questionId: "storage", selectedLabel: "应用数据目录" },
    { questionId: "q2", selectedLabel: "不迁移" },
  ]);
  assert.ok(answers);

  const parsed = shared.parseAskUserQuestionResultDetails({
    kind: "ask_user_question",
    questions,
    answers,
  });
  assert.ok(parsed);
  assert.equal(parsed.questions.length, 2);
  assert.equal(parsed.answers.length, 2);
  assert.equal(parsed.cancelled, false);

  assert.equal(shared.parseAskUserQuestionResultDetails({ kind: "todo_write" }), null);
  assert.equal(shared.parseAskUserQuestionResultDetails(null), null);
});

test("remote answers are rejected when the conversation does not match", async () => {
  const { tools } = loadModules();
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-owner" });
  const resultPromise = bundle.executeToolCall(createToolCall(buildQuestionsArgs(), "call-ask-conv"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const answers = [
    { questionId: "storage", selectedLabel: "应用数据目录" },
    { questionId: "q2", selectedLabel: "不迁移" },
  ];
  // 携带会话上下文的应答（WebUI tool_answer 通道）必须命中挂起提问所属会话。
  const mismatch = tools.answerAskUserQuestion("call-ask-conv", answers, {
    conversationId: "conv-other",
  });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /different conversation/);
  assert.equal(tools.hasPendingAskUserQuestion("call-ask-conv"), true);

  const accepted = tools.answerAskUserQuestion("call-ask-conv", answers, {
    conversationId: "conv-owner",
  });
  assert.equal(accepted.ok, true);
  const result = await resultPromise;
  assert.equal(result.isError, false);
});

test("gateway deadline stamp is preset once and adopted by execute", async () => {
  const { shared, tools } = loadModules();

  // 网关参数上报先于 execute：首次 ensure 预置，之后幂等返回同一值。
  const preset = tools.ensureAskUserQuestionDeadlineAt("call-ask-deadline");
  assert.ok(preset > Date.now());
  assert.equal(tools.ensureAskUserQuestionDeadlineAt("call-ask-deadline"), preset);
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-deadline"), preset);

  // execute 挂起后复用同一预置值作为权威 deadline（不重新计时）。
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1" });
  const resultPromise = bundle.executeToolCall(
    createToolCall(buildQuestionsArgs(), "call-ask-deadline"),
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-deadline"), preset);
  assert.equal(tools.ensureAskUserQuestionDeadlineAt("call-ask-deadline"), preset);

  tools.answerAskUserQuestion("call-ask-deadline", [
    { questionId: "storage", selectedLabel: "应用数据目录" },
    { questionId: "q2", selectedLabel: "不迁移" },
  ]);
  await resultPromise;
  // 落定后清理，读取回落 null（卡片此时已只读，无需倒计时）。
  assert.equal(tools.getAskUserQuestionDeadlineAt("call-ask-deadline"), null);

  // 参数上盖章的读取器：合法数值透传，缺失/非法回 null。
  const stamped = { questions: [], [shared.ASK_USER_QUESTION_DEADLINE_ARG]: preset };
  assert.equal(shared.readAskUserQuestionDeadlineAt(stamped), preset);
  assert.equal(shared.readAskUserQuestionDeadlineAt({ questions: [] }), null);
  assert.equal(
    shared.readAskUserQuestionDeadlineAt({ [shared.ASK_USER_QUESTION_DEADLINE_ARG]: "soon" }),
    null,
  );
  assert.equal(shared.readAskUserQuestionDeadlineAt(null), null);
});

test("injected test timeout overrides a preset deadline", async () => {
  const { tools } = loadModules();
  // 预置一个 3 分钟后的 deadline；注入 timeoutMs 必须无视它，避免测试悬挂。
  tools.ensureAskUserQuestionDeadlineAt("call-ask-timeout-preset");
  const bundle = tools.createAskUserQuestionTools({ conversationId: "conv-1", timeoutMs: 50 });
  const result = await bundle.executeToolCall(
    createToolCall(buildQuestionsArgs(), "call-ask-timeout-preset"),
  );
  assert.equal(result.details.timedOut, true);
});
