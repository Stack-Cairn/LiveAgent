import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Independent review tests for the failure-panel redesign. Real ImageStudioPage, controller
// and studioModel; only the client and icon/picker shells are stubbed (same as workbench-layout).
const target = { id: "m", name: "Studio Model", enabled: true, parameters: [],
  capabilities: { operations: ["generate"], maxCount: 4, maxInputs: 3, supportsCancel: true } };
const err = (code, extra = {}) => ({ code, message: "x", retryable: false, requestId: "", ...extra });
const job = (id, overrides = {}) => ({
  id, projectId: "archive", revision: 1, lastEventSeq: 0, status: "failed",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  request: { projectId: "archive", targetId: "m", prompt: `Prompt ${id}`, operation: "generate",
    count: 1, parameters: {}, inputs: [] },
  targetSnapshot: target, assetIds: [], items: [], usage: null, ...overrides,
});

async function mounted(run, { jobs, client: extra } = {}) {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    "./AssetLightbox": { AssetLightbox: () => null },
  } });
  const calls = { getJob: [], exports: [] };
  const client = {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [target],
    listProjects: async () => ({ items: [{ id: "archive", title: "archive", revision: 1 }] }),
    listJobs: async () => ({ items: jobs }),
    getJob: async (id) => { calls.getJob.push(id); return jobs.find((j) => j.id === id); },
    subscribe: async () => new Promise(() => {}),
    readAsset: async () => new Blob(["png"], { type: "image/png" }),
    createJob: async () => { throw new Error("unused"); },
    ...extra,
  };
  const { ImageStudioPage } = env.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const storageData = new Map();
  const storage = { getItem: (k) => storageData.get(k) ?? null, setItem: (k, v) => storageData.set(k, v), removeItem: (k) => storageData.delete(k) };
  await env.act(async () => root.render(env.React.createElement(ImageStudioPage, {
    client, ownerId: "o", backendId: "b", storage, exportDestinations: ["download"] })));
  for (let i = 0; i < 5; i++) await env.act(() => new Promise((r) => setTimeout(r, 0)));
  const click = (el) => env.act(async () => el.click());
  const button = (text) => {
    const el = [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
    assert.ok(el, `Missing button: ${text}`);
    return el;
  };
  try { await run({ env, host, calls, click, button }); } finally {
    await env.act(async () => root.unmount()); host.remove(); env.cleanup();
  }
}
const open = (host, click, id) =>
  click([...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `查看任务：Prompt ${id}`));
const preview = (host) => host.querySelector('section[aria-label="图片预览"]').textContent;

test("job-level error shadows an item whose outcome is unknown: the panel must still check before regenerating", async () => {
  // A job can fail on its own error while one of its items never got an answer. primaryJobError
  // returns job.error first, so failureKind is "other" and checkFirst is false.
  const j = job("mixed", {
    status: "failed", error: err("IMAGE_UNAVAILABLE"),
    items: [{ id: "i0", index: 0, status: "failed", error: err("IMAGE_RESULT_UNKNOWN") }],
  });
  await mounted(async ({ host, click }) => {
    await open(host, click, "mixed");
    assert.match(preview(host), /重新核对任务状态/, "an unknown item must offer the provider check");
    assert.match(preview(host), /再扣一次费用/, "and warn that regenerating may bill again");
  }, { jobs: [j] });
});

test("a lost provider output is not called a missing image and warns before regenerating", async () => {
  const j = job("lost", {
    status: "failed",
    error: err("IMAGE_OUTPUT_SAVE_FAILED", { reason: "image download timed out" }),
  });
  await mounted(async ({ host, click }) => {
    await open(host, click, "lost");
    const text = preview(host);
    assert.match(text, /图片已生成，但没能保存/);
    assert.match(text, /image download timed out/);
    assert.match(text, /很可能已经计费/);
    assert.doesNotMatch(text, /这次没有生成图片|图像模块不可用/);
    assert.doesNotMatch(text, /重新核对任务状态/, "rechecking cannot bring a lost image back");
  }, { jobs: [j] });
});

test("a slow direct download suggests the provider proxy and links to settings", async () => {
  const j = job("slow", {
    status: "failed",
    error: err("IMAGE_OUTPUT_SAVE_FAILED", {
      reason: "image download was too slow over a direct connection",
    }),
  });
  await mounted(async ({ host, click }) => {
    await open(host, click, "slow");
    const text = preview(host);
    assert.match(text, /使用应用代理/);
    assert.match(text, /很可能已经计费/);
  }, { jobs: [j] });
});

test("a lost output for any other reason does not suggest the provider proxy", async () => {
  const j = job("timeout", {
    status: "failed",
    error: err("IMAGE_OUTPUT_SAVE_FAILED", { reason: "image download timed out" }),
  });
  await mounted(async ({ host, click }) => {
    await open(host, click, "timeout");
    assert.doesNotMatch(preview(host), /使用应用代理/);
  }, { jobs: [j] });
});

test("checking an unchanged result-unknown job gives the user some feedback", async () => {
  // refreshJob only re-reads GET /jobs/{id}; when the snapshot is identical nothing on screen changes,
  // so the button labelled "check the provider result" looks dead.
  const j = job("u", { status: "result_unknown", error: err("IMAGE_RESULT_UNKNOWN") });
  await mounted(async ({ host, calls, click, button }) => {
    await open(host, click, "u");
    const before = host.textContent;
    const requests = calls.getJob.length;
    await click(button("重新核对任务状态"));
    assert.equal(calls.getJob.length, requests + 1, "the button re-reads the job snapshot");
    assert.notEqual(host.textContent, before, "no notice, spinner or text change after the check");
  }, { jobs: [j] });
});

test("an unsupported export destination does not tell the user to change the prompt", async () => {
  // failureKind now maps IMAGE_UNSUPPORTED_OPERATION to "rejected", and exportAsset's catch
  // feeds errorActionMessage into the export-failed notice (client.ts throws it when no handler exists).
  const j = job("ok", { status: "succeeded", assetIds: ["a1"] });
  await mounted(async ({ host, click, button }) => {
    await click(button("下载图片"));
    await env_tick();
    assert.doesNotMatch(host.textContent, /修改提示词、参数或输入图片/);
  }, { jobs: [j], client: { exportAsset: async () => { throw Object.assign(new Error("x"), { code: "IMAGE_UNSUPPORTED_OPERATION", status: 0 }); } } });
});
const env_tick = () => new Promise((r) => setTimeout(r, 20));

const loader = createTsModuleLoader();
const { jobErrorLines } = loader.loadModule("@liveagent/ui/features/image-studio/studioModel");
const { parseImageError } = loader.loadModule("@liveagent/ui/lib/imaging/errors");
const { t } = loader.loadModule("@liveagent/app/i18n/config");

test("a reason on only one of job.error / item.error does not duplicate the history error line", () => {
  // Before the change both collapsed to one line (same code); now the reason makes the strings differ.
  const lines = jobErrorLines(
    job("d", { error: err("IMAGE_UNAVAILABLE", { reason: "upstream timeout" }),
      items: [{ id: "i0", index: 0, status: "failed", error: err("IMAGE_UNAVAILABLE") }] }),
    (key) => t(key, "zh-CN"),
  );
  assert.equal(lines.length, 1, JSON.stringify(lines));
});

test("truncating a long reason never leaves half of a surrogate pair", () => {
  const { reason } = parseImageError(err("IMAGE_UNAVAILABLE", { reason: `${"a".repeat(198)}😀😀` }));
  assert.doesNotMatch(reason, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});
