import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { estimateAssistantRowHeight, estimateUserRowHeight, measureEstimateText } =
  loader.loadModule("@liveagent/ui/lib/transcript-virtual/rowEstimates.ts");

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

test("measureEstimateText caps visible lines independently for every fence", () => {
  const firstFence = Array.from({ length: 40 }, (_, index) => `first ${index + 1}`);
  const secondFence = Array.from({ length: 30 }, (_, index) => `second ${index + 1}`);
  const text = ["```ts", ...firstFence, "```", "between", "```sh", ...secondFence, "```"].join(
    "\n",
  );

  assert.deepEqual(measureEstimateText(text), {
    proseChars: "between".length + 1,
    codeLines: 48,
    codeFences: 2,
  });
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

test("a collapsed long fence estimates only its 24-line plain-text preview", () => {
  const text = ["```ts", ...Array.from({ length: 300 }, (_, index) => `line ${index + 1}`), "```"].join(
    "\n",
  );
  const measured = measureEstimateText(text);
  assert.deepEqual(measured, { proseChars: 0, codeLines: 24, codeFences: 1 });

  const estimate = estimateAssistantRowHeight({
    ...measured,
    toolCount: 0,
    thinkingCount: 0,
  });
  assert.ok(estimate >= 600 && estimate < 1000, `unexpected preview estimate: ${estimate}`);
});

test("user estimates include attachments and stay bounded", () => {
  assert.ok(estimateUserRowHeight(60, 2) > estimateUserRowHeight(60, 0));
  assert.equal(estimateUserRowHeight(100_000, 10), 600);
  assert.equal(estimateUserRowHeight(0, 0), 80);
});
