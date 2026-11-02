import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const ledgerModule = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");
const { BINARY_BLOCK_TOKENS } = loader.loadModule("@liveagent/ui/lib/chat/contextUsage.ts");
const { sanitizeMessageForModelContext } = loader.loadModule(
  "src/lib/chat/context/requestContextSanitizer.ts",
);

const {
  TokenLedger,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateMessageTokens,
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

test("usage anchors are pure arithmetic: prompt side plus visible output", () => {
  // totalTokens 含本轮全部 output（reasoning 占大头）。Chat Completions 等会在
  // 轮次终止后剥离 reasoning：锚点只做 usage 算术（prompt 侧 + output − reasoning）。
  // OpenAI Responses 会重放 thinkingSignature，另案保留 reasoning。
  const heavyReasoning = assistant(
    "hi",
    usage(47_500, { input: 4_000, cacheRead: 500, output: 43_000, reasoning: 40_000 }),
  );
  // stop 终止：4_500(prompt 侧) + 43_000 − 40_000(被剥离的 reasoning) = 7_500。
  assert.equal(getMessageObservedTokens(heavyReasoning), 7_500);

  // toolUse 续跑：本轮 reasoning 仍留在同一 turn 的后续请求里（各家都要求
  // 回传并计费），output 全量计入；thinking 正文绝不再叠加估算（旧双算）。
  const toolLoop = assistant(
    "hi",
    usage(47_500, { input: 4_000, cacheRead: 500, output: 43_000, reasoning: 40_000 }),
    { stopReason: "toolUse" },
  );
  assert.equal(getMessageObservedTokens(toolLoop), 47_500);

  // 中转只报 totalTokens（prompt 侧全零）：文档化降级，读数不许归零。
  assert.equal(getMessageObservedTokens(assistant("hi", usage(1_234))), 1_234);
});

test("reasoning-less providers deduct estimated thinking text from stop anchors", () => {
  // 不上报推理分解的供应商：thinking 全文就在消息内容里，轮次终止后服务端
  // 剥离思维链，锚点按正文估算扣减——误差只剩这一项估算。
  const thinkingText = "a".repeat(1_000); // 250 token units
  const message = assistant("答案", usage(0, { input: 2_000, output: 400 }));
  message.content.unshift({ type: "thinking", thinking: thinkingText });
  assert.equal(getMessageObservedTokens(message), 2_000 + (400 - 250));

  // 扣减下限为 0：估算偏保守时不许把可见输出扣成负数。
  const overEstimated = assistant("短", usage(0, { input: 1_000, output: 100 }));
  overEstimated.content.unshift({ type: "thinking", thinking: "b".repeat(1_000) });
  assert.equal(getMessageObservedTokens(overEstimated), 1_000);

  // toolUse 续跑会重放 thinking：不扣减。
  const inLoop = assistant("跑工具", usage(0, { input: 2_000, output: 400 }), {
    stopReason: "toolUse",
  });
  inLoop.content.unshift({ type: "thinking", thinking: thinkingText });
  assert.equal(getMessageObservedTokens(inLoop), 2_400);
});

test("ledger anchors on usage arithmetic and never mutates messages", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const observed = assistant(
    "answer",
    usage(9_000, { input: 5_000, cacheRead: 1_000, output: 3_000, reasoning: 2_800 }),
  );
  ledger.addMessages([observed]);

  // 6_000(prompt 侧) + 3_000 − 2_800 = 6_200；锚点在读取时现算，不写任何印章。
  assert.equal(ledger.total(), 6_200);
  assert.equal(observed.liveAgentContextUsage, undefined);
});

test("two-turn readings never fall back without compaction (regression: 首轮高、次轮跳水)", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "sys", messages: [user("第一问")] });

  // 轮 1：重推理（4.5k reasoning）。锚点 = prompt 侧 + 可见输出，不含 reasoning。
  const turn1 = assistant(
    "答案一",
    usage(15_500, { input: 10_000, output: 5_000, reasoning: 4_500 }),
  );
  ledger.addMessages([turn1]);
  const afterTurn1 = ledger.total();
  assert.equal(afterTurn1, 10_500);

  // 用户第二问进入 trailing 估算，空闲读数只增不减。
  const question2 = user("第二问：请继续");
  ledger.addMessages([question2]);
  const idleBeforeTurn2 = ledger.total();
  assert.ok(idleBeforeTurn2 >= afterTurn1);

  // 轮 2：供应商实测 prompt 侧 = 上一轮可见上下文 + 用户消息实际 token。
  // 旧口径（锚点含 reasoning/正文估算）在这里必然回落；新口径单调不减。
  const turn2 = assistant("答案二", usage(0, { input: 10_512, output: 300, reasoning: 250 }));
  ledger.addMessages([turn2]);
  const afterTurn2 = ledger.total();
  assert.equal(afterTurn2, 10_562);
  assert.ok(
    afterTurn2 >= afterTurn1,
    `无压缩不得回落: ${afterTurn1} -> ${afterTurn2}`,
  );
});

