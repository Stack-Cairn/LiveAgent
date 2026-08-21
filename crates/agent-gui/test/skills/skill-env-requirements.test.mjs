import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const skillEnv = loader.loadModule("@liveagent/ui/lib/skills/skillEnv.ts");

function requirement(name, overrides = {}) {
  return {
    name,
    required: true,
    confidence: "strong",
    provider: null,
    description: null,
    url: null,
    sources: [],
    systemValuePresent: false,
    ...overrides,
  };
}

function summary(name, envRequirements) {
  return { name, envRequirements };
}

test("探测仅建议：强信号不锁启用，声明必填才参与门禁", () => {
  const detectedOnly = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("OPENWEATHER_API_KEY")]),
    {},
  );
  assert.equal(detectedOnly.satisfied, true);
  assert.equal(detectedOnly.requirements[0].effectiveRequired, false);

  const declared = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("OPENWEATHER_API_KEY", { confidence: "declared" })]),
    {},
  );
  assert.equal(declared.satisfied, false);
  assert.deepEqual(declared.missingRequired, ["OPENWEATHER_API_KEY"]);
  assert.equal(declared.requirements[0].state, "missing");
});

test("用户填写值或脱敏 configured 标记都算已满足", () => {
  const byValue = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("OPENWEATHER_API_KEY", { confidence: "declared" })]),
    { weather: { OPENWEATHER_API_KEY: { value: "sk-test" } } },
  );
  assert.equal(byValue.satisfied, true);
  assert.equal(byValue.requirements[0].state, "user");

  const byConfigured = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("OPENWEATHER_API_KEY", { confidence: "declared" })]),
    { weather: { OPENWEATHER_API_KEY: { configured: true } } },
  );
  assert.equal(byConfigured.satisfied, true);
  assert.equal(byConfigured.requirements[0].state, "user");
});

test("系统环境变量存在即满足，probeOverrides 可覆盖后端探测", () => {
  const bySystem = skillEnv.resolveSkillEnvStatus(
    summary("weather", [
      requirement("OPENWEATHER_API_KEY", { confidence: "declared", systemValuePresent: true }),
    ]),
    {},
  );
  assert.equal(bySystem.satisfied, true);
  assert.equal(bySystem.requirements[0].state, "system");

  const byProbe = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("OPENWEATHER_API_KEY", { confidence: "declared" })]),
    {},
    { OPENWEATHER_API_KEY: true },
  );
  assert.equal(byProbe.satisfied, true);
  assert.equal(byProbe.requirements[0].state, "system");
});

test("误报豁免让声明必填退出门禁，探测建议可采纳为必需", () => {
  const ignored = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("SORT_KEY", { confidence: "declared" })]),
    { weather: { SORT_KEY: { override: "ignored" } } },
  );
  assert.equal(ignored.satisfied, true);
  assert.equal(ignored.requirements[0].effectiveRequired, false);
  assert.equal(ignored.requirements[0].ignored, true);

  const adopted = skillEnv.resolveSkillEnvStatus(
    summary("weather", [requirement("WEATHER_REGION", { required: false, confidence: "weak" })]),
    { weather: { WEATHER_REGION: { override: "required" } } },
  );
  assert.equal(adopted.satisfied, false);
  assert.deepEqual(adopted.missingRequired, ["WEATHER_REGION"]);
});

test("手动添加的变量参与门禁，标记忽略的手动条目不显示", () => {
  const status = skillEnv.resolveSkillEnvStatus(summary("weather", []), {
    weather: {
      MANUAL_TOKEN: { override: "required" },
      NOISE_VAR: { override: "ignored" },
    },
  });
  assert.deepEqual(
    status.requirements.map((entry) => entry.name),
    ["MANUAL_TOKEN"],
  );
  assert.equal(status.requirements[0].confidence, "user");
  assert.equal(status.satisfied, false);
});

test("注入只包含用户填写的值，忽略非法变量名，冲突按技能名序后者覆盖", () => {
  const injection = skillEnv.collectSkillEnvInjection(
    [{ name: "beta" }, { name: "alpha" }],
    {
      alpha: {
        SHARED_KEY: { value: "from-alpha" },
        "BAD NAME": { value: "x" },
        EMPTY_ONE: { value: "  " },
        FLAG_ONLY: { configured: true },
      },
      beta: { SHARED_KEY: { value: "from-beta" }, BETA_TOKEN: { value: "b" } },
    },
  );
  assert.deepEqual(injection, { SHARED_KEY: "from-beta", BETA_TOKEN: "b" });
});

test("normalize 清理空条目并保留 value/configured/override", () => {
  const normalized = skillEnv.normalizeSkillEnvSettings({
    weather: {
      GOOD_KEY: { value: "v", override: "required", junk: 1 },
      CONFIGURED_ONLY: { configured: true },
      EMPTY: {},
      "bad name": { value: "x" },
    },
    "": { X_KEY: { value: "y" } },
  });
  assert.deepEqual(Object.keys(normalized), ["weather"]);
  assert.deepEqual(normalized.weather.GOOD_KEY, { value: "v", override: "required" });
  assert.deepEqual(normalized.weather.CONFIGURED_ONLY, { configured: true });
  assert.equal(normalized.weather.EMPTY, undefined);
  assert.equal(normalized.weather["bad name"], undefined);
});

test("envRequirements 摘要随必需性与系统探测变化", () => {
  const a = skillEnv.skillEnvRequirementsSignature([requirement("K_KEY")]);
  const b = skillEnv.skillEnvRequirementsSignature([
    requirement("K_KEY", { systemValuePresent: true }),
  ]);
  assert.notEqual(a, b);
  assert.equal(skillEnv.skillEnvRequirementsSignature([]), "");
  assert.equal(skillEnv.skillEnvRequirementsSignature(undefined), "");
});

test("手动添加输入支持 NAME、NAME=值 与多行 .env 粘贴", () => {
  assert.deepEqual(skillEnv.parseSkillEnvAddEntries("MY_API_KEY"), [{ name: "MY_API_KEY" }]);
  assert.deepEqual(skillEnv.parseSkillEnvAddEntries("MY_API_KEY=sk-123"), [
    { name: "MY_API_KEY", value: "sk-123" },
  ]);
  assert.deepEqual(
    skillEnv.parseSkillEnvAddEntries(
      [
        "# 注释行忽略",
        "export FOO_TOKEN='tok-1'",
        'BAR_KEY="k=with=equals"',
        "BAZ_URL=",
        "bad name=x",
        "FOO_TOKEN=重复忽略",
        "",
      ].join("\n"),
    ),
    [
      { name: "FOO_TOKEN", value: "tok-1" },
      { name: "BAR_KEY", value: "k=with=equals" },
      { name: "BAZ_URL" },
    ],
  );
  assert.deepEqual(skillEnv.parseSkillEnvAddEntries("   "), []);
});
