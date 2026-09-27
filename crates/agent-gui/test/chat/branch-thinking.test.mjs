import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

test("desktop branch handler copies thinking before opening and leaves source untouched", async () => {
  const loader = createTsModuleLoader({ mocks: {
    react: { useCallback: (fn) => fn, useRef: (current) => ({ current }), useState: (value) => [value, () => {}] },
    "../../../lib/chat/history/chatHistory": { branchChatHistory: async () => ({ id: "branch" }) },
  } });
  const s = loader.loadModule("src/lib/settings/index.ts");
  const { useBranchConversation } = loader.loadModule("src/pages/chat/history/useBranchConversation.ts");
  const params = { providerId: "codex", requestFormat: "openai-responses", modelId: "gpt-5.2" };
  let app = s.normalizeSettings({ chatRuntimeControls: s.updateChatRuntimeControlsForProvider({}, { reasoning: "xhigh", thinkingEnabled: false }, { ...params, conversationId: "source" }) });
  let opened;
  const hook = useBranchConversation({
    currentConversationIdRef: { current: "source" }, isSending: false,
    isConversationHydrating: false, isConversationHydrationFailed: false,
    sidebarStore: { upsertLocal() {} }, setSettings: (fn) => { app = fn(app); },
    handleSelectConversation: (id) => {
      opened = id;
      const controls = s.normalizeChatRuntimeControlsForProvider(app.chatRuntimeControls, { ...params, conversationId: id });
      assert.equal(controls.reasoning, "xhigh");
      assert.equal(controls.thinkingEnabled, false);
    },
    setErrorMessage: (error) => { throw Error(error); }, t: (key) => key,
  });
  await hook.handleBranchConversation({ messageId: "m" });
  assert.equal(opened, "branch");
  assert.equal(app.chatRuntimeControls.thinkingByConversation.source.reasoning, "xhigh");
});
