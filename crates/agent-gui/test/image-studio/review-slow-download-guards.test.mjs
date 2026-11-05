import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Review guards that PASS today: they pin the author's claims that the review attacked and found
// sound. Real wire parsers, real reducer and real ImageStudioPage.
const SLOW = "image download was too slow over a direct connection";
const loader = createTsModuleLoader();
const { errorAction, errorActionMessage, isSlowDirectDownload, jobErrorLines, applyImageEvent, applyJobSnapshot } =
  loader.loadModule("@liveagent/ui/features/image-studio/studioModel");
const { parseImageError, responseError } = loader.loadModule("@liveagent/ui/lib/imaging/errors");
const { parseEvent } = loader.loadModule("@liveagent/ui/lib/imaging/wire");
const { t } = loader.loadModule("@liveagent/app/i18n/config");
const zh = (key, params) => t(key, "zh-CN", params);
const en = (key, params) => t(key, "en-US", params);

const target = { id: "m", name: "Studio Model", enabled: true, parameters: [],
  capabilities: { operations: ["generate"], maxCount: 4, maxInputs: 3, supportsCancel: true } };
const wire = (code, extra = {}) => ({ code, message: "x", retryable: false, requestId: "", ...extra });
const job = (id, overrides = {}) => ({
  id, projectId: "archive", revision: 1, lastEventSeq: 0, status: "failed",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  request: { projectId: "archive", targetId: "m", prompt: `Prompt ${id}`, operation: "generate",
    count: 1, parameters: {}, inputs: [] },
  targetSnapshot: target, assetIds: [], items: [], usage: null, ...overrides,
});

test("the phrase survives safeReason, parseImageError and responseError unchanged", async () => {
  assert.equal(SLOW.length, 52);
  assert.equal(parseImageError(wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW })).reason, SLOW);
  assert.ok(isSlowDirectDownload(parseImageError(wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: `  ${SLOW}\n` }))));
  const response = new Response(JSON.stringify({ version: "kbrain.image.v1", error: wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW }) }), { status: 502 });
  assert.ok(isSlowDirectDownload(await responseError(response)));
});

test("the phrase matches K-brain's constant when the sibling checkout is present", (t2) => {
  let go;
  try {
    go = readFileSync(new URL("../../../../../../Go/K-brain/internal/imaging/assets_download.go", import.meta.url), "utf8");
  } catch {
    t2.skip("K-brain checkout not found");
    return;
  }
  assert.ok(go.includes(`reasonSlowDirectDownload = "${SLOW}"`));
});

test("only the exact phrase on the save-failed code triggers the advice", () => {
  const key = (error) => errorActionMessage(error).key;
  assert.equal(key({ code: "IMAGE_OUTPUT_SAVE_FAILED", reason: SLOW }), "imageStudio.errorAction.slowDownload");
  for (const error of [
    { code: "IMAGE_UNAVAILABLE", reason: SLOW },
    { code: "IMAGE_RESULT_UNKNOWN", reason: SLOW },
    { code: "IMAGE_OUTPUT_SAVE_FAILED" },
    { code: "IMAGE_OUTPUT_SAVE_FAILED", reason: "image download timed out" },
    { code: "IMAGE_OUTPUT_SAVE_FAILED", reason: `${SLOW}…` },
    { code: "IMAGE_OUTPUT_SAVE_FAILED", reason: SLOW.toUpperCase() },
    undefined,
  ]) {
    assert.notEqual(key(error), "imageStudio.errorAction.slowDownload", JSON.stringify(error));
  }
});

test("both locales resolve the slow-download copy and name the provider toggle by its real label", () => {
  const error = { code: "IMAGE_OUTPUT_SAVE_FAILED", reason: SLOW };
  assert.ok(errorAction(error, zh).includes(zh("settings.providerUseSystemProxy")));
  assert.ok(errorAction(error, en).includes(en("settings.providerUseSystemProxy")));
});