test("hosted-search turns are never usage anchors and their blocks are never estimated", () => {
  // 实测数据（用量环 44%→16% 跳水的会话）：搜索轮 usage 报 input 110k（服务端
  // 多次内部调用的聚合，搜索结果全文计入 input 却不进入后续请求），而下一轮
  // 实测整个持久上下文只有 52k。聚合值绝不能锚定环读数。
  const searchTurn = assistant(
    "综合搜索结果……",
    usage(117_996, { input: 110_008, cacheRead: 5_184, output: 2_804, reasoning: 1_941 }),
  );
  searchTurn.content.push({
    type: "hostedSearch",
    id: "hs-1",
    provider: "openai",
    status: "completed",
    queries: ["西安 今日新闻"],
    sources: [{ url: "https://example.com/a", title: "x".repeat(2_000) }],
  });
  assert.equal(getMessageObservedTokens(searchTurn), undefined);

  // 旧版本按聚合值盖的印章已是死数据：读取侧不存在任何印章消费方。
  const legacyStamped = assistant("旧印章", usage(117_996, { input: 110_008 }));
  legacyStamped.content.push({ type: "hostedSearch", id: "hs-2", sources: [] });
  legacyStamped.liveAgentContextUsage = { totalTokens: 117_996, fixedTokens: 100 };
  assert.equal(getMessageObservedTokens(legacyStamped), undefined);

  // hostedSearch 块在请求侧被剥除：估算跳过其 queries/sources JSON。
  const plainEquivalent = assistant("综合搜索结果……", usage(0));
  assert.equal(estimateMessageTokens(searchTurn), estimateMessageTokens(plainEquivalent));

  // 下一个普通轮次的真实 usage 正常锚定：52_719(prompt 侧) + 9(可见输出)。
  const nextTurn = assistant("好的", usage(52_728, { input: 2_991, cacheRead: 49_728, output: 9 }));
  assert.equal(getMessageObservedTokens(nextTurn), 52_728);
});

test("OpenAI Responses stop anchors keep reasoning that will be replayed", () => {
  const signature = JSON.stringify({
    id: "rs_1",
    type: "reasoning",
    encrypted_content: "A".repeat(1_600),
  });
  const message = assistant(
    "答案",
    usage(0, { input: 18_000, output: 2_366, reasoning: 1_543 }),
    { api: "openai-responses" },
  );
  message.content.unshift({
    type: "thinking",
    thinking: "short summary",
    thinkingSignature: signature,
  });
  // 旧口径扣 1_543 → 18_823；Responses 下一请求仍发送 reasoning item。
  assert.equal(getMessageObservedTokens(message), 20_366);
});

test("hosted-search estimate includes Responses signatures so 谢谢 does not jump 19k→30k", () => {
  const encLens = [1_612, 1_484, 1_356, 1_444, 1_912, 1_420, 1_444, 4_620, 1_848];
  const signatures = encLens.map((encLen) => ({
    type: "thinking",
    thinking: "plan",
    thinkingSignature: JSON.stringify({
      id: "rs",
      type: "reasoning",
      encrypted_content: "A".repeat(encLen),
    }),
  }));
  const searchTurn = assistant(
    "以下是西安今日新闻要点……",
    usage(86_331, { input: 80_509, cacheRead: 3_456, output: 2_366, reasoning: 1_543 }),
    { api: "openai-responses" },
  );
  searchTurn.content = [
    ...signatures,
    {
      type: "hostedSearch",
      id: "hs-1",
      provider: "openai",
      status: "completed",
      queries: ["西安 新闻"],
      sources: [],
    },
    { type: "text", text: "以下是西安今日新闻要点……" },
  ];
  assert.equal(getMessageObservedTokens(searchTurn), undefined);

  const context = {
    systemPrompt: "s".repeat(4_000),
    tools: [{ name: "Read", description: "d".repeat(200), parameters: { type: "object" } }],
    messages: [user("请你联网搜索西安今天的新闻"), searchTurn],
  };
  const ledger = new TokenLedger();
  ledger.rebase(context);
  const withReplay = ledger.total();

  const plainSearch = assistant("以下是西安今日新闻要点……", usage(0));
  plainSearch.content.push({
    type: "hostedSearch",
    id: "hs-plain",
    sources: [],
  });
  const oldLedger = new TokenLedger();
  oldLedger.rebase({
    ...context,
    messages: [user("请你联网搜索西安今天的新闻"), plainSearch],
  });
  const withoutReplay = oldLedger.total();
  assert.ok(
    withReplay > withoutReplay + 3_000,
    `signatures must lift hosted-search estimate: ${withReplay} vs ${withoutReplay}`,
  );

  ledger.addMessages([user("谢谢")]);
  const idle = ledger.total();
  ledger.addMessages([
    assistant("不客气", usage(32_286, { input: 3_149, cacheRead: 29_056, output: 81 })),
  ]);
  const afterThanks = ledger.total();
  assert.equal(afterThanks, 32_286);
  assert.ok(
    afterThanks - idle < afterThanks - (withoutReplay + estimateMessageTokens(user("谢谢"))),
    `idle→real jump must shrink: idle=${idle} old=${withoutReplay} real=${afterThanks}`,
  );
});

