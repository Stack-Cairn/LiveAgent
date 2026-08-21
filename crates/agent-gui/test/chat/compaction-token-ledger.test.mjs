import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const ledgerModule = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");
const { BINARY_BLOCK_TOKENS } = loader.loadModule("@liveagent/ui/lib/chat/contextUsage.ts");

const {
  TokenLedger,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateMessageTokens,
  getUsageTotalTokens,
  getMessageObservedTokens,
} = ledgerModule;

function usage(totalTokens, extra = {}) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...extra,
  };
}

function user(content) {
  return { role: "user", content, timestamp: 1 };
}

function assistant(text, messageUsage, extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: 2,
    usage: messageUsage,
    ...extra,
  };
}

function toolResult(text) {
  return {
    role: "toolResult",
    toolCallId: "tc-1",
    toolName: "Read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
  };
}

test("estimateTextTokens is ceil(chars/4) of trimmed text for non-CJK content", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("   "), 0);
  assert.equal(estimateTextTokens("a".repeat(400)), 100);
  assert.equal(estimateTextTokens("a".repeat(401)), 101);
});

test("estimateTextTokens weighs CJK characters at 0.7 tokens each", () => {
  // 100 个汉字按 chars/4 只算 25 token，真实 tokenizer 约 60~70：必须显著高于 25。
  assert.equal(estimateTextTokens("你".repeat(100)), Math.ceil(100 * 0.7));
  // 假名与谚文同样按 CJK 密度估算。
  assert.equal(estimateTextTokens("あ".repeat(50)), Math.ceil(50 * 0.7));
  assert.equal(estimateTextTokens("한".repeat(50)), Math.ceil(50 * 0.7));
  // 中英混排：各按各的密度累加。
  assert.equal(
    estimateTextTokens(`${"你".repeat(40)}${"a".repeat(40)}`),
    Math.ceil(40 * 0.7 + 40 / 4),
  );
  // 全角标点计入 CJK 密度。
  assert.equal(estimateTextTokens("。".repeat(10)), Math.ceil(10 * 0.7));
});

test("estimateTextTokenUnits is additive across arbitrary splits", () => {
  const text = `汉字 mixed ascii ${"你好".repeat(20)} tail`;
  const whole = estimateTextTokenUnits(text);
  const split =
    estimateTextTokenUnits(text.slice(0, 7)) +
    estimateTextTokenUnits(text.slice(7, 23)) +
    estimateTextTokenUnits(text.slice(23));
  assert.ok(Math.abs(whole - split) < 1e-9, `whole=${whole} split=${split}`);
});

test("estimateMessageTokens covers text, tool calls and model-visible tool result content", () => {
  assert.equal(estimateMessageTokens(user("a".repeat(400))), 100 + 8);

  const withToolCall = {
    role: "assistant",
    content: [
      { type: "text", text: "a".repeat(40) },
      { type: "toolCall", id: "t1", name: "Read", arguments: { path: "b".repeat(30) } },
    ],
    stopReason: "toolUse",
    timestamp: 2,
  };
  const argsChars = JSON.stringify({ path: "b".repeat(30) }).length;
  assert.equal(
    estimateMessageTokens(withToolCall),
    Math.ceil((40 + "Read".length + argsChars) / 4) + 8,
  );

  // details 是 UI/记账负载（shell 全量输出、文件元数据都挂在上面），provider
  // 转换只发送 content——计入即双算，账本读数系统性虚高。
  const resultWithDetails = { ...toolResult("c".repeat(80)), details: { lines: 12 } };
  assert.equal(estimateMessageTokens(resultWithDetails), Math.ceil(80 / 4) + 8);
});