test("the reason reaches the job through the event stream as well as the snapshot", () => {
  const state = applyJobSnapshot(
    { jobs: {}, lastSeqByJob: {}, snapshotNeeded: {} },
    job("e", { status: "running", items: [{ id: "i0", status: "running", attemptCount: 1, outputAssetIds: [] }] }),
  );
  const error = wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW });
  const after = [
    { seq: 1, revision: 2, type: "item.state_changed", data: { itemId: "i0", status: "failed", error } },
    { seq: 2, revision: 3, type: "job.finished", data: { status: "failed", error } },
  ].reduce(
    (s, event) => applyImageEvent(s, parseEvent({ jobId: "e", timestamp: "2026-01-01T00:00:00Z", ...event })),
    state,
  );
  assert.ok(isSlowDirectDownload(after.jobs.e.error), "job.error");
  assert.ok(isSlowDirectDownload(after.jobs.e.items[0].error), "item.error");
  const lines = jobErrorLines(after.jobs.e, zh);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /使用应用代理/);
});

async function page(run, { jobs, onOpenSettings }) {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    "./AssetLightbox": { AssetLightbox: () => null },
  } });
  const client = {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [target],
    listProjects: async () => ({ items: [{ id: "archive", title: "archive", revision: 1 }] }),
    listJobs: async () => ({ items: jobs }),
    getJob: async (id) => jobs.find((j) => j.id === id),
    subscribe: async () => new Promise(() => {}),
    readAsset: async () => new Blob(["png"], { type: "image/png" }),
    createJob: async () => { throw new Error("unused"); },
  };
  const { ImageStudioPage } = env.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const data = new Map();
  const storage = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
  await env.act(async () => root.render(env.React.createElement(ImageStudioPage, {
    client, ownerId: "o", backendId: "b", storage, exportDestinations: ["download"], onOpenSettings })));
  for (let i = 0; i < 5; i++) await env.act(() => new Promise((r) => setTimeout(r, 0)));
  const click = (el) => env.act(async () => el.click());
  await click([...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `查看任务：Prompt ${jobs[0].id}`));
  const buttonNamed = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  try {
    await run({ text: () => host.querySelector('section[aria-label="图片预览"]').textContent, click, buttonNamed, host });
  } finally {
    await env.act(async () => root.unmount()); host.remove(); env.cleanup();
  }
}
const slowJob = () => {
  const error = wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW });
  return job("slow", { error, items: [{ id: "i0", status: "failed", attemptCount: 1, outputAssetIds: [], error }] });
};

test("the settings button shows the advice's next step and calls the host", async () => {
  let opened = 0;
  await page(async ({ text, click, buttonNamed }) => {
    assert.match(text(), /使用应用代理/);
    assert.match(text(), /很可能已经计费/);
    assert.equal(buttonNamed("重新核对任务状态"), undefined);
    await click(buttonNamed("检查连接设置"));
    assert.equal(opened, 1);
  }, { jobs: [slowJob()], onOpenSettings: () => { opened += 1; } });
});

test("without a settings host the advice stays and the button goes away", async () => {
  await page(async ({ text, buttonNamed }) => {
    assert.match(text(), /使用应用代理/);
    assert.equal(buttonNamed("检查连接设置"), undefined);
  }, { jobs: [slowJob()] });
});

test("an old backend without a reason keeps the plain save-failed wording and no button", async () => {
  await page(async ({ text, buttonNamed }) => {
    assert.doesNotMatch(text(), /使用应用代理/);
    assert.match(text(), /上游已经出图，但下载或保存失败/);
    assert.equal(buttonNamed("检查连接设置"), undefined);
  }, { jobs: [job("old", { error: wire("IMAGE_OUTPUT_SAVE_FAILED") })], onOpenSettings: () => {} });
});

test("an unknown item outranks a slow item: checking comes first", async () => {
  const slow = wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW });
  const unknown = wire("IMAGE_RESULT_UNKNOWN");
  await page(async ({ text, buttonNamed }) => {
    assert.ok(buttonNamed("重新核对任务状态"));
    assert.doesNotMatch(text(), /使用应用代理/);
  }, { jobs: [job("m", { status: "result_unknown", error: slow, items: [
    { id: "i0", status: "failed", attemptCount: 1, outputAssetIds: [], error: slow },
    { id: "i1", status: "result_unknown", attemptCount: 1, outputAssetIds: [], error: unknown },
  ] })] });
});
