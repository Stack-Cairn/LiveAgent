import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const turnInjection = loader.loadModule("src/lib/memory/prompts/turnInjection.ts");
const {
  MEMORY_TURN_UPDATE_LIMIT,
  attachMemoryTurnUpdates,
  formatMemoryTurnUpdate,
  planMemoryTurnInjection,
} = turnInjection;
const { memoryTurnInjection } = loader.loadModule("src/lib/chat/memory/injectionController.ts");
const { formatMemoryOverview } = loader.loadModule("src/lib/memory/prompts/injection.ts");
const { capturePrefixShape, comparePrefixShape } = loader.loadModule(
  "src/lib/debug/prefixCacheShape.ts",
);
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { normalizeConversationState } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const { extractLatestUserText } = loader.loadModule("src/lib/memory/extraction/context.ts");

const BASE_SYSTEM_PROMPT = "base system prompt";
const TOOLS = [{ name: "MemoryManager", description: "memory", parameters: { type: "object" } }];

function entry(overrides = {}) {
  return {
    slug: "user-name",
    scope: "global",
    memoryType: "user",
    description: "用户叫苏枫",
    headline: "",
    dateLocal: null,
    // 固定成「今天」,新鲜度桶恒为 d0,overview 的字节只随内容变化。
    updatedAt: Date.now(),
    unreviewed: false,
    confidence: "high",
    ...overrides,
  };
}

function overviewText(entries) {
  return formatMemoryOverview({
    user: entries,
    project: [],
    global: [],
    recentDays: [],
    root: "/tmp/memory",
    workdirHash: null,
  });
}

const OVERVIEW_A = overviewText([entry()]);
const OVERVIEW_B = overviewText([entry(), entry({ slug: "user-editor", description: "用户用 neovim" })]);

function baselineFrom(overview) {
  const plan = planMemoryTurnInjection({ baseline: null, overview });
  return plan.baseline;
}

// ---------------------------------------------------------------------------
// 纯规划器:三条硬约束逐条对齐

test("首轮走 system prompt,不额外产生增量块", () => {
  const plan = planMemoryTurnInjection({ baseline: null, overview: OVERVIEW_A });

  assert.equal(plan.systemText, OVERVIEW_A);
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.baseline.lastSeenText, OVERVIEW_A);
  assert.equal(plan.baseline.updateCount, 0);
});

test("内容未变时不产生任何额外消息", () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({ baseline, overview: OVERVIEW_A });

  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.systemText, baseline.systemText);
  assert.equal(plan.baseline.lastSeenText, baseline.lastSeenText);
  assert.equal(plan.baseline.updateCount, 0);
});

test("内容变化时产出增量,且 system 段一个字节都不动", () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });

  assert.equal(plan.systemText, baseline.systemText);
  assert.ok(plan.turnUpdate.startsWith("<memory-update>"));
  assert.ok(plan.turnUpdate.includes("[user-editor|u|d0]"));
  assert.ok(plan.turnUpdate.includes("supersedes"));
  assert.equal(plan.baseline.lastSeenText, OVERVIEW_B);
  assert.equal(plan.baseline.updateCount, 1);
});

test("增量只报被顶替条目的 id,不复述旧值", () => {
  const removed = formatMemoryTurnUpdate(OVERVIEW_B, OVERVIEW_A);

  assert.ok(removed.includes("- [user-editor]"));
  assert.ok(!removed.includes("用户用 neovim"));
  // 未变化的条目不重复列出,避免每次增量都把整份索引再刷一遍。
  assert.ok(!removed.includes("[user-name|u|d0]"));
});

test("只有折叠提示之类的非条目变化时,不挂出空壳增量块", () => {
  assert.equal(formatMemoryTurnUpdate(OVERVIEW_A, `${OVERVIEW_A}\n\ntrailing note`), "");

  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({
    baseline,
    overview: `${OVERVIEW_A}\n\ntrailing note`,
  });

  assert.equal(plan.turnUpdate, "");
  // 指纹仍然推进,否则下一轮还会重复算同一个差异。
  assert.equal(plan.baseline.lastSeenText, `${OVERVIEW_A}\n\ntrailing note`);
  assert.equal(plan.baseline.updateCount, 0);
});

test("读取失败(overview=null)保持基线不动,也不推进指纹", () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const plan = planMemoryTurnInjection({ baseline, overview: null });

  assert.equal(plan.systemText, baseline.systemText);
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.baseline, baseline);
});

test("首轮就读取失败时不建立基线,留给下一轮重来", () => {
  const plan = planMemoryTurnInjection({ baseline: null, overview: null });

  assert.equal(plan.systemText, "");
  assert.equal(plan.turnUpdate, "");
  assert.equal(plan.baseline, null);
});