test("estimateMessageTokens prices binary blocks at provider scale, not base64 length", () => {
  // 400KB 图的 base64 按字符数会虚报 ~13 万 token，环随锚点在估算/真实 usage
  // 间切换而剧烈跳变；按计价量级常量后读数与真实成本同量级。
  const imageResult = {
    role: "toolResult",
    toolCallId: "tc-img",
    toolName: "Read",
    content: [
      { type: "text", text: "a".repeat(40) },
      { type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" },
    ],
    isError: false,
    timestamp: 3,
  };
  assert.equal(estimateMessageTokens(imageResult), Math.ceil(40 / 4) + BINARY_BLOCK_TOKENS + 8);

  const imageUser = {
    role: "user",
    content: [
      { type: "text", text: "看这张图" },
      { type: "image", data: "B".repeat(500_000), mimeType: "image/jpeg" },
    ],
    timestamp: 1,
  };
  assert.equal(
    estimateMessageTokens(imageUser),
    Math.ceil(estimateTextTokenUnits("看这张图") + BINARY_BLOCK_TOKENS) + 8,
  );
});

test("estimateMessageTokens memoizes by object identity", () => {
  const message = user("a".repeat(4000));
  const first = estimateMessageTokens(message);
  message.content = "";
  // 同一对象命中缓存（消息按不可变值对象使用）；内容被原地篡改也不重算。
  assert.equal(estimateMessageTokens(message), first);
});

test("getUsageTotalTokens derives from parts without double-counting reasoning", () => {
  assert.equal(getUsageTotalTokens(usage(5000)), 5000);
  // reasoning 是 output 的子集：从分项推导时不得单独累加。
  assert.equal(
    getUsageTotalTokens(usage(0, { input: 100, output: 50, reasoning: 30 })),
    150,
  );
  assert.equal(getUsageTotalTokens(usage(0)), undefined);
  assert.equal(getUsageTotalTokens(undefined), undefined);
});

test("compaction checkpoint messages are never observed-usage anchors", () => {
  const checkpoint = assistant("summary body", usage(99_999), { api: "liveagent-compaction" });
  assert.equal(getMessageObservedTokens(checkpoint), undefined);

  const legacyCheckpoint = assistant("summary body", usage(99_999), {
    provider: "liveagent",
    model: "summary",
  });
  assert.equal(getMessageObservedTokens(legacyCheckpoint), undefined);

  assert.equal(getMessageObservedTokens(assistant("hi", usage(1234))), 1234);
});

test("rebase anchors on the latest real usage and estimates the trailing messages", () => {
  const ledger = new TokenLedger();
  const trailing = toolResult("d".repeat(4000));
  ledger.rebase({
    systemPrompt: "s".repeat(4000),
    messages: [user("hello"), assistant("world", usage(5000)), trailing],
  });

  const expectedTrailing = estimateMessageTokens(trailing);
  assert.equal(ledger.total(), 5000 + expectedTrailing);
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, true);
  assert.equal(snapshot.observedTokens, 5000);
  assert.equal(snapshot.trailingTokens, expectedTrailing);
  // observed usage 已含 system prompt，fixed 不再叠加。
  assert.equal(snapshot.totalTokens, snapshot.observedTokens + snapshot.trailingTokens);
});

test("persisted usage anchors adjust when current system and tools fixed tokens change", () => {
  const ledger = new TokenLedger();
  const observed = assistant("answer", usage(5_000));
  const originalContext = {
    systemPrompt: "s".repeat(400),
    tools: [],
    messages: [user("question")],
  };
  ledger.rebase(originalContext);
  ledger.addMessages([observed]);
  assert.equal(ledger.total(), 5_000);

  const changedContext = {
    systemPrompt: "s".repeat(4_000),
    tools: [{ name: "LargeTool", description: "d".repeat(4_000), parameters: {} }],
    messages: [...originalContext.messages, observed],
  };
  const originalFixed = estimateTextTokens(originalContext.systemPrompt);
  const changedFixed =
    estimateTextTokens(changedContext.systemPrompt) + ledgerModule.estimateToolsTokens(changedContext.tools);
  ledger.rebase(changedContext);

  assert.equal(ledger.total(), 5_000 + changedFixed - originalFixed);
  assert.equal(ledger.snapshot().hasFixedTokenAnchor, true);
});

test("legacy usage without fixed metadata trusts the observed total over estimates", () => {
  const ledger = new TokenLedger();
  const legacyObserved = assistant("answer", usage(1_000));
  // PR 之前持久化的会话：有真实 usage 但无 liveAgentContextUsage 印章。
  // 估算口径有意高估（序列化字符 / CJK 密度），绝不允许覆盖真实读数——
  // 否则环读数会超 100% 并触发自动压缩循环。
  ledger.rebase({
    systemPrompt: "s".repeat(400_000),
    tools: [{ name: "LargeTool", description: "d".repeat(400_000), parameters: {} }],
    messages: [legacyObserved],
  });

  assert.equal(ledger.total(), 1_000);
  assert.equal(ledger.snapshot().hasObservedUsage, true);
  assert.equal(ledger.snapshot().hasFixedTokenAnchor, false);
});

