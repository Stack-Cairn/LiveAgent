import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../../agent-gateway/test/helpers/load-web-module.mjs";
import {
  parseTypeScriptSource,
  walkSyntaxTree,
} from "../../../../scripts/typescript-source-tools.mjs";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// The whole image studio follows the interface language: an English UI shows no Chinese,
// the Chinese UI keeps its exact wording, and the framing line appended to the prompt is
// wire format that stays the same in both languages.

const CJK = /[　-〿㐀-鿿＀-￯]/;
const studioRoot = fileURLToPath(new URL("../../../agent-ui/src/features/image-studio/", import.meta.url));
const loader = createTsModuleLoader();
const { t } = loader.loadModule("@liveagent/app/i18n/config");
const zh = (key) => t(key, "zh-CN");
const en = (key) => t(key, "en-US");
const { SHARED_TRANSLATIONS } = loader.loadModule("@liveagent/ui/i18n/sharedTranslations.ts");
const studioKeys = (locale) =>
  Object.entries(SHARED_TRANSLATIONS[locale]).filter(([key]) => key.startsWith("imageStudio."));

test("no studio source renders Chinese except the stored archive title and the prompt marker", () => {
  // Wire text the backend or model reads back; the interface language must not change it.
  const allowed = new Map([
    ["studioController.ts", ["图像工作台"]],
    ["framing.ts", ["【画面参数】", "画面比例 ", "分辨率 ", "（约 ", "×", " 像素）", "；"]],
  ]);
  const found = [];
  for (const name of readdirSync(studioRoot).filter((file) => /\.tsx?$/.test(file))) {
    const tree = parseTypeScriptSource(readFileSync(path.join(studioRoot, name), "utf8"), name);
    walkSyntaxTree(tree, (node) => {
      const texts =
        node.type === "StringLiteral" || node.type === "JSXText"
          ? [node.value]
          : node.type === "TemplateLiteral"
            ? node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw)
            : node.type === "RegExpLiteral"
              ? [node.pattern]
              : [];
      for (const text of texts) {
        if (!CJK.test(text)) continue;
        const ok = (allowed.get(name) ?? []).some((part) => text.includes(part));
        if (!ok) found.push(`${name}:${node.loc.start.line} ${JSON.stringify(text)}`);
      }
    });
  }
  assert.deepEqual(found, []);
});

test("every English studio message is free of Chinese and both locales share placeholders", () => {
  const english = studioKeys("en-US");
  assert.ok(english.length > 250);
  for (const [key, value] of english) assert.doesNotMatch(value, CJK, key);
  for (const [key] of studioKeys("zh-CN"))
    assert.ok(Object.hasOwn(SHARED_TRANSLATIONS["en-US"], key), `en-US is missing ${key}`);
});

test("notice tones keep the colour the Chinese wording used to give them", () => {
  const { noticeTone } = loader.loadModule("@liveagent/ui/features/image-studio/studioModel");
  const { formatMessage, message } = loader.loadModule("@liveagent/ui/features/image-studio/studioText");
  // The classifier the studio used before notices became keys.
  const legacyTone = (text) => {
    if (/失败|已失效/.test(text)) return "error";
    if (/^(已删除历史记录|图片已保存)/.test(text)) return "success";
    if (/请|不支持|不可用|上限|不兼容|未确认|可能|计费/.test(text)) return "warning";
    return "info";
  };
  const params = {
    count: 2,
    format: "GIF",
    action: message("imageStudio.errorAction.default"),
    // The old disabled-model notice showed the raw reason code.
    reason: "auth_required",
  };
  const notices = studioKeys("zh-CN").filter(([key]) => key.startsWith("imageStudio.notice."));
  assert.ok(notices.length >= 60);
  for (const [key] of notices) {
    const text = formatMessage(message(key, params), zh);
    assert.equal(noticeTone({ key }), legacyTone(text), `${key}: ${text}`);
  }
});

test("message parameters are inserted verbatim in one pass", () => {
  const { formatMessage, message } = loader.loadModule("@liveagent/ui/features/image-studio/studioText");
  const prompt = "cat {total} $& $1 {prompt}";
  assert.equal(
    formatMessage(message("imageStudio.pending.view", { prompt }), en),
    `View unconfirmed request: ${prompt}`,
  );
  assert.equal(
    formatMessage(message("imageStudio.imageIndex", { index: 1 }), en),
    "Image 1 of {total}",
    "a missing parameter stays visible instead of reading undefined",
  );
});