test("增量数量封顶后只推进指纹,不再追加消息", () => {
  let baseline = baselineFrom(OVERVIEW_A);
  for (let round = 0; round < MEMORY_TURN_UPDATE_LIMIT; round += 1) {
    const plan = planMemoryTurnInjection({
      baseline,
      overview: overviewText([entry({ description: `用户叫苏枫 ${round}` })]),
    });
    assert.notEqual(plan.turnUpdate, "");
    baseline = plan.baseline;
  }
  assert.equal(baseline.updateCount, MEMORY_TURN_UPDATE_LIMIT);

  const capped = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });
  assert.equal(capped.turnUpdate, "");
  assert.equal(capped.systemText, baseline.systemText);
  assert.equal(capped.baseline.lastSeenText, OVERVIEW_B);
});

test("规划器是纯函数:重复调用结果一致,且不改动入参", async () => {
  const baseline = baselineFrom(OVERVIEW_A);
  const snapshot = { ...baseline };
  const first = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = planMemoryTurnInjection({ baseline, overview: OVERVIEW_B });

  assert.deepEqual(first, second);
  assert.deepEqual(baseline, snapshot);
});

// ---------------------------------------------------------------------------
// 挂载:增量必须落在最后一条 user 消息尾部(复用 pi-ai 的第 4 个断点)

test("字符串 content 的增量追加到消息尾部,不改动入参", () => {
  const messages = [
    { role: "user", id: "u1", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
  ];
  const next = attachMemoryTurnUpdates(messages, new Map([["u1", "<memory-update>x</memory-update>"]]));

  assert.equal(next[0].content, "hello\n\n<memory-update>x</memory-update>");
  assert.equal(messages[0].content, "hello");
  assert.equal(next[1], messages[1]);
});

test("数组 content 的增量追加成末尾的 text block", () => {
  const messages = [
    {
      role: "user",
      id: "u1",
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "..." },
      ],
    },
  ];
  const next = attachMemoryTurnUpdates(messages, new Map([["u1", "UPDATE"]]));

  assert.equal(next[0].content.length, 3);
  assert.deepEqual(next[0].content.at(-1), { type: "text", text: "UPDATE" });
  assert.equal(messages[0].content.length, 2);
});

test("无匹配 id / 非 user 消息 / 空增量表时原样返回同一数组", () => {
  const messages = [
    { role: "user", id: "u1", content: "hello" },
    { role: "assistant", id: "a1", content: [{ type: "text", text: "hi" }] },
  ];

  assert.equal(attachMemoryTurnUpdates(messages, undefined), messages);
  assert.equal(attachMemoryTurnUpdates(messages, new Map()), messages);
  assert.equal(attachMemoryTurnUpdates(messages, new Map([["missing", "U"]])), messages);
  // assistant 消息即使 id 撞上也不挂:断点只认最后一条 user 消息。
  assert.equal(attachMemoryTurnUpdates(messages, new Map([["a1", "U"]])), messages);
});

// ---------------------------------------------------------------------------
// 端到端:用阶段 ① 的前缀哈希对账验证 system 段冻结

function stateOf(messages) {
  return normalizeConversationState({
    meta: {
      systemPrompt: BASE_SYSTEM_PROMPT,
      tools: TOOLS,
      totalSegmentCount: 1,
      totalMessageCount: messages.length,
    },
    segments: [
      {
        segmentIndex: 0,
        segmentId: "s0",
        messages,
        messageCount: messages.length,
        createdAt: 1,
        updatedAt: messages.length + 1,
      },
    ],
  });
}

function contextFor(conversationId, messages, systemText) {
  return buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: "",
    memoryPrompt: systemText,
    memoryTurnUpdates: memoryTurnInjection.getMessageUpdates(conversationId),
  });
}

function userTurn(index) {
  return { role: "user", id: `u${index}`, content: `turn ${index}`, timestamp: index * 10 };
}

function assistantTurn(index) {
  return {
    role: "assistant",
    content: [{ type: "text", text: `reply ${index}` }],
    stopReason: "stop",
    timestamp: index * 10 + 1,
  };
}

