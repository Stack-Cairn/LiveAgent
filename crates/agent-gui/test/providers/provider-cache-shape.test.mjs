import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { describeProviderCacheShape } = loader.loadModule(
  "src/lib/providers/runtime/providerCacheShape.ts",
);

test("DeepSeek cache diagnostics describe provider-managed prefix caching", () => {
  assert.deepEqual(
    describeProviderCacheShape({
      providerId: "deepseek",
      baseUrl: "https://api.deepseek.com",
      modelApi: "deepseek-responses",
      sessionId: "conversation-1",
      cacheRetention: "long",
      headers: { "x-session-id": "ignored" },
    }),
    {
      cacheRetention: "automatic",
      breakpointStrategy: "deepseek-prefix",
    },
  );
});
