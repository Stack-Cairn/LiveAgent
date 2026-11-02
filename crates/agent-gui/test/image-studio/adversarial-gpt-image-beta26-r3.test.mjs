import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// beta.25 vs beta.26 shapes of the same K-brain OpenAI target (K-brain#68).
const enumSpec = (key, values, label = key) => ({ key, label, type: "string", required: false, enum: values });
const common = [
  enumSpec("output_format", ["png", "jpeg", "webp"]),
  enumSpec("background", ["opaque", "transparent", "auto"]),
  { key: "output_compression", label: "Output compression", type: "integer", required: false, minimum: 0, maximum: 100 },
];
const caps = { operations: ["generate"], maxCount: 1, maxInputs: 16, outputFormats: ["png"] };
const beta25 = {
  id: "it_flare", name: "moonup · gpt-image-2.5-flare", enabled: true, revision: 1, capabilities: caps,
  parameters: [enumSpec("size", ["1024x1024", "1536x1024", "1024x1536"]), enumSpec("quality", ["low", "medium", "high", "auto"]), ...common],
};
const beta26 = {
  ...beta25, revision: 2,
  parameters: [
    enumSpec("aspectRatio", ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"], "Aspect ratio"),
    enumSpec("imageSize", ["1K", "2K", "4K"], "Image size"),
    enumSpec("quality", ["low", "medium", "high", "auto", "xhigh", "max"]),
    ...common,
  ],
};

const loader = createTsModuleLoader();
const { ImageStudioController } = loader.loadModule("@liveagent/ui/features/image-studio/studioController");
const { t } = loader.loadModule("@liveagent/app/i18n/config");
const archive = { id: "archive", title: "图像工作台", revision: 1 };
function storage() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v), removeItem: (k) => values.delete(k) };
}
function controller(overrides) {
  return new ImageStudioController({
    capabilities: async () => ({ supported: true }), listTargets: async () => [beta26],
    listProjects: async () => ({ items: [archive] }), listJobs: async () => ({ items: [] }),
    createProject: async () => archive, readAsset: async () => new Blob(), subscribe: async () => {},
    ...overrides,
  }, "o", "b", storage());
}
const job = (id, parameters, prompt = "cat") => ({
  id, projectId: "archive", status: "succeeded", revision: 1, assetIds: [], items: [], usage: null,
  request: { projectId: "archive", targetId: beta26.id, prompt, parameters, inputs: [], operation: "generate", count: 1 },
});

test("beta.26 target: aspectRatio/imageSize/xhigh pass validation and submit without size or prompt framing", async () => {
  const requests = [];
  const c = controller({ createJob: async (request) => { requests.push(request); return job("new", request.parameters); } });
  try {
    await c.start();
    c.updateDraft({ prompt: "dog", parameters: { aspectRatio: "21:9", imageSize: "4K", quality: "xhigh" } });
    assert.deepEqual(c.validation(), []);
    await c.submit();
    assert.deepEqual(requests[0].parameters, { aspectRatio: "21:9", imageSize: "4K", quality: "xhigh" });
    assert.equal(requests[0].prompt, "dog", "parameter-mode targets never get the 【画面参数】 line");
  } finally { c.dispose(); }
});

test("switching beta.25 -> beta.26 drops only size, keeps quality; back again drops the new keys", async () => {
  const c = controller({ listTargets: async () => [beta25, { ...beta26, id: "it_new" }] });
  try {
    await c.start();
    c.setTarget(beta25.id);
    c.updateDraft({ parameters: { size: "1536x1024", quality: "high" } });
    c.setTarget("it_new");
    assert.deepEqual(c.view.draft.parameters, { quality: "high" });
    assert.deepEqual(c.view.dropped, ["size"]);
    c.acknowledgeMigration();
    c.updateDraft({ parameters: { aspectRatio: "4:3", imageSize: "2K", quality: "max" } });
    c.setTarget(beta25.id);
    assert.equal("size" in c.view.draft.parameters, false);
    assert.deepEqual([...c.view.dropped].sort(), ["aspectRatio", "imageSize", "quality"]);
  } finally { c.dispose(); }
});

