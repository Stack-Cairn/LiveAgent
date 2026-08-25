import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const contextUsage = loader.loadModule("@liveagent/ui/lib/chat/contextUsage.ts");
const tokenLedger = loader.loadModule("src/lib/chat/compaction/tokenLedger.ts");
const chatComposerBarSource = readFileSync(
  new URL("../../../agent-ui/src/pages/chat/ChatComposerBar.tsx", import.meta.url),
  "utf8",
);
const chatTurnQueueSource = readFileSync(
  new URL("../../src/pages/chat/queue/useChatTurnQueue.ts", import.meta.url),
  "utf8",
);
const gatewayAppSource = readFileSync(
  new URL(
    "../../../agent-gateway/web/src/app/hooks/useGatewayConversationRuntime.ts",
    import.meta.url,
  ),
  "utf8",
);
const contextUsageRingSource = readFileSync(
  new URL("../../../agent-ui/src/components/chat/ContextUsageRing.tsx", import.meta.url),
  "utf8",
);

const {
  CONTEXT_USAGE_WARN_RATIO,
  CONTEXT_USAGE_DANGER_RATIO,
  assistantAnchorTokens,
  buildContextUsageScanItems,
  contextUsageLevel,
  canManualCompact,
  contextUsageRatio,
  deriveContextUsageTokens,
  estimateJsonTokens,
  estimateTextTokens,
  estimateTextTokenUnits,
  estimateThinkingReplayTokenUnits,
  hasContextUsageUsageAnchor,
  hostedSearchFollowUpTokens,
  isResponsesReasoningSignature,
  isStrippedHostedSearchUsage,
} = contextUsage;

test("threshold boundaries: <50% ok, 50-80% warn, >=80% danger", () => {
  assert.equal(CONTEXT_USAGE_WARN_RATIO, 0.5);
  assert.equal(CONTEXT_USAGE_DANGER_RATIO, 0.8);
  assert.equal(contextUsageLevel(0), "ok");
  assert.equal(contextUsageLevel(0.49), "ok");
  assert.equal(contextUsageLevel(0.5), "warn");
  assert.equal(contextUsageLevel(0.79), "warn");
  assert.equal(contextUsageLevel(0.8), "danger");
  assert.equal(contextUsageLevel(1.5), "danger");
});

test("manual compaction unlocks exactly at the warn ratio", () => {
  assert.equal(canManualCompact(0.49), false);
  assert.equal(canManualCompact(0.5), true);
  assert.equal(canManualCompact(0.99), true);
});

test("WebUI manual compaction targets the requested conversation and only accepts on proceed", () => {
  assert.doesNotMatch(chatTurnQueueSource, /conversation is not active on desktop/);
  // 严格 operationId：缺失即拒绝，不回退 requestId（回退产生 WebUI 从未登记的
  // operationId，终态永不匹配、挂满超时）。
  assert.match(chatTurnQueueSource, /manual compaction requires operationId/);
  // 受理只在探针通过、真正开始压缩时经 onAccepted 同步回包。
  assert.match(
    chatTurnQueueSource,
    /manualCompactActionRef\s*\.current\(\{\s*conversationId,\s*operationId,\s*onAccepted: respondAccepted,?\s*\}\)/,
  );
  // 探针拒绝据返回值同步回 accepted:false + message（不再受理即回包）。
  assert.match(
    chatTurnQueueSource,
    /fail\(result\.message \|\| "manual compaction declined", codeFor\(result\.status\)\)/,
  );
});

test("WebUI manual compaction converges from the transcript store and a bounded timeout", () => {
  assert.match(gatewayAppSource, /store\.getSnapshot\(\)\.manualCompactionResult/);
  assert.match(gatewayAppSource, /MANUAL_COMPACTION_TIMEOUT_MS/);
  assert.match(gatewayAppSource, /chat\.manualCompactTimedOut/);
});