test("sanitized hosted-search turns cannot re-anchor rebase on aggregated usage", () => {
  // 回归：搜索轮结束后空闲环走估算（约 7%），下一轮 beginRequest 对净化后
  // 上下文 rebase。净化剥除 hostedSearch 块后若留下聚合 usage（实测 input
  // 101k），账本会把它当真实锚点，流式期环跳高到约 40%，回复完成再落到
  // 下一轮真实 usage（约 11%）。
  const searchTurn = assistant(
    "以下是西安今日新闻要点……",
    usage(107_014, { input: 101_156, cacheRead: 3_456, output: 2_402, reasoning: 1_799 }),
  );
  searchTurn.content.push({
    type: "hostedSearch",
    id: "hs-sanitize",
    provider: "openai",
    status: "completed",
    queries: ["西安 新闻"],
    sources: [],
  });
  const originalUsage = { ...searchTurn.usage };
  const sanitized = sanitizeMessageForModelContext(searchTurn);
  const nextUser = { role: "user", content: "好的", timestamp: 3 };

  assert.equal(
    sanitized.content.some((block) => block.type === "hostedSearch"),
    false,
  );
  assert.equal(getMessageObservedTokens(sanitized), undefined);
  assert.equal(searchTurn.usage.totalTokens, originalUsage.totalTokens);

  const ledger = new TokenLedger();
  ledger.rebase({
    systemPrompt: "s".repeat(400),
    messages: [user("请你联网搜索西安今天的新闻"), sanitized, nextUser],
  });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, false);
  assert.ok(
    snapshot.totalTokens < 10_000,
    `sanitized rebase must stay on estimate path, got ${snapshot.totalTokens}`,
  );

  const realNext = assistant("收到", usage(30_986, { input: 1_883, cacheRead: 29_056, output: 47 }));
  ledger.addMessages([realNext]);
  assert.equal(ledger.total(), 30_986);
});

test("warm hosted-search turns anchor on cacheRead+output, not aggregated input", () => {
  const searchTurn = assistant(
    "西安今日新闻速览",
    usage(86_335, { input: 53_290, cacheRead: 30_080, output: 2_965, reasoning: 2_057 }),
    { api: "openai-responses" },
  );
  searchTurn.content.push({
    type: "hostedSearch",
    id: "hs-warm",
    provider: "openai",
    status: "completed",
    queries: ["西安 新闻"],
    sources: [],
  });
  assert.equal(getMessageObservedTokens(searchTurn), 33_045);
  assert.notEqual(getMessageObservedTokens(searchTurn), 86_335);

  const sanitized = sanitizeMessageForModelContext(searchTurn);
  assert.equal(
    sanitized.content.some((block) => block.type === "hostedSearch"),
    false,
  );
  assert.equal(sanitized.usage.input, 0);
  assert.equal(sanitized.usage.totalTokens, 0);
  assert.equal(sanitized.usage.cacheRead, 30_080);
  assert.equal(sanitized.usage.output, 2_965);
  assert.equal(getMessageObservedTokens(sanitized), 33_045);

  const nextUser = { role: "user", content: "好的", timestamp: 3 };
  const ledger = new TokenLedger();
  ledger.rebase({
    systemPrompt: "s".repeat(400),
    messages: [user("请你联网搜索西安今天的新闻"), sanitized, nextUser],
  });
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, true);
  assert.equal(snapshot.observedTokens, 33_045);
  assert.equal(snapshot.totalTokens, 33_045 + estimateMessageTokens(nextUser));

  const realNext = assistant("不客气", usage(32_703, { input: 3_588, cacheRead: 29_056, output: 59 }));
  ledger.addMessages([realNext]);
  assert.equal(ledger.total(), 32_703);
  assert.ok(
    Math.abs(32_703 - snapshot.totalTokens) < 500,
    `beginRequest→real jump must stay in hundreds: rebase=${snapshot.totalTokens} real=32703`,
  );
});

