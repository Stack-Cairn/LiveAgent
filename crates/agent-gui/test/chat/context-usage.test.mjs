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
  buildContextUsageScanItems,
  contextUsageLevel,
  canManualCompact,
  contextUsageRatio,
  deriveContextUsageTokens,
  estimateTextTokens,
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

test("deriveContextUsageTokens reads the newest assistant round usage", () => {
  const items = [
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [{ meta: { usageTotalTokens: 10_000 } }, { meta: { usageTotalTokens: 12_000 } }],
    },
    { kind: "user" },
    {
      kind: "assistant",
      rounds: [{ meta: {} }, { meta: { usageTotalTokens: 34_000 } }, { meta: {} }],
    },
  ];
  assert.equal(deriveContextUsageTokens(items), 34_000);
});

test("deriveContextUsageTokens prefers the runtime context snapshot over provider usage", () => {
  assert.equal(
    deriveContextUsageTokens([
      {
        kind: "assistant",
        rounds: [
          { meta: { usageTotalTokens: 10_000, contextUsageTokens: 150_000 }, blocks: [] },
        ],
      },
    ]),
    150_000,
  );
});

test("deriveContextUsageTokens ignores render-only assistant rounds", () => {
  const items = [
    { kind: "assistant", rounds: [{ meta: { contextUsageTokens: 150_000 }, blocks: [] }] },
    {
      kind: "assistant",
      rounds: [
        {
          meta: {
            contextRelevant: false,
            usageTotalTokens: 10_000,
            contextUsageTokens: 10_000,
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
          meta: { usageTotalTokens: 100_000 },
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
  const toolResultTokens =
    Math.ceil(contextUsage.estimateTextTokenUnits(JSON.stringify(toolResultContent))) + 8;
  assert.equal(deriveContextUsageTokens(items), 120_008 + toolResultTokens);
});

test("deriveContextUsageTokens falls back to checkpoint estimate after compaction", () => {
  const summaryText = "摘要正文 summary body".repeat(50);
  // GUI 检查点（kind:"summary"）与 WebUI 检查点（kind:"checkpoint"）同口径。
  for (const kind of ["summary", "checkpoint"]) {
    const items = [
      { kind: "assistant", rounds: [{ meta: { usageTotalTokens: 190_000 } }] },
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
  const anchor = { kind: "assistant", rounds: [{ meta: { usageTotalTokens: 50_000 } }] };
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
      meta: { usageTotalTokens: 120_000 },
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
    [{ kind: "assistant", rounds: [{ meta: { usageTotalTokens: 50_000 } }] }],
    { liveRounds: [], draftAssistantText: draft },
  );
  assert.equal(
    deriveContextUsageTokens(items),
    50_000 + Math.ceil(contextUsage.estimateTextTokenUnits(draft)) + 8,
  );
});
