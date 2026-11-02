import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

// Mirrors K-brain aa58c01 direct.AgnesParameters(): ratio first, then size; no default.
const enumSpec = (key, label, values) => ({ key, label, type: "string", enum: values });
const agnes = {
  id: "it_provider_agnes", name: "Agnes · agnes-image", enabled: true,
  parameters: [
    enumSpec("aspectRatio", "Aspect ratio", ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"]),
    enumSpec("imageSize", "Size", ["1K", "2K", "3K", "4K"]),
  ],
  capabilities: { operations: ["generate", "reference", "edit"], maxCount: 1, maxInputs: 16, outputFormats: ["png"] },
};

test("Agnes target uses params mode and keeps all 8 ratios and 3K", async () => {
  const env = await createDomTestEnv({ mocks: { "../../components/IconSet": new Proxy({}, { get: () => () => null }) } });
  const { describeImageSize } = env.loadModule("@liveagent/ui/features/image-studio/ImageSizePicker");
  const { usesPromptFraming } = env.loadModule("@liveagent/ui/features/image-studio/framing");
  const { validateParameters, defaultParameters } = env.loadModule("@liveagent/ui/features/image-studio/parameterModel");
  assert.equal(usesPromptFraming(agnes), false);
  assert.equal(describeImageSize(agnes, { aspectRatio: "21:9", imageSize: "3K" }), "比例 21:9 · 分辨率 3K");
  assert.equal(describeImageSize(agnes, {}), "尺寸由模型自动决定");
  for (const r of agnes.parameters[0].enum)
    for (const s of agnes.parameters[1].enum)
      assert.deepEqual(validateParameters(agnes, { aspectRatio: r, imageSize: s }), []);
  assert.deepEqual(defaultParameters(agnes), {});
});
