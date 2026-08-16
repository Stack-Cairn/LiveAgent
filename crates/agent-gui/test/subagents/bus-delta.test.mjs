import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const bus = loader.loadModule("src/lib/subagents/bus.ts");
const tailBlock = loader.loadModule("src/lib/chat/context/contextTailBlock.ts");

let nextSeq = 0;
function makeMessage(overrides = {}) {
  nextSeq += 1;
  return {
    id: nextSeq,
    parentConversationId: "conversation-1",
    seq: overrides.seq ?? nextSeq,
    senderId: overrides.senderId ?? "agent-x",
    senderName: overrides.senderName,
    recipientId: overrides.recipientId ?? "parent",
    recipientName: overrides.recipientName,
    channel: overrides.channel ?? "direct",
    subject: overrides.subject,
    bodyMarkdown: overrides.bodyMarkdown ?? `message body ${nextSeq}`,
    createdAt: overrides.createdAt ?? 1_700_000_000_000 + nextSeq,
  };
}

function delta(messages, sinceSeq, overrides = {}) {
  return bus.renderMessageBusDelta({
    messages,
    sinceSeq,
    currentAgentId: overrides.currentAgentId ?? "parent",
    currentAgentName: overrides.currentAgentName,
    maxBodyChars: overrides.maxBodyChars,
  });
}

test("delta renders nothing and holds the cursor when no message is newer than sinceSeq", () => {
  const messages = [
    makeMessage({ seq: 11, bodyMarkdown: "already delivered" }),
    makeMessage({ seq: 12, bodyMarkdown: "also delivered" }),
  ];

  assert.deepEqual(delta(messages, 12), { text: "", lastSeq: 12 });
  assert.deepEqual(delta([], 7), { text: "", lastSeq: 7 });
  // 游标领先于全部消息（压缩后重冻结的极端情况）也不得回退。
  assert.deepEqual(delta(messages, 99), { text: "", lastSeq: 99 });
});

