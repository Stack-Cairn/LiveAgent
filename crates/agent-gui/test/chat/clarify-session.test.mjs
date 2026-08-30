// crates/agent-gui/test/chat/clarify-session.test.mjs
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const rootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const abs = (rel) => path.join(rootDir, rel);

// React mock：hook 只用 useRef/useCallback/useSyncExternalStore，全部可空实现
// （测试只直测 createClarifySessionCore，hook 部分由 Task 5 手测）。
const reactMock = {
  useState: (initial) => [initial, () => {}],
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  useEffect: (fn) => (fn(), () => {}),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
};
const loader = createTsModuleLoader({ mocks: { react: reactMock } });
const mod = loader.loadModule(
  abs("../agent-ui/src/components/chat/clarify/useClarifySession.ts"),
);

const QUESTION = "[CLARIFY_QUESTION]\n要做什么功能？";
const FINAL = "[CLARIFY_FINAL]\n优化后的提示词";

test("happy path: question then final", async () => {
  const seenInputs = [];
  const runTurn = async (messages, _signal, onDelta) => {
    seenInputs.push(messages);
    if (onDelta) onDelta(QUESTION.slice(0, 10));
    return seenInputs.length === 1 ? QUESTION : FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("帮我写个脚本");
  assert.equal(session.getState().status, "awaitingInput");
  assert.equal(session.getState().questionCount, 1);
  await session.submitAnswer("批量改文件名");
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["优化后的提示词"]);
  // 第二轮输入应包含第一轮问答 + system
  const second = seenInputs[1];
  assert.equal(second[0].role, "system");
  assert.equal(second.filter((m) => m.role === "assistant").length, 1);
});

test("exceeding max questions force-injects final instruction", async () => {
  let calls = 0;
  const runTurn = async (messages) => {
    calls += 1;
    if (messages.at(-1).content.includes("CLARIFY_FINAL")) {
      return FINAL; // 已是强制指令轮
    }
    return QUESTION;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("draft");
  for (let i = 0; i < mod.CLARIFY_MAX_QUESTIONS; i++) {
    await session.submitAnswer(`a${i}`);
  }
  // 第 6 轮：不追加提问，直接强制终稿
  assert.equal(session.getState().status, "done");
  assert.ok(calls <= mod.CLARIFY_MAX_QUESTIONS + 1);
});

test("forceFinal injects instruction and produces final", async () => {
  const runTurn = async (messages) =>
    messages.at(-1).content.includes("CLARIFY_FINAL") ? FINAL : QUESTION;
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  await session.forceFinal();
  assert.deepEqual(finals, ["优化后的提示词"]);
});

test("error state keeps messages; retry resends", async () => {
  let fail = true;
  const runTurn = async () => {
    if (fail) throw new Error("boom");
    return FINAL;
  };
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  await session.start("d");
  assert.equal(session.getState().status, "error");
  assert.match(session.getState().error, /boom/);
  fail = false;
  await session.retry();
  assert.equal(session.getState().status, "done");
  assert.deepEqual(finals, ["优化后的提示词"]);
});

test("unmarked reply falls back to question", async () => {
  const runTurn = async () => "没有标记的一句话";
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  assert.equal(session.getState().status, "awaitingInput");
  assert.equal(session.getState().visibleMessages.at(-1).content, "没有标记的一句话");
});