test("context usage ring stays vertically centered in the shared composer", () => {
  assert.match(
    chatComposerBarSource,
    /className="absolute right-3 top-1\/2 z-20 -translate-y-1\/2"/,
  );
  assert.doesNotMatch(chatComposerBarSource, /className="absolute bottom-11 right-3 z-20"/);
});

test("composer editor row reserves the right control rail so the scrollbar clears the ring", () => {
  // 让位必须做在编辑器外层容器上：padding 不移动滚动条，编辑器自带 pr-8 时
  // 那条 6px 滚动轨会压在用量环/展开图标上（right-3 + w-8 的 44px 轨道）。
  assert.match(chatComposerBarSource, /"relative flex flex-1 pl-4 pr-12"/);
  assert.doesNotMatch(chatComposerBarSource, /"relative flex flex-1 px-4"/);
  assert.doesNotMatch(chatComposerBarSource, /"px-0 py-0 pr-8"/);
});

test("context usage ring resets a stale confirm popover when compaction flips unavailable", () => {
  // 可压缩分支翻回纯展示时（他端压缩/发消息置 disabled、压缩后占用掉回阈值
  // 下），confirmOpen 必须渲染期归位：否则恢复可压缩后确认弹层会无操作自动
  // 弹开，残留期间互斥守卫还会一直吞掉 tooltip 的打开请求。
  assert.match(
    contextUsageRingSource,
    /if \(!compactAvailable && confirmOpen\) \{\s*setConfirmOpen\(false\);/,
  );
});

test("context usage ring tracks pointer form-factor changes via matchMedia subscription", () => {
  // iPad 插拔键鼠、可翻转本翻转等触屏形态热切换必须实时生效，
  // 不能挂载时一次性求值定死交互模式。
  assert.match(
    contextUsageRingSource,
    /useSyncExternalStore\(\s*subscribeCoarsePointer,\s*isCoarsePointerNow/,
  );
  assert.match(contextUsageRingSource, /addEventListener\("change", onChange\)/);
});

test("contextUsageRatio guards degenerate inputs", () => {
  assert.equal(contextUsageRatio(100_000, 200_000), 0.5);
  assert.equal(contextUsageRatio(undefined, 200_000), 0);
  assert.equal(contextUsageRatio(100_000, undefined), 0);
  assert.equal(contextUsageRatio(100_000, 0), 0);
  assert.equal(contextUsageRatio(-1, 200_000), 0);
  assert.equal(contextUsageRatio(Number.NaN, 200_000), 0);
});

test("assistantAnchorTokens is the single anchor semantic: usage arithmetic only", () => {
  // stop + reasoning 上报：精确算术（prompt 侧 + output − reasoning）。
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 4_000, cacheRead: 500, output: 43_000, reasoning: 40_000 },
      stopReason: "stop",
    }),
    7_500,
  );
  // reasoning 上报为 0：不扣减。
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 1_000, output: 200, reasoning: 0 },
      stopReason: "stop",
    }),
    1_200,
  );
  // reasoning 缺失：按调用方提供的 thinking 正文估算 units 扣减，可见输出下限 0。
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 2_000, output: 400 },
      stopReason: "stop",
      thinkingTokenUnits: 250,
    }),
    2_150,
  );
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 1_000, output: 100 },
      stopReason: "stop",
      thinkingTokenUnits: 250.4,
    }),
    1_000,
  );
  // toolUse：reasoning/thinking 随工具环重放计费，output 全量计入、无双算。
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 2_000, output: 400, reasoning: 300 },
      stopReason: "toolUse",
      thinkingTokenUnits: 250,
    }),
    2_400,
  );
  // OpenAI Responses / 带签名 thinking：stop 后仍重放，不得扣 reasoning。
  assert.equal(
    assistantAnchorTokens({
      usage: { input: 18_000, output: 2_366, reasoning: 1_543 },
      stopReason: "stop",
      replayReasoning: true,
    }),
    20_366,
  );
  // prompt 侧全缺（中转只报总量）：totalTokens 做同样扣减，下限 1。
  assert.equal(
    assistantAnchorTokens({ usage: { totalTokens: 5_000, reasoning: 2_000 } }),
    3_000,
  );
  assert.equal(
    assistantAnchorTokens({ usage: { totalTokens: 1_000 }, thinkingTokenUnits: 2_000 }),
    1,
  );
  // 无任何可用量：不锚定。
  assert.equal(assistantAnchorTokens({ usage: undefined }), undefined);
  assert.equal(
    assistantAnchorTokens({ usage: { input: 0, output: 0, totalTokens: 0 } }),
    undefined,
  );
});