const enumSpec = (key, values) => ({ key, label: key, type: "string", required: false, enum: values });
const caps = (extra = {}) => ({
  operations: ["generate", "edit"], maxCount: 4, maxInputs: 3, outputFormats: ["png"], supportsCancel: true, ...extra,
});
// No size or ratio parameter, so framing goes into the prompt.
const framed = {
  id: "t-framed", name: "moonup · gpt-image", enabled: true, revision: 1, capabilities: caps(),
  parameters: [
    enumSpec("quality", ["low", "high", "auto"]),
    { key: "watermark", label: "watermark", type: "boolean", required: false },
    { key: "steps", label: "Steps", type: "integer", required: false, minimum: 1, maximum: 50 },
  ],
};
const disabled = {
  id: "t-off", name: "other · broken-image", enabled: false, disabledReason: "auth_required", revision: 1,
  capabilities: caps(), parameters: [],
};
const project = { id: "archive", title: "图像工作台", revision: 1 };
const framedPrompt = "Neon cat\n\n【画面参数】画面比例 16:9；分辨率 2K（约 2048×1152 像素）";
const job = (id, overrides = {}) => ({
  id, projectId: "archive", revision: 1, lastEventSeq: 0, status: "succeeded",
  createdAt: "2026-10-30T10:00:00Z", updatedAt: "2026-10-30T10:00:00Z",
  request: { projectId: "archive", targetId: framed.id, prompt: `Prompt ${id}`, operation: "generate",
    count: 1, parameters: {}, inputs: [] },
  targetSnapshot: framed, assetIds: [], items: [], usage: null, ...overrides,
});
const error = (code) => ({ code, message: "provider said no", retryable: false, requestId: "" });
const jobs = [
  job("ok", { assetIds: ["a1", "a2"], createdAt: "2026-10-30T12:00:00Z",
    request: { ...job("ok").request, prompt: framedPrompt } }),
  job("failed", { status: "failed", error: error("IMAGE_RATE_LIMITED") }),
  job("unknown", { status: "result_unknown", error: error("IMAGE_RESULT_UNKNOWN") }),
  job("running", { status: "running", targetSnapshot: { ...framed, capabilities: caps({ supportsCancel: false }) } }),
  job("local", { status: "cancelled", cancelEffect: "local_only" }),
];

/** Every text node and user-facing attribute under the document that contains Chinese. */
function chineseOnScreen(document) {
  const found = [];
  const walker = document.createTreeWalker(document.body, 4);
  while (walker.nextNode()) if (CJK.test(walker.currentNode.nodeValue)) found.push(walker.currentNode.nodeValue);
  for (const element of document.body.querySelectorAll("*"))
    for (const name of ["aria-label", "title", "placeholder", "alt"]) {
      const value = element.getAttribute(name);
      if (value && CJK.test(value)) found.push(`${element.tagName}[${name}]=${value}`);
    }
  return found;
}

async function studio(locale, client = {}) {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "../../components/AppErrorBoundary": { AppErrorBoundary: ({ children }) => children },
    // The lazy chat viewer is outside the studio; its own strings are covered elsewhere.
    "./AssetLightbox": { AssetLightbox: () => null },
  } });
  const { LocaleContext, useLocaleContextValue } = env.loadModule("@liveagent/ui/i18n");
  const { ImageStudioPage } = env.loadModule("@liveagent/ui/features/image-studio/ImageStudioPage");
  const created = [];
  const fullClient = {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [framed, disabled],
    listProjects: async () => ({ items: [project] }),
    listJobs: async () => ({ items: jobs }),
    getJob: async (id) => jobs.find((item) => item.id === id),
    subscribe: async () => new Promise(() => {}),
    readAsset: async () => new Blob(["png"], { type: "image/png" }),
    createJob: async (request) => { created.push(request); throw Object.assign(new TypeError("offline"), { code: "IMAGE_NETWORK_ERROR", status: 0 }); },
    exportAsset: async () => ({ saved: true }),
    ...client,
  };
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const Provider = ({ value, children }) =>
    env.React.createElement(LocaleContext.Provider, { value: useLocaleContextValue(value) }, children);
  const render = (next) => env.act(async () => root.render(env.React.createElement(Provider, { value: next },
    env.React.createElement(ImageStudioPage, { client: fullClient, ownerId: "o", backendId: "b", exportDestinations: ["download"] }))));
  await render(locale);
  for (let i = 0; i < 5; i++) await env.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const click = (element) => env.act(async () => element.click());
  return {
    env, host, created, render, click,
    async close() { await env.act(async () => root.unmount()); host.remove(); env.cleanup(); },
  };
}

