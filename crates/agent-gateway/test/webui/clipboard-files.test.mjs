import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const clipboard = loader.loadModule("src/lib/clipboardFiles.ts");

function createClipboardFile(name, content, type, lastModified) {
  return new File([content], name, { type, lastModified });
}

test("extractClipboardFiles does not double-read files exposed through clipboard items", () => {
  const directFile = createClipboardFile("", "image-bytes", "image/png", 100);
  const itemFile = createClipboardFile("", "image-bytes", "image/png", 101);

  const files = clipboard.extractClipboardFiles({
    files: [directFile],
    items: [
      {
        kind: "file",
        getAsFile: () => itemFile,
      },
    ],
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "clipboard-file-1.png");
  assert.equal(files[0].type, "image/png");
});

test("extractClipboardFiles falls back to clipboard items when files list is empty", () => {
  const itemFile = createClipboardFile("", "image-bytes", "image/png", 101);

  const files = clipboard.extractClipboardFiles({
    files: [],
    items: [
      {
        kind: "file",
        getAsFile: () => itemFile,
      },
    ],
  });

  assert.equal(files.length, 1);
  assert.equal(files[0].name, "clipboard-file-1.png");
});

test("both clipboard representations preserve files with identical metadata and distinct contents", async () => {
  const files = ["abcd", "wxyz"].map((content) =>
    createClipboardFile("notes.txt", content, "text/plain", 1000),
  );
  for (const data of [
    { files },
    { files: [], items: files.map((file) => ({ kind: "file", getAsFile: () => file })) },
  ]) {
    const result = clipboard.extractClipboardFiles(data);
    assert.deepEqual(await Promise.all(result.map((file) => file.text())), ["abcd", "wxyz"]);
  }
});
