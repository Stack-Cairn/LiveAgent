import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Battle 2: this suite now drives crates/core, the engine that actually ships.
// The frontend copy under src/lib was a duplicate and has been removed.
// crates/core modules that talk to the Rust backend read this at import time.
process.env.LIVEAGENT_BACKEND_PORT ??= "0";
const coreRootDir = path.resolve(fileURLToPath(new URL("../..", import.meta.url)), "../core");
const coreSrc = (rel) => path.join(coreRootDir, "src", rel);


// 反漂移锁：UI 档位列表（resolveModelThinking）与请求期钳制
// （pi-ai getSupportedThinkingLevels 读 createModelFromConfig 产物）必须逐档一致，
// 否则用户能选到发不出去的档、或被钳到列表之外的档。
const realPiAi = await import(
  new URL("../../node_modules/@earendil-works/pi-ai/dist/models.js", import.meta.url).href
);

const loader = createTsModuleLoader();
const { resolveModelThinking } = loader.loadModule(coreSrc("models/modelThinking.ts"));
const catalog = loader.loadModule(coreSrc("models/modelCatalog.ts"));
const { createModelFromConfig } = loader.loadModule(coreSrc("models/modelFactory.ts"));

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
