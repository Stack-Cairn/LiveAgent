import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// Adversarial review of "图像工作台全部文字跟随界面语言" (5adf2fa4e).

const tick = () => new Promise((resolve) => setImmediate(resolve));
const requireFromGui = createRequire(fileURLToPath(new URL("../../package.json", import.meta.url)));

// Switching the interface language only changes the slide alt text, yet the lightbox
// effect depends on `t`, so every open original is aborted, its blob URL revoked, all
// originals are downloaded again and the viewer falls back to "Loading" (losing the
// slide the user navigated to). The alt can be derived at render time instead.
test("an open lightbox keeps its loaded originals when the interface language changes", async () => {
  // The vm loader cannot run the lazy import() of the chat viewer; stand it in through
  // React.lazy with a viewer that renders each slide's src and alt.
  const React = requireFromGui("react");
  const Viewer = ({ slides }) =>
    React.createElement(
      "div",
      { "data-viewer": "" },
      slides.map((slide) => React.createElement("img", { key: slide.assetId, src: slide.src, alt: slide.alt })),
    );
  const env = await createDomTestEnv({
    mocks: {
      "../../components/IconSet": new Proxy({}, { get: () => () => null }),
      react: { ...React, lazy: () => Viewer },
    },
  });
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  const created = [];
  const revoked = [];
  const reads = [];
  URL.createObjectURL = () => {
    const url = `blob:test-${created.length}`;
    created.push(url);
    return url;
  };
  URL.revokeObjectURL = (url) => revoked.push(url);
  // The first download of each original answers at once; any later one stays in flight,
  // as a 20 MiB original over the Gateway would.
  const client = {
    readAsset: (id) => {
      reads.push(id);
      return reads.length <= 2 ? Promise.resolve(new Blob([id], { type: "image/png" })) : new Promise(() => {});
    },
  };
  const { LocaleContext, useLocaleContextValue } = env.loadModule("@liveagent/ui/i18n");
  const { AssetLightbox } = env.loadModule("@liveagent/ui/features/image-studio/AssetLightbox");
  const Provider = ({ value, children }) =>
    env.React.createElement(LocaleContext.Provider, { value: useLocaleContextValue(value) }, children);
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const props = { client, assetIds: ["a1", "a2"], index: 1, title: "Paper boat", assets: {}, open: true, onClose() {} };
  const render = (locale) =>
    env.act(async () =>
      root.render(env.React.createElement(Provider, { value: locale }, env.React.createElement(AssetLightbox, props))),
    );
  const settle = async () => {
    for (let i = 0; i < 6; i++) await env.act(tick);
  };
  try {
    await render("zh-CN");
    await settle();
    assert.ok(host.querySelector("[data-viewer]"), "viewer opened");
    assert.deepEqual(reads, ["a1", "a2"]);
    assert.equal(host.querySelector("img").alt, "Paper boat（第 1 张）");

    await render("en-US");
    await settle();
    assert.deepEqual(
      {
        reads,
        revoked,
        viewerOpen: Boolean(host.querySelector("[data-viewer]")),
        alt: host.querySelector("img")?.alt,
      },
      {
        reads: ["a1", "a2"],
        revoked: [],
        viewerOpen: true,
        alt: "Paper boat (image 1)",
      },
      "a language switch re-labels the slides; it must not re-download, revoke or close the viewer",
    );
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    env.cleanup();
  }
});

// The PR claims every Chinese notice keeps the colour (and therefore the timeout) it had.
// interface-language.test.mjs checks targetDisabled with a synthetic `reason`, so it never
// sees the real refresh path. Before this change that notice was the raw reason code
// (auth_required), which the old classifier always rated info (4 s); the reason is now
// translated, and the tone must still be the one the raw code got.
test("a disabled draft target keeps the tone its old raw-code notice had", async () => {
  const loader = createTsModuleLoader();
  const { ImageStudioController } = loader.loadModule("@liveagent/ui/features/image-studio/studioController");
  const legacyTone = (text) => {
    if (/失败|已失效/.test(text)) return "error";
    if (/^(已删除历史记录|图片已保存)/.test(text)) return "success";
    if (/请|不支持|不可用|上限|不兼容|未确认|可能|计费/.test(text)) return "warning";
    return "info";
  };
  const caps = { operations: ["generate"], maxCount: 1, maxInputs: 0, outputFormats: ["png"], supportsCancel: true };
  const enabled = { id: "t", name: "p · m", enabled: true, revision: 1, capabilities: caps, parameters: [] };
  const mismatched = [];
  for (const reason of ["auth_required", "awaiting_verification", "unsupported_image_model"]) {
    let targets = [enabled];
    const controller = new ImageStudioController(
      {
        capabilities: async () => ({ supported: true }),
        listTargets: async () => targets,
        listProjects: async () => ({ items: [{ id: "archive", title: "图像工作台", revision: 1 }] }),
        listJobs: async () => ({ items: [] }),
        subscribe: async () => {},
        readAsset: async () => new Blob(),
      },
      "o",
      "b",
    );
    try {
      await controller.start();
      assert.equal(controller.view.draft.targetId, "t");
      targets = [{ ...enabled, enabled: false, disabledReason: reason, revision: 2 }];
      await controller.refreshTargets();
      const { notice, noticeTone } = controller.view;
      assert.ok(notice && notice !== reason, `${reason}: the reason is shown translated`);
      if (noticeTone !== legacyTone(reason))
        mismatched.push(`${reason}: "${notice}" is ${noticeTone}, the old raw-code notice was ${legacyTone(reason)}`);
    } finally {
      controller.dispose();
    }
  }
  assert.deepEqual(mismatched, []);
});