test("English workbench shows no Chinese across history, preview, pickers, notices and pending requests", async () => {
  const ui = await studio("en-US");
  const { env, host, click } = ui;
  try {
    const screen = () => chineseOnScreen(document);
    assert.match(host.textContent, /Image Studio/);
    assert.match(host.textContent, /Image 1 of 2/);
    const buttons = [...host.querySelectorAll("button")].map((button) => button.textContent.trim());
    assert.ok(buttons.includes("Stop locally"), "short label keeps the status badge visible");
    assert.deepEqual(
      [...host.querySelectorAll('fieldset[aria-label="Filter history"] button')].map((b) => b.textContent),
      ["All", "Results", "Active", "Issues"],
    );
    assert.match(host.textContent, /Image request limit reached — Wait for the rate limit/);
    assert.match(host.textContent, /Local processing stopped/);
    assert.match(host.textContent, /Size chosen by the model/);
    const { describeImageSize } = env.loadModule("@liveagent/ui/features/image-studio/ImageSizePicker");
    assert.equal(
      describeImageSize(framed, {}, { ratio: "16:9", tier: "2K" }, en),
      "16:9 · 2K · ≈2048x1152 · In prompt",
      "fits the composer footer at 390 px",
    );
    assert.equal(describeImageSize(framed, {}, { ratio: "16:9", tier: "2K" }), "比例 16:9 · 分辨率 2K · 约 2048x1152 · 写入提示词");
    assert.deepEqual(screen(), [], "initial workbench");

    const failed = host.querySelector('[aria-label="View job: Prompt failed"]');
    assert.ok(failed, "history cards are named in English");
    await click(failed);
    assert.match(host.textContent, /No image was generated/);
    assert.deepEqual(screen(), [], "failed job preview");

    await click(host.querySelector('button[title="Aspect ratio and size"]'));
    assert.ok(document.querySelector('[role="radiogroup"][aria-label="Aspect ratio"]'), "size picker opened");
    assert.match(document.body.textContent, /appended to the end of the prompt/);
    assert.match(document.body.textContent, /More parameters/);
    const options = [...document.querySelectorAll("option")].map((option) => option.textContent);
    assert.ok(options.includes("Select") && options.includes("Yes") && options.includes("No"), options.join("|"));
    assert.deepEqual(screen(), [], "size picker and parameter form");
    await env.act(async () => document.dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    await click(document.getElementById(host.querySelector("label[for$='-model']").htmlFor));
    assert.match(document.body.textContent, /Unavailable/);
    assert.match(document.body.textContent, /The provider has no API key/);
    assert.match(document.body.textContent, /Text to image/);
    assert.deepEqual(screen(), [], "model picker");
    await env.act(async () => document.dispatchEvent(new env.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    const form = host.querySelector('form[aria-label="Create image"]');
    await env.act(async () => form.dispatchEvent(new env.dom.window.Event("submit", { bubbles: true, cancelable: true })));
    const notice = () => host.querySelector('[role="status"].absolute, [role="alert"].absolute');
    assert.equal(notice()?.textContent, "Enter a prompt.");
    assert.deepEqual(screen(), [], "validation notice");

    // A language switch re-renders the notice that is already on screen.
    await ui.render("zh-CN");
    assert.equal(notice()?.textContent, "请输入提示词。");
    assert.match(host.textContent, /视觉创作/);
    await ui.render("en-US");
    assert.equal(notice()?.textContent, "Enter a prompt.");

    const prompt = host.querySelector("textarea");
    await env.act(async () => {
      Object.getOwnPropertyDescriptor(env.dom.window.HTMLTextAreaElement.prototype, "value").set.call(prompt, "Paper boat");
      prompt.dispatchEvent(new env.dom.window.Event("input", { bubbles: true }));
    });
    await env.act(async () => form.dispatchEvent(new env.dom.window.Event("submit", { bubbles: true, cancelable: true })));
    for (let i = 0; i < 3; i++) await env.act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    assert.equal(ui.created.length, 1);
    assert.match(host.textContent, /View unconfirmed request: Paper boat/);
    assert.match(notice()?.textContent ?? "", /The submission is unconfirmed/);
    assert.deepEqual(screen(), [], "pending request and unconfirmed notice");
  } finally {
    await ui.close();
  }
});

test("the framing line sent to the model is the same Chinese marker in an English UI", async () => {
  const { ImageStudioController } = loader.loadModule("@liveagent/ui/features/image-studio/studioController");
  const { splitFramedPrompt } = loader.loadModule("@liveagent/ui/features/image-studio/framing");
  const sent = [];
  const controller = new ImageStudioController({
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [framed],
    listProjects: async () => ({ items: [project] }),
    listJobs: async () => ({ items: [] }),
    subscribe: async () => new Promise(() => {}),
    readAsset: async () => new Blob(),
    createJob: async (request) => { sent.push(request); return job("new", { request, status: "running" }); },
  }, "o", "b");
  controller.setTranslator(en);
  try {
    await controller.start();
    controller.updateDraft({ prompt: "Paper boat", framing: { ratio: "16:9", tier: "2K" } });
    await controller.submit();
    assert.equal(sent[0].prompt, "Paper boat\n\n【画面参数】画面比例 16:9；分辨率 2K（约 2048×1152 像素）");
    assert.deepEqual(splitFramedPrompt(sent[0].prompt), { prompt: "Paper boat", framing: { ratio: "16:9", tier: "2K" } });
  } finally {
    controller.dispose();
  }
});

test("controller notices, validation and tones follow the translator without a new announcement", async () => {
  const { ImageStudioController } = loader.loadModule("@liveagent/ui/features/image-studio/studioController");
  const controller = new ImageStudioController({
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [{ ...framed, parameters: [{ key: "steps", label: "Steps", type: "integer", required: true }] }],
    listProjects: async () => ({ items: [project] }),
    listJobs: async () => ({ items: [] }),
    subscribe: async () => {},
    readAsset: async () => new Blob(),
    deleteJob: async () => { throw Object.assign(new Error("busy"), { status: 409 }); },
  }, "o", "b");
  try {
    await controller.start();
    controller.updateDraft({ parameters: { steps: 0.5 } });
    assert.deepEqual(controller.validation(en), ["Steps: Enter a whole number", "Enter a prompt."]);
    assert.deepEqual(controller.validation(), ["Steps：请输入整数", "请输入提示词。"], "default stays Chinese");
    await controller.deleteJob("missing");
    assert.equal(controller.view.notice, "任务仍在进行，请先取消或等待结束后再删除。");
    assert.equal(controller.view.noticeTone, "warning");
    const seq = controller.view.noticeSeq;
    controller.setTranslator(en);
    assert.equal(controller.view.notice, "The job is still running. Cancel it or wait for it to finish before deleting.");
    assert.equal(controller.view.noticeSeq, seq, "re-rendering is not a new notice");
    controller.dismissNotice();
    controller.setTranslator(zh);
    assert.equal(controller.view.notice, "", "a dismissed notice stays dismissed");
  } finally {
    controller.dispose();
  }
});

test("WebUI host notices follow the interface language", async () => {
  const web = createWebModuleLoader();
  const { gatewayImageErrorNotice } = web.loadModule("src/agent-ui-adapters/imageStudio.ts");
  const { ImageClientError } = web.loadModule("@liveagent/ui/lib/imaging/errors");
  const { t: webT } = web.loadModule("@liveagent/ui/i18n/index");
  const webEn = (key) => webT(key, "en-US");
  const webZh = (key) => webT(key, "zh-CN");
  for (const error of [new TypeError("offline"), new ImageClientError("IMAGE_IDENTITY_UNAVAILABLE"), new ImageClientError("IMAGE_UNAVAILABLE", 503)]) {
    const text = gatewayImageErrorNotice(error, webEn);
    assert.doesNotMatch(text, CJK, text);
    assert.match(text, /IMAGE_[A-Z_]+/, "the code stays for diagnosis");
  }
  assert.equal(gatewayImageErrorNotice(new TypeError("offline"), webZh), "图像连接失败（IMAGE_NETWORK_ERROR）。");
  assert.equal(gatewayImageErrorNotice(new ImageClientError("IMAGE_UNAVAILABLE", 503), webZh), "HTTP 503 · 图像模块不可用（IMAGE_UNAVAILABLE）");
});
