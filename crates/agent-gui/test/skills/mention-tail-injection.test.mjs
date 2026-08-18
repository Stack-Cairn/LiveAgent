// skills「显式提及」后置到 user 消息尾部的端到端对账。
//
// 关注三件事：
//  1. 用户打 `/skill-name` 的那轮及其下一轮，systemPrompt 字节必须不变；
//  2. 没有提及时不产生任何额外内容（数组引用都不能变）；
//  3. 已挂上的块在后续轮次原样重放，历史消息一个字节都不动。

import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skills = loader.loadModule("@liveagent/ui/lib/skills/index.ts");
const { skillMentionInjection } = loader.loadModule("src/lib/chat/skills/mentionInjection.ts");
const { capturePrefixShape, comparePrefixShape } = loader.loadModule(
  "src/lib/debug/prefixCacheShape.ts",
);
const { buildPreparedContext } = loader.loadModule(
  "src/pages/chat/runtime/conversationContextBuilders.ts",
);
const { normalizeConversationState } = loader.loadModule(
  "src/lib/chat/conversation/conversationState.ts",
);
const { attachMemoryTurnUpdates } = loader.loadModule("src/lib/memory/prompts/turnInjection.ts");

const BASE_SYSTEM_PROMPT = "base system prompt";
const TOOLS = [{ name: "SkillsManager", description: "skills", parameters: { type: "object" } }];

const enabledSkills = [
  {
    name: "code-review",
    description: "Review local code changes",
    skillFile: "code-review/SKILL.md",
    baseDir: "code-review",
  },
  {
    name: "release_notes",
    description: "Prepare release notes",
    skillFile: "release_notes/SKILL.md",
    baseDir: "release_notes",
  },
];

const SKILLS_PROMPT = skills.buildSkillsSystemPrompt({
  rootDir: "/skills",
  selected: enabledSkills,
});

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

function contextFor(conversationId, messages) {
  return buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: SKILLS_PROMPT,
    skillMentionUpdates: skillMentionInjection.getMessageUpdates(conversationId),
  });
}

/** 复刻发送链路：解析提及 → 渲染块 → 记账到当轮 user 消息。 */
function sendTurn(conversationId, turn, text) {
  const explicit = skills.resolveExplicitSkillMentions({ text, enabledSkills });
  skillMentionInjection.record({
    conversationId,
    messageId: `u${turn}`,
    block: skills.formatExplicitSkillMentions(explicit),
  });
}

function userTurn(index, text) {
  return { role: "user", id: `u${index}`, content: text, timestamp: index * 10 };
}

function assistantTurn(index) {
  return {
    role: "assistant",
    content: [{ type: "text", text: `reply ${index}` }],
    stopReason: "stop",
    timestamp: index * 10 + 1,
  };
}