test("deriveContextUsageTokens reads the newest assistant round usage", () => {
  const items = [
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [
        { meta: { usage: { totalTokens: 10_000 } } },
        { meta: { usage: { totalTokens: 12_000 } } },
      ],
    },
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [{ meta: {} }, { meta: { usage: { totalTokens: 34_000 } } }, { meta: {} }],
    },
  ];
  assert.equal(deriveContextUsageTokens(items), 34_000);
});

test("deriveContextUsageTokens computes round anchors from usage arithmetic at read time", () => {
  // 锚点不再随 meta 携带派生值：倒扫从 usage + stopReason + 轮内 thinking 块现算。
  const usage = { input: 100_000, cacheRead: 20_000, output: 5_000, reasoning: 4_000 };
  assert.equal(
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [{ meta: { usage, stopReason: "stop" }, blocks: [] }] },
    ]),
    121_000,
  );
  assert.equal(
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [{ meta: { usage, stopReason: "toolUse" }, blocks: [] }] },
    ]),
    125_000,
  );
  // 无 reasoning 分解：按轮内 thinking 块正文估算扣减（"a"×2000 = 500 units）。
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [
          {
            meta: { usage: { input: 50_000, output: 1_000 }, stopReason: "stop" },
            blocks: [{ kind: "thinking", text: "a".repeat(2_000) }],
          },
        ],
      },
    ]),
    50_500,
  );
});

test("deriveContextUsageTokens ignores render-only assistant rounds", () => {
  const items = [
    { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 150_000 } }, blocks: [] }] },
    {
      kind: "assistant",
      rounds: [
        {
          meta: {
            contextRelevant: false,
            usage: { totalTokens: 10_000 },
          },
          blocks: [{ kind: "text", text: "memory extraction status" }],
        },
      ],
    },
  ];
  assert.equal(deriveContextUsageTokens(items), 150_000);
});

test("deriveContextUsageTokens adds messages and tool results after the newest usage", () => {
  const trailingUser = "x".repeat(80_000);
  const toolResultContent = [{ type: "text", text: "y".repeat(4_000) }];
  const items = [
    {
      kind: "assistant",
      rounds: [
        {
          meta: { usage: { totalTokens: 100_000 } },
          blocks: [
            {
              kind: "tool",
              item: {
                toolCall: { name: "Read", arguments: { path: "src/app.ts" } },
                toolResult: { content: toolResultContent },
              },
            },
          ],
        },
      ],
    },
    { kind: "user", text: trailingUser },
  ];
  // 工具结果只计模型可见文本（不再整块 JSON 序列化后按字符估）。
  const toolResultTokens = Math.ceil(contextUsage.estimateTextTokenUnits("y".repeat(4_000))) + 8;
  assert.equal(deriveContextUsageTokens(items), 120_008 + toolResultTokens);
});

test("deriveContextUsageTokens prices binary tool payloads flat and ignores details", () => {
  const items = [
    {
      kind: "assistant",
      rounds: [
        {
          meta: { usage: { totalTokens: 10_000 } },
          blocks: [
            {
              kind: "tool",
              item: {
                toolCall: { name: "Read", arguments: { path: "shot.png" } },
                toolResult: {
                  content: [{ type: "image", data: "A".repeat(1_000_000), mimeType: "image/png" }],
                  details: { stdout: "C".repeat(400_000) },
                },
              },
            },
          ],
        },
      ],
    },
  ];
  // 锚点轮次自身的工具结果补计：图按计价常量而非 base64/4（后者虚报 25 万
  // token 令环跳变），details 不发给模型、不计。
  assert.equal(deriveContextUsageTokens(items), 10_000 + contextUsage.BINARY_BLOCK_TOKENS + 8);
});

