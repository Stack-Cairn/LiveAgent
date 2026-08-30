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

test("close() during in-flight ask leaves state idle and produces no error afterwards", async () => {
  let rejectTurn;
  const runTurn = () =>
    new Promise((_resolve, reject) => {
      rejectTurn = reject;
    });
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  const pending = session.start("d");
  session.close();
  // close 之后 runTurn 才以 abort 类错误 reject：不得污染已重置的 idle 态。
  const abortLike = new Error("The operation was aborted");
  abortLike.name = "AbortError";
  rejectTurn(abortLike);
  await pending;
  const s = session.getState();
  assert.equal(s.status, "idle");
  assert.equal(s.error, null);
  assert.deepEqual(s.visibleMessages, []);
  assert.equal(s.questionCount, 0);
});

test("close() then start() while old ask in flight: stale completion must not corrupt the new session", async () => {
  const pending = [];
  const runTurn = () =>
    new Promise((resolve) => {
      pending.push(resolve);
    });
  const finals = [];
  const session = mod.createClarifySessionCore(runTurn, { onFinal: (t) => finals.push(t) });
  const first = session.start("old");
  session.close();
  const second = session.start("new");
  // 旧请求迟到返回一个「问题」：不得写入新会话的消息，也不得改状态。
  pending[0](QUESTION);
  await first;
  assert.equal(session.getState().status, "asking");
  assert.deepEqual(
    session.getState().visibleMessages.map((m) => m.content),
    ["new"],
  );
  pending[1](FINAL);
  await second;
  assert.equal(session.getState().status, "done");
  assert.deepEqual(
    session.getState().visibleMessages.map((m) => m.content),
    ["new", FINAL],
  );
  assert.deepEqual(finals, ["优化后的提示词"]);
});

test("second start() without close() aborts the first request and discards its stale completion", async () => {
  const pending = [];
  const signals = [];
  const runTurn = (_messages, signal) =>
    new Promise((resolve) => {
      signals.push(signal);
      pending.push(resolve);
    });
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  const first = session.start("old");
  const second = session.start("new");
  // start() 必须中止旧请求的 signal，而不是任由其自流。
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  pending[0](QUESTION); // 旧请求迟到返回
  await first;
  assert.equal(session.getState().status, "asking");
  assert.deepEqual(
    session.getState().visibleMessages.map((m) => m.content),
    ["new"],
  );
  pending[1](FINAL);
  await second;
  assert.equal(session.getState().status, "done");
});

test("subscribe fires on state changes and unsubscribe stops notifications", async () => {
  const runTurn = async () => FINAL;
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  let calls = 0;
  const unsubscribe = session.subscribe(() => {
    calls += 1;
  });
  await session.start("d");
  assert.ok(calls > 0, "subscribe listener should have fired on state changes");
  const afterStart = calls;
  unsubscribe();
  session.close();
  assert.equal(calls, afterStart);
});

test("streamingText accumulates onDelta values during asking", async () => {
  const snapshots = [];
  const runTurn = async (_messages, _signal, onDelta) => {
    if (onDelta) {
      onDelta("你");
      onDelta("好");
    }
    return FINAL;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  session.subscribe(() => snapshots.push(session.getState().streamingText));
  await session.start("d");
  assert.ok(snapshots.includes("你"), "first delta should be visible while asking");
  assert.ok(snapshots.includes("你好"), "deltas should accumulate");
  assert.equal(session.getState().streamingText, "", "streamingText cleared after turn end");
});

test("retry() is a no-op when status is not error", async () => {
  let calls = 0;
  const runTurn = async () => {
    calls += 1;
    return QUESTION;
  };
  const session = mod.createClarifySessionCore(runTurn, { onFinal: () => {} });
  await session.start("d");
  assert.equal(session.getState().status, "awaitingInput");
  await session.retry();
  assert.equal(calls, 1, "retry must not resend when not in error state");
  assert.equal(session.getState().status, "awaitingInput");
});

test("throwing onFinal does not clobber the committed done state", async () => {
  const runTurn = async () => FINAL;
  const session = mod.createClarifySessionCore(runTurn, {
    onFinal: () => {
      throw new Error("host callback boom");
    },
  });
  await session.start("d");
  const s = session.getState();
  assert.equal(s.status, "done");
  assert.equal(s.error, null);
});
