import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const uploadedFiles = loader.loadModule("@liveagent/ui/lib/chat/uploadedFiles.ts");

const {
  buildUserMessageContentWithUploads,
  parseUserMessageContentWithUploads,
  UPLOADED_FILES_INSTRUCTION_HEADER_LINES,
} = uploadedFiles;

const WORKSPACE = "C:\\work\\project";
const STAGING = "C:\\Users\\AlphaCat\\.liveagent\\uploads";

function stagedFile(batch, name, kind, sizeBytes) {
  return {
    relativePath: `uploads/${batch}/${name}`,
    absolutePath: `${STAGING}\\${batch}\\${name}`,
    fileName: name,
    kind,
    sizeBytes,
  };
}

function workspaceFile(relativePath, kind, sizeBytes) {
  return {
    relativePath,
    absolutePath: `${WORKSPACE}\\${relativePath.replace(/\//g, "\\")}`,
    fileName: relativePath.split("/").pop(),
    kind,
    sizeBytes,
  };
}

test("round-trips a staged image back into display text and attachment metadata", () => {
  const file = stagedFile("1791367333797", "08-34-44.png", "image", 257 * 1024);
  const content = buildUserMessageContentWithUploads("告诉我截图里面有什么", [file]);

  const parsed = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.displayText, "告诉我截图里面有什么");
  assert.deepEqual(parsed.attachments, [file]);
});

test("restores workspace-relative and staged relativePaths from absolute paths", () => {
  const inside = workspaceFile("src/App.tsx", "text", 2048);
  const staged = stagedFile("42", "report.pdf", "pdf", 1.5 * 1024 * 1024);
  const content = buildUserMessageContentWithUploads("看看这两个", [inside, staged]);

  const { attachments } = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.deepEqual(
    attachments.map((file) => file.relativePath),
    ["src/App.tsx", "uploads/42/report.pdf"],
  );
  assert.deepEqual(
    attachments.map((file) => file.fileName),
    ["App.tsx", "report.pdf"],
  );
  assert.deepEqual(
    attachments.map((file) => file.kind),
    ["text", "pdf"],
  );
  assert.deepEqual(
    attachments.map((file) => file.sizeBytes),
    [2048, Math.round(1.5 * 1024 * 1024)],
  );
});

test("restores the staged relativePath even without a cwd", () => {
  const file = stagedFile("7", "notes.txt", "text", 12);
  const content = buildUserMessageContentWithUploads("读一下", [file]);

  const parsed = parseUserMessageContentWithUploads(content);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.attachments[0].relativePath, "uploads/7/notes.txt");
});

test("keeps paths that are neither in the cwd nor recently staged", () => {
  const external = {
    relativePath: "D:/elsewhere/spec.docx",
    absolutePath: "D:\\elsewhere\\spec.docx",
    fileName: "spec.docx",
    kind: "word",
    sizeBytes: 4096,
  };
  const content = buildUserMessageContentWithUploads("读这个", [external]);

  const parsed = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.attachments[0].relativePath, "D:/elsewhere/spec.docx");
});

test("restores an empty text body from the placeholder line", () => {
  const file = stagedFile("5", "diagram.png", "image", 3 * 1024);
  const content = buildUserMessageContentWithUploads("   ", [file]);

  const parsed = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.displayText, "");
});

test("round-trips a large paste chip reference", () => {
  const paste = stagedFile("9", "pasted-1.txt", "text", 64 * 1024);
  const content = buildUserMessageContentWithUploads(
    "看看这段 [Pasted text 1: uploads/9/pasted-1.txt] 有什么问题",
    [paste],
  );

  const parsed = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.equal(
    parsed.displayText,
    "看看这段 [Pasted text 1: uploads/9/pasted-1.txt] 有什么问题",
  );
  assert.equal(parsed.attachments[0].relativePath, "uploads/9/pasted-1.txt");
});

test("accepts the legacy instruction header and lines without a size", () => {
  const legacyContent = [
    "hello there",
    ...UPLOADED_FILES_INSTRUCTION_HEADER_LINES.slice(0, 2),
    `- ${WORKSPACE}\\src\\App.tsx (text)`,
  ].join("\n");

  const parsed = parseUserMessageContentWithUploads(legacyContent, WORKSPACE);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.displayText, "hello there");
  assert.deepEqual(parsed.attachments, [
    {
      relativePath: "src/App.tsx",
      absolutePath: `${WORKSPACE}\\src\\App.tsx`,
      fileName: "App.tsx",
      kind: "text",
      sizeBytes: 0,
    },
  ]);
});

test("accepts the legacy header text that predates the paging hint", () => {
  const legacyContent = [
    "hello there",
    "The user attached the files below to this message.",
    "Use Read with these exact paths before analyzing or modifying them:",
    `- ${WORKSPACE}\\src\\App.tsx (text, 2 KB)`,
  ].join("\n");

  const parsed = parseUserMessageContentWithUploads(legacyContent, WORKSPACE);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.displayText, "hello there");
  assert.equal(parsed.attachments.length, 1);
  assert.equal(parsed.attachments[0].kind, "text");
});

test("keeps a path containing parentheses intact", () => {
  const file = {
    relativePath: "uploads/3/scan (1).pdf",
    absolutePath: `${STAGING}\\3\\scan (1).pdf`,
    fileName: "scan (1).pdf",
    kind: "pdf",
    sizeBytes: 257 * 1024,
  };
  const content = buildUserMessageContentWithUploads("读这个", [file]);

  const parsed = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.equal(parsed.parsed, true);
  assert.equal(parsed.attachments[0].absolutePath, `${STAGING}\\3\\scan (1).pdf`);
  assert.equal(parsed.attachments[0].fileName, "scan (1).pdf");
  assert.equal(parsed.attachments[0].sizeBytes, 257 * 1024);
});

test("leaves the message untouched when an attachment line cannot be parsed", () => {
  const brokenLines = [
    "hello there",
    ...UPLOADED_FILES_INSTRUCTION_HEADER_LINES,
    `- ${WORKSPACE}\\src\\App.tsx (text, 2 KB)`,
    "- this line is not a valid attachment entry",
  ];

  const parsed = parseUserMessageContentWithUploads(brokenLines.join("\n"), WORKSPACE);

  assert.equal(parsed.parsed, false);
  assert.deepEqual(parsed.attachments, []);
  assert.equal(parsed.displayText, brokenLines.join("\n"));
});

test("leaves ordinary user text untouched", () => {
  const parsed = parseUserMessageContentWithUploads("just a normal message", WORKSPACE);

  assert.equal(parsed.parsed, false);
  assert.deepEqual(parsed.attachments, []);
  assert.equal(parsed.displayText, "just a normal message");
});

test("does not treat a hand-written header without attachment lines as an instruction", () => {
  const content = [...UPLOADED_FILES_INSTRUCTION_HEADER_LINES, "no entries here"].join("\n");

  const parsed = parseUserMessageContentWithUploads(content, WORKSPACE);

  assert.equal(parsed.parsed, false);
});

test("survives a second round-trip through the rebuilt display text", () => {
  const file = stagedFile("11", "chart.png", "image", 257 * 1024);
  const first = parseUserMessageContentWithUploads(
    buildUserMessageContentWithUploads("画了什么", [file]),
    WORKSPACE,
  );

  const rebuilt = buildUserMessageContentWithUploads(first.displayText, first.attachments);
  const second = parseUserMessageContentWithUploads(rebuilt, WORKSPACE);

  assert.equal(second.parsed, true);
  assert.equal(second.displayText, "画了什么");
  assert.deepEqual(second.attachments, [file]);
});
