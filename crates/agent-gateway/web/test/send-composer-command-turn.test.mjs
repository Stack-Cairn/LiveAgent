import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// WebUI 的“/”指令发送：指令语义映射成聊天请求字段；未被接受时抛错，输入框据此保留草稿。
const loader = createWebModuleLoader();
const { sendComposerCommandTurn } = loader.loadModule("src/app/sendComposerCommandTurn.ts");
const t = (key) => key;
const idle = () => false;

test("goal and prompt commands map onto chat request fields for the target conversation", async () => {
  const calls = [];
  const sendChat = async (text, options) => {
    calls.push([text, options]);
    return { kind: "accepted", accepted: { conversationId: "c1" } };
  };
  await sendComposerCommandTurn(sendChat, t, "/goal ship", { kind: "goal", action: "set", goal: "ship" }, { conversationId: "c1", isBusy: idle });
  await sendComposerCommandTurn(sendChat, t, "/review", { kind: "prompt" }, { isBusy: idle });
  assert.equal(calls[0][1].conversationId, "c1");
  assert.equal(calls[0][1].goalAction, "set");
  assert.equal(calls[0][1].goalText, "ship");
  assert.equal(calls[1][1].promptCommand, true);
  assert.equal(calls[1][1].conversationId, undefined);
});

test("a send that is not accepted throws instead of silently dropping the command", async () => {
  await assert.rejects(
    sendComposerCommandTurn(async () => null, t, "/review", { kind: "prompt" }, { isBusy: idle }),
    /chat\.commands\.busy/,
  );
  await assert.rejects(
    sendComposerCommandTurn(async () => ({ kind: "failed", errorCode: null, message: "offline" }), t, "/review", { kind: "prompt" }, { isBusy: idle }),
    /offline/,
  );
});

test("a command turn is refused while the conversation is busy instead of being queued", async () => {
  // 桌面端的 sendTurn 先查会话是否在跑，在跑就报忙、不发送。WebUI 以前直接 sendChat，
  // 网关按 queuePolicy "auto" 把 /goal 排进等待队列，上一轮结束后自动执行。
  const calls = [];
  const sendChat = async (text, options) => {
    calls.push([text, options]);
    return { kind: "accepted", accepted: { conversationId: "c1" } };
  };
  await assert.rejects(
    sendComposerCommandTurn(sendChat, t, "/goal ship", { kind: "goal", action: "set", goal: "ship" }, {
      conversationId: "c1",
      isBusy: () => true,
    }),
    /chat\.commands\.busy/,
  );
  assert.equal(calls.length, 0);
  await sendComposerCommandTurn(sendChat, t, "/goal ship", { kind: "goal", action: "set", goal: "ship" }, {
    conversationId: "c1",
    isBusy: () => false,
  });
  assert.equal(calls.length, 1);
});