test("多轮对账:内容未变不加消息,内容变化只动 user 消息、system 段判定 unchanged", (t) => {
  const conversationId = "conv-multi-turn";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  const messages = [];
  const shapes = [];
  const contexts = [];
  const overviews = [OVERVIEW_A, OVERVIEW_A, OVERVIEW_B, OVERVIEW_B];

  overviews.forEach((overview, index) => {
    const turn = index + 1;
    messages.push(userTurn(turn));
    const { systemText } = memoryTurnInjection.planTurn({
      conversationId,
      messageId: `u${turn}`,
      overview,
    });
    const context = contextFor(conversationId, messages, systemText);
    contexts.push(context);
    shapes.push(capturePrefixShape({ systemPrompt: context.systemPrompt, tools: context.tools }));
    messages.push(assistantTurn(turn));
  });

  // 每轮的消息数就是真实消息数:没有任何一轮凭空多出一条消息。
  assert.deepEqual(
    contexts.map((context) => context.messages.length),
    [1, 3, 5, 7],
  );

  // system 段从第一轮起就冻住了,四轮全部 unchanged。
  const summaries = shapes.map((shape, index) =>
    comparePrefixShape(index === 0 ? null : shapes[index - 1], shape).prefixChangeSummary,
  );
  assert.deepEqual(summaries, ["initial", "unchanged", "unchanged", "unchanged"]);

  // 第 2 轮 memory 没变:上下文里不该出现任何增量块。
  assert.ok(!JSON.stringify(contexts[1].messages).includes("<memory-update>"));

  // 第 3 轮 memory 变了:增量挂在第 3 轮那条 user 消息上,历史消息原样不动。
  const thirdTurnUser = contexts[2].messages.find((message) => message.id === "u3");
  assert.ok(thirdTurnUser.content.includes("<memory-update>"));
  assert.ok(thirdTurnUser.content.includes("[user-editor|u|d0]"));
  assert.equal(contexts[2].messages[0].content, "turn 1");

  // 第 4 轮重放同一份字节:历史区间保持可缓存。
  assert.equal(
    JSON.stringify(contexts[3].messages.slice(0, 5)),
    JSON.stringify(contexts[2].messages),
  );
});

test("对照组:同样的变化若继续走 system prompt,前缀会被判定为 system 变更", () => {
  const before = capturePrefixShape({
    systemPrompt: `${BASE_SYSTEM_PROMPT}\n\n${OVERVIEW_A}`,
    tools: TOOLS,
  });
  const after = capturePrefixShape({
    systemPrompt: `${BASE_SYSTEM_PROMPT}\n\n${OVERVIEW_B}`,
    tools: TOOLS,
  });

  assert.equal(comparePrefixShape(before, after).prefixChangeSummary, "system");
});

test("会话恢复后基线丢失:完整快照只进 system prompt 一次,不重复注入", (t) => {
  const conversationId = "conv-restore";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 1);

  // 重启/恢复:内存态基线随进程一起没了。
  memoryTurnInjection.dispose(conversationId);

  const restored = memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u3",
    overview: OVERVIEW_B,
  });
  assert.equal(restored.systemText, OVERVIEW_B);
  assert.equal(restored.turnUpdate, "");
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 0);

  const context = contextFor(
    conversationId,
    [userTurn(1), assistantTurn(1), userTurn(3)],
    restored.systemText,
  );
  assert.ok(!JSON.stringify(context.messages).includes("<memory-update>"));
  // 同一份内容不会既进 system 段又发一遍增量。
  assert.equal(context.systemPrompt.split("# Memory Index").length - 1, 1);
});

test("没有可挂载的消息 id 时丢掉本次增量,但不推进指纹", (t) => {
  const conversationId = "conv-no-message-id";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  const skipped = memoryTurnInjection.planTurn({ conversationId, overview: OVERVIEW_B });
  assert.equal(skipped.turnUpdate, "");
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 0);

  // 指纹没推进,下一轮拿到消息 id 时补上同一份差异。
  const recovered = memoryTurnInjection.planTurn({
    conversationId,
    messageId: "u2",
    overview: OVERVIEW_B,
  });
  assert.ok(recovered.turnUpdate.includes("[user-editor|u|d0]"));
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).get("u2"), recovered.turnUpdate);
});

test("缺少会话 id 时退回旧行为:整块进 system prompt", () => {
  const plan = memoryTurnInjection.planTurn({ conversationId: "  ", overview: OVERVIEW_A });

  assert.equal(plan.systemText, OVERVIEW_A);
  assert.equal(plan.turnUpdate, "");
});

test("会话删除后状态清空", () => {
  const conversationId = "conv-dispose";
  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId).size, 1);

  memoryTurnInjection.dispose(conversationId);
  assert.equal(memoryTurnInjection.getMessageUpdates(conversationId), undefined);
});

// ---------------------------------------------------------------------------
// 旁路:复用同一份消息的子模型链路必须显式关掉增量

test("memoryTurnUpdates=null 时抽取子模型看到的仍是用户原话", (t) => {
  const conversationId = "conv-extraction-bypass";
  t.after(() => memoryTurnInjection.dispose(conversationId));

  memoryTurnInjection.planTurn({ conversationId, messageId: "u1", overview: OVERVIEW_A });
  memoryTurnInjection.planTurn({ conversationId, messageId: "u2", overview: OVERVIEW_B });

  const messages = [userTurn(1), assistantTurn(1), userTurn(2)];
  const forModel = contextFor(conversationId, messages, OVERVIEW_A);
  const forExtraction = buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: "",
    memoryPrompt: OVERVIEW_A,
    memoryTurnUpdates: null,
  });

  // 主模型那份带增量:这也正是抽取不能直接复用它的原因 —— 索引行会被当成用户
  // 发言,既撑破「消息太短就跳过」的门控,又诱发重复写入。
  assert.ok(extractLatestUserText(forModel.messages).includes("<memory-update>"));
  assert.equal(extractLatestUserText(forExtraction.messages), "turn 2");
});
