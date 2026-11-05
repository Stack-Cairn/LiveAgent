// createStreamingBlockParser: incremental block split for an append-only
// streaming text. Red line: for every prefix of the stream, the raw blocks equal
// a full parse of that prefix, and only the last block is repaired.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMarkdownIntoBlocks } from "../../node_modules/streamdown/dist/index.js";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// remend is ESM-only; load the real module and inject it like streamdown.
const { default: remend } = await import("../../../agent-ui/node_modules/remend/dist/index.js");

const loader = createTsModuleLoader({
  mocks: {
    streamdown: { __esModule: true, parseMarkdownIntoBlocks },
    remend: { __esModule: true, default: remend },
  },
});
const { createStreamingBlockParser } = loader.loadModule(
  "@liveagent/ui/lib/streamingMarkdownBlocks.ts",
);
const { parseChatMarkdownBlocks } = loader.loadModule("@liveagent/ui/lib/markdownBlocks.ts");

const identity = (text) => text;

const CORPUS = {
  mixed: [
    "# Streaming reply\n\nSome **bold** text, `inline code` and a [link](https://example.com).\n",
    "## Section\n\n- first item\n- second item\n  - nested item\n  - nested again\n\n",
    "```ts\nexport function step(input: number[]): number {\n  let total = 0;\n\n  for (const value of input) total += value;\n  return total;\n}\n```\n\n",
    "| Metric | Before | After |\n| --- | ---: | ---: |\n| p50 | 20 | 12 |\n| p95 | 80 | 40 |\n\n",
    "> A quote that\ncontinues lazily on the next line.\n\n",
    "The cost is $T(n) = O(n \\log n)$ and\n\n$$\nE[X] = \\sum_k p_k x_k\n\n+ 1\n$$\n\nDone.\n",
  ].join(""),
  lists: [
    "1. First step\n\n   with a continuation paragraph.\n\n2. Second step\n\n",
    "   ```bash\n   pnpm test\n   ```\n\n3. Third step\n- a dash list right after\n\n",
    "* loose\n\n* list\n\n  indented continuation\n\nAfter the list.\n",
  ].join(""),
  setext: "Title line\n==========\n\nParagraph that becomes a heading\n---\n\nText\n\n---\n\nAfter a rule.\n",
  footnotes: "Intro paragraph.\n\nClaim with a note[^1] and more.\n\nMiddle paragraph.\n\n[^1]: The note text.\n\nTail paragraph.\n",
  html: "<details>\n<summary>More</summary>\n\nHidden **content** here.\n\n</details>\n\nAfter html.\n",
  cjk: "第一段中文内容，包含**加粗**和`代码`。\n\n第二段：\n\n- 列表一\n- 列表二\n\n```python\nprint('你好')\n```\n",
  fences: "~~~\nouter ``` still code\n\nmore\n~~~\n\n````md\n```js\nnested\n```\n````\n\nEnd.\n",
};

function* chunks(text, seed) {
  let state = seed;
  let index = 0;
  while (index < text.length) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const size = 1 + (state % 9);
    index = Math.min(text.length, index + size);
    yield text.slice(0, index);
  }
}

for (const [name, text] of Object.entries(CORPUS)) {
  test(`raw blocks match a full parse at every prefix: ${name}`, () => {
    for (const seed of [1, 7, 42]) {
      const parse = createStreamingBlockParser(parseChatMarkdownBlocks, identity);
      for (const prefix of chunks(text, seed)) {
        assert.deepEqual(parse(prefix), parseChatMarkdownBlocks(prefix), `prefix ${prefix.length}`);
      }
    }
  });
}

test("only the last block is repaired", () => {
  const parse = createStreamingBlockParser(parseChatMarkdownBlocks, remend);
  const text = "First **bold** paragraph.\n\nSecond paragraph.\n\nThird with **unfinished";
  const blocks = parse(text);
  const raw = parseChatMarkdownBlocks(text);
  assert.deepEqual(blocks.slice(0, -1), raw.slice(0, -1));
  assert.equal(blocks.at(-1), remend(raw.at(-1)));
  assert.match(blocks.at(-1), /\*\*unfinished\*\*$/);
});

test("finished blocks are lexed once, not on every update", () => {
  let lexed = 0;
  const counting = (markdown) => {
    lexed += markdown.length;
    return parseChatMarkdownBlocks(markdown);
  };
  const parse = createStreamingBlockParser(counting, identity);
  const paragraph = (index) => `Paragraph ${index} with enough words to look like prose.\n\n`;
  let text = "";
  for (let index = 0; index < 200; index += 1) {
    text += paragraph(index);
    parse(text);
  }
  const full = text.length;
  // A full re-lex per update would cost ~full * 100 characters.
  assert.ok(lexed < full * 5, `lexed ${lexed} chars for a ${full} char stream`);
});

test("a non-append update (tail moved into a frozen segment) parses from scratch", () => {
  const parse = createStreamingBlockParser(parseChatMarkdownBlocks, identity);
  parse("one\n\ntwo\n\nthree\n\nfour\n\nfive");
  const next = "four\n\nfive and more";
  assert.deepEqual(parse(next), parseChatMarkdownBlocks(next));
});
