import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { detectCompactionSummaryLanguage } = loader.loadModule(
  "src/lib/chat/compaction/summaryLanguage.ts",
);
const { buildCompactionSystemPrompt, COMPACTION_SYSTEM_PROMPT } = loader.loadModule(
  "src/lib/chat/compaction/summaryPrompt.ts",
);

function payloadWith({ userTexts = [], nextUserMessage } = {}) {
  return {
    compaction_reason: { trigger: "test", context_tokens: 0, threshold: 0 },
    system_prompt: "",
    previous_summary: null,
    active_segment_messages: userTexts.map((content, index) => ({
      index,
      role: "user",
      timestamp: index,
      content,
    })),
    next_user_message: nextUserMessage,
  };
}

test("english conversations keep the default english summary", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["Please refactor the config loader and add tests."] }),
    ),
    undefined,
  );
});

test("chinese-dominant conversations are detected as Chinese", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["帮我重构这个配置加载器，然后补上单元测试。"] }),
    ),
    "Chinese",
  );
});

test("mixed chinese with english identifiers still detects Chinese", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({
        userTexts: ["把 src/lib/config.ts 里的 loadConfig 改成异步实现，注意保留 retry 逻辑。"],
      }),
    ),
    "Chinese",
  );
});

test("japanese conversations are detected as Japanese", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["この設定ローダーをリファクタリングしてテストを追加してください。"] }),
    ),
    "Japanese",
  );
});

test("korean conversations are detected as Korean", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: ["이 설정 로더를 리팩터링하고 테스트를 추가해 주세요."] }),
    ),
    "Korean",
  );
});

test("next_user_message participates in detection", () => {
  assert.equal(
    detectCompactionSummaryLanguage(
      payloadWith({ userTexts: [], nextUserMessage: "继续，把剩下的模块也迁移完。" }),
    ),
    "Chinese",
  );
});

test("tiny samples fall back to the english default", () => {
  assert.equal(detectCompactionSummaryLanguage(payloadWith({ userTexts: ["好"] })), undefined);
  assert.equal(detectCompactionSummaryLanguage(payloadWith({ userTexts: [] })), undefined);
});

test("assistant/tool messages do not affect detection", () => {
  const payload = payloadWith({ userTexts: ["Run the tests again please."] });
  payload.active_segment_messages.push({
    index: 99,
    role: "assistant",
    timestamp: 99,
    stopReason: "stop",
    text: "这里是一大段助手输出的中文内容，不应参与语言判定。".repeat(10),
  });
  assert.equal(detectCompactionSummaryLanguage(payload), undefined);
});

test("buildCompactionSystemPrompt defaults to the english mandate", () => {
  assert.ok(COMPACTION_SYSTEM_PROMPT.includes("You MUST write the summary in English"));
  assert.equal(buildCompactionSystemPrompt(), COMPACTION_SYSTEM_PROMPT);
});

test("buildCompactionSystemPrompt embeds the detected language directive", () => {
  const prompt = buildCompactionSystemPrompt("Chinese");
  assert.ok(prompt.includes("You MUST write the free-text summary content in Chinese"));
  assert.ok(!prompt.includes("You MUST write the summary in English"));
  assert.ok(prompt.includes("CONTEXT CHECKPOINT"));
  assert.ok(prompt.includes("<summary>"), "XML schema must stay intact");
});

test("summarizeConversation sends the language directive for chinese payloads", async () => {
  const { summarizeConversation } = loader.loadModule("src/lib/chat/compaction/summarizer.ts");
  const validXml = `<summary>
<task>重构压缩子系统</task>
<state>已修改 src/app.ts，${"细节说明。".repeat(60)}</state>
<artifacts>
- [file] src/app.ts | modified | 重写入口
</artifacts>
<next_steps>
1. 接好 controller
</next_steps>
</summary>`;
  const calls = [];
  const result = await summarizeConversation({
    providerId: "claude_code",
    model: "claude-x",
    runtime: { baseUrl: "https://example", apiKey: "k" },
    payload: {
      compaction_reason: { trigger: "test", context_tokens: 190_000, threshold: 152_000 },
      system_prompt: "base prompt",
      previous_summary: null,
      active_segment_messages: [
        { index: 0, role: "user", timestamp: 1, content: "请帮我修改 src/app.ts 的入口逻辑。" },
        {
          index: 1,
          role: "assistant",
          timestamp: 2,
          stopReason: "stop",
          text: "已修改 src/app.ts。",
        },
      ],
    },
    complete: async (params) => {
      calls.push(params);
      return {
        role: "assistant",
        content: [{ type: "text", text: validXml }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-real",
        stopReason: "stop",
        usage: {
          input: 5000,
          output: 300,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5300,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        timestamp: 1234,
        responseId: "resp-1",
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].context.systemPrompt.includes(
      "You MUST write the free-text summary content in Chinese",
    ),
  );
  assert.ok(result.summaryText.includes("重构压缩子系统"));
});
