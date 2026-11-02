import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const f = loader.loadModule("@liveagent/ui/features/image-studio/framing");
const { noticeTone, noticeDuration } = loader.loadModule("@liveagent/ui/features/image-studio/studioModel");

test("framed prompts round-trip so restored jobs never accumulate the suffix", () => {
  const composed = f.composeFramedPrompt("一只小猫  ", { ratio: "16:9", tier: "2K" });
  assert.equal(composed, "一只小猫\n\n【画面参数】画面比例 16:9；分辨率 2K（约 2048×1152 像素）");
  assert.deepEqual(f.splitFramedPrompt(composed), { prompt: "一只小猫", framing: { ratio: "16:9", tier: "2K" } });
  assert.equal(f.composeFramedPrompt("plain", undefined), "plain");
  assert.deepEqual(f.splitFramedPrompt("no marker here"), { prompt: "no marker here" });
  assert.deepEqual(f.splitFramedPrompt("tall\n\n【画面参数】画面比例 9:16"), { prompt: "tall", framing: { ratio: "9:16" } });
});

test("pixel estimate keeps the long edge at the tier and snaps to 16 px; sanitizer drops unknown values", () => {
  assert.deepEqual(f.framingPixels({ ratio: "9:16", tier: "1K" }), { w: 576, h: 1024 });
  assert.deepEqual(f.framingPixels({ ratio: "21:9", tier: "4K" }), { w: 4096, h: 1760 });
  assert.equal(f.framingPixels({ ratio: "1:1" }), undefined);
  assert.deepEqual(f.sanitizeFraming({ ratio: "5:4", tier: "2K" }), { tier: "2K" });
  assert.equal(f.sanitizeFraming({ ratio: "nope" }), undefined);
});

test("prompt framing applies only when the target declares no ratio/size enum", () => {
  const spec = (key, values) => ({ key, label: key, type: "string", required: false, enum: values });
  assert.equal(f.usesPromptFraming({ parameters: [] }), true);
  assert.equal(f.usesPromptFraming({ parameters: [{ key: "size", label: "s", type: "string", required: false }] }), true, "free-form size is not a ratio contract");
  assert.equal(f.usesPromptFraming({ parameters: [spec("size", ["1024x1024"])] }), false);
  assert.equal(f.usesPromptFraming({ parameters: [spec("aspectRatio", ["1:1"])] }), false);
});

test("notice tones: failures persist, successes and info fade, cautions linger", () => {
  assert.equal(noticeTone({ key: "imageStudio.notice.error.jobDeleteFailed" }), "error");
  assert.equal(noticeTone({ key: "imageStudio.notice.success.jobDeleted" }), "success");
  assert.equal(noticeTone({ key: "imageStudio.notice.success.exportSaved" }), "success");
  assert.equal(noticeTone({ key: "imageStudio.notice.warning.modelSwitched" }), "warning");
  assert.equal(noticeTone({ key: "imageStudio.notice.info.uploadCancelled" }), "info");
  assert.equal(noticeTone({ key: "imageStudio.validation.promptRequired" }), "warning", "validation lists are cautions");
  assert.equal(noticeDuration.error, null);
  assert.ok(noticeDuration.success < noticeDuration.warning);
});
