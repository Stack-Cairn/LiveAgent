import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 反漂移锁：UI 档位列表（resolveModelThinking）与请求期钳制
// （pi-ai getSupportedThinkingLevels 读 createModelFromConfig 产物）必须逐档一致，
// 否则用户能选到发不出去的档、或被钳到列表之外的档。
const realPiAi = await import(
  new URL("../../node_modules/@earendil-works/pi-ai/dist/models.js", import.meta.url).href
);

const loader = createTsModuleLoader();
const { resolveModelThinking } = loader.loadModule("@liveagent/ui/lib/models/modelThinking.ts");
const catalog = loader.loadModule("@liveagent/ui/lib/models/modelCatalog.ts");
const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");
const { clampOpenAIReasoningEffort, resolveAnthropicThinkingRuntime, resolveGeminiThinkingRuntime } =
  loader.loadModule("src/lib/providers/runtime/thinkingLevels.ts");

const NATIVE = [
  ["claude_code", "anthropic", "https://api.anthropic.com"],
  ["gemini", "google", "https://generativelanguage.googleapis.com/v1beta"],
  ["codex", "openai", "https://api.openai.com/v1"],
  ["xai", "xai", "https://api.x.ai/v1"],
];

// deepseek 走原生 Responses 适配器，档位同样经 clampOpenAIReasoningEffort 直通。
const WIRE_PROVIDERS = [...NATIVE, ["deepseek", "deepseek", "https://api.deepseek.com"]];

// 与 piAiAdapter / deepSeekNative 各分支同源的档位解析：把一个 UI 档位翻译成实际
// 下发的 wire 值（adaptive effort / budget tokens / thinking_level / reasoning_effort）。
function resolveWireValue(providerId, model, level) {
  if (providerId === "claude_code") {
    const runtime = resolveAnthropicThinkingRuntime(model, { reasoning: level });
    return runtime.mode === "adaptive"
      ? `effort:${runtime.effort}`
      : `budget:${runtime.thinkingBudgetTokens}`;
  }
  if (providerId === "gemini") {
    const thinking = resolveGeminiThinkingRuntime(model, level);
    return thinking.level !== undefined
      ? `level:${thinking.level}`
      : `budget:${thinking.budgetTokens}`;
  }
  return `effort:${clampOpenAIReasoningEffort(model, level)}`;
}

test("catalog thinking levels == pi-ai getSupportedThinkingLevels of the built model", () => {
  for (const [providerId, section, baseUrl] of NATIVE) {
    for (const entry of catalog.MODEL_CATALOG[section]) {
      const capability = resolveModelThinking(providerId, entry.id);
      const model = createModelFromConfig(providerId, entry.id, baseUrl);
      const supported = realPiAi.getSupportedThinkingLevels(model);
      const label = `${providerId}/${entry.id}`;
      assert.deepEqual(
        supported.filter((level) => level !== "off"),
        capability.levels,
        `${label}: UI levels must equal request-side clamp levels`,
      );
      assert.equal(
        !supported.includes("off"),
        capability.alwaysOn,
        `${label}: always-on must agree`,
      );
    }
  }
});

// 防塌档锁：档位集合一致还不够——UI 上可选的每一档必须落到不同的 wire 值，否则
// 用户选了 medium 实际按 high 下发（gemini-3.1-pro 曾因 id 正则把 3.x Pro 全系
// 折成 LOW/HIGH 两档而漏网），既多付费也让档位控件形同虚设。
test("every selectable level resolves to a distinct wire value (no silent level collapse)", () => {
  for (const [providerId, section, baseUrl] of WIRE_PROVIDERS) {
    for (const entry of catalog.MODEL_CATALOG[section]) {
      const capability = resolveModelThinking(providerId, entry.id);
      if (capability.levels.length < 2) continue;
      const model = createModelFromConfig(providerId, entry.id, baseUrl);
      const wires = capability.levels.map((level) => resolveWireValue(providerId, model, level));
      // Gemini 预算表未收录的系列（robotics 等非 2.5/3.x id）每档都发 -1，交由 API
      // 用模型默认预算——档位对 wire 无影响是目录无法派生的已知限制，显式豁免；
      // 其余一律要求逐档唯一。
      if (providerId === "gemini" && wires.every((wire) => wire === "budget:-1")) continue;
      const label = `${providerId}/${entry.id}`;
      assert.equal(
        new Set(wires).size,
        wires.length,
        `${label}: levels ${JSON.stringify(capability.levels)} collapse on the wire: ${JSON.stringify(wires)}`,
      );
    }
  }
});
