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
const { resolveModelThinking } = loader.loadModule("src/lib/models/modelThinking.ts");
const catalog = loader.loadModule("src/lib/models/modelCatalog.ts");
const { createModelFromConfig } = loader.loadModule("src/lib/providers/runtime/modelFactory.ts");

const NATIVE = [
  ["claude_code", "anthropic", "https://api.anthropic.com"],
  ["gemini", "google", "https://generativelanguage.googleapis.com/v1beta"],
  ["codex", "openai", "https://api.openai.com/v1"],
  ["xai", "xai", "https://api.x.ai/v1"],
];

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