test("deriveContextUsageTokens falls back to checkpoint estimate after compaction", () => {
  const summaryText = "摘要正文 summary body".repeat(50);
  // GUI 检查点（kind:"summary"）与 WebUI 检查点（kind:"checkpoint"）同口径。
  for (const kind of ["summary", "checkpoint"]) {
    const items = [
      { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 190_000 } } }] },
      { kind, content: summaryText },
    ];
    const derived = deriveContextUsageTokens(items);
    assert.equal(derived, estimateTextTokens(summaryText));
    assert.ok(derived > 0, "checkpoint estimate must keep the ring alive");
    assert.ok(derived < 190_000, "estimate must reflect the freed context");
  }
});

test("deriveContextUsageTokens prefers checkpoint fixed overhead and adds its trailing messages", () => {
  const items = [
    { kind: "checkpoint", content: "short summary", contextUsageTokens: 40_000 },
    { kind: "user", text: "x".repeat(4_000) },
  ];
  assert.equal(deriveContextUsageTokens(items), 41_008);
});

test("deriveContextUsageTokens counts user attachment metadata after the anchor", () => {
  const attachment = {
    relativePath: "uploads/diagram.png",
    fileName: "diagram.png",
    kind: "image",
    sizeBytes: 123_456,
  };
  const anchor = { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 50_000 } } }] };
  const text = "看看这张图";
  const textOnly = deriveContextUsageTokens([anchor, { kind: "user", text }]);
  const withAttachment = deriveContextUsageTokens([
    anchor,
    { kind: "user", text, attachments: [attachment] },
  ]);
  assert.ok(withAttachment > textOnly, "附件元数据必须计入尾部估算");
  assert.equal(
    withAttachment,
    50_000 +
      Math.ceil(
        contextUsage.estimateTextTokenUnits(text) +
          contextUsage.stringifiedTokenUnits(attachment),
      ) +
      8,
  );
});

test("deriveContextUsageTokens counts attachment-only user messages", () => {
  // 纯附件消息（正文为空）此前完全计零。
  const attachment = {
    relativePath: "uploads/error.log",
    fileName: "error.log",
    kind: "text",
    sizeBytes: 2_048,
  };
  assert.equal(
    deriveContextUsageTokens([
      { kind: "checkpoint", content: "short summary", contextUsageTokens: 40_000 },
      { kind: "user", text: "", attachments: [attachment] },
    ]),
    40_000 + Math.ceil(contextUsage.stringifiedTokenUnits(attachment)) + 8,
  );
});

test("deriveContextUsageTokens returns undefined without any usage", () => {
  assert.equal(deriveContextUsageTokens([]), undefined);
  assert.equal(deriveContextUsageTokens([{ kind: "user" }]), undefined);
  assert.equal(
    deriveContextUsageTokens([{ kind: "assistant", rounds: [{ meta: {} }] }]),
    undefined,
  );
  // usage 全零（中转异常）同样不锚定。
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [{ meta: { usage: { input: 0, output: 0, totalTokens: 0 } } }],
      },
    ]),
    undefined,
  );
});