test("delta carries only messages after the cursor and advances it to the newest seq", () => {
  const messages = [
    makeMessage({ seq: 1, bodyMarkdown: "old one" }),
    makeMessage({ seq: 2, bodyMarkdown: "old two" }),
    makeMessage({ seq: 3, bodyMarkdown: "fresh three" }),
    makeMessage({ seq: 4, recipientId: "*", channel: "decision", bodyMarkdown: "fresh four" }),
  ];

  const result = delta(messages, 2);
  assert.equal(result.lastSeq, 4);
  assert.doesNotMatch(result.text, /old one/);
  assert.doesNotMatch(result.text, /old two/);
  assert.match(result.text, /> fresh three/);
  assert.match(result.text, /> fresh four/);
  assert.match(result.text, /^## LiveAgent Message Bus \(new messages\)/);
  assert.match(result.text, /Current agent: `parent`/);
  // 顺序按 seq 升序，与快照同口径。
  assert.ok(result.text.indexOf("fresh three") < result.text.indexOf("fresh four"));
});

test("delta reuses the snapshot visibility filter", () => {
  const invisible = [
    // 定向给别的 agent
    makeMessage({ seq: 21, recipientId: "agent-b", bodyMarkdown: "secret for b" }),
    // 空正文
    makeMessage({ seq: 22, bodyMarkdown: "   " }),
    // 空会话归属
    { ...makeMessage({ seq: 23, bodyMarkdown: "orphan" }), parentConversationId: "  " },
  ];
  assert.deepEqual(delta(invisible, 20), { text: "", lastSeq: 20 });
  assert.equal(bus.renderMessageBusSnapshot({ messages: invisible, currentAgentId: "parent" }).text, "");

  const visible = [
    makeMessage({ seq: 24, recipientId: "parent", bodyMarkdown: "direct to parent" }),
    makeMessage({ seq: 25, recipientId: "*", bodyMarkdown: "broadcast" }),
    makeMessage({ seq: 26, senderId: "parent", recipientId: "agent-b", bodyMarkdown: "sent by me" }),
  ];
  const result = delta([...invisible, ...visible], 20);
  assert.equal(result.lastSeq, 26);
  assert.doesNotMatch(result.text, /secret for b/);
  assert.doesNotMatch(result.text, /orphan/);
  assert.match(result.text, /> direct to parent/);
  assert.match(result.text, /> broadcast/);
  assert.match(result.text, /> sent by me/);
});

test("delta is pure: same input renders byte-identical output", () => {
  const first = makeMessage({ seq: 31, bodyMarkdown: "deterministic", createdAt: 1_700_000_000_001 });
  const second = makeMessage({ seq: 32, bodyMarkdown: "later", createdAt: 1_700_000_000_002 });
  assert.equal(delta([first], 30).text, delta([first], 30).text);
  // 乱序输入不影响输出（内部按 seq 排序）。
  assert.equal(delta([first, second], 30).text, delta([second, first], 30).text);
});

test("overflow snapshot exposes renderedSeq so unrendered messages get re-delivered by delta", () => {
  // 超过快照渲染上限（recent 桶 24 条）的可见消息：低 seq 的会被配额挤掉。
  const messages = [];
  for (let i = 1; i <= 30; i += 1) {
    messages.push(
      makeMessage({ seq: i, recipientId: "*", bodyMarkdown: `overflow message ${i}` }),
    );
  }

  const snapshot = bus.renderMessageBusSnapshot({ messages, currentAgentId: "parent" });
  assert.ok(snapshot.omittedCount > 0, "30 条可见消息必须超出快照容量");
  // 游标不得跳过未渲染的消息：连续已渲染前缀在第一条被挤掉的消息前停下。
  assert.ok(
    snapshot.renderedSeq < 30,
    `renderedSeq(${snapshot.renderedSeq}) 不能用全体可见消息的最大 seq`,
  );
  assert.match(snapshot.text, new RegExp(`\\(${snapshot.omittedCount} messages omitted;`));

  // 未进快照的消息必须能被 delta 按 renderedSeq 补投，不得静默丢失。
  const followUp = delta(messages, snapshot.renderedSeq);
  assert.equal(followUp.lastSeq, 30);
  for (const message of messages) {
    const inSnapshot = snapshot.text.includes(message.bodyMarkdown);
    const inDelta = followUp.text.includes(message.bodyMarkdown);
    assert.ok(inSnapshot || inDelta, `seq=${message.seq} 既不在快照也不在 delta 里`);
  }
});

function toolResult(toolCallId, text, overrides = {}) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: overrides.toolName ?? "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 1,
    ...overrides,
  };
}

function assistant(overrides = {}) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call-1", name: "Read", arguments: {} }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "m",
    usage: {},
    stopReason: "toolUse",
    timestamp: 1,
    ...overrides,
  };
}

test("resolveTailBlockAnchorId picks the last safe tool result and attach pins to it", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "first result"),
    assistant(),
    toolResult("call-2", "second result"),
  ];
  const snapshot = JSON.parse(JSON.stringify(messages));

  const anchorToolCallId = tailBlock.resolveTailBlockAnchorId(messages);
  assert.equal(anchorToolCallId, "call-2");

  const next = tailBlock.attachPinnedTailBlocks(messages, [
    { anchorToolCallId, text: "BUS DELTA" },
  ]);
  assert.notEqual(next, messages);
  assert.deepEqual(messages, snapshot, "入参消息不得被原地修改");
  assert.equal(next[2], messages[2], "未命中的消息保持同一引用");
  assert.deepEqual(next[4].content, [
    { type: "text", text: "second result" },
    { type: "text", text: "BUS DELTA" },
  ]);
  assert.equal(next[4].toolCallId, "call-2", "toolCallId 原样保留");
});

