import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const {
  FILE_UPLOAD_CONVERSATION_ATTRIBUTE,
  FILE_UPLOAD_DROP_ZONE_SELECTOR,
  resolveFileUploadConversationId,
  resolveFileUploadDropZone,
} = loader.loadModule("src/app/hooks/fileUploadDropRouting.ts");

function targetInside(zone) {
  return {
    closest(selector) {
      assert.equal(selector, FILE_UPLOAD_DROP_ZONE_SELECTOR);
      return zone;
    },
  };
}

test("file upload routing resolves the landing Pane conversation", () => {
  const zone = {
    getAttribute(attribute) {
      assert.equal(attribute, FILE_UPLOAD_CONVERSATION_ATTRIBUTE);
      return "  background-conversation  ";
    },
  };
  const target = targetInside(zone);

  assert.equal(resolveFileUploadDropZone(target), zone);
  assert.equal(resolveFileUploadConversationId(target), "background-conversation");
});

test("file upload routing does not invent ownership outside a marked composer", () => {
  assert.equal(resolveFileUploadConversationId(targetInside(null)), null);
  assert.equal(resolveFileUploadConversationId({}), null);
  assert.equal(
    resolveFileUploadConversationId(
      targetInside({
        getAttribute() {
          return "   ";
        },
      }),
    ),
    null,
  );
});

test("paste and drop freeze the landing target before asynchronous file reads", () => {
  const source = readFileSync(
    fileURLToPath(new URL("../src/app/hooks/usePendingUploads.ts", import.meta.url)),
    "utf8",
  );

  assert.match(
    source,
    /const uploadTarget = resolveEventUploadTarget\(event\.target\);[\s\S]*?readClipboardFiles\(\)[\s\S]*?handleImportReadableFiles\(files, uploadTarget\)/,
  );
  assert.match(
    source,
    /const uploadTarget = resolveEventUploadTarget\(event\.target\);[\s\S]*?snapshotDroppedEntries\(event\.dataTransfer\)[\s\S]*?handleImportReadableFiles\(payload\.files, uploadTarget\)/,
  );
  assert.match(source, /handleImportReadableFiles\(files, uploadTarget\)/);
});
