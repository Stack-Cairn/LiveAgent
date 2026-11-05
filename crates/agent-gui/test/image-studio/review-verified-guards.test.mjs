import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Review guards that PASS today: they pin behaviour the review attacked and found sound.
// Real ImageStudioPage and studioModel; only the client and icon/picker shells are stubbed.
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

const loader = createTsModuleLoader();
const { jobErrorLines } = loader.loadModule("@liveagent/ui/features/image-studio/studioModel");
const { t } = loader.loadModule("@liveagent/app/i18n/config");

test("a hostile reason is inserted verbatim: no placeholder or $-pattern expansion, in both locales", () => {
  const reason = "{action} {error} $& $1 $$ $` $' {reason}";
  for (const locale of ["zh-CN", "en-US"]) {
    const [line] = jobErrorLines(job("h", { error: err("IMAGE_UNAVAILABLE", { reason }) }), (key) => t(key, locale));
    assert.equal(line.split(reason).length - 1, 1, `${locale}: ${line}`);
    assert.equal(line.replace(reason, "").includes("{"), false, `${locale}: leftover placeholder in ${line}`);
  }
});

test("the unknown chip lists only result_unknown jobs, a subset of Issues; empty result uses the no-match copy", async () => {
  const jobs = [job("f"), job("u", { status: "result_unknown", error: err("IMAGE_RESULT_UNKNOWN") }), job("c", { status: "cancelled" }), job("s", { status: "succeeded", assetIds: ["a1"] })];
  await mounted(async ({ host, click, button }) => {
    const cards = () => [...host.querySelectorAll("article")].map((a) => a.getAttribute("aria-label")).sort();
    await click(button("待核对"));
    assert.deepEqual(cards(), ["任务 u"]);
    await click(button("需关注"));
    assert.deepEqual(cards(), ["任务 c", "任务 f", "任务 u"]);
  }, { jobs });
  await mounted(async ({ host, click, button }) => {
    await click(button("待核对"));
    assert.match(host.textContent, /没有匹配的历史记录/);
  }, { jobs: [job("f")] });
});

test("three-column template is only used with a selected job, history leads, detail pane needs a wide container", async () => {
  await mounted(async ({ host, click }) => {
    const grid = host.querySelector("aside").parentElement;
    assert.match(grid.className, /xl:grid-cols-\[minmax\(0,1fr\)_22rem\]/);
    await open(host, click, "f");
    assert.match(grid.className, /@5xl:grid-cols-\[17rem_minmax\(0,1fr\)_16rem\] @7xl:grid-cols-\[19rem_minmax\(0,1fr\)_19rem\]/);
    const [history, detail] = [...host.querySelectorAll("aside")];
    assert.match(history.className, /@5xl:order-first/);
    assert.match(detail.className, /\bhidden\b.*@5xl:flex/);
  }, { jobs: [job("f")] });
});
