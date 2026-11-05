import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Slow-download advice on the failure page. Real ImageStudioPage, controller and studioModel; only
// the client and icon/picker shells are stubbed. Job shapes follow K-brain's aggregateJob: job.error
// is the first item's error, and the job stays failed whatever the other items report.
const SLOW = "image download was too slow over a direct connection";
const target = { id: "m", name: "Studio Model", enabled: true, parameters: [],
  capabilities: { operations: ["generate"], maxCount: 4, maxInputs: 3, supportsCancel: true } };
const err = (code, extra = {}) => ({ code, message: "x", retryable: false, requestId: "", ...extra });
const job = (id, overrides = {}) => ({
  id, projectId: "archive", revision: 1, lastEventSeq: 0, status: "failed",
  createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
  request: { projectId: "archive", targetId: "m", prompt: `Prompt ${id}`, operation: "generate",
    count: 2, parameters: {}, inputs: [] },
  targetSnapshot: target, assetIds: [], items: [], usage: null, ...overrides,
});

async function mounted(run, { jobs, onOpenSettings } = {}) {
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
  const buttonNamed = (text) => [...host.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  try { await run({ host, click, buttonNamed }); } finally {
    await env.act(async () => root.unmount()); host.remove(); env.cleanup();
  }
}
const open = (host, click, id) =>
  click([...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === `查看任务：Prompt ${id}`));
const preview = (host) => host.querySelector('section[aria-label="图片预览"]').textContent;

test("a slow download on the second item still gets the proxy advice", async () => {
  // count=2, both outputs lost. The first output hit a host error, which a proxy may not fix; the
  // second is K-brain's explicit "too slow over a direct connection".
  const first = err("IMAGE_OUTPUT_SAVE_FAILED", { reason: "image host returned HTTP 502" });
  const j = job("mixed", {
    error: first,
    items: [
      { id: "i0", status: "failed", attemptCount: 1, outputAssetIds: [], error: first },
      { id: "i1", status: "failed", attemptCount: 1, outputAssetIds: [],
        error: err("IMAGE_OUTPUT_SAVE_FAILED", { reason: SLOW }) },
    ],
  });
  let opened = 0;
  await mounted(async ({ host, click, buttonNamed }) => {
    await open(host, click, "mixed");
    const card = [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "查看任务：Prompt mixed");
    assert.match(card.title, /使用应用代理/, "the history card drops the known cause of the second item too");
    assert.match(preview(host), /使用应用代理/, "the known cause of the second item is not surfaced");
    assert.ok(buttonNamed("检查连接设置"), "the settings button should follow the advice");
    await click(buttonNamed("检查连接设置"));
    assert.equal(opened, 1);
  }, { jobs: [j], onOpenSettings: () => { opened += 1; } });
});

test("a job the user cancelled is not told to refresh and verify", async () => {
  // K-brain leaves job.error empty on a cancelled job.
  const j = job("c", { status: "cancelled", request: { projectId: "archive", targetId: "m",
    prompt: "Prompt c", operation: "generate", count: 1, parameters: {}, inputs: [] } });
  await mounted(async ({ host, click }) => {
    await open(host, click, "c");
    assert.doesNotMatch(preview(host), /请刷新核对任务/);
  }, { jobs: [j] });
});
