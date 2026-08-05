import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { normalizeLatexDelimiters } = loader.loadModule(
  "src/lib/normalizeLatexDelimiters.ts",
);

test("normalizes LaTeX display and inline delimiters for Streamdown math", () => {
  const content = String.raw`2. 拉普拉斯形式

\[
H = 18400(1 + \frac{t}{273})\log_{10}\frac{p_0}{p}
\]

其中 \(p_0\) 是海平面气压。`;

  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`2. 拉普拉斯形式

$$
H = 18400(1 + \frac{t}{273})\log_{10}\frac{p_0}{p}
$$

其中 $$p_0$$ 是海平面气压。`,
  );
});

test("preserves existing dollar math and escaped LaTeX delimiters", () => {
  const content = String.raw`已有 $$x^2$$，字面量 \\(x\\) 和 \\[x\\]。`;
  assert.equal(normalizeLatexDelimiters(content), content);
});

test("does not normalize delimiters inside Markdown or HTML code", () => {
  const content = [
    "正文 \\(x\\)。",
    "",
    "`inline \\(x\\)`",
    "",
    "```latex",
    "\\[",
    "x",
    "\\]",
    "```",
    "",
    "~~~text",
    "\\(x\\)",
    "~~~",
    "",
    "<code>\\(x\\)</code>",
    "<pre>\\[",
    "x",
    "\\]</pre>",
  ].join("\n");

  const expected = [
    "正文 $$x$$。",
    "",
    "`inline \\(x\\)`",
    "",
    "```latex",
    "\\[",
    "x",
    "\\]",
    "```",
    "",
    "~~~text",
    "\\(x\\)",
    "~~~",
    "",
    "<code>\\(x\\)</code>",
    "<pre>\\[",
    "x",
    "\\]</pre>",
  ].join("\n");

  assert.equal(normalizeLatexDelimiters(content), expected);
});

test("preserves fenced code nested in blockquotes and lists", () => {
  const content = [
    "> ```latex",
    "> \\[",
    "> x",
    "> \\]",
    "> ```",
    "",
    "- ```latex",
    "  \\(",
    "  x",
    "  \\)",
    "  ```",
  ].join("\n");

  assert.equal(normalizeLatexDelimiters(content, true), content);
});

test("keeps incomplete delimiters static and enables streaming completion", () => {
  const content = String.raw`推导中：\[
H = 18400`;
  assert.equal(normalizeLatexDelimiters(content), content);
  assert.equal(normalizeLatexDelimiters(content, true), String.raw`推导中：$$
H = 18400`);
});

test("converts single-dollar inline math to double-dollar", () => {
  const content = String.raw`质能方程 $E = mc^2$，求根公式 $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$。`;
  assert.equal(
    normalizeLatexDelimiters(content),
    String.raw`质能方程 $$E = mc^2$$，求根公式 $$x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$$。`,
  );
});

test("keeps currency, shell variables, and escaped dollars literal", () => {
  const currency = "价格 $5，成本 $10。总共 $15 元。";
  assert.equal(normalizeLatexDelimiters(currency), currency);

  const shell = "检查 $PATH 和 $HOME 是否已导出。";
  assert.equal(normalizeLatexDelimiters(shell), shell);

  const escaped = String.raw`费用 \$5 和 \$10。`;
  assert.equal(normalizeLatexDelimiters(escaped), escaped);

  const digitAfterClose = "单价 $3$5 促销。";
  assert.equal(normalizeLatexDelimiters(digitAfterClose), digitAfterClose);
});

test("single-dollar math must close on the same line", () => {
  const content = "起价 $99\n次日 $x$ 恢复原价。";
  assert.equal(normalizeLatexDelimiters(content), "起价 $99\n次日 $$x$$ 恢复原价。");
});

test("mixed currency and math on one line converts only the math pair", () => {
  const content = "价格 $5，令 $x$ 表示价格。";
  assert.equal(normalizeLatexDelimiters(content), "价格 $5，令 $$x$$ 表示价格。");
});

test("existing double-dollar spans stay opaque next to single-dollar math", () => {
  assert.equal(normalizeLatexDelimiters("已有 $$x^2$$ 与 $y$。"), "已有 $$x^2$$ 与 $$y$$。");
});

test("streaming leaves unterminated dollar math untouched", () => {
  const inline = "计算 $E = mc^";
  assert.equal(normalizeLatexDelimiters(inline, true), inline);

  const display = "$$\nE = mc^2";
  assert.equal(normalizeLatexDelimiters(display, true), display);
});

test("does not convert dollars inside code spans or fences", () => {
  const content = [
    "行内 `sum $a$ b` 保留，公式 $c$ 转换。",
    "",
    "```sh",
    "echo $HOME $USER",
    "```",
  ].join("\n");
  const expected = [
    "行内 `sum $a$ b` 保留，公式 $$c$$ 转换。",
    "",
    "```sh",
    "echo $HOME $USER",
    "```",
  ].join("\n");
  assert.equal(normalizeLatexDelimiters(content), expected);
});
