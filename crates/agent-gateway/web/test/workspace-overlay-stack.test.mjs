import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { workspaceOverlayStackClassName } = loader.loadModule(
  "@liveagent/adapters/workspacePreview",
);
const preview = loader.loadModule("@liveagent/adapters/workspacePreview");

function restoreGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
}

function restorePropertyDescriptor(name, descriptor) {
  if (descriptor === undefined) delete globalThis[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

test("web workspace overlays keep the web shell stacking level", () => {
  assert.equal(workspaceOverlayStackClassName, "z-40");
});

test("web workspace image save uses the native picker and keeps source bytes", async () => {
  const previousWindow = globalThis.window;
  const writes = [];
  let pickerOptions = null;
  globalThis.window = {
    atob,
    async showSaveFilePicker(options) {
      pickerOptions = options;
      return {
        async createWritable() {
          return {
            async write(blob) {
              writes.push(blob);
            },
            async close() {},
          };
        },
      };
    },
  };

  try {
    await preview.saveWorkspacePreviewImage({
      data: "AQID",
      fileName: "diagram.png",
      mimeType: "image/png",
    });
    assert.equal(pickerOptions.suggestedName, "diagram.png");
    assert.deepEqual(pickerOptions.types, [{ accept: { "image/png": [".png"] }, description: "Image" }]);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].type, "image/png");
    assert.deepEqual([...new Uint8Array(await writes[0].arrayBuffer())], [1, 2, 3]);
  } finally {
    restoreGlobal("window", previousWindow);
  }
});

test("web workspace image save treats picker cancellation as a no-op", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {
    atob,
    async showSaveFilePicker() {
      throw new DOMException("cancelled", "AbortError");
    },
  };

  try {
    await preview.saveWorkspacePreviewImage({
      data: "AQID",
      fileName: "diagram.png",
      mimeType: "image/png",
    });
  } finally {
    restoreGlobal("window", previousWindow);
  }
});

test("web workspace image save falls back to a browser download", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const originalCreateObjectUrl = URL.createObjectURL;
  const originalRevokeObjectUrl = URL.revokeObjectURL;
  const downloads = [];
  const revokedUrls = [];
  URL.createObjectURL = () => "blob:workspace-preview";
  URL.revokeObjectURL = (url) => revokedUrls.push(url);
  globalThis.window = {
    atob,
    setTimeout(callback) {
      callback();
      return 1;
    },
  };
  globalThis.document = {
    body: {
      appendChild() {},
    },
    createElement(tag) {
      assert.equal(tag, "a");
      return {
        style: {},
        click() {
          downloads.push({ href: this.href, download: this.download });
        },
        remove() {},
      };
    },
  };

  try {
    await preview.saveWorkspacePreviewImage({
      data: "AQID",
      fileName: "diagram.png",
      mimeType: "image/png",
    });
    assert.deepEqual(downloads, [{ href: "blob:workspace-preview", download: "diagram.png" }]);
    assert.deepEqual(revokedUrls, ["blob:workspace-preview"]);
  } finally {
    URL.createObjectURL = originalCreateObjectUrl;
    URL.revokeObjectURL = originalRevokeObjectUrl;
    restoreGlobal("window", previousWindow);
    restoreGlobal("document", previousDocument);
  }
});

test("web workspace image copy writes a PNG clipboard item", async () => {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const previousCreateImageBitmap = globalThis.createImageBitmap;
  const previousClipboardItem = globalThis.ClipboardItem;
  const clipboardWrites = [];
  let closed = false;
  globalThis.window = { atob };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      clipboard: {
        async write(items) {
          clipboardWrites.push(items);
        },
      },
    },
  });
  globalThis.createImageBitmap = async () => ({
    width: 2,
    height: 3,
    close() {
      closed = true;
    },
  });
  globalThis.ClipboardItem = class ClipboardItem {
    constructor(items) {
      this.items = items;
    }
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return {
        width: 0,
        height: 0,
        getContext() {
          return { drawImage() {} };
        },
        toBlob(callback, type) {
          callback(new Blob(["png"], { type }));
        },
      };
    },
  };

  try {
    await preview.copyWorkspacePreviewImage({ data: "AQID", mimeType: "image/png" });
    assert.equal(closed, true);
    assert.equal(clipboardWrites.length, 1);
    const item = clipboardWrites[0][0];
    assert.equal(item.items["image/png"].type, "image/png");
  } finally {
    restoreGlobal("window", previousWindow);
    restoreGlobal("document", previousDocument);
    restorePropertyDescriptor("navigator", previousNavigator);
    restoreGlobal("createImageBitmap", previousCreateImageBitmap);
    restoreGlobal("ClipboardItem", previousClipboardItem);
  }
});
