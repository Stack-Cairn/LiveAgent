import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  decodeChatFileLinkPayload,
  encodeChatFileLink,
  parseChatFileLink,
} = loader.loadModule("src/lib/chat/messages/chatFileLinks.ts");

const validCases = [
  ["C:/work/src/a.ts", { path: "C:/work/src/a.ts", source: "absolute" }],
  [String.raw`C:\work\src\a.ts`, { path: "C:/work/src/a.ts", source: "absolute" }],
  [String.raw`C:\\project\\file.ts`, { path: "C:/project/file.ts", source: "absolute" }],
  ["D:/other/a.ts", { path: "D:/other/a.ts", source: "absolute" }],
  ["C:/work/src/a.ts:12", { path: "C:/work/src/a.ts", line: 12, source: "absolute" }],
  [
    "C:/work/src/a.ts:12:4",
    { path: "C:/work/src/a.ts", line: 12, column: 4, source: "absolute" },
  ],
  ["C:/work/src/a.ts#L12", { path: "C:/work/src/a.ts", line: 12, source: "absolute" }],
  [
    "C:/work/src/a.ts#L12-L20",
    { path: "C:/work/src/a.ts", line: 12, endLine: 20, source: "absolute" },
  ],
  ["C:/path with spaces/a.ts", { path: "C:/path with spaces/a.ts", source: "absolute" }],
  ["C:/path%20with%20spaces/a.ts", { path: "C:/path with spaces/a.ts", source: "absolute" }],
  ["C:/路径/文件.ts", { path: "C:/路径/文件.ts", source: "absolute" }],
  [
    "file:///C:/work/a.ts",
    { path: "C:/work/a.ts", source: "file-url" },
  ],
  [
    "file:///C:/path%20with%20spaces/%E6%96%87%E4%BB%B6.ts#L7-L9",
    {
      path: "C:/path with spaces/文件.ts",
      line: 7,
      endLine: 9,
      source: "file-url",
    },
  ],
  ["/home/user/work/a.ts", { path: "/home/user/work/a.ts", source: "absolute" }],
  ["./src/a.ts", { path: "./src/a.ts", source: "relative" }],
  ["../src/a.ts:3:2", { path: "../src/a.ts", line: 3, column: 2, source: "relative" }],
  ["src/a.ts", { path: "src/a.ts", source: "relative" }],
  ["README.md", { path: "README.md", source: "relative" }],
  [
    String.raw`\\server\share\folder\a.ts:8`,
    { path: "//server/share/folder/a.ts", line: 8, source: "absolute" },
  ],
  [
    "file://server/share/folder/a.ts#L4",
    { path: "//server/share/folder/a.ts", line: 4, source: "file-url" },
  ],
];

test("parseChatFileLink supports the cross-platform chat path matrix", () => {
  for (const [input, expected] of validCases) {
    assert.deepEqual(parseChatFileLink(input), expected, input);
  }
});

test("parseChatFileLink rejects external, dangerous, internal, and malformed targets", () => {
  for (const input of [
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "https://example.com/a.ts",
    "http://example.com/a.ts",
    "mailto:user@example.com",
    "liveagent-file:path=C%3A%2Fa.ts&source=absolute",
    "C:drive-relative.txt",
    "C:/work/a.ts:4294967296",
    "file:///C:/work/a.ts#L999999999999999999999999",
    "#L12",
    "",
  ]) {
    assert.equal(parseChatFileLink(input), null, input);
  }

  assert.doesNotThrow(() => parseChatFileLink("file:///%E0%A4%A"));
});

test("the internal payload codec preserves locations and rejects malformed payloads", () => {
  const original = {
    path: "C:/路径/a file.ts",
    line: 12,
    endLine: 20,
    column: 4,
    source: "absolute",
  };
  const encoded = encodeChatFileLink(original);
  assert.match(encoded, /^liveagent-file:/);
  assert.deepEqual(
    decodeChatFileLinkPayload(encoded.slice("liveagent-file:".length)),
    original,
  );

  for (const payload of [
    "path=&source=absolute",
    "v=1&path=&source=absolute",
    "v=1&path=C%3A%2Fa.ts&source=unknown",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=0",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=-1",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=abc",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=4294967296",
    "v=1&path=C%3A%2Fa.ts&source=absolute&line=20&endLine=12",
    "v=1&path=C%3A%2Fa.ts&path=D%3A%2Fb.ts&source=absolute",
    "v=1&path=C%3A%2Fa.ts&source=absolute&extra=true",
  ]) {
    assert.equal(decodeChatFileLinkPayload(payload), null, payload);
  }
});
