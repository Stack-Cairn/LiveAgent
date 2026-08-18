import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});
const adapter = loader.loadModule("@liveagent/adapters/imagePreview");

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

test("Gateway image save uses the file picker and silently accepts a picker cancellation", async () => {
  const writes = [];
  const events = [];
  const restore = installGlobals({
    window: {
      atob(value) {
        events.push("decode");
        return base64Atob(value);
      },
      showSaveFilePicker: async (options) => {
        events.push("picker");
        assert.deepEqual(options, {
          suggestedName: "chart.png",
          types: [
            {
              accept: { "image/png": [".png"] },
              description: "Image",
            },
          ],
        });
        return {
          createWritable: async () => ({
            async write(blob) {
              writes.push(blob);
            },
            async close() {
              writes.push("closed");
            },
          }),
        };
      },
    },
  });
  try {
    const writeImage = await adapter.prepareImagePreviewSave({
      fileName: "chart.png",
      mimeType: "image/png",
    });
    assert.equal(typeof writeImage, "function");
    assert.deepEqual(events, ["picker"]);
    await writeImage({
      dataBase64: "aGVsbG8=",
      fileName: "chart.png",
      mimeType: "image/png",
    });
    assert.deepEqual(events, ["picker", "decode"]);
    assert.equal(writes[0] instanceof Blob, true);
    assert.equal(writes[0].type, "image/png");
    assert.equal(writes[0].size, 5);
    assert.equal(writes[1], "closed");
  } finally {
    restore();
  }

  const restoreCancellation = installGlobals({
    window: {
      atob: base64Atob,
      showSaveFilePicker: async () => {
        throw new DOMException("cancelled", "AbortError");
      },
    },
  });
  try {
    await assert.doesNotReject(
      adapter.saveImagePreviewData({
        dataBase64: "aGVsbG8=",
        fileName: "chart.png",
        mimeType: "image/png",
      }),
    );
  } finally {
    restoreCancellation();
  }
});

test("Gateway image save falls back to a browser download anchor", async () => {
  const events = [];
  const anchor = {
    href: "",
    download: "",
    style: {},
    click() {
      events.push("click");
    },
    remove() {
      events.push("remove");
    },
  };
  const restore = installGlobals({
    window: {
      atob: base64Atob,
      setTimeout(callback) {
        callback();
        return 1;
      },
    },
    document: {
      body: {
        appendChild(node) {
          assert.equal(node, anchor);
          events.push("append");
        },
      },
      createElement(tagName) {
        assert.equal(tagName, "a");
        return anchor;
      },
    },
    URL: {
      createObjectURL(blob) {
        assert.equal(blob.type, "image/png");
        return "blob:download";
      },
      revokeObjectURL(url) {
        events.push(`revoke:${url}`);
      },
    },
  });
  try {
    await adapter.saveImagePreviewData({
      dataBase64: "aGVsbG8=",
      fileName: "chart.png",
      mimeType: "image/png",
    });
    assert.equal(anchor.href, "blob:download");
    assert.equal(anchor.download, "chart.png");
    assert.deepEqual(events, ["append", "click", "remove", "revoke:blob:download"]);
  } finally {
    restore();
  }
});

test("Gateway image copy writes a PNG ClipboardItem and reports unsupported browser APIs", async () => {
  const events = [];
  let clipboardItems;
  let resolveImageData;
  const imageBitmap = {
    width: 12,
    height: 8,
    close() {
      events.push("bitmap-closed");
    },
  };
  class TestClipboardItem {
    constructor(items) {
      this.items = items;
    }
  }
  const restore = installGlobals({
    window: { atob: base64Atob },
    navigator: {
      clipboard: {
        async write(items) {
          events.push("write");
          clipboardItems = items;
          await items[0].items["image/png"];
          events.push("written");
        },
      },
    },
    ClipboardItem: TestClipboardItem,
    createImageBitmap: async () => {
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
    const imageData = new Promise((resolve) => {
      resolveImageData = resolve;
    });
    const copying = adapter.copyImagePreviewData(imageData);

    assert.deepEqual(events, ["write"]);
    assert.equal(clipboardItems.length, 1);
    assert.equal(clipboardItems[0] instanceof TestClipboardItem, true);
    assert.equal(clipboardItems[0].items["image/png"] instanceof Promise, true);

    resolveImageData({ dataBase64: "aGVsbG8=", mimeType: "image/jpeg" });
    await copying;
    const png = await clipboardItems[0].items["image/png"];
    assert.equal(png.type, "image/png");
    assert.deepEqual(events, ["write", "decode", "draw", "bitmap-closed", "encode", "written"]);
  } finally {
    restore();
  }

  const restoreUnsupported = installGlobals({
    navigator: { clipboard: {} },
    ClipboardItem: undefined,
  });
  try {
    await assert.rejects(
      adapter.copyImagePreviewData({ dataBase64: "aGVsbG8=", mimeType: "image/png" }),
      /Image clipboard is unavailable/,
    );
    await assert.rejects(
      adapter.openUploadedImageInSystemViewer({ workdir: "/workspace", absolutePath: "/workspace/chart.png" }),
      /unavailable in WebUI/,
    );
    await assert.rejects(
      adapter.copyUploadedImagePreview({ workdir: "/workspace", absolutePath: "/workspace/chart.png" }),
      /unavailable in WebUI/,
    );
    await assert.doesNotReject(
      adapter.prepareUploadedImagePreviewCopy({
        workdir: "/workspace",
        absolutePath: "/workspace/chart.png",
      }),
    );
    assert.equal(adapter.supportsSystemImageOpen, false);
    assert.equal(adapter.supportsDirectUploadedImageCopy, false);
  } finally {
    restoreUnsupported();
  }
});
