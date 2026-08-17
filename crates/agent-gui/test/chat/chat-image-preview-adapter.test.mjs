import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function installGlobals(values) {
  const previous = new Map();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  }
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  };
}

function base64Atob(value) {
  return Buffer.from(value, "base64").toString("binary");
}

function binaryBtoa(value) {
  return Buffer.from(value, "binary").toString("base64");
}

function loadAdapter() {
  const calls = [];
  const loader = createTsModuleLoader({
    mocks: {
      "@tauri-apps/api/core": {
        async invoke(command, payload) {
          calls.push({ command, payload });
          return command === "system_prepare_preview_file_save" ? "save-token" : true;
        },
      },
    },
  });
  return { adapter: loader.loadModule("@liveagent/adapters/imagePreview"), calls };
}

test("desktop image preview adapter selects a save target before sending image data", async () => {
  const { adapter, calls } = loadAdapter();

  assert.equal(adapter.supportsSystemImageOpen, true);
  assert.equal(adapter.supportsDirectUploadedImageCopy, true);
  const writeImage = await adapter.prepareImagePreviewSave({
    fileName: "chart.png",
    mimeType: "image/png",
  });
  assert.equal(typeof writeImage, "function");
  assert.deepEqual(calls, [
    {
      command: "system_prepare_preview_file_save",
      payload: { file_name: "chart.png" },
    },
  ]);
  await writeImage({
    dataBase64: "aGVsbG8=",
    fileName: "chart.png",
    mimeType: "image/png",
  });
  await adapter.prepareUploadedImagePreviewCopy({
    workdir: "C:/work",
    absolutePath: "C:/work/assets/chart.png",
  });
  await adapter.copyUploadedImagePreview({
    workdir: "C:/work",
    absolutePath: "C:/work/assets/chart.png",
  });
  await adapter.openUploadedImageInSystemViewer({
    workdir: "C:/work",
    absolutePath: "C:/work/assets/chart.png",
  });

  assert.deepEqual(calls, [
    {
      command: "system_prepare_preview_file_save",
      payload: {
        file_name: "chart.png",
      },
    },
    {
      command: "system_write_preview_file",
      payload: {
        save_token: "save-token",
        data_base64: "aGVsbG8=",
        mime_type: "image/png",
      },
    },
    {
      command: "system_prepare_uploaded_image_clipboard",
      payload: {
        workdir: "C:/work",
        absolute_path: "C:/work/assets/chart.png",
      },
    },
    {
      command: "system_clipboard_write_uploaded_image",
      payload: {
        workdir: "C:/work",
        absolute_path: "C:/work/assets/chart.png",
      },
    },
    {
      command: "system_open_uploaded_image",
      payload: {
        workdir: "C:/work",
        absolute_path: "C:/work/assets/chart.png",
      },
    },
  ]);
});

test("desktop image copy rasterizes SVG data to PNG before invoking Tauri", async () => {
  const { adapter, calls } = loadAdapter();
  const events = [];
  const imageBitmap = {
    width: 16,
    height: 9,
    close() {
      events.push("bitmap-closed");
    },
  };
  const restore = installGlobals({
    window: { atob: base64Atob, btoa: binaryBtoa },
    createImageBitmap: async (blob) => {
      assert.equal(blob.type, "image/svg+xml");
      events.push("decode");
      return imageBitmap;
    },
    document: {
      createElement(tagName) {
        assert.equal(tagName, "canvas");
        return {
          width: 0,
          height: 0,
          getContext() {
            return { drawImage: () => events.push("draw") };
          },
          toBlob(callback, type) {
            events.push("encode");
            callback(new Blob(["png"], { type }));
          },
        };
      },
    },
  });
  try {
    await adapter.copyImagePreviewData(
      Promise.resolve({ dataBase64: "PHN2Zz48L3N2Zz4=", mimeType: "image/svg+xml" }),
    );
    assert.deepEqual(events, ["decode", "draw", "bitmap-closed", "encode"]);
    assert.deepEqual(calls, [
      {
        command: "system_clipboard_write_image",
        payload: { data_base64: "cG5n", mime_type: "image/png" },
      },
    ]);
  } finally {
    restore();
  }
});

test("desktop image preview actions are implemented and registered with Tauri", () => {
  const systemSource = fs.readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/commands/app/system.rs", import.meta.url)),
    "utf8",
  );
  const libSource = fs.readFileSync(
    fileURLToPath(new URL("../../src-tauri/src/lib.rs", import.meta.url)),
    "utf8",
  );

  assert.match(systemSource, /pub async fn system_save_preview_file\(/);
  assert.match(systemSource, /pub async fn system_prepare_preview_file_save\(/);
  assert.match(systemSource, /pub async fn system_write_preview_file\(/);
  assert.match(systemSource, /pub async fn system_clipboard_write_image\(/);
  assert.match(systemSource, /pub async fn system_prepare_uploaded_image_clipboard\(/);
  assert.match(systemSource, /pub async fn system_clipboard_write_uploaded_image\(/);
  assert.match(
    systemSource,
    /fn system_prepare_uploaded_image_clipboard_sync\([\s\S]*resolve_uploaded_image_target\(&workdir, &absolute_path\)/,
  );
  assert.match(
    systemSource,
    /fn system_clipboard_write_uploaded_image_sync\([\s\S]*prepare_uploaded_image_preview_clipboard_target\(&target\)/,
  );
  assert.match(libSource, /commands::system::system_save_preview_file,/);
  assert.match(libSource, /commands::system::system_prepare_preview_file_save,/);
  assert.match(libSource, /commands::system::system_write_preview_file,/);
  assert.match(libSource, /commands::system::system_clipboard_write_image,/);
  assert.match(libSource, /commands::system::system_prepare_uploaded_image_clipboard,/);
  assert.match(libSource, /commands::system::system_clipboard_write_uploaded_image,/);
});