test("suppressUsageAnchors still accepts warm hosted-search follow-up tokens", () => {
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const warm = assistant(
    "搜索汇总",
    usage(86_335, { input: 53_290, cacheRead: 30_080, output: 2_965 }),
  );
  ledger.addMessages([warm], { suppressUsageAnchors: true });
  assert.equal(ledger.snapshot().hasObservedUsage, true);
  assert.equal(ledger.total(), 33_045);
});

test("addMessages with suppressUsageAnchors keeps usage turns on the estimate path", () => {
  // 搜索收尾会异步替换 assistant 消息对象，提交时刻内容块可能还没挂上，
  // 调用方按轮次追踪并显式抑制：不锚定、只累计 trailing 估算。
  const ledger = new TokenLedger();
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const totalBefore = ledger.total();
  const aggregated = assistant("搜索汇总", usage(117_996, { input: 110_008, cacheRead: 5_184 }));
  ledger.addMessages([aggregated], { suppressUsageAnchors: true });

  assert.equal(ledger.snapshot().hasObservedUsage, false);
  assert.equal(ledger.total(), totalBefore + estimateMessageTokens(aggregated));
});

test("rebase skips hosted-search anchors and lands on the previous trusted usage", () => {
  const ledger = new TokenLedger();
  const trusted = assistant("earlier answer", usage(30_000, { input: 30_000 }));
  const searchTurn = assistant("搜索汇总", usage(117_996, { input: 110_008 }), { timestamp: 4 });
  searchTurn.content.push({ type: "hostedSearch", id: "hs-3", sources: [] });
  ledger.rebase({
    systemPrompt: "sys",
    messages: [user("q1"), trusted, user("q2", 3), searchTurn],
  });

  const snapshot = ledger.snapshot();
  assert.equal(snapshot.hasObservedUsage, true);
  // 锚点落在更早的可信轮次（30_000 prompt 侧 + 0 可见输出），搜索轮与其后的
  // 消息按 trailing 估算。
  assert.equal(snapshot.observedTokens, 30_000);
  assert.equal(
    snapshot.trailingTokens,
    estimateMessageTokens({ role: "user", content: "q2", timestamp: 3 }) +
      estimateMessageTokens(searchTurn),
  );
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

test("legacy liveAgentContextUsage stamps are dead data: anchors recompute from usage", () => {
  // 修复前持久化的印章按旧口径写入（正文估算、甚至聚合值），读取侧曾无条件
  // 优先——旧会话因此继续锯齿。现在锚点一律从 usage 现算，印章没有任何读取方。
  const ledger = new TokenLedger();
  const stamped = assistant("旧会话轮次", usage(0, { input: 5_000, output: 200 }));
  stamped.liveAgentContextUsage = { totalTokens: 117_996, fixedTokens: 100 };
  ledger.rebase({ systemPrompt: "sys", messages: [user("q"), stamped] });

  assert.equal(getMessageObservedTokens(stamped), 5_200);
  assert.equal(ledger.total(), 5_200);
});

test("usage anchors always beat estimates regardless of fixed-cost size", () => {
  const ledger = new TokenLedger();
  const observed = assistant("answer", usage(1_000));
  // 估算口径有意高估（序列化字符 / CJK 密度），绝不允许覆盖真实读数——
  // 否则环读数会超 100% 并触发自动压缩循环。usage 锚点已含 system/tools
  // 的真实占用，fixed 估算无论多大都不叠加。
  ledger.rebase({
    systemPrompt: "s".repeat(400_000),
    tools: [{ name: "LargeTool", description: "d".repeat(400_000), parameters: {} }],
    messages: [observed],
  });

  assert.equal(ledger.total(), 1_000);
  assert.equal(ledger.snapshot().hasObservedUsage, true);
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

test("assistant messages without provider usage stay on the estimate path", () => {
  const ledger = new TokenLedger();
  const noUsage = assistant("answer", usage(0));
  ledger.rebase({ systemPrompt: "s".repeat(400), messages: [user("question")] });
  const totalBefore = ledger.total();
  ledger.addMessages([noUsage]);

  // 无 usage 的消息只走 trailing 估算，绝不产生锚点。
  assert.equal(getMessageObservedTokens(noUsage), undefined);
  assert.equal(ledger.total(), totalBefore + estimateMessageTokens(noUsage));
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
