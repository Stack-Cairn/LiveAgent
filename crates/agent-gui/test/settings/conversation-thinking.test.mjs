import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const settings = loader.loadModule("src/lib/settings/index.ts");
const sync = loader.loadModule("@liveagent/ui/lib/settings/sync.ts");
const { createProviderRuntimeConfig } = loader.loadModule("src/lib/providers/runtime/providerRuntimeConfig.ts");
const params = { providerId: "codex", requestFormat: "openai-responses", modelId: "gpt-5.2" };
const read = (controls, conversationId, modelId = params.modelId) =>
  settings.normalizeChatRuntimeControlsForProvider(controls, { ...params, conversationId, modelId });
const update = (controls, conversationId, patch, modelId = params.modelId) =>
  settings.updateChatRuntimeControlsForProvider(controls, patch, { ...params, conversationId, modelId });

test("same-model conversations keep independent thinking levels and leave defaults untouched", () => {
  const defaults = settings.normalizeChatRuntimeControls({ reasoning: "medium" });
  let controls = update(defaults, "a", { reasoning: "xhigh" });
  controls = update(controls, "b", { reasoning: "low" });
  assert.equal(read(controls, "a").reasoning, "xhigh");
  assert.equal(read(controls, "b").reasoning, "low");
  assert.equal(read(controls, "new").reasoning, "medium");
  assert.deepEqual(settings.resolveChatRuntimeControlsForConversation(controls), defaults);
  assert.equal(defaults.thinkingByConversation, undefined);
});

test("switching models and toggling thinking preserve each conversation's model preferences", () => {
  let controls = update({}, "a", { reasoning: "xhigh" });
  controls = update(controls, "a", { reasoning: "low" }, "gpt-5");
  controls = update(controls, "a", { thinkingEnabled: false }, "gpt-5");
  assert.equal(read(controls, "a").reasoning, "xhigh");
  assert.equal(read(controls, "a", "gpt-5").reasoning, "low");
  assert.equal(read(controls, "a").thinkingEnabled, false);
  assert.equal(read(controls, "b").thinkingEnabled, true);
  controls = update(controls, "a", { thinkingEnabled: true });
  assert.equal(read(controls, "a").reasoning, "xhigh");
  const stored = JSON.stringify(controls);
  read(controls, "a", "gpt-5.2-chat-latest");
  assert.equal(JSON.stringify(controls), stored, "display clamping must not rewrite storage");
});

test("unrelated controls preserve session levels without changing their global defaults", () => {
  let controls = update({}, "a", { reasoning: "xhigh" });
  controls = update(controls, "a", { nativeWebSearchEnabled: false, planModeEnabled: true }, "gpt-5.2-chat-latest");
  assert.equal(read(controls, "a").reasoning, "xhigh");
  assert.equal(read(controls, "b").reasoning, "high");
  assert.equal(controls.nativeWebSearchEnabled, false);
  assert.equal(controls.planModeEnabled, true);
});

test("legacy defaults migrate on first edit and conversation settings survive JSON and gateway sync", () => {
  const legacy = { reasoningByProvider: { codex_openai_responses: "low" }, reasoningByModel: { codex_openai_responses: { "gpt-5.2": "medium" } } };
  assert.equal(read(legacy, "a").reasoning, "medium");
  let controls = update(legacy, "a", { reasoning: "xhigh" });
  controls = update(controls, "b", { reasoning: "low", thinkingEnabled: false });
  const app = settings.normalizeSettings(JSON.parse(JSON.stringify({ chatRuntimeControls: controls })));
  const payload = sync.buildGatewaySettingsSyncPayload(app);
  const restored = sync.applyGatewaySettingsSyncPayload(settings.normalizeSettings({}), payload);
  assert.equal(read(restored.chatRuntimeControls, "a").reasoning, "xhigh");
  assert.equal(read(restored.chatRuntimeControls, "b").reasoning, "low");
  assert.equal(read(restored.chatRuntimeControls, "b").thinkingEnabled, false);
  assert.equal(read(restored.chatRuntimeControls, "new").reasoning, "medium");
});