test("deriveContextUsageTokens never anchors on hosted-search rounds", () => {
  // 实测数据：搜索轮 usage 报 117,996（服务端多次内部调用的聚合），下一轮实测
  // 持久上下文仅 52k。含 hostedSearch 块的轮次必须跳过锚点、内容按估算累加，
  // 且 hostedSearch 块本身（请求侧被剥除）不计任何估算。
  const searchRound = {
    meta: { usage: { input: 110_008, cacheRead: 5_184, output: 2_804, totalTokens: 117_996 } },
    blocks: [
      { kind: "text", text: "综合搜索结果……" },
      { kind: "hostedSearch", hostedSearch: { queries: ["新闻"], sources: [{ url: "u".repeat(4_000) }] } },
    ],
  };
  const plainRound = {
    blocks: [{ kind: "text", text: "综合搜索结果……" }],
  };

  // 搜索轮在末尾：跳过其聚合锚点，回落到更早的可信锚点 + 搜索轮正文估算。
  const withEarlierAnchor = deriveContextUsageTokens([
    { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 30_000 } }, blocks: [] }] },
    { kind: "assistant", rounds: [searchRound] },
  ]);
  const searchRoundEstimate = deriveContextUsageTokens([
    { kind: "assistant", rounds: [{ blocks: searchRound.blocks }] },
  ]);
  assert.equal(withEarlierAnchor, 30_000 + searchRoundEstimate);
  // hostedSearch 块不计估算：与纯文本轮次的估算完全一致。
  assert.equal(
    searchRoundEstimate,
    deriveContextUsageTokens([{ kind: "assistant", rounds: [{ blocks: plainRound.blocks }] }]),
  );

  // 全会话只有搜索轮：无锚点，退回估算（绝不显示 117,996 聚合值）。
  assert.notEqual(
    deriveContextUsageTokens([{ kind: "assistant", rounds: [searchRound] }]),
    117_996,
  );

  // 搜索轮之后的普通轮次正常锚定（用户会话的第二次请求即由此修正读数）。
  assert.equal(
    deriveContextUsageTokens([
      { kind: "assistant", rounds: [searchRound] },
      {
        kind: "assistant",
        rounds: [{ meta: { usage: { totalTokens: 52_730 } }, blocks: [] }],
      },
    ]),
    52_730,
  );
});

test("Responses thinking signatures are replayed, not the UI summary", () => {
  const signature = JSON.stringify({
    id: "rs_1",
    type: "reasoning",
    content: [],
    encrypted_content: "A".repeat(1_612),
    summary: [{ type: "summary_text", text: "plan" }],
  });
  assert.equal(isResponsesReasoningSignature(signature), true);
  assert.equal(isResponsesReasoningSignature("reasoning_content"), false);
  const summary = "short summary";
  const replay = estimateThinkingReplayTokenUnits({
    thinking: summary,
    thinkingSignature: signature,
  });
  assert.ok(replay > estimateTextTokenUnits(signature));
  assert.ok(replay > estimateTextTokenUnits(summary) * 5);
});

test("hosted-search idle scan counts Responses replay and does not jump 19k→30k", () => {
  // 实测会话 02fb1f14：搜索轮结束后空闲约 19k（只计摘要），下一短回复真实
  // usage 32_286。倒扫必须计入 thinkingSignature 重放量。
  const replayTokenUnits = Math.ceil(
    estimateTextTokenUnits(
      JSON.stringify({
        id: "rs",
        type: "reasoning",
        encrypted_content: "A".repeat(17_140),
      }),
    ),
  );
  const searchRound = {
    meta: {
      api: "openai-responses",
      stopReason: "stop",
      usage: { input: 80_509, cacheRead: 3_456, output: 2_366, reasoning: 1_543, totalTokens: 86_331 },
    },
    blocks: [
      { kind: "thinking", text: "short summary", replayTokenUnits },
      { kind: "hostedSearch", item: { queries: ["西安"], sources: [] } },
      { kind: "text", text: "西安今日新闻速览" },
    ],
  };
  const items = [
    { kind: "user", text: "请你联网搜索西安今天的新闻" },
    { kind: "assistant", rounds: [searchRound] },
  ];
  assert.equal(hasContextUsageUsageAnchor(items), false);
  const idle = deriveContextUsageTokens(items, { unanchoredFixedTokens: 17_000 });
  const withoutReplay = deriveContextUsageTokens(
    [
      items[0],
      {
        kind: "assistant",
        rounds: [
          {
            ...searchRound,
            blocks: [
              { kind: "thinking", text: "short summary" },
              { kind: "hostedSearch", item: { queries: ["西安"], sources: [] } },
              { kind: "text", text: "西安今日新闻速览" },
            ],
          },
        ],
      },
    ],
    { unanchoredFixedTokens: 17_000 },
  );
  assert.ok(idle > withoutReplay + 3_000, `replay must lift idle: ${idle} vs ${withoutReplay}`);
  assert.notEqual(idle, 86_331);

  const afterThanks = deriveContextUsageTokens(
    [
      ...items,
      { kind: "user", text: "谢谢" },
      {
        kind: "assistant",
        rounds: [
          {
            meta: {
              api: "openai-responses",
              stopReason: "stop",
              usage: { input: 3_149, cacheRead: 29_056, output: 81, totalTokens: 32_286 },
            },
            blocks: [{ kind: "text", text: "不客气" }],
          },
        ],
      },
    ],
    { unanchoredFixedTokens: 17_000 },
  );
  assert.equal(afterThanks, 32_286);
  assert.ok(
    afterThanks - idle < afterThanks - withoutReplay,
    `new idle must shrink the 19k→32k jump: idle=${idle} old=${withoutReplay} real=${afterThanks}`,
  );
});

