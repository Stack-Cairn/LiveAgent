import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skills = loader.loadModule("@liveagent/ui/lib/skills/index.ts");

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

test("extractSkillMentionNamesFromText finds explicit skill tokens without treating common env vars as skills", () => {
  assert.deepEqual(
    skills.extractSkillMentionNamesFromText(
      "Use /code-review and /release_notes, keep /usr/bin literal and ignore price/tags.",
    ),
    ["code-review", "release_notes"],
  );
  assert.deepEqual(skills.extractSkillMentionNamesFromText("/liveagent-code-review"), [
    "liveagent-code-review",
  ]);
  // "$" is no longer a skill mention marker.
  assert.deepEqual(
    skills.extractSkillMentionNamesFromText("Use $code-review and $release_notes."),
    [],
  );
});

test("resolveExplicitSkillMentions only returns enabled skills and deduplicates structured/text mentions", () => {
  assert.deepEqual(
    skills.resolveExplicitSkillMentions({
      text: "/disabled /release_notes /code-review /code-review",
      structured: [
        {
          name: "code-review",
          skillFile: "code-review/SKILL.md",
          baseDir: "code-review",
        },
      ],
      enabledSkills,
    }),
    [enabledSkills[0], enabledSkills[1]],
  );
});

test("buildSkillsSystemPrompt no longer carries per-turn explicit mentions", () => {
  const prompt = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });

  // 显式提及已经移出 system prompt：它只对当轮有效，留在这里会让 system 段这轮
  // 多一段、下轮撤回去，一次 `/skill-name` 连废两次缓存前缀。
  assert.doesNotMatch(prompt, /Explicitly mentioned/);
  assert.doesNotMatch(prompt, /<skill-mentions>/);
  assert.match(prompt, /skill:\/\/<baseDir>\/\.\.\./);
  assert.doesNotMatch(prompt, /root=["']skills["']/);
  assert.doesNotMatch(prompt, /Read\(root=/);
});

test("buildSkillsSystemPrompt stays byte-identical across a mention turn and the next turn", () => {
  // 用户这轮打了 `/code-review`，下一轮什么都没打：两轮的 skills system prompt
  // 必须一个字节都不差，否则 system 块连同其后全部历史一起作废。
  const mentionTurn = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });
  const nextTurn = skills.buildSkillsSystemPrompt({
    rootDir: "/skills",
    selected: enabledSkills,
  });

  assert.equal(mentionTurn, nextTurn);
});

test("formatExplicitSkillMentions renders the resolved mentions and stays empty without any", () => {
  const block = skills.formatExplicitSkillMentions([enabledSkills[0]]);

  assert.match(block, /^<skill-mentions>\n/);
  assert.match(block, /\n<\/skill-mentions>$/);
  assert.match(block, /- code-review \(skillFile: code-review\/SKILL\.md, baseDir: code-review\)/);
  assert.ok(block.includes("`/` mentions never grant access to disabled Skills"));
  assert.ok(
    block.includes("Treat these mentions as user intent to prioritize those Skills."),
    "the prioritization instruction must survive the move out of the system prompt",
  );

  // 没有提及就不产生任何内容——空块是「不挂任何东西」的唯一信号。
  assert.equal(skills.formatExplicitSkillMentions([]), "");
});

test("formatExplicitSkillMentions never lists skills that resolveExplicitSkillMentions filtered out", () => {
  // 提及解析仍然是唯一的准入口径：禁用的 Skill 在这一步就被剔掉，渲染层拿不到。
  const resolved = skills.resolveExplicitSkillMentions({
    text: "/disabled /code-review",
    enabledSkills,
  });
  const block = skills.formatExplicitSkillMentions(resolved);

  assert.match(block, /- code-review \(/);
  // 只有条目行代表「授权可用」；样板行里的 "disabled Skills" 是措辞，不是条目。
  assert.doesNotMatch(block, /- disabled \(/);
  assert.doesNotMatch(block, /disabled\/SKILL\.md/);
});