test("显式提及那轮及下一轮 systemPrompt 字节不变，块只挂在对应 user 消息尾部", (t) => {
  const conversationId = "conv-skill-mentions";
  t.after(() => skillMentionInjection.dispose(conversationId));

  const messages = [];
  const shapes = [];
  const contexts = [];
  // 第 2 轮用户打了 `/code-review`，其余三轮没有任何提及。
  const texts = ["plain turn", "please run /code-review now", "plain turn", "plain turn"];

  texts.forEach((text, index) => {
    const turn = index + 1;
    messages.push(userTurn(turn, text));
    sendTurn(conversationId, turn, text);
    const context = contextFor(conversationId, messages);
    contexts.push(context);
    shapes.push(capturePrefixShape({ systemPrompt: context.systemPrompt, tools: context.tools }));
    messages.push(assistantTurn(turn));
  });

  // 没有任何一轮凭空多出一条消息。
  assert.deepEqual(
    contexts.map((context) => context.messages.length),
    [1, 3, 5, 7],
  );

  // 核心断言：提及轮（第 2 轮）与其下一轮（第 3 轮）都判定 unchanged。
  const summaries = shapes.map((shape, index) =>
    comparePrefixShape(index === 0 ? null : shapes[index - 1], shape).prefixChangeSummary,
  );
  assert.deepEqual(summaries, ["initial", "unchanged", "unchanged", "unchanged"]);

  // 第 1 轮没有提及：上下文里不该出现任何块。
  assert.ok(!JSON.stringify(contexts[0].messages).includes("<skill-mentions>"));

  // 第 2 轮的块挂在第 2 轮那条 user 消息上，历史消息原样不动。
  const mentionUser = contexts[1].messages.find((message) => message.id === "u2");
  assert.ok(mentionUser.content.includes("<skill-mentions>"));
  assert.ok(mentionUser.content.includes("code-review/SKILL.md"));
  assert.ok(
    mentionUser.content.startsWith("please run /code-review now"),
    "用户原文必须留在最前面，块只追加在尾部",
  );
  assert.equal(contexts[1].messages[0].content, "plain turn");

  // 第 3、4 轮重放同一份字节：历史区间保持可缓存。
  assert.equal(
    JSON.stringify(contexts[2].messages.slice(0, 3)),
    JSON.stringify(contexts[1].messages),
  );
  assert.equal(
    JSON.stringify(contexts[3].messages.slice(0, 5)),
    JSON.stringify(contexts[2].messages),
  );
});

test("没有显式提及时不产生任何额外内容：不建状态、数组引用不变", (t) => {
  const conversationId = "conv-skill-mentions-empty";
  t.after(() => skillMentionInjection.dispose(conversationId));

  sendTurn(conversationId, 1, "no mentions at all, keep /usr/bin literal");

  // 空块连状态都不该创建。
  assert.equal(skillMentionInjection.getMessageUpdates(conversationId), undefined);

  const messages = [userTurn(1, "no mentions at all, keep /usr/bin literal")];
  const baseline = buildPreparedContext({
    state: stateOf(messages),
    tools: TOOLS,
    activeAgentPrompt: "",
    skillsPrompt: SKILLS_PROMPT,
  });
  const withEmptyUpdates = contextFor(conversationId, messages);

  assert.equal(
    JSON.stringify(withEmptyUpdates.messages),
    JSON.stringify(baseline.messages),
    "没有提及时上下文与不传 updates 时完全一致",
  );
  assert.ok(!JSON.stringify(withEmptyUpdates.messages).includes("<skill-mentions>"));

  // 没挂东西时必须原样返回同一个数组引用：调用方的引用相等短路依赖这一点。
  const raw = [userTurn(1, "plain"), assistantTurn(1)];
  assert.equal(attachMemoryTurnUpdates(raw, undefined), raw);
  assert.equal(attachMemoryTurnUpdates(raw, new Map()), raw);
  assert.equal(attachMemoryTurnUpdates(raw, new Map([["missing", "BLOCK"]])), raw);
});

test("缺少会话 id 或消息 id 时丢掉这次提及，不挂到对不上的消息上", (t) => {
  t.after(() => {
    skillMentionInjection.dispose("conv-skill-mentions-guard");
    skillMentionInjection.dispose("");
  });

  const block = skills.formatExplicitSkillMentions([enabledSkills[0]]);

  skillMentionInjection.record({ conversationId: "  ", messageId: "u1", block });
  assert.equal(skillMentionInjection.getMessageUpdates(""), undefined);

  skillMentionInjection.record({ conversationId: "conv-skill-mentions-guard", block });
  assert.equal(skillMentionInjection.getMessageUpdates("conv-skill-mentions-guard"), undefined);
});

test("对照组：同样的提及若继续走 system prompt，前缀会被判定为 system 变更", () => {
  const block = skills.formatExplicitSkillMentions([enabledSkills[0]]);
  const before = capturePrefixShape({ systemPrompt: SKILLS_PROMPT, tools: TOOLS });
  const after = capturePrefixShape({
    systemPrompt: `${SKILLS_PROMPT}\n\n${block}`,
    tools: TOOLS,
  });

  assert.equal(comparePrefixShape(before, after).prefixChangeSummary, "system");
});
