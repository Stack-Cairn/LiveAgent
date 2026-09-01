// crates/agent-gui/test/chat/clarify-protocol.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);
const loader = createTsModuleLoader({ mocks: {} });
const protocol = loader.loadModule(
  abs("../agent-ui/src/components/chat/clarify/clarifyProtocol.ts"),
);

const QUESTIONS_JSON = JSON.stringify({
  questions: [
    {
      id: "q1",
      header: "范围",
      prompt: "要做什么功能？",
      options: [
        { label: "批量重命名", description: "按规则改文件名" },
        { label: "格式转换", recommended: true },
      ],
    },
    {
      prompt: "目标平台？",
      options: [{ label: "Web" }, { label: "移动端" }],
      allowMultiple: true,
    },
  ],
});

test("questions marker + JSON parses into normalized questions", () => {
  const r = protocol.parseClarifyTurn(`[CLARIFY_QUESTIONS]\n${QUESTIONS_JSON}`);
  assert.equal(r.kind, "questions");
  assert.equal(r.questions.length, 2);
  assert.equal(r.questions[0].id, "q1");
  assert.equal(r.questions[0].header, "范围");
  assert.equal(r.questions[0].options.length, 2);
  assert.equal(r.questions[0].options[1].recommended, true);
  // 缺失 id 按序号补齐；allowMultiple 透传。
  assert.equal(r.questions[1].id, "q2");
  assert.equal(r.questions[1].allowMultiple, true);
});

test("final marker parses", () => {
  const r = protocol.parseClarifyTurn("[CLARIFY_FINAL]\n优化后的提示词正文");
  assert.equal(r.kind, "final");
  assert.equal(r.text, "优化后的提示词正文");
});

test("fenced JSON without marker still parses as questions", () => {
  const r = protocol.parseClarifyTurn("```json\n" + QUESTIONS_JSON + "\n```");
  assert.equal(r.kind, "questions");
  assert.equal(r.questions.length, 2);
});

test("invalid JSON falls back to a single open question", () => {
  const r = protocol.parseClarifyTurn("直接一句没有标记的话");
  assert.equal(r.kind, "questions");
  assert.equal(r.questions.length, 1);
  assert.equal(r.questions[0].prompt, "直接一句没有标记的话");
  assert.deepEqual(r.questions[0].options, []);
});

test("normalization drops blank prompts, dedupes ids/labels and enforces caps", () => {
  const payload = {
    questions: [
      { id: "a", prompt: "", options: [] }, // 空 prompt 丢弃
      {
        id: "dup",
        prompt: "Q1",
        options: [
          { label: "x" },
          { label: "x" }, // 重复 label 丢弃
          { label: "  " }, // 空 label 丢弃
          { label: "1" },
          { label: "2" },
          { label: "3" },
          { label: "4" },
          { label: "5" }, // 超过上限截断
          { label: "6" },
        ],
      },
      { id: "dup", prompt: "Q2", options: [] }, // 重复 id 重派
      { id: "q3", prompt: "Q3", options: [] },
      { id: "q4", prompt: "Q4", options: [] },
      { id: "q5", prompt: "Q5", options: [] }, // 超过每轮上限截断
    ],
  };
  const questions = protocol.normalizeClarifyQuestions(payload);
  assert.equal(questions.length, protocol.CLARIFY_MAX_QUESTIONS_PER_ROUND);
  assert.equal(questions[0].id, "dup");
  assert.equal(questions[0].options.length, protocol.CLARIFY_MAX_OPTIONS_PER_QUESTION);
  assert.notEqual(questions[1].id, "dup");
});

test("clarifyStreamPreview hides markers and JSON, streams final text", () => {
  // 标记碎片与 JSON 都不上屏。
  assert.equal(protocol.clarifyStreamPreview("[CLARIFY_QUE"), "");
  assert.equal(protocol.clarifyStreamPreview("[CLARIFY_QUESTIONS]\n{\"questions\":["), "");
  assert.equal(protocol.clarifyStreamPreview('{"questions":[{"id"'), "");
  assert.equal(protocol.clarifyStreamPreview("```json"), "");
  // 终稿标记后的文本逐字上屏。
  assert.equal(protocol.clarifyStreamPreview("[CLARIFY_FINAL]\n终稿开头"), "终稿开头");
  // 排除标记可能性后的普通文本照常显示（降级开放问题）。
  assert.equal(protocol.clarifyStreamPreview("这是一段足够长的普通提问文本"), "这是一段足够长的普通提问文本");
});

test("buildClarifyAnswersMessage serializes picks, custom text and skips", () => {
  const round = {
    questions: [
      { id: "q1", prompt: "要做什么？", options: [{ label: "A" }], allowMultiple: true },
      { id: "q2", prompt: "平台？", options: [{ label: "Web" }] },
      { id: "q3", prompt: "跳过的问题", options: [] },
    ],
    answers: [
      { questionId: "q1", prompt: "要做什么？", selectedLabels: ["A"], customText: "还要支持撤销" },
      { questionId: "q2", prompt: "平台？", selectedLabels: ["Web"] },
      { questionId: "q3", prompt: "跳过的问题", selectedLabels: [] },
    ],
  };
  const message = protocol.buildClarifyAnswersMessage(round);
  assert.ok(message.startsWith("[CLARIFY_ANSWERS]"));
  assert.match(message, /Q1: 要做什么？/);
  assert.match(message, /A1: A; 还要支持撤销/);
  assert.match(message, /A2: Web/);
  assert.match(message, /A3: \(not answered\)/);
});

test("system prompt contains protocol markers, caps and workspace context", () => {
  const p = protocol.buildClarifySystemPrompt({ workdir: "/repo/x", gitBranch: "main" });
  assert.match(p, /\[CLARIFY_QUESTIONS\]/);
  assert.match(p, /\[CLARIFY_FINAL\]/);
  assert.match(p, /\[CLARIFY_ANSWERS\]/);
  assert.match(p, /\/repo\/x/);
  assert.match(p, /main/);
  assert.ok(p.includes(`1-${protocol.CLARIFY_MAX_QUESTIONS_PER_ROUND} questions`));
  const bare = protocol.buildClarifySystemPrompt();
  assert.doesNotMatch(bare, /Workspace:/);
});

test("buildClarifyMessages prepends system", () => {
  const msgs = protocol.buildClarifyMessages(
    [{ role: "user", content: "hi" }],
    { workdir: "/w" },
  );
  assert.equal(msgs[0].role, "system");
  assert.equal(msgs.length, 2);
});