test("real usage anchors are never overridden by the full-history estimate", () => {
  const ledger = new TokenLedger();
  // 100 万字符的工具输出估算约 25 万 token，真实 usage 只有 5000：读数恒信 usage。
  ledger.rebase({
    systemPrompt: "sys",
    messages: [toolResult("x".repeat(1_000_000)), assistant("done", usage(5_000))],
  });

  assert.equal(ledger.total(), 5_000);
});

test("assistant messages without provider usage are never stamped with estimates", () => {
  const ledger = new TokenLedger();
  const noUsage = assistant("answer", usage(0));
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const totalBefore = ledger.total();
  ledger.addMessages([noUsage]);

  // 印章随会话持久化且读取侧优先于 usage：估算一旦盖章会永久遮蔽后到的
  // 真实读数。无 usage 的消息只走 trailing 估算，不产生印章。
  assert.equal(noUsage.liveAgentContextUsage, undefined);
  assert.equal(getMessageObservedTokens(noUsage), undefined);
  assert.equal(ledger.total(), totalBefore + estimateMessageTokens(noUsage));
});

test("assistant messages with real usage are stamped as fixed-token anchors", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const observed = assistant("answer", usage(5_000));
  ledger.addMessages([observed]);

  // 印章只记录 usage 派生的权威值 + 当时的 fixed 开销（供跨端 rebase 补偿）。
  assert.deepEqual(observed.liveAgentContextUsage, { totalTokens: 5_000, fixedTokens: 100 });
  assert.equal(ledger.total(), 5_000);
  assert.equal(ledger.snapshot().hasFixedTokenAnchor, true);
});

test("rebase without any usage falls back to fixed + estimates", () => {
  const ledger = new TokenLedger();
  const message = user("a".repeat(400));
  ledger.rebase({ systemPrompt: "s".repeat(4000), messages: [message] });

  assert.equal(ledger.snapshot().hasObservedUsage, false);
  assert.equal(ledger.total(), 1000 + estimateMessageTokens(message));
});

test("addMessages accumulates estimates and a fresh usage resets the trailing sum", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "", messages: [assistant("w", usage(5000))] });

  const extra = toolResult("e".repeat(800));
  ledger.addMessages([extra]);
  assert.equal(ledger.total(), 5000 + estimateMessageTokens(extra));

  ledger.addMessages([assistant("next", usage(6100))]);
  assert.equal(ledger.total(), 6100);
  assert.equal(ledger.snapshot().trailingTokens, 0);
});

test("post-checkpoint rebase shrinks the total to the fresh segment size", () => {
  const ledger = new TokenLedger();
  ledger.rebase({
    systemPrompt: "base",
    messages: [assistant("big history", usage(150_000)), toolResult("f".repeat(20_000))],
  });
  assert.ok(ledger.total() > 150_000);

  const resume = user("Continue.");
  ledger.rebase({ systemPrompt: `base\n## Previous Conversation Summary\n${"g".repeat(2000)}`, messages: [resume] });
  assert.equal(ledger.snapshot().hasObservedUsage, false);
  assert.ok(ledger.total() < 1000);
});

test("totalWithPendingTokens adds the streamed token-unit estimate in O(1)", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "", messages: [assistant("w", usage(4000))] });
  assert.equal(ledger.totalWithPendingTokens(0), 4000);
  assert.equal(ledger.totalWithPendingTokens(estimateTextTokenUnits("a".repeat(401))), 4000 + 101);
  // 中文流按 CJK 密度累计：400 字远高于 400/4=100。
  assert.equal(
    ledger.totalWithPendingTokens(estimateTextTokenUnits("好".repeat(400))),
    4000 + Math.ceil(400 * 0.7),
  );
});

test("estimateMessageTokens weighs CJK message content by CJK density", () => {
  const cjkMessage = user("这是一段用于估算的中文正文内容".repeat(20));
  const asciiEquivalent = user("a".repeat(15 * 20));
  assert.ok(
    estimateMessageTokens(cjkMessage) > estimateMessageTokens(asciiEquivalent) * 2,
    "CJK content must estimate significantly more tokens than same-length ASCII",
  );
});
