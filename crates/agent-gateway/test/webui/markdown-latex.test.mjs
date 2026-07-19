import assert from "node:assert/strict";
import test from "node:test";

import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const { normalizeLatexDelimiters } = loader.loadModule(
  "src/lib/normalizeLatexDelimiters.ts",
);

test("webui normalizes LaTeX delimiters with the mirrored parser", () => {
  const content = String.raw`\[
p_0 = p \cdot 10^{\frac{H}{18400(1+t/273)}}
\]

其中 \(p_0\) 是海平面气压。`;

  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`$$
p_0 = p \cdot 10^{\frac{H}{18400(1+t/273)}}
$$

其中 $$p_0$$ 是海平面气压。`,
  );
});

test("webui preserves code and supports an incomplete streaming formula", () => {
  const fenced = ["```latex", "\\[", "x", "\\]", "```"].join("\n");
  assert.equal(normalizeLatexDelimiters(fenced, true), fenced);
  assert.equal(normalizeLatexDelimiters(String.raw`\(x`, true), "$$x");
});

test("webui converts single-dollar math and keeps currency literal", () => {
  assert.equal(normalizeLatexDelimiters("质能方程 $E = mc^2$。"), "质能方程 $$E = mc^2$$。");

  const currency = "价格 $5，成本 $10。";
  assert.equal(normalizeLatexDelimiters(currency), currency);

  const streamingInline = "计算 $E = mc^";
  assert.equal(normalizeLatexDelimiters(streamingInline, true), streamingInline);
});