// 关键回退防线：锚点一旦钉死，后续轮次工具循环推进也不得让块搬家——搬家会让
// 上一轮挂过块的那条消息字节变回去，前缀从它开始整段作废。
test("pinned tail block stays on its original anchor as the tool loop grows", () => {
  const roundTwo = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "first result"),
  ];
  const anchorToolCallId = tailBlock.resolveTailBlockAnchorId(roundTwo);
  assert.equal(anchorToolCallId, "call-1");
  const pinned = [{ anchorToolCallId, text: "BUS DELTA" }];

  const outboundTwo = tailBlock.attachPinnedTailBlocks(roundTwo, pinned);

  // 第 3 轮：工具循环又推进了一轮，"最后一条工具结果"已经变成 call-2。
  const roundThree = [...roundTwo, assistant(), toolResult("call-2", "second result")];
  const outboundThree = tailBlock.attachPinnedTailBlocks(roundThree, pinned);

  assert.deepEqual(
    outboundThree[2],
    outboundTwo[2],
    "钉住的锚点消息必须逐字节稳定，块不得随工具循环搬到新消息上",
  );
  assert.deepEqual(
    outboundThree[4].content,
    [{ type: "text", text: "second result" }],
    "新的工具结果不得被搬过来的块污染",
  );
});

test("attachPinnedTailBlocks returns the same reference when there is nothing to attach", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "result"),
  ];
  assert.equal(tailBlock.attachPinnedTailBlocks(messages, []), messages);
  assert.equal(
    tailBlock.attachPinnedTailBlocks(messages, [{ anchorToolCallId: "call-1", text: "" }]),
    messages,
    "空文本不产生任何内容",
  );
  assert.equal(
    tailBlock.attachPinnedTailBlocks(messages, [{ anchorToolCallId: "gone", text: "BUS DELTA" }]),
    messages,
    "锚点已不在消息列表里时本轮不挂，不搬家",
  );
});

test("multiple blocks on one anchor replay in delivery order", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "result"),
  ];
  const next = tailBlock.attachPinnedTailBlocks(messages, [
    { anchorToolCallId: "call-1", text: "FIRST" },
    { anchorToolCallId: "call-1", text: "SECOND" },
  ]);
  assert.deepEqual(next[2].content, [
    { type: "text", text: "result" },
    { type: "text", text: "FIRST" },
    { type: "text", text: "SECOND" },
  ]);
});

test("anchor resolution refuses unsafe anchors and never crosses the last user message", () => {
  const displayImage = [
    assistant(),
    toolResult("call-1", "image", { toolName: "Image", details: { kind: "display_image" } }),
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(displayImage),
    null,
    "display-image 工具结果的 content 会被净化整体替换，不能当锚点",
  );

  const subagentCard = [
    assistant(),
    toolResult("call-1", "card", { toolName: "Agent", details: { kind: "subagent_card" } }),
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(subagentCard),
    null,
    "subagent 卡片工具结果会被整条过滤，不能当锚点",
  );

  const aborted = [
    assistant({ stopReason: "aborted" }),
    toolResult("call-1", "orphan"),
    toolResult("call-2", "orphan too"),
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(aborted),
    null,
    "aborted assistant 之后的工具结果会被丢弃，不能当锚点",
  );

  const onlyUser = [
    { role: "user", content: "earlier", timestamp: 1 },
    assistant(),
    toolResult("call-1", "safe"),
    { role: "user", content: "latest", timestamp: 2 },
  ];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(onlyUser),
    null,
    "不得越过最后一条 user 消息去改写已缓存前缀",
  );

  const noToolCallId = [assistant(), toolResult("", "anonymous")];
  assert.equal(
    tailBlock.resolveTailBlockAnchorId(noToolCallId),
    null,
    "钉不住的锚点等于没有锚点，否则后续轮次会退化成重新搜索",
  );
});

test("anchor resolution skips unsafe tail anchors and falls back to an earlier safe tool result", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 1 },
    assistant(),
    toolResult("call-1", "safe result"),
    toolResult("call-2", "image", { toolName: "Image", details: { kind: "display_image" } }),
  ];
  const anchorToolCallId = tailBlock.resolveTailBlockAnchorId(messages);
  assert.equal(anchorToolCallId, "call-1");

  const next = tailBlock.attachPinnedTailBlocks(messages, [
    { anchorToolCallId, text: "BUS DELTA" },
  ]);
  assert.notEqual(next, messages);
  assert.equal(next[3], messages[3], "不安全的尾部锚点保持原样");
  assert.deepEqual(next[2].content, [
    { type: "text", text: "safe result" },
    { type: "text", text: "BUS DELTA" },
  ]);
});
