import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
});

const { estimateAssistantRowHeight, estimateUserRowHeight, measureEstimateText } =
  loader.loadModule("src/lib/transcript-virtual/rowEstimates.ts");

test("measureEstimateText splits prose from fenced code", () => {
  const text = ["intro line", "```ts", "const a = 1;", "const b = 2;", "```", "outro"].join("\n");
  assert.deepEqual(measureEstimateText(text), {
    proseChars: "intro line".length + 1 + "outro".length + 1,
    codeLines: 2,
    codeFences: 1,
  });
});

test("measureEstimateText fast-paths fence-free text", () => {
  assert.deepEqual(measureEstimateText("plain prose"), {
    proseChars: 11,
    codeLines: 0,
    codeFences: 0,
  });
});

test("measureEstimateText tolerates an unclosed fence", () => {
  const text = ["```", "line 1", "line 2"].join("\n");
  assert.deepEqual(measureEstimateText(text), { proseChars: 0, codeLines: 2, codeFences: 1 });
});

test("assistant estimates grow monotonically with content", () => {
  const base = { proseChars: 200, codeLines: 0, codeFences: 0, toolCount: 0, thinkingCount: 0 };
  const withCode = estimateAssistantRowHeight({ ...base, codeLines: 40, codeFences: 1 });
  const withoutCode = estimateAssistantRowHeight(base);
  assert.ok(withCode > withoutCode, "code lines raise the estimate");
  assert.ok(
    estimateAssistantRowHeight({ ...base, toolCount: 4 }) > withoutCode,
    "tool headers raise the estimate",
  );
  assert.ok(
    estimateAssistantRowHeight({ ...base, proseChars: 4000 }) > withoutCode,
    "prose raises the estimate",
  );
});

test("assistant estimates respect the clamp bounds", () => {
  assert.equal(
    estimateAssistantRowHeight({
      proseChars: 0,
      codeLines: 0,
      codeFences: 0,
      toolCount: 0,
      thinkingCount: 0,
    }),
    92,
  );
  assert.equal(
    estimateAssistantRowHeight({
      proseChars: 1_000_000,
      codeLines: 100_000,
      codeFences: 50,
      toolCount: 100,
      thinkingCount: 100,
    }),
    6000,
  );
});

test("a long code block is no longer capped into a blank-flash under-estimate", () => {
  // 300 code lines render at thousands of px; the old model capped at 1600.
  const estimate = estimateAssistantRowHeight({
    proseChars: 100,
    codeLines: 300,
    codeFences: 1,
    toolCount: 0,
    thinkingCount: 0,
  });
  assert.ok(estimate >= 6000, `estimate ${estimate} should hit the generous cap`);
});

test("user estimates include attachments and stay bounded", () => {
  assert.ok(estimateUserRowHeight(60, 2) > estimateUserRowHeight(60, 0));
  assert.equal(estimateUserRowHeight(100_000, 10), 600);
  assert.equal(estimateUserRowHeight(0, 0), 80);
});