test("request and queue snapshots keep the chosen session level after another edit", () => {
  let controls = update({}, "a", { reasoning: "xhigh" });
  controls = update(controls, "b", { reasoning: "low" });
  const queued = settings.resolveChatRuntimeControlsForConversation(controls, "a");
  controls = update(controls, "a", { reasoning: "medium" });
  const provider = settings.normalizeCustomProvider({ id: "provider", type: "codex", models: ["gpt-5.2"], activeModels: ["gpt-5.2"], requestFormat: "openai-responses" });
  assert.equal(createProviderRuntimeConfig(provider, "gpt-5.2", queued).reasoning, "xhigh");
  assert.equal(createProviderRuntimeConfig(provider, "gpt-5.2", read(controls, "b")).reasoning, "low");
  assert.equal(createProviderRuntimeConfig(provider, "gpt-5.2", read(controls, "a")).reasoning, "medium");
  assert.equal(queued.thinkingByConversation, undefined);
});

test("draft binding moves session preferences and preserves an existing destination", () => {
  const draft = update({}, "draft", { reasoning: "xhigh" });
  const moved = settings.moveConversationThinking(draft, "draft", "saved");
  assert.equal(read(moved, "saved").reasoning, "xhigh");
  assert.equal(moved.thinkingByConversation.draft, undefined);
  assert.ok(draft.thinkingByConversation.draft);
  const existing = update(draft, "saved", { reasoning: "low" });
  assert.equal(read(settings.moveConversationThinking(existing, "draft", "saved"), "saved").reasoning, "low");
  assert.equal(settings.moveConversationThinking(draft, "absent", "saved"), draft);
});

test("malformed session entries are discarded and nested session maps are not accepted", () => {
  const controls = settings.normalizeChatRuntimeControls({ thinkingByConversation: {
    "": {}, bad: null, array: [], text: "high",
    " a ": { reasoning: "invalid", thinkingEnabled: false, thinkingByConversation: { recursive: {} } },
  } });
  assert.deepEqual(Object.keys(controls.thinkingByConversation), ["a"]);
  assert.equal(read(controls, "a").reasoning, "high");
  assert.equal(read(controls, "a").thinkingEnabled, false);
  assert.equal(controls.thinkingByConversation.a.thinkingByConversation, undefined);
});


test("concurrent edits to different conversations survive full settings updates in either direction", () => {
  const base = settings.normalizeSettings({});
  const a = { ...base, chatRuntimeControls: update(base.chatRuntimeControls, "a", { reasoning: "xhigh" }) };
  const b = { ...base, chatRuntimeControls: update(base.chatRuntimeControls, "b", { reasoning: "low" }) };
  const mergedA = sync.applyGatewaySettingsSyncPayload(a, sync.buildGatewaySettingsSyncUpdatePayload(base, b));
  const mergedB = sync.applyGatewaySettingsSyncPayload(b, sync.buildGatewaySettingsSyncUpdatePayload(base, a));
  for (const merged of [mergedA, mergedB]) {
    assert.equal(read(merged.chatRuntimeControls, "a").reasoning, "xhigh");
    assert.equal(read(merged.chatRuntimeControls, "b").reasoning, "low");
  }
  assert.deepEqual(mergedA.chatRuntimeControls.thinkingByConversation, mergedB.chatRuntimeControls.thinkingByConversation);
});

