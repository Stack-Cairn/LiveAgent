import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  kBrainSettingsUpdateForMissingInputModalities,
  kBrainSettingsUpdateFromLegacyProviders,
} = loader.loadModule(
  "src/lib/kbrain/providerSettings.ts",
);
const uploads = loader.loadModule("src/lib/kbrain/uploadStagingRoot.ts");

function relayProvider(id, models) {
  return {
    id,
    name: id,
    type: "claude_code",
    baseUrl: "https://relay.invalid/claude/v1",
    apiKey: "",
    apiKeyConfigured: true,
    models,
    activeModels: models.map((model) => model.id),
  };
}

function pushedModel(update, providerId, modelId) {
  return update.providers
    .find((provider) => provider.id === providerId)
    .models.find((model) => model.id === modelId);
}

test("relay models without modalities are pushed to K-brain with catalog vision", () => {
  // 旧配置只保存了 id/limits，K-brain 因此判定为纯文本并丢弃 Read 到的图片。
  const saved = relayProvider("relay", [
    { id: "claude-opus-5-5", contextWindow: 1_000_000, limitsSource: "provider" },
    { id: "deepseek-v4-pro", contextWindow: 1_000_000, limitsSource: "provider" },
    { id: "unknown-relay-model", contextWindow: 8192, limitsSource: "user" },
  ]);
  const update = kBrainSettingsUpdateFromLegacyProviders([saved], [saved]);

  assert.deepEqual(pushedModel(update, "relay", "claude-opus-5-5").inputModalities, [
    "text",
    "image",
  ]);
  // 目录明确为纯文本、或目录未知的模型不做猜测，保留 K-brain 现值。
  assert.equal(pushedModel(update, "relay", "deepseek-v4-pro").inputModalities, undefined);
  assert.equal(pushedModel(update, "relay", "unknown-relay-model").inputModalities, undefined);
});

test("explicit modalities win and are shared across providers for the same model id", () => {
  const explicit = relayProvider("a", [{ id: "claude-opus-4-6", inputModalities: ["text"] }]);
  const implicit = relayProvider("b", [{ id: "claude-opus-4-6" }]);
  const update = kBrainSettingsUpdateFromLegacyProviders([], [explicit, implicit]);

  // K-brain 要求同 id 跨供应商元数据一致，否则整次设置更新会被拒绝。
  assert.deepEqual(pushedModel(update, "a", "claude-opus-4-6").inputModalities, ["text"]);
  assert.deepEqual(pushedModel(update, "b", "claude-opus-4-6").inputModalities, ["text"]);
});

test("uploads staging root is granted read-only after the workspace roots", () => {
  const roots = [{ path: "D:\\work\\repo", access: "write" }];
  assert.deepEqual(uploads.withUploadStagingRoot(roots, "C:\\Users\\me\\.liveagent\\uploads"), [
    { path: "D:\\work\\repo", access: "write" },
    { path: "C:\\Users\\me\\.liveagent\\uploads", access: "read" },
  ]);
  // 已授权（含大小写/尾分隔符差异）时不重复追加。
  const granted = [...roots, { path: "c:/users/me/.liveagent/uploads/", access: "read" }];
  assert.equal(
    uploads.withUploadStagingRoot(granted, "C:\\Users\\me\\.liveagent\\uploads").length,
    2,
  );
  // 无根时保持为空：K-brain 会默认授权 cwd，单独追加暂存区会挤掉默认授权。
  assert.deepEqual(uploads.withUploadStagingRoot([], "C:\\uploads"), []);
  assert.deepEqual(uploads.withUploadStagingRoot(roots, undefined), roots);
});

test("uploads staging root lookup never breaks a run and retries after failure", async () => {
  uploads.resetUploadStagingRootCache();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("command unavailable");
  };
  assert.equal(await uploads.resolveUploadStagingRoot(failing), undefined);
  assert.equal(await uploads.resolveUploadStagingRoot(failing), undefined);
  assert.equal(calls, 2, "failed lookups must not be cached");

  const ok = async () => {
    calls += 1;
    return "C:\\Users\\me\\.liveagent\\uploads";
  };
  assert.equal(await uploads.resolveUploadStagingRoot(ok), "C:\\Users\\me\\.liveagent\\uploads");
  assert.equal(await uploads.resolveUploadStagingRoot(failing), "C:\\Users\\me\\.liveagent\\uploads");
  assert.equal(calls, 3, "successful lookups are cached");
  uploads.resetUploadStagingRootCache();
});

test("startup reconcile pushes missing modalities once and is a no-op afterwards", () => {
  const saved = relayProvider("relay", [
    { id: "claude-opus-5-5", contextWindow: 1_000_000, limitsSource: "provider" },
  ]);
  const selected = { customProviderId: "relay", model: "claude-opus-5-5" };
  const update = kBrainSettingsUpdateForMissingInputModalities([saved], selected);
  assert.ok(update, "a stale relay model must trigger a backfill write");
  assert.deepEqual(pushedModel(update, "relay", "claude-opus-5-5").inputModalities, [
    "text",
    "image",
  ]);
  // 对账写入不能删除任何供应商，也不能改动默认模型。
  assert.equal(update.deleteProviders, undefined);
  assert.equal(update.defaultModel, "claude-opus-5-5");

  const reconciled = relayProvider("relay", [
    { id: "claude-opus-5-5", inputModalities: ["text", "image"] },
    { id: "deepseek-v4-pro" },
  ]);
  assert.equal(kBrainSettingsUpdateForMissingInputModalities([reconciled], selected), undefined);
});
