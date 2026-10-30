import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Mirrors K-brain direct.ProtocolProfile(OpenAIID).Parameters: enumSpec labels are the
// bare wire keys and output_compression carries an English label.
const enumSpec = (key, values) => ({ key, label: key, type: "string", required: false, enum: values });
const openAI = {
  id: "it_provider_moonup", name: "moonup-4k · gpt-image-2.5-flare", enabled: true,
  parameters: [
    enumSpec("size", ["1024x1024", "1536x1024", "1024x1536"]),
    enumSpec("quality", ["low", "medium", "high", "auto"]),
    enumSpec("output_format", ["png", "jpeg", "webp"]),
    enumSpec("background", ["opaque", "transparent", "auto"]),
    { key: "output_compression", label: "Output compression", type: "integer", required: false, minimum: 0, maximum: 100 },
  ],
  capabilities: { operations: ["generate"], maxCount: 1, maxInputs: 16, outputFormats: ["png"] },
};
const unknownJob = {
  id: "job-unknown", projectId: "archive", revision: 1, lastEventSeq: 0, status: "result_unknown",
  createdAt: "2026-10-30T15:12:00Z", updatedAt: "2026-10-30T15:12:00Z",
  request: { projectId: "archive", targetId: openAI.id, prompt: "竖版构图", operation: "generate",
    count: 1, parameters: { quality: "high", background: "transparent" }, inputs: [] },
  targetSnapshot: openAI, assetIds: [], items: [], usage: null,
  error: { code: "IMAGE_RESULT_UNKNOWN", message: "Image execution result is unknown", retryable: false, requestId: "" },
};

async function render(locale, element) {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    "./AssetLightbox": { AssetLightbox: () => null },
    "./ImageModelPicker": { ImageModelPicker: () => null },
  } });
  const { LocaleContext, useLocaleContextValue } = env.loadModule("@liveagent/ui/i18n");
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const Provider = ({ children }) =>
    env.React.createElement(LocaleContext.Provider, { value: useLocaleContextValue(locale) }, children);
  await env.act(async () => root.render(env.React.createElement(Provider, null, element(env))));
  return {
    env, host,
    async close() { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); },
  };
}

const labels = (host) => [...host.querySelectorAll("label")].map((label) => label.textContent.trim());
const options = (host, label) => {
  const control = [...host.querySelectorAll("label")].find((e) => e.textContent.trim() === label)?.control;
  assert.ok(control, `Missing control: ${label}`);
  return [...control.querySelectorAll("option")].map((option) => option.textContent);
};
const parameterForm = (env) => {
  const { TargetParameterForm } = env.loadModule("@liveagent/ui/features/image-studio/TargetParameterForm");
  return env.React.createElement(TargetParameterForm, {
    target: { ...openAI, parameters: openAI.parameters.slice(1) }, values: {}, onChange: () => {},
  });
};

test("zh-CN shows Chinese names and options for gpt-image parameters", async () => {
  const view = await render("zh-CN", parameterForm);
  try {
    assert.deepEqual(labels(view.host), ["画质", "输出格式", "背景", "输出压缩率"]);
    assert.deepEqual(options(view.host, "画质"), ["请选择", "低", "中", "高", "自动"]);
    assert.deepEqual(options(view.host, "背景"), ["请选择", "不透明", "透明", "自动"]);
    // File formats are names, not words; they stay as the provider sends them.
    assert.deepEqual(options(view.host, "输出格式"), ["请选择", "png", "jpeg", "webp"]);
  } finally {
    await view.close();
  }
});

test("en-US keeps English parameter names and options", async () => {
  const view = await render("en-US", parameterForm);
  try {
    assert.deepEqual(labels(view.host), ["Quality", "Output format", "Background", "Output compression"]);
    assert.deepEqual(options(view.host, "Quality").slice(1), ["Low", "Medium", "High", "Auto"]);
    assert.deepEqual(options(view.host, "Background").slice(1), ["Opaque", "Transparent", "Auto"]);
  } finally {
    await view.close();
  }
});