test("warm hosted-search idle uses cacheRead+output so 好的 does not drop 36k→32k", () => {
  // 实测会话 b96f6ab6：热缓存搜索轮 cacheRead 30080、output 2965。encrypted
  // 签名按 0.4/字估会把空闲环抬到 ~36k；下一短回复真实 usage 32703。
  const searchUsage = {
    input: 53_290,
    cacheRead: 30_080,
    output: 2_965,
    reasoning: 2_057,
    totalTokens: 86_335,
  };
  assert.equal(hostedSearchFollowUpTokens(searchUsage), 33_045);
  assert.equal(hostedSearchFollowUpTokens(searchUsage, 26_466), 33_045);
  assert.equal(
    hostedSearchFollowUpTokens({
      input: 80_509,
      cacheRead: 3_456,
      output: 2_366,
      totalTokens: 86_331,
    }),
    undefined,
  );
  assert.equal(
    isStrippedHostedSearchUsage({ input: 0, cacheRead: 30_080, output: 2_965, totalTokens: 0 }),
    true,
  );
  assert.equal(
    isStrippedHostedSearchUsage(searchUsage),
    false,
  );

  const searchRound = {
    meta: { api: "openai-responses", stopReason: "stop", usage: searchUsage },
    blocks: [
      { kind: "thinking", text: "short summary", replayTokenUnits: 8_674 },
      { kind: "hostedSearch", item: { queries: ["西安"], sources: [] } },
      { kind: "text", text: "西安今日新闻速览" },
    ],
  };
  const items = [
    { kind: "user", text: "请你联网搜索西安今天的新闻" },
    { kind: "assistant", rounds: [searchRound] },
  ];
  assert.equal(hasContextUsageUsageAnchor(items, { unanchoredFixedTokens: 26_466 }), true);
  const idle = deriveContextUsageTokens(items, { unanchoredFixedTokens: 26_466 });
  assert.equal(idle, 33_045);
  assert.notEqual(idle, 86_335);

  const afterThanks = deriveContextUsageTokens(
    [
      ...items,
      { kind: "user", text: "好的" },
      {
        kind: "assistant",
        rounds: [
          {
            meta: {
              api: "openai-responses",
              stopReason: "stop",
              usage: { input: 3_588, cacheRead: 29_056, output: 59, totalTokens: 32_703 },
            },
            blocks: [{ kind: "text", text: "不客气" }],
          },
        ],
      },
    ],
    { unanchoredFixedTokens: 26_466 },
  );
  assert.equal(afterThanks, 32_703);
  assert.ok(
    Math.abs(afterThanks - idle) < 500,
    `warm idle must stay within hundreds of the next real usage: idle=${idle} real=${afterThanks}`,
  );
});

