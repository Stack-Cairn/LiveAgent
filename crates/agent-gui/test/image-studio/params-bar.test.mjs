import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const bar = createTsModuleLoader().loadModule("@liveagent/ui/features/image-studio/paramsBarModel");
const plain = (v) => JSON.parse(JSON.stringify(v));

const target = (keys) => ({
  parameters: keys.map((key) => ({ key, label: key, type: "string", required: false })),
  capabilities: { maxCount: 4 },
});

test("the parameter bar greys out fields the platform does not declare", () => {
  const openaiFields = bar.allowedFields(
    target(["size", "quality", "output_format", "output_compression", "moderation", "background"]),
  );
  assert.deepEqual([...openaiFields].sort(), [
    "moderation",
    "outputCompression",
    "outputFormat",
    "quality",
    "size",
    "transparentOutput",
  ]);
  assert.deepEqual([...bar.allowedFields(target(["size"]))], ["size"]);
  assert.deepEqual([...bar.allowedFields(target(["aspect_ratio", "image_size"]))], ["size"]);
  assert.deepEqual([...bar.allowedFields(undefined)], []);
});

test("unsupported values stay in the draft but are not submitted", () => {
  const limited = target(["size"]);
  assert.deepEqual(
    plain(bar.pruneParams(limited, { size: "1536x1024", quality: "high", outputFormat: "webp", transparentOutput: true })),
    { size: "1536x1024", n: 1 },
  );
  const full = target(["size", "quality", "output_format", "output_compression"]);
  assert.deepEqual(
    plain(bar.pruneParams(full, { size: "auto", quality: "high", outputFormat: "jpeg", outputCompression: 80 })),
    { size: "auto", n: 1, quality: "high", outputFormat: "jpeg", outputCompression: 80 },
  );
  assert.equal(bar.pruneParams(full, { outputCompression: 101 }).outputCompression, undefined);
  assert.equal(bar.pruneParams(full, {}).size, "auto");
});

test("size presets stay inside the backend envelope", () => {
  for (const [tier, ratios] of Object.entries(bar.SIZE_PRESETS))
    for (const [ratio, size] of Object.entries(ratios)) {
      const [w, h] = size.split("x").map(Number);
      assert.equal(w % 16, 0, `${tier} ${ratio} width`);
      assert.equal(h % 16, 0, `${tier} ${ratio} height`);
      assert.ok(Math.max(w, h) <= 3840, `${tier} ${ratio} max edge`);
      assert.ok(Math.max(w, h) / Math.min(w, h) <= 3, `${tier} ${ratio} aspect`);
      assert.ok(w * h >= 655360 && w * h <= 8294400, `${tier} ${ratio} pixels`);
    }
});

test("the task card summary lists only non-default values", () => {
  assert.deepEqual(bar.describeParams({ size: "auto", n: 1, quality: "auto", outputFormat: "png" }), []);
  assert.deepEqual(bar.describeParams({ size: "1536x1024", n: 2, quality: "high", outputFormat: "webp" }), [
    "1536x1024",
    "质量 高",
    "WebP",
  ]);
});
