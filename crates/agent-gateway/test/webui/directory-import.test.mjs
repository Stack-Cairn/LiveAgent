import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const directoryDrop = loader.loadModule("src/lib/directoryDrop.ts");
const uploadDirectory = loader.loadModule("src/lib/uploadDirectory.ts");

function installWindow() {
  globalThis.window = {
    location: { origin: "https://gateway.example" },
  };
}

function createNamedBlob(name, content) {
  const blob = new Blob([content], { type: "text/plain" });
  Object.defineProperty(blob, "name", { value: name, configurable: true });
  return blob;
}

test("directory collection excludes generated trees but preserves project dot paths", () => {
  assert.equal(directoryDrop.isExcludedDirectoryName(".git"), true);
  assert.equal(directoryDrop.isExcludedDirectoryName("node_modules"), true);
  assert.equal(directoryDrop.isExcludedDirectoryName(".github"), false);
  assert.equal(directoryDrop.isExcludedFileName(".DS_Store"), true);
  assert.equal(directoryDrop.isExcludedFileName(".env"), false);
  assert.equal(directoryDrop.isExcludedFileName(".gitignore"), false);
});

test("directory upload preserves dot paths in the multipart manifest", async () => {
  installWindow();
  let request;
  globalThis.fetch = async (url, init) => {
    request = { url, init };
    return {
      ok: true,
      async json() {
        return { rootPath: "/imports/demo", fileCount: 2, skipped: [] };
      },
    };
  };

  await uploadDirectory.importDirectory("token", "agent", {
    name: "demo",
    target: "workspace",
    files: [
      { relativePath: ".env", file: createNamedBlob(".env", "TOKEN=secret") },
      {
        relativePath: ".github/workflows/ci.yml",
        file: createNamedBlob("ci.yml", "name: CI"),
      },
    ],
  });

  assert.equal(request.url, "https://gateway.example/api/files/import-directory?agent_id=agent");
  assert.deepEqual(request.init.body.getAll("paths"), [".env", ".github/workflows/ci.yml"]);
});

test("directory upload rejects content above the shared 200 MiB limit before fetch", async () => {
  installWindow();
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };
  const oversizedFile = {
    name: "large.bin",
    size: directoryDrop.MAX_DIRECTORY_UPLOAD_BYTES + 1,
  };

  await assert.rejects(
    () =>
      uploadDirectory.importDirectory("token", "agent", {
        name: "demo",
        target: "workspace",
        files: [{ relativePath: "large.bin", file: oversizedFile }],
      }),
    /TOO_LARGE/,
  );
  assert.equal(fetchCalled, false);
});