test("openai-responses usage rounds keep reasoning in the stop anchor", () => {
  // 无 hostedSearch 的 Responses 轮：api + reasoning 即视为会重放，stop 不扣。
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [
          {
            meta: {
              api: "openai-responses",
              stopReason: "stop",
              usage: { input: 18_000, output: 2_000, reasoning: 1_500 },
            },
            blocks: [{ kind: "thinking", text: "plan" }],
          },
        ],
      },
    ]),
    20_000,
  );
});

test("ledger and idle scan agree on the same round so settle never jumps", () => {
  // 运行中（账本）与空闲（倒扫）对同一轮次必须给出同一读数：两端各自从
  // usage + stopReason + thinking 正文现算同一公式。
  const thinking = "推理过程".repeat(100);
  const messageUsage = {
    input: 40_000,
    cacheRead: 8_000,
    output: 900,
    cacheWrite: 0,
    totalTokens: 48_900,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const ledgerReading = tokenLedger.getMessageObservedTokens({
    role: "assistant",
    content: [
      { type: "thinking", thinking },
      { type: "text", text: "结论" },
    ],
    stopReason: "stop",
    usage: messageUsage,
    timestamp: 2,
  });
  const scanReading = deriveContextUsageTokens([
    {
      kind: "assistant",
      rounds: [
        {
          meta: { usage: messageUsage, stopReason: "stop" },
          blocks: [
            { kind: "thinking", text: thinking },
            { kind: "text", text: "结论" },
          ],
        },
      ],
    },
  ]);
  assert.equal(ledgerReading, scanReading);
  const thinkingTokens = Math.ceil(contextUsage.estimateTextTokenUnits(thinking));
  assert.equal(ledgerReading, 48_000 + Math.max(0, 900 - thinkingTokens));
});

test("deriveContextUsageTokens adds fixed overhead only when unanchored", () => {
  // 无锚点时倒扫只算可见正文，不补 fixed（system+tools 估算）会与运行中账本
  // 读数（含 fixed）来回跳变——供应商不回传 usage 的会话上环每次 settle 必跳。
  const items = [{ kind: "user", text: "a".repeat(400) }];
  const base = deriveContextUsageTokens(items);
  assert.equal(base, 100 + 8);
  assert.equal(
    deriveContextUsageTokens(items, { unanchoredFixedTokens: 2_000 }),
    base + 2_000,
  );
  // 有 usage 锚点时读数已含 fixed，绝不叠加。
  const anchored = [
    { kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 50_000 } } }] },
  ];
  assert.equal(
    deriveContextUsageTokens(anchored, { unanchoredFixedTokens: 2_000 }),
    50_000,
  );
  // 完全空转录 + fixed：读数为 fixed 本身（system+tools 真实占用上下文）。
  assert.equal(deriveContextUsageTokens([], { unanchoredFixedTokens: 2_000 }), 2_000);
  assert.equal(deriveContextUsageTokens([], { unanchoredFixedTokens: 0 }), undefined);
});

test("deriveContextUsageTokens adds fixed overhead to legacy checkpoint estimates only", () => {
  const summaryText = "legacy checkpoint summary body".repeat(30);
  // 旧历史检查点没有权威快照：正文估算不含 system/tools，需补 fixed 对齐口径。
  assert.equal(
    deriveContextUsageTokens([{ kind: "summary", content: summaryText }], {
      unanchoredFixedTokens: 1_500,
    }),
    estimateTextTokens(summaryText) + 1_500,
  );
  // 权威快照（contextUsageTokens）出自 deriveContextTokens，已含 fixed。
  assert.equal(
    deriveContextUsageTokens(
      [{ kind: "checkpoint", content: summaryText, contextUsageTokens: 40_000 }],
      { unanchoredFixedTokens: 1_500 },
    ),
    40_000,
  );
});

