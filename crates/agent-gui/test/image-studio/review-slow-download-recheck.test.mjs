import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Second-round review guards. These pass: they pin behaviour the review attacked and found sound.
const SLOW = "image download was too slow over a direct connection";
const loader = createTsModuleLoader();
const { jobErrorLines } = loader.loadModule("@liveagent/ui/features/image-studio/studioModel");
const { t } = loader.loadModule("@liveagent/app/i18n/config");
const zh = (key, params) => t(key, "zh-CN", params);

const target = { id: "m", name: "Studio Model", enabled: true, parameters: [],
  capabilities: { operations: ["generate"], maxCount: 4, maxInputs: 3, supportsCancel: true } };
const wire = (code, extra = {}) => ({ code, message: "x", retryable: false, requestId: "", ...extra });
const job = (id, overrides = {}) => ({
  id, projectId: "archive", revision: 1, lastEventSeq: 0, status: "failed",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  request: { projectId: "archive", targetId: "m", prompt: `Prompt ${id}`, operation: "generate",
    count: 2, parameters: {}, inputs: [] },
  targetSnapshot: target, assetIds: [], items: [], usage: null, ...overrides,
});
const item = (id, status, error) => ({ id, status, attemptCount: 1, outputAssetIds: [], error });

test("jobErrorLines keeps an unknown item beside a slow one, in either order", () => {
  const slow = wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW });
  const other = wire("IMAGE_OUTPUT_SAVE_FAILED", { reason: "image host returned HTTP 502" });
  const unknown = wire("IMAGE_RESULT_UNKNOWN");
  for (const errors of [[other, slow, unknown], [unknown, slow, other], [slow, unknown, other]]) {
    const lines = jobErrorLines(job("o", { error: errors[0], items: errors.map((e, i) => item(`i${i}`, "failed", e)) }), zh);
    assert.equal(lines.length, 2, JSON.stringify(lines));
    assert.equal(lines.filter((l) => /使用应用代理/.test(l)).length, 1);
    assert.equal(lines.filter((l) => l.startsWith(zh("imageStudio.error.IMAGE_RESULT_UNKNOWN"))).length, 1, JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.includes("HTTP 502")));
  }
});

test("jobErrorLines leaves an unknown reason alone when no slow error is present", () => {
  const lines = jobErrorLines(job("u", { status: "result_unknown", error: wire("IMAGE_RESULT_UNKNOWN"), items: [
    item("i0", "result_unknown", wire("IMAGE_RESULT_UNKNOWN")),
    item("i1", "result_unknown", wire("IMAGE_RESULT_UNKNOWN", { reason: "provider did not respond within 180 seconds" })),
  ] }), zh);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /180 seconds/);
});

async function page(run, j) {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    "./AssetLightbox": { AssetLightbox: () => null },
  } });
  const client = {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [target],
    listProjects: async () => ({ items: [{ id: "archive", title: "archive", revision: 1 }] }),
    listJobs: async () => ({ items: [j] }),
    getJob: async () => j,
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
    client, ownerId: "o", backendId: "b", storage, exportDestinations: ["download"], onOpenSettings: () => {} })));
  for (let i = 0; i < 5; i++) await env.act(() => new Promise((r) => setTimeout(r, 0)));
  await env.act(async () => [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `查看任务：Prompt ${j.id}`).click());
  const buttonNamed = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  try {
    await run({ text: () => host.querySelector('section[aria-label="图片预览"]').textContent, buttonNamed });
  } finally {
    await env.act(async () => root.unmount()); host.remove(); env.cleanup();
  }
}

test("a failed job with no error still has a title and a way forward", async () => {
  await page(async ({ text, buttonNamed }) => {
    assert.match(text(), new RegExp(zh("imageStudio.noImage")));
    assert.ok(buttonNamed(zh("imageStudio.restoreRetry")));
    assert.equal(buttonNamed(zh("imageStudio.failure.openSettings")), undefined);
    assert.ok(!text().includes(zh("imageStudio.failure.billingWarning")));
  }, job("f"));
});

test("a result_unknown job with no error still warns and offers the check", async () => {
  await page(async ({ text, buttonNamed }) => {
    assert.ok(buttonNamed(zh("imageStudio.failure.checkResult")));
    assert.match(text(), new RegExp(zh("imageStudio.failure.title.unknown")));
    assert.ok(text().includes(zh("imageStudio.failure.billingWarning")));
  }, job("r", { status: "result_unknown" }));
});
