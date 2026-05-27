import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const upload = loader.loadModule("src/lib/uploadReadableFiles.ts");

function installWindow() {
  globalThis.window = {
    location: { origin: "https://gateway.example" },
  };
}

function createNamedBlob(name, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  Object.defineProperty(blob, "name", {
    value: name,
    configurable: true,
  });
  return blob;
}

test("importReadableFiles validates token and workdir before network calls", async () => {
  installWindow();
  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error("unexpected fetch");
  };

  await assert.rejects(
    () => upload.importReadableFiles(" ", "/workspace", [createNamedBlob("a.txt", "a")]),
    /Gateway token is required/,
  );
  await assert.rejects(
    () => upload.importReadableFiles("token", " ", [createNamedBlob("a.txt", "a")]),
    /项目目录未选择，无法导入文件。/,
  );
  assert.deepEqual(await upload.importReadableFiles("token", "/workspace", []), {
    files: [],
    skipped: [],
  });
  assert.equal(fetchCalled, false);
});

test("importReadableFiles posts multipart form and normalizes response files", async () => {
  installWindow();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: true,
      async json() {
        return {
          files: [
            {
              relativePath: "uploads/a.txt",
              absolutePath: " /workspace/uploads/a.txt ",
              fileName: "a.txt",
              kind: "text",
              sizeBytes: 12,
            },
            {
              relativePath: "",
              fileName: "bad.bin",
              kind: "binary",
              sizeBytes: 9,
            },
            {
              relativePath: "uploads/report.docx",
              fileName: "report.docx",
              kind: "word",
              sizeBytes: 34,
            },
            {
              relativePath: "uploads/screenshot.webp",
              fileName: "screenshot.webp",
              kind: "image",
              sizeBytes: 45,
            },
            {
              relativePath: "uploads/report.pdf",
              fileName: "report.pdf",
              kind: "pdf",
              sizeBytes: 67,
            },
            {
              relativePath: "uploads/workbook.xlsx",
              fileName: "workbook.xlsx",
              kind: "spreadsheet",
              sizeBytes: 56,
            },
            {
              relativePath: "uploads/assets.zip",
              fileName: "assets.zip",
              kind: "archive",
              sizeBytes: 78,
            },
          ],
          skipped: ["ignored.bin", 42],
        };
      },
    };
  };

  const result = await upload.importReadableFiles(" token ", " /workspace ", [
    createNamedBlob("a.txt", "hello"),
    createNamedBlob("b.txt", "world"),
  ]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://gateway.example/api/files/import");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Bearer token");
  assert.ok(requests[0].init.body instanceof FormData);
  assert.equal(requests[0].init.body.get("workdir"), "/workspace");
  const uploadedParts = requests[0].init.body.getAll("files");
  assert.equal(uploadedParts.length, 2);
  assert.equal(uploadedParts[0].name, "a.txt");
  assert.equal(uploadedParts[1].name, "b.txt");
  assert.deepEqual(result, {
    files: [
      {
        relativePath: "uploads/a.txt",
        absolutePath: "/workspace/uploads/a.txt",
        fileName: "a.txt",
        kind: "text",
        sizeBytes: 12,
      },
      {
        relativePath: "uploads/report.docx",
        absolutePath: undefined,
        fileName: "report.docx",
        kind: "word",
        sizeBytes: 34,
      },
      {
        relativePath: "uploads/screenshot.webp",
        absolutePath: undefined,
        fileName: "screenshot.webp",
        kind: "image",
        sizeBytes: 45,
      },
      {
        relativePath: "uploads/report.pdf",
        absolutePath: undefined,
        fileName: "report.pdf",
        kind: "pdf",
        sizeBytes: 67,
      },
      {
        relativePath: "uploads/workbook.xlsx",
        absolutePath: undefined,
        fileName: "workbook.xlsx",
        kind: "spreadsheet",
        sizeBytes: 56,
      },
      {
        relativePath: "uploads/assets.zip",
        absolutePath: undefined,
        fileName: "assets.zip",
        kind: "archive",
        sizeBytes: 78,
      },
    ],
    skipped: ["ignored.bin"],
  });
});

test("importReadableFiles surfaces gateway error payloads", async () => {
  installWindow();
  globalThis.fetch = async () => ({
    ok: false,
    async text() {
      return JSON.stringify({ error: "agent offline" });
    },
  });

  await assert.rejects(
    () => upload.importReadableFiles("token", "/workspace", [createNamedBlob("a.txt", "a")]),
    /agent offline/,
  );
});