test("stale echoes and legacy clients cannot overwrite a newer conversation choice", () => {
  const old = settings.normalizeSettings({ chatRuntimeControls: update({}, "a", { reasoning: "xhigh" }) });
  const latest = { ...old, chatRuntimeControls: update(old.chatRuntimeControls, "a", { reasoning: "low" }) };
  for (const stale of [old.chatRuntimeControls, { thinkingByConversation: old.chatRuntimeControls.thinkingByConversation }, {}]) {
    const merged = sync.applyGatewaySettingsSyncPayload(latest, { chatRuntimeControls: stale });
    assert.equal(read(merged.chatRuntimeControls, "a").reasoning, "low");
  }
  const restored = settings.normalizeSettings(JSON.parse(JSON.stringify(latest)));
  assert.deepEqual(restored.chatRuntimeControls.thinkingByConversationRevisions, latest.chatRuntimeControls.thinkingByConversationRevisions);
});

test("same-conversation concurrent writers converge deterministically", () => {
  const a = settings.normalizeSettings({ chatRuntimeControls: update({}, "a", { reasoning: "xhigh" }) });
  const b = settings.normalizeSettings({ chatRuntimeControls: update({}, "a", { reasoning: "low" }) });
  a.chatRuntimeControls.thinkingByConversationRevisions.a.writerId = "desktop";
  b.chatRuntimeControls.thinkingByConversationRevisions.a.writerId = "web";
  const ab = sync.applyGatewaySettingsSyncPayload(a, sync.buildGatewaySettingsSyncPayload(b));
  const ba = sync.applyGatewaySettingsSyncPayload(b, sync.buildGatewaySettingsSyncPayload(a));
  assert.equal(read(ab.chatRuntimeControls, "a").reasoning, "low");
  assert.deepEqual(ab.chatRuntimeControls, ba.chatRuntimeControls);
});

test("draft migration and deletion survive stale snapshot replay", () => {
  const before = settings.normalizeSettings({ chatRuntimeControls: update({}, "draft", { reasoning: "xhigh" }) });
  const moved = { ...before, chatRuntimeControls: settings.moveConversationThinking(before.chatRuntimeControls, "draft", "saved") };
  const replayed = sync.applyGatewaySettingsSyncPayload(moved, sync.buildGatewaySettingsSyncPayload(before));
  assert.equal(replayed.chatRuntimeControls.thinkingByConversation.draft, undefined);
  assert.equal(read(replayed.chatRuntimeControls, "saved").reasoning, "xhigh");
  const deleted = { ...replayed, chatRuntimeControls: settings.removeConversationThinking(replayed.chatRuntimeControls, "saved") };
  const restored = sync.applyGatewaySettingsSyncPayload(replayed, sync.buildGatewaySettingsSyncPayload(deleted));
  const again = sync.applyGatewaySettingsSyncPayload(restored, sync.buildGatewaySettingsSyncPayload(moved));
  assert.equal(again.chatRuntimeControls.thinkingByConversation, undefined);
  assert.ok(again.chatRuntimeControls.thinkingByConversationRevisions.saved);
});

test("branches inherit effective defaults or overrides and remain independent", () => {
  for (const source of [settings.normalizeChatRuntimeControls({ reasoning: "low", thinkingEnabled: false }), update({}, "source", { reasoning: "xhigh", thinkingEnabled: false })]) {
    const branched = settings.copyConversationThinking(source, "source", "branch");
    assert.equal(read(branched, "branch").reasoning, read(source, "source").reasoning);
    assert.equal(read(branched, "branch").thinkingEnabled, false);
    const changed = update(branched, "branch", { reasoning: "medium", thinkingEnabled: true });
    assert.equal(read(changed, "source").reasoning, read(source, "source").reasoning);
    assert.equal(read(changed, "source").thinkingEnabled, false);
  }
});

test("request resolution touches only its target and strips sync metadata", () => {
  const controls = update({}, "a", { reasoning: "xhigh" });
  Object.defineProperty(controls.thinkingByConversation, "unrelated", {
    enumerable: true,
    get() { throw new Error("unrelated conversation must not be read"); },
  });
  const resolved = read(controls, "a");
  assert.equal(resolved.reasoning, "xhigh");
  assert.equal(resolved.thinkingByConversation, undefined);
  assert.equal(resolved.thinkingByConversationRevisions, undefined);
});