test("restoring a job made under beta.25 onto the same target after the beta.26 upgrade stays submittable", async () => {
  // K-brain keeps the target id; only its parameter list changed. Every gpt-image job
  // created before this pin carries `size`, which beta.26 no longer declares.
  const requests = [];
  const c = controller({
    listJobs: async (id) => ({ items: id === "archive" ? [job("old", { size: "1536x1024", quality: "high" })] : [] }),
    createJob: async (request) => { requests.push(request); return job("new", request.parameters); },
  });
  try {
    await c.start();
    await c.restoreJob("old");
    assert.equal(c.view.draft.prompt, "cat");
    // Nothing in the UI can clear `size`: the picker writes aspectRatio and the form only
    // renders declared keys, so a stale key must be dropped (with a notice) at restore.
    assert.equal("size" in c.view.draft.parameters, false, `stale size kept: ${JSON.stringify(c.view.draft.parameters)}; validation=${JSON.stringify(c.validation())}`);
    assert.deepEqual(c.view.draft.parameters, { quality: "high" });
    assert.deepEqual(c.view.dropped, ["size"]);
    assert.deepEqual(c.droppedLabels((key) => t(key, "zh-CN")), ["尺寸"]);
    // Same flow as a model switch: the banner must be acknowledged before submitting.
    assert.deepEqual(c.validation(), ["请先确认参数调整。"]);
    c.acknowledgeMigration();
    assert.deepEqual(c.validation(), []);
    c.updateDraft({ parameters: { ...c.view.draft.parameters, aspectRatio: "16:9" } });
    await c.submit();
    assert.deepEqual(requests[0].parameters, { quality: "high", aspectRatio: "16:9" });
  } finally { c.dispose(); }
});

async function picker(props) {
  const env = await createDomTestEnv({ mocks: { "../../components/IconSet": new Proxy({}, { get: () => () => null }) } });
  const { ImageSizePicker, describeImageSize } = env.loadModule("@liveagent/ui/features/image-studio/ImageSizePicker");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const changes = [];
  await env.act(async () => root.render(env.React.createElement(ImageSizePicker, { onFramingChange: () => {}, ...props, onChange: (v) => changes.push(v) })));
  return {
    env, changes, describeImageSize, trigger: host.querySelector("button"),
    async close() { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); },
  };
}

test("picker offers all eight beta.26 ratios and writes aspectRatio/imageSize, never size", async () => {
  const view = await picker({ target: beta26, values: { quality: "xhigh" } });
  try {
    await view.env.act(async () => view.trigger.click());
    const group = document.querySelector('[role="radiogroup"][aria-label="画面比例"]');
    const labels = [...group.querySelectorAll("label")].map((l) => l.textContent.trim());
    assert.deepEqual(labels, ["自动", "21:9", "16:9", "3:2", "4:3", "1:1", "3:4", "2:3", "9:16"]);
    const pick = async (g, label) => {
      const input = [...g.querySelectorAll("label")].find((l) => l.textContent.trim() === label).querySelector("input");
      await view.env.act(async () => input.click());
    };
    await pick(group, "21:9");
    assert.deepEqual(view.changes.at(-1), { quality: "xhigh", aspectRatio: "21:9" });
    const tiers = document.querySelector('[role="radiogroup"][aria-label="分辨率"]');
    await pick(tiers, "4K");
    assert.ok(view.changes.every((v) => !("size" in v)));
    assert.match(document.body.textContent, /更多参数/);
    assert.equal(view.describeImageSize(beta26, { aspectRatio: "3:4", imageSize: "2K" }), "比例 3:4 · 分辨率 2K");
  } finally { await view.close(); }
});