test("unknown keys and hinted labels fall back to the backend label", async () => {
  const env = await createDomTestEnv();
  try {
    const { parameterLabel, parameterValueLabel } = env.loadModule("@liveagent/ui/features/image-studio/studioText");
    const { t } = env.loadModule("@liveagent/app/i18n/config");
    const zh = (key) => t(key, "zh-CN");
    // Volcengine's free-text size explains its own format; translating it to 尺寸 would drop the hint.
    const hinted = { key: "size", label: "Size (1K, 1.5K, 2K or width x height)" };
    assert.equal(parameterLabel(hinted, zh), hinted.label);
    assert.equal(parameterLabel({ key: "size", label: "size" }, zh), "尺寸");
    assert.equal(parameterLabel({ key: "seed", label: "Seed" }, zh), "Seed");
    // K-brain's fixed English name is a wire label too.
    assert.equal(parameterLabel({ key: "output_compression", label: "Output compression" }, zh), "输出压缩率");
    const quality = { key: "quality", label: "quality" };
    assert.equal(parameterValueLabel(quality, "high", zh), "高");
    assert.equal(parameterValueLabel(quality, "ultra", zh), "ultra");
    assert.equal(parameterValueLabel({ key: "seed", label: "seed" }, 7, zh), "7");
    // A label written in settings names a different parameter under the same key.
    const steps = { key: "quality", label: "采样步数" };
    assert.equal(parameterLabel(steps, zh), "采样步数");
    assert.equal(parameterValueLabel(steps, "high", zh), "high");
  } finally {
    env.cleanup();
  }
});

test("job error lines localize the image error by code", async () => {
  const env = await createDomTestEnv();
  try {
    const { jobErrorLines } = env.loadModule("@liveagent/ui/features/image-studio/studioModel");
    const { ImageClientError } = env.loadModule("@liveagent/ui/lib/imaging/errors");
    const { t } = env.loadModule("@liveagent/app/i18n/config");
    const zh = (key) => t(key, "zh-CN");
    const en = (key) => t(key, "en-US");
    const [zhLine] = jobErrorLines(unknownJob, zh);
    assert.match(zhLine, /^图像任务的执行结果未知 请先核对任务状态/);
    assert.doesNotMatch(zhLine, /[A-Za-z]{3}/);
    assert.match(jobErrorLines(unknownJob, en)[0], /^Image execution result is unknown — Check the job status/);
    // A code the client does not know arrives with the generic English message.
    const future = new ImageClientError("IMAGE_FUTURE_REASON");
    const job = { ...unknownJob, status: "failed", error: { ...unknownJob.error, code: future.code, message: future.message } };
    assert.match(jobErrorLines(job, zh)[0], /^图像操作失败 /);
    assert.match(jobErrorLines(job, en)[0], /^Image operation failed — /);
    // Every client-side code has a translation in both locales.
    const { IMAGE_ERROR_CODES } = env.loadModule("@liveagent/ui/lib/imaging/errors");
    for (const code of IMAGE_ERROR_CODES)
      for (const translate of [zh, en]) assert.notEqual(translate(`imageStudio.error.${code}`), `imageStudio.error.${code}`);
  } finally {
    env.cleanup();
  }
});

test("zh-CN workbench shows the result-unknown job error in Chinese", async () => {
  const client = {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [openAI],
    listProjects: async () => ({ items: [{ id: "archive", title: "archive", revision: 1 }] }),
    createProject: async () => ({ id: "archive", title: "archive", revision: 1 }),
    listJobs: async () => ({ items: [unknownJob] }),
    getJob: async () => unknownJob,
    subscribe: async () => {},
    readAsset: async () => new Blob([], { type: "image/png" }),
  };
  const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  const view = await render("zh-CN", (env) => {
    const { ImageStudioPage } = env.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
    return env.React.createElement(ImageStudioPage, { client, ownerId: "owner", backendId: "backend", storage });
  });
  try {
    await view.env.act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    const text = view.host.textContent;
    assert.match(text, /图像任务的执行结果未知 请先核对任务状态/);
    assert.doesNotMatch(text, /Image execution result is unknown/);
  } finally {
    await view.close();
  }
});