test("JSON / tool-schema estimates are denser than prose chars/4", () => {
  // 工具定义是 JSON schema：o200k 大约 2.5 字/token。chars/4 会让 fixedTokens
  // 比真实首轮 prompt 少 4–8k（搜索后续轮 cacheRead 仍稳定在 ~29k）。
  const schema = JSON.stringify({
    type: "object",
    properties: {
      path: { type: "string", description: "workspace-relative path" },
      limit: { type: "number", minimum: 1 },
    },
    required: ["path"],
    additionalProperties: false,
  }).repeat(40);
  const prose = estimateTextTokens(schema);
  const json = estimateJsonTokens(schema);
  assert.ok(json > prose, `json=${json} must exceed prose=${prose}`);
  assert.equal(json, Math.ceil(schema.length * 0.4));
  // CJK 仍走 0.7，不因 JSON 口径被压低。
  assert.equal(estimateJsonTokens("参数".repeat(10)), Math.ceil(20 * 0.7));
  // estimateToolsTokens 必须走 JSON 口径，否则账本 fixed 仍按 chars/4。
  const tools = [{ name: "Read", description: "d".repeat(200), parameters: { type: "object" } }];
  assert.equal(tokenLedger.estimateToolsTokens(tools), estimateJsonTokens(JSON.stringify(tools)));
  assert.ok(tokenLedger.estimateToolsTokens(tools) > estimateTextTokens(JSON.stringify(tools)));
});

test("estimateTextTokens keeps the CJK-aware estimate after the move to shared", () => {
  // tokenLedger re-export 与共享层实现必须是同一函数（迁移不改口径）。
  assert.equal(tokenLedger.estimateTextTokens, estimateTextTokens);
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("   "), 0);
  // 4 个西文字符 ≈ 1 token；CJK 每字 0.7 token（向上取整）。
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("你好世界"), Math.ceil(4 * 0.7));
  // 可加性：分段和 = 整体（同一字符串拼接）。
  const west = "hello world ";
  const cjk = "上下文压缩";
  assert.equal(
    Math.ceil(
      contextUsage.estimateTextTokenUnits(west) + contextUsage.estimateTextTokenUnits(cjk),
    ),
    estimateTextTokens(west + cjk),
  );
});

test("deriveContextTokens includes system, tools, and messages without an observed usage", () => {
  const context = {
    systemPrompt: "system instructions",
    tools: [{ name: "Read", description: "read a file", parameters: { type: "object" } }],
    messages: [{ role: "user", content: "continue", timestamp: 1 }],
  };
  assert.equal(
    tokenLedger.deriveContextTokens(context),
    estimateTextTokens(context.systemPrompt) +
      tokenLedger.estimateToolsTokens(context.tools) +
      tokenLedger.estimateMessageTokens(context.messages[0]),
  );
});

test("buildContextUsageScanItems appends live rounds so streaming anchors the ring in real time", () => {
  const history = [{ kind: "user", text: "hi" }];
  const liveRounds = [
    {
      round: 1,
      key: "r1",
      blocks: [],
      meta: { usage: { totalTokens: 120_000 } },
      runningToolCallIds: [],
      thinkingOpen: false,
    },
  ];
  const items = buildContextUsageScanItems(history, {
    liveRounds,
    draftAssistantText: "",
  });
  assert.equal(items.length, 2);
  assert.equal(deriveContextUsageTokens(items), 120_000);
  // 空闲（无 live）时原样透传历史项。
  assert.equal(buildContextUsageScanItems(history, null), history);
});

test("buildContextUsageScanItems counts the streaming draft as a trailing round", () => {
  const draft = "x".repeat(4_000);
  const items = buildContextUsageScanItems(
    [{ kind: "assistant", rounds: [{ meta: { usage: { totalTokens: 50_000 } } }] }],
    { liveRounds: [], draftAssistantText: draft },
  );
  assert.equal(
    deriveContextUsageTokens(items),
    50_000 + Math.ceil(contextUsage.estimateTextTokenUnits(draft)) + 8,
  );
});
