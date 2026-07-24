import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const catalog = loader.loadModule("@/lib/models/modelCatalog.ts");

// 目录模块两端逐字节镜像（scripts/mirror-manifest.json），数据不变量由
// agent-gui/test/models/model-catalog.test.mjs 全量覆盖；这里只冒烟验证
// web 构建树里的 seam 可用且关键数值一致。
test("web mirror of the model catalog resolves limits and fallbacks", () => {
  assert.deepEqual(catalog.resolveModelLimits("xai", "grok-4.5"), {
    contextWindow: 500_000,
    maxOutputToken: 32_000,
  });
  assert.equal(catalog.findCatalogModel("claude_code", "claude-sonnet-4-6[1m]")?.id, "claude-sonnet-4-6");
  assert.deepEqual(catalog.getProviderFallbackLimits("xai"), {
    contextWindow: 258_000,
    maxOutputToken: 142_000,
  });
  assert.deepEqual(
    catalog.normalizeModelLimits({ contextWindow: 128_000, maxOutputToken: 128_000 }),
    { contextWindow: 128_000, maxOutputToken: 32_000 },
  );
});
