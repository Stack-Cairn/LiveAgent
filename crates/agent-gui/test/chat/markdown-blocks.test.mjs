// parseChatMarkdownBlocks：脚注文档不再整体退化为单块——脚注首现位置之前
// 保持默认切分（块级 memo 有效），之后合并为一块（脚注引用与定义同树解析）。
// 红线：任何输入下 blocks.join("") === 原文；无脚注输入与默认切分器完全一致。
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownIntoBlocks } from "../../node_modules/streamdown/dist/index.js";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// streamdown 是 ESM-only，loader 的 CJS 解析不了；与 mermaid-theme 测试同款，
// 把真实模块作为 mock 注入（非仓真件）。
const loader = createTsModuleLoader({
  mocks: { streamdown: { __esModule: true, parseMarkdownIntoBlocks } },
});
const { parseChatMarkdownBlocks } = loader.loadModule("@liveagent/ui/lib/markdownBlocks.ts");

const PARA = (n) => `第 ${n} 段普通文字，用于验证块切分。\n\n`;

test("no footnote input matches the default splitter exactly", () => {
  const md = `${PARA(1)}\`\`\`ts\nconst x = 1;\n\`\`\`\n\n${PARA(2)}$$\nx^2\n$$\n\n${PARA(3)}`;
  assert.deepEqual(parseChatMarkdownBlocks(md), parseMarkdownIntoBlocks(md));
});

test("footnote document splits the prefix and merges only the suffix", () => {
  const prefix = PARA(1) + PARA(2) + PARA(3);
  const suffix = `带脚注的段落[^1]。\n\n${PARA(4)}[^1]: 脚注定义内容。\n`;
  const md = prefix + suffix;

  // 上游默认：整篇一块（退化路径）。
  assert.equal(parseMarkdownIntoBlocks(md).length, 1);

  const blocks = parseChatMarkdownBlocks(md);
  assert.ok(blocks.length > 2, "prefix must stay split into multiple blocks");
  assert.equal(blocks.join(""), md, "blocks must reassemble losslessly");
  const last = blocks[blocks.length - 1];
  assert.ok(last.includes("[^1]。") || last.includes("带脚注"), "reference stays in merged block");
  assert.ok(last.includes("[^1]: 脚注定义内容。"), "definition stays in merged block");
  for (const block of blocks.slice(0, -1)) {
    assert.doesNotMatch(block, /\[\^/, "prefix blocks must contain no footnote syntax");
  }
});

test("footnote at the very start degrades to a single block (same as upstream)", () => {
  const md = `开头就有脚注[^a]。\n\n${PARA(1)}[^a]: 定义。\n`;
  const blocks = parseChatMarkdownBlocks(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0], md);
});

test("lossless reassembly holds while streaming a growing footnote document", () => {
  const full = `${PARA(1)}引用[^x]与更多文字。\n\n${PARA(2)}$$\na+b\n$$\n\n[^x]: 定义文本。\n`;
  for (let end = 1; end <= full.length; end += 7) {
    const partial = full.slice(0, end);
    assert.equal(parseChatMarkdownBlocks(partial).join(""), partial, `lossless at ${end}`);
  }
});

test("unclosed $$ keeps upstream parity-merge semantics", () => {
  const md = `${PARA(1)}$$\nx = 1\n未闭合的数学块继续增长`;
  assert.deepEqual(parseChatMarkdownBlocks(md), parseMarkdownIntoBlocks(md));
});
