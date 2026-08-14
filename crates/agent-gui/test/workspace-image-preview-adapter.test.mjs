import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTsModuleLoader } from "./helpers/load-ts-module.mjs";

const invokeCalls = [];
const loader = createTsModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command, args) {
        invokeCalls.push({ command, args });
        return Promise.resolve(command === "system_save_preview_file" ? false : undefined);
      },
    },
    "../components/MacOsTitleBarSpacer": { MacOsTitleBarSpacer: () => null },
    "../lib/system/clipboardText": { readClipboardText: async () => null },
  },
});

const preview = loader.loadModule("@liveagent/adapters/workspacePreview");

test("desktop workspace image actions preserve Tauri command payload names", async () => {
  invokeCalls.length = 0;

  await preview.saveWorkspacePreviewImage({
    data: "AQID",
    fileName: "diagram.png",
    mimeType: "image/png",
  });
  await preview.copyWorkspacePreviewImage({
    data: "AQID",
    mimeType: "image/png",
  });

  assert.deepEqual(invokeCalls, [
    {
      command: "system_save_preview_file",
      args: {
        data_base64: "AQID",
        file_name: "diagram.png",
        mime_type: "image/png",
      },
    },
    {
      command: "system_clipboard_write_image",
      args: {
        data_base64: "AQID",
        mime_type: "image/png",
      },
    },
  ]);
});
