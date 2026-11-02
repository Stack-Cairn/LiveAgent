import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Round 2 adversarial review: the isWireLabel gate and droppedLabels(t), fed with the
// exact parameter specs K-brain sends (internal/imaging/adapters/direct/profile.go).

const enumSpec = (key, values) => ({ key, label: key, type: "string", required: false, enum: values });
const caps = { operations: ["generate"], maxCount: 1, maxInputs: 16, outputFormats: ["png"], supportsCancel: true };
const openAI = {
  id: "it_openai", name: "moonup · gpt-image", enabled: true, revision: 1, capabilities: caps,
  parameters: [enumSpec("size", ["1024x1024", "1536x1024"]), enumSpec("quality", ["low", "high"])],
};
// direct.AgnesParameters(): size, ratio := enumSpec("imageSize"), enumSpec("aspectRatio");
// size.Label, ratio.Label = "Size", "Aspect ratio".
const agnes = {
  id: "it_agnes", name: "agnes · image", enabled: true, revision: 1, capabilities: caps,
  parameters: [
    { ...enumSpec("aspectRatio", ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]), label: "Aspect ratio" },
    { ...enumSpec("imageSize", ["1K", "2K", "3K", "4K"]), label: "Size" },
  ],
};

// [P2] "Size" is K-brain's fixed English wire label for Agnes imageSize, but isWireLabel only
// accepts the key itself or the en-US name of the same key ("Image size"), so it is treated as
// user-authored and shown in English next to the translated 画面比例.
test("adversarial r2: zh-CN banner translates Agnes' fixed wire labels after switching to gpt-image", async () => {
  const env = await createDomTestEnv({ mocks: {
    "../../components/IconSet": new Proxy({}, { get: () => () => null }),
    "./ImageModelPicker": { ImageModelPicker: () => null },
  } });
  const { ImageStudioController } = env.loadModule("@liveagent/ui/features/image-studio/studioController");
  const { t } = env.loadModule("@liveagent/app/i18n/config");
  const storage = new Map();
  const controller = new ImageStudioController({
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [agnes, openAI],
    listProjects: async () => ({ items: [{ id: "archive", title: "archive", revision: 1 }] }),
    createProject: async () => ({ id: "archive", title: "archive", revision: 1 }),
    listJobs: async () => ({ items: [] }),
    getJob: async () => undefined,
    subscribe: async () => {},
    readAsset: async () => new Blob([], { type: "image/png" }),
  }, "owner", "backend", {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  });
  try {
    await controller.start();
    controller.setTarget(agnes.id);
    // What ImageSizePicker writes when the user picks 16:9 and 2K.
    controller.updateDraft({ parameters: { aspectRatio: "16:9", imageSize: "2K" } });
    controller.setTarget(openAI.id);
    assert.deepEqual([...controller.view.dropped], ["aspectRatio", "imageSize"]);
    const zh = (key) => t(key, "zh-CN");
    // Before the fix: ["画面比例", "Size"]
    assert.deepEqual(controller.droppedLabels(zh), ["画面比例", "分辨率"]);
  } finally {
    controller.dispose();
    env.cleanup();
  }
});

// [P2] wireAliases is a plain object indexed by a user-controlled key. "constructor" and
// "toString" pass both the settings parser and K-brain's keyPattern (^[A-Za-z][A-Za-z0-9_.-]*$),
// and `...(wireAliases[key] ?? [])` then spreads Object.prototype members, which are not iterable.
test("adversarial r3: parameter keys named like Object.prototype members render as plain labels", async () => {
  const env = await createDomTestEnv();
  try {
    const { parseImageParameters } = env.loadModule("@liveagent/ui/pages/settings/imageSettingsAdapter");
    const { parameterLabel, parameterValueLabel } = env.loadModule("@liveagent/ui/features/image-studio/studioText");
    const { t } = env.loadModule("@liveagent/app/i18n/config");
    const zh = (key) => t(key, "zh-CN");
    const specs = parseImageParameters(JSON.stringify([
      { key: "constructor", label: "构造器节点", type: "string", required: false, enum: ["a"] },
      { key: "toString", label: "文本节点", type: "string", required: false },
    ]));
    // Before the fix: TypeError: Spread syntax requires ...iterable[Symbol.iterator] to be a function
    assert.deepEqual(specs.map((spec) => parameterLabel(spec, zh)), ["构造器节点", "文本节点"]);
    assert.equal(parameterValueLabel(specs[0], "a", zh), "a");
  } finally {
    env.cleanup();
  }
});
