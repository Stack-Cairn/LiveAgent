// StreamingSplitMarkdown 的边界推进逻辑：流式长文切「冻结前缀 + 活跃尾巴」。
// 正确性红线：任意时刻 segments.join("") + tail === 原文；代码围栏/数学块
// 永不跨实例；新实例首行必须是普通段落文本（间距由容器 [&>div+div] 补齐）。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { advanceBoundary, createSplitState } = loader.loadModule(
  "@liveagent/ui/lib/chat/streamingSplit.ts",
);

function reassemble(state, text) {
  return state.segments.join("") + text.slice(state.boundary);
}

function streamInto(state, full, step = 1024) {
  for (let end = step; end < full.length; end += step) {
    advanceBoundary(state, full.slice(0, end));
  }
  advanceBoundary(state, full);
}

test("prose stream splits into frozen segments and a bounded tail", () => {
  const paragraph = "这是一段说明文字，用来模拟模型的正常回答输出。\n\n";
  const full = paragraph.repeat(2000); // ~100KB+
  const state = createSplitState();
  streamInto(state, full);
  assert.ok(state.segments.length > 3, "expected multiple frozen segments");
  assert.ok(full.length - state.boundary < 16_000, "tail must stay bounded");
  assert.equal(reassemble(state, full), full, "no characters lost or duplicated");
});

test("code fences never span across a boundary", () => {
  const prose = "普通段落文字。\n\n";
  const fence = "```ts\nconst value = 1;\nconsole.log(value);\n```\n\n";
  const full = (prose + fence).repeat(600);
  const state = createSplitState();
  streamInto(state, full);
  assert.equal(reassemble(state, full), full);
  for (const segment of state.segments) {
    const count = segment.split("```").length - 1;
    assert.equal(count % 2, 0, "segment must contain balanced fences");
  }
});

test("boundaries only open on plain paragraph text", () => {
  const mixed =
    "文字段落甲。\n\n- 列表项 1\n- 列表项 2\n\n# 标题\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$\nx^2\n$$\n\n文字段落乙。\n\n";
  const full = mixed.repeat(400);
  const state = createSplitState();
  streamInto(state, full);
  assert.equal(reassemble(state, full), full);
  assert.ok(state.segments.length > 0, "mixed content must still find boundaries");
  for (let index = 1; index < state.segments.length; index += 1) {
    assert.match(
      state.segments[index][0],
      /[^\-*+>=#|`$\s]/,
      "segment must start with plain text",
    );
  }
});

test("no safe boundary means no split (single unbroken fence)", () => {
  const full = `\`\`\`ts\n${"const line = 1;\n".repeat(4000)}`;
  const state = createSplitState();
  streamInto(state, full);
  assert.equal(state.segments.length, 0, "an unclosed fence must never split");
  assert.equal(state.boundary, 0);
});

test("advance is idempotent for identical text (StrictMode double render)", () => {
  const full = "段落内容示例文本。\n\n".repeat(3000);
  const state = createSplitState();
  streamInto(state, full);
  const boundary = state.boundary;
  const segmentCount = state.segments.length;
  advanceBoundary(state, full);
  assert.equal(state.boundary, boundary);
  assert.equal(state.segments.length, segmentCount);
});

test("footnote syntax disables splitting and unfreezes earlier segments", () => {
  const paragraph = "普通段落文字，用来撑长度。\n\n";
  const prefix = paragraph.repeat(1500); // 已经切出若干冻结段
  const state = createSplitState();
  streamInto(state, prefix);
  assert.ok(state.segments.length > 1, "precondition: segments frozen");
  // 引用在早已冻结的前缀里不可能出现（否则已 latch）；这里模拟引用出现在尾部、
  // 定义稍后到达——两者都必须落在同一个 Streamdown 实例里。
  const withRef = `${prefix}见注释[^1]。\n\n`;
  advanceBoundary(state, withRef);
  assert.equal(state.segments.length, 0, "must unfreeze every segment");
  assert.equal(state.boundary, 0);
  const withDef = `${withRef}${paragraph.repeat(1500)}[^1]: 注释正文。\n`;
  advanceBoundary(state, withDef);
  assert.equal(state.segments.length, 0, "never splits again");
  assert.equal(reassemble(state, withDef), withDef);
});

test("reference-style link definition disables splitting", () => {
  const paragraph = "普通段落文字，用来撑长度。\n\n";
  const full = `参考[文档][docs]。\n\n${paragraph.repeat(1500)}[docs]: https://example.com\n`;
  const state = createSplitState();
  streamInto(state, full);
  assert.equal(state.segments.length, 0);
  assert.equal(state.boundary, 0);
});

test("a definition marker split across two flushes is still detected", () => {
  const paragraph = "普通段落文字，用来撑长度。\n\n";
  const state = createSplitState();
  const head = `${paragraph.repeat(1500)}[docs]`;
  streamInto(state, head);
  assert.ok(state.segments.length > 1, "precondition: `[docs]` alone is a plain bracket");
  advanceBoundary(state, `${head}: https://example.com\n`);
  assert.equal(state.segments.length, 0, "the completed `[docs]: ` must latch");
});

test("plain brackets and inline links never trip the document-wide guard", () => {
  const paragraph = "数组写作 [1, 2, 3]，链接写作 [示例](https://example.com)。\n\n";
  const full = paragraph.repeat(2000);
  const state = createSplitState();
  streamInto(state, full);
  assert.ok(state.segments.length > 3, "ordinary brackets must still split");
});
