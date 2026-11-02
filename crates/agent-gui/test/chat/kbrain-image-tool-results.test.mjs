import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { displayImageResultDetails, kbrainToolImages } = loader.loadModule(
  "src/lib/kbrain/toolImages.ts",
);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6WQAAAABJRU5ErkJggg==";

test("K-brain Image results become display_image details with raw base64 content", () => {
  const output = [
    "Display image: C:/Users/me/AppData/Local/Temp/shot.png",
    "Display image: https://example.com/a.png",
  ].join("\n");
  const images = kbrainToolImages(
    [
      { type: "text", text: output },
      { type: "image", image_url: `data:image/png;base64,${PNG}` },
      { type: "image", image_url: "https://example.com/a.png" },
    ],
    output,
  );
  // The data URL prefix is stripped once; the renderer adds it back.
  assert.deepEqual(images.content, [{ type: "image", data: PNG, mimeType: "image/png" }]);
  assert.equal(images.images[0].path, "C:/Users/me/AppData/Local/Temp/shot.png");
  assert.equal(images.images[0].renderMode, "inline");
  assert.deepEqual(images.images[1], {
    path: "https://example.com/a.png",
    sourceType: "url",
    renderMode: "proxy",
    sourceUrl: "https://example.com/a.png",
  });
  const details = displayImageResultDetails("Image", images.images, false);
  assert.equal(details.kind, "display_image");
  assert.equal(details.loadMode, "mixed");
  assert.equal(details.images.length, 2);
});

test("only successful Image calls with images get display_image details", () => {
  const { images } = kbrainToolImages([{ type: "image", image_url: `data:image/png;base64,${PNG}` }]);
  assert.equal(images[0].path, "inline-image-1");
  assert.equal(displayImageResultDetails("Image", images, true), undefined);
  assert.equal(displayImageResultDetails("ComputerUse", images, false), undefined);
  assert.equal(displayImageResultDetails("Image", [], false), undefined);
  assert.equal(displayImageResultDetails("Image", images, false).loadMode, "inline");
});

test("a mime type sent by K-brain wins over the data URL prefix", () => {
  const { content } = kbrainToolImages([
    { type: "image", image_url: `data:image/png;base64,${PNG}`, mime_type: "image/webp" },
    { type: "image", image_url: PNG },
  ]);
  assert.deepEqual(
    content.map((image) => `${image.mimeType}:${image.data === PNG}`),
    ["image/webp:true", "image/png:true"],
  );
});

test("live tool results and reloaded history both build Image details from the helper", () => {
  for (const relativePath of ["../../src/lib/kbrain/turn.ts", "../../src/lib/kbrain/history.ts"]) {
    const source = fs.readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
    assert.match(source, /kbrainToolImages\(/, relativePath);
    assert.match(source, /displayImageResultDetails\(/, relativePath);
  }
});
