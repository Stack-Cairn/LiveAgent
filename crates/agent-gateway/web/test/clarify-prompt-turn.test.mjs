import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { executeClarifyPromptTurn } = loader.loadModule("src/lib/chat/clarifyPromptTurn.ts");

const settings = {
  customSettings: {},
  chatRuntimeControls: {
    thinkingEnabled: false,
    nativeWebSearchEnabled: false,
    reasoning: "off",
    planModeEnabled: false,
  },
};

test("executeClarifyPromptTurn forwards onTextDelta to the RPC client", async () => {
  const deltas = [];
  const calls = [];
  const api = {
    async clarifyPromptTurn(input, options) {
      calls.push({ input, options });
      options?.onDelta?.("[CLARIFY");
      options?.onDelta?.("_QUESTION]");
      return { final_text: "[CLARIFY_QUESTION]\n要做什么？" };
    },
  };
  const text = await executeClarifyPromptTurn(
    api,
    settings,
    {
      provider: { id: "p1", type: "openai", requestFormat: "openai" },
      model: "m1",
      runtimeControls: settings.chatRuntimeControls,
    },
    [{ role: "user", content: "帮我做一个网站" }],
    (delta) => deltas.push(delta),
  );
  assert.equal(text, "[CLARIFY_QUESTION]\n要做什么？");
  assert.deepEqual(deltas, ["[CLARIFY", "_QUESTION]"]);
  assert.equal(calls[0].input.providerId, "p1");
  assert.equal(calls[0].input.model, "m1");
});
