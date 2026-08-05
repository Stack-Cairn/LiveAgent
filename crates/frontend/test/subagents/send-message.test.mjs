import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const sendMessageModule = loader.loadModule("src/lib/subagents/sendMessageTool.ts");

function createFakeSendMessageStore(options = {}) {
  const appended = [];
  let seq = 0;
  return {
    appended,
    conversationId: options.conversationId ?? "conversation-1",
    async ready() {
      if (options.readyError) throw options.readyError;
    },
    knownAgentIds: () => options.knownAgentIds ?? ["agent-a", "agent-b"],
    async appendBusMessage(input) {
      if (options.appendError) throw options.appendError;
      seq += 1;
      const record = {
        id: seq,
        parentConversationId: options.conversationId ?? "conversation-1",
        seq,
        createdAt: 1_000 + seq,
        ...input,
      };
      appended.push(record);
      return { ...record };
    },
  };
}

function createBundle(params = {}) {
  const store = params.store ?? createFakeSendMessageStore(params.storeOptions);
  const bundle = sendMessageModule.createSendMessageTools({
    store,
    senderId: params.senderId ?? "agent-a",
    senderName: params.senderName ?? "Agent A",
    currentRunId: params.currentRunId,
  });
  return { store, bundle };
}

function sendCall(argumentsValue, id = "call-send") {
  return { type: "toolCall", id, name: "SendMessage", arguments: argumentsValue };
}

test("subagent sends a direct message to the parent", async () => {
  const { store, bundle } = createBundle({ currentRunId: "run-1" });
  const result = await bundle.executeToolCall(
    sendCall({ to: "parent", message: "Found the bug in policy.ts.", subject: "Bug" }),
  );

  assert.equal(result.isError, false);
  assert.match(result.content[0].text, /Message sent to parent via LiveAgent Message Bus\./);
  assert.match(result.content[0].text, /seq=1/);
  assert.match(result.content[0].text, /channel=direct/);

  const details = result.details;
  assert.equal(details.kind, "subagent_message");
  assert.equal(details.parentConversationId, "conversation-1");
  assert.equal(details.seq, 1);
  assert.equal(details.senderId, "agent-a");
  assert.equal(details.senderName, "Agent A");
  assert.equal(details.recipientId, "parent");
  assert.equal(details.recipientName, "Parent Agent");
  assert.equal(details.channel, "direct");
  assert.equal(details.subject, "Bug");
  assert.equal(details.sourceRunId, "run-1");
  assert.equal(details.sourceToolCallId, "call-send");
  assert.equal(details.bodyPreview, "Found the bug in policy.ts.");
  assert.equal(store.appended[0].recipientId, "parent");
});

test("broadcast to * defaults the channel to shared", async () => {
  const { bundle } = createBundle();
  const result = await bundle.executeToolCall(sendCall({ to: "*", message: "FYI everyone" }));
  assert.equal(result.isError, false);
  assert.equal(result.details.recipientId, "*");
  assert.equal(result.details.recipientName, "All Agents");
  assert.equal(result.details.channel, "shared");
  assert.match(result.content[0].text, /Message sent to all agents/);
});

test("direct recipient resolves case-insensitively to the canonical roster id", async () => {
  const { bundle } = createBundle();
  const result = await bundle.executeToolCall(
    sendCall({ to: "  AGENT-B ", message: "ping", channel: "shared" }),
  );
  assert.equal(result.isError, false);
  assert.equal(result.details.recipientId, "agent-b");
  // shared channel normalizes to direct for a single recipient.
  assert.equal(result.details.channel, "direct");
});

test("missing to is only allowed with channel=shared and then broadcasts", async () => {
  const { bundle } = createBundle();
  const broadcast = await bundle.executeToolCall(
    sendCall({ message: "team update", channel: "shared" }),
  );
  assert.equal(broadcast.isError, false);
  assert.equal(broadcast.details.recipientId, "*");
  assert.equal(broadcast.details.channel, "shared");

  const missing = await bundle.executeToolCall(sendCall({ message: "who gets this?" }));
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /SendMessage requires "to" unless channel=shared/);
  assert.match(missing.content[0].text, /Valid recipients: "parent", "\*", "agent-b"\./);
});

test("unknown recipient is rejected with the valid recipient list", async () => {
  const { store, bundle } = createBundle();
  const result = await bundle.executeToolCall(sendCall({ to: "nobody", message: "hello?" }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown recipient "nobody"/);
  assert.match(result.content[0].text, /"parent", "\*", "agent-b"/);
  // The sender itself is not offered as a recipient.
  assert.doesNotMatch(result.content[0].text, /"agent-a"/);
  assert.equal(store.appended.length, 0);
});

test("the parent-side sender cannot send a message to parent", async () => {
  const { store, bundle } = createBundle({ senderId: "parent", senderName: "Parent Agent" });
  const result = await bundle.executeToolCall(sendCall({ to: "parent", message: "self note" }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /The parent agent cannot send a message to itself\./);
  // "parent" is not listed as a valid target for the parent sender.
  assert.match(result.content[0].text, /Valid recipients: "\*", "agent-a", "agent-b"\./);
  assert.equal(store.appended.length, 0);

  const toAgent = await bundle.executeToolCall(sendCall({ to: "agent-a", message: "task" }));
  assert.equal(toAgent.isError, false);
  assert.equal(toAgent.details.senderId, "parent");
  assert.equal(toAgent.details.recipientId, "agent-a");
});

test("a non-empty message body is required", async () => {
  const { store, bundle } = createBundle();
  for (const argumentsValue of [{}, { to: "parent" }, { to: "parent", message: "   " }]) {
    const result = await bundle.executeToolCall(sendCall(argumentsValue));
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /requires a non-empty message field/);
  }
  assert.equal(store.appended.length, 0);
});

test("channel normalization: broadcast keeps decision/question, coerces direct to shared", async () => {
  const { bundle } = createBundle();
  const cases = [
    { to: "*", channel: "direct", expected: "shared" },
    { to: "*", channel: "decision", expected: "decision" },
    { to: "*", channel: "question", expected: "question" },
    { to: "agent-b", channel: "question", expected: "question" },
    { to: "agent-b", channel: "decision", expected: "decision" },
    { to: "agent-b", channel: undefined, expected: "direct" },
  ];
  for (const { to, channel, expected } of cases) {
    const result = await bundle.executeToolCall(sendCall({ to, channel, message: "m" }));
    assert.equal(result.isError, false, `to=${to} channel=${channel}`);
    assert.equal(result.details.channel, expected, `to=${to} channel=${channel}`);
  }
});

test("store failures produce tool errors instead of silent drops", async () => {
  const unavailable = createBundle({ storeOptions: { conversationId: "" } });
  const noConversation = await unavailable.bundle.executeToolCall(
    sendCall({ to: "parent", message: "hi" }),
  );
  assert.equal(noConversation.isError, true);
  assert.match(noConversation.content[0].text, /SendMessage is unavailable/);

  const failing = createBundle({ storeOptions: { appendError: new Error("bus offline") } });
  const notPersisted = await failing.bundle.executeToolCall(
    sendCall({ to: "parent", message: "hi" }),
  );
  assert.equal(notPersisted.isError, true);
  assert.match(notPersisted.content[0].text, /bus offline/);

  const rosterBroken = createBundle({ storeOptions: { readyError: new Error("roster gone") } });
  const noRoster = await rosterBroken.bundle.executeToolCall(
    sendCall({ to: "parent", message: "hi" }),
  );
  assert.equal(noRoster.isError, true);
  assert.match(noRoster.content[0].text, /roster gone/);
});
