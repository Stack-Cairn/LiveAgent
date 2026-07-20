import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const mod = loader.loadModule("src/lib/chat/clipboardCapture.ts");

const {
  clipboardImageMimeTypes,
  extensionForImageMime,
  filesFromClipboardItems,
  pickPreferredImageMime,
  readClipboardImageFiles,
} = mod;

test("clipboardImageMimeTypes keeps only image/*", () => {
  assert.deepEqual(clipboardImageMimeTypes(["text/plain", "image/png", "IMAGE/JPEG"]), [
    "image/png",
    "IMAGE/JPEG",
  ]);
});

test("extensionForImageMime rejects unsupported image types", () => {
  assert.equal(extensionForImageMime("image/png"), "png");
  assert.equal(extensionForImageMime("image/jpeg"), "jpg");
  assert.equal(extensionForImageMime("image/svg+xml"), null);
  assert.equal(extensionForImageMime("image/tiff"), null);
  assert.equal(extensionForImageMime("image/avif"), null);
});

test("pickPreferredImageMime prefers png over jpeg for one item", () => {
  assert.equal(pickPreferredImageMime(["image/jpeg", "image/png", "text/plain"]), "image/png");
  assert.equal(pickPreferredImageMime(["image/svg+xml", "image/tiff"]), null);
});

test("filesFromClipboardItems builds File objects for image blobs", async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  const items = [
    {
      types: ["text/plain", "image/png"],
      getType: async (type) => {
        if (type === "image/png") return new Blob([pngBytes], { type: "image/png" });
        return new Blob(["hi"], { type: "text/plain" });
      },
    },
  ];
  const files = await filesFromClipboardItems(items, 1_700_000_000_000);
  assert.equal(files.length, 1);
  assert.match(files[0].name, /^clipboard-image-1700000000000-1\.png$/);
  assert.equal(files[0].type, "image/png");
  assert.equal(files[0].size, pngBytes.length);
});

test("filesFromClipboardItems imports one representation per ClipboardItem", async () => {
  const pngBytes = new Uint8Array([137, 80, 78, 71]);
  const jpegBytes = new Uint8Array([255, 216, 255]);
  const files = await filesFromClipboardItems(
    [
      {
        types: ["image/png", "image/jpeg"],
        getType: async (type) => {
          if (type === "image/png") return new Blob([pngBytes], { type: "image/png" });
          if (type === "image/jpeg") return new Blob([jpegBytes], { type: "image/jpeg" });
          throw new Error(`unexpected ${type}`);
        },
      },
    ],
    1_700_000_000_000,
  );
  assert.equal(files.length, 1);
  assert.equal(files[0].type, "image/png");
  assert.match(files[0].name, /\.png$/);
});

test("filesFromClipboardItems skips unsupported image-only items", async () => {
  const files = await filesFromClipboardItems([
    {
      types: ["image/svg+xml"],
      getType: async () => new Blob(["<svg/>"], { type: "image/svg+xml" }),
    },
  ]);
  assert.deepEqual(files, []);
});

test("filesFromClipboardItems returns empty when no images", async () => {
  const files = await filesFromClipboardItems([
    {
      types: ["text/plain"],
      getType: async () => new Blob(["x"], { type: "text/plain" }),
    },
  ]);
  assert.deepEqual(files, []);
});

test("readClipboardImageFiles reports unsupported without clipboard API", async () => {
  const result = await readClipboardImageFiles(null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unsupported");
});

test("readClipboardImageFiles maps empty clipboard", async () => {
  const result = await readClipboardImageFiles({
    read: async () => [],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty");
});

test("readClipboardImageFiles maps permission errors", async () => {
  const result = await readClipboardImageFiles({
    read: async () => {
      throw new Error("NotAllowedError: permission denied");
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "denied");
});
