// createThrottledCodePlugin：有界 LRU + 流式增长块节流的 shiki 包装。
// 红线：终态（节流窗口后的最后一次调用）必然经 callback 得到精确 tokens；
// 精确缓存命中不再触底层；LRU 有上限。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

function createFakeBase() {
  const calls = [];
  return {
    calls,
    plugin: {
      name: "shiki",
      type: "code-highlighter",
      supportsLanguage: () => true,
      getSupportedLanguages: () => ["ts"],
      getThemes: () => ["github-light", "github-dark"],
      highlight(options, callback) {
        calls.push(options.code);
        // 模拟上游异步 tokenize：微任务后回调
        const result = { tokens: [[{ content: options.code }]], fg: "", bg: "" };
        queueMicrotask(() => callback?.(result));
        return null;
      },
    },
  };
}

// 模块顶层会用默认 base 创建单例，mock 需提供最小可用的 code 插件。
const noopBase = {
  name: "shiki",
  type: "code-highlighter",
  supportsLanguage: () => true,
  getSupportedLanguages: () => [],
  getThemes: () => ["github-light", "github-dark"],
  highlight: () => null,
};
const loader = createTsModuleLoader({
  mocks: { "@streamdown/code": { __esModule: true, code: noopBase } },
});
const { createThrottledCodePlugin } = loader.loadModule(
  "@liveagent/ui/lib/markdownCodeHighlight.ts",
);

const OPTS = (code) => ({ code, language: "ts", themes: ["github-light", "github-dark"] });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("first sight forwards immediately; repeats hit the exact cache", async () => {
  const base = createFakeBase();
  const plugin = createThrottledCodePlugin(base.plugin);
  let delivered = null;
  plugin.highlight(OPTS("const a = 1;"), (result) => {
    delivered = result;
  });
  await tick();
  assert.equal(base.calls.length, 1);
  assert.ok(delivered, "callback must deliver tokens");
  // 同内容重复调用：命中精确缓存，底层不再被触发
  const cached = plugin.highlight(OPTS("const a = 1;"));
  assert.ok(cached);
  assert.equal(base.calls.length, 1);
});

test("a growing block is throttled but the final content always lands", async () => {
  const base = createFakeBase();
  const plugin = createThrottledCodePlugin(base.plugin);
  const head = "function demo() {\n";
  let latest = null;
  const record = (result) => {
    latest = result;
  };
  // 模拟流式:同一块(相同前缀)快速增长 30 个版本
  for (let step = 1; step <= 30; step += 1) {
    plugin.highlight(OPTS(head + "x".repeat(step)), record);
  }
  await tick();
  // 节流窗口内只允许首个版本转发
  assert.equal(base.calls.length, 1, "mid-window growth must not re-tokenize");
  await sleep(350);
  // trailing 定时器必须把最后版本转发并回调
  assert.equal(base.calls.length, 2, "trailing run must fire once");
  assert.equal(base.calls[1], head + "x".repeat(30), "trailing run must use the newest content");
  await tick();
  assert.ok(JSON.stringify(latest).includes("x".repeat(30)), "final tokens delivered");
});

test("theme switch is a new identity and forwards immediately", async () => {
  const base = createFakeBase();
  const plugin = createThrottledCodePlugin(base.plugin);
  plugin.highlight(OPTS("const b = 2;"));
  plugin.highlight({ code: "const b = 2;x", language: "ts", themes: ["night-owl", "night-owl"] });
  await tick();
  assert.equal(base.calls.length, 2, "different themes must not share a throttle window");
});

test("sibling blocks sharing the first line never borrow each other's tokens", async () => {
  const base = createFakeBase();
  const plugin = createThrottledCodePlugin(base.plugin);
  const json = (code) => ({ code, language: "json", themes: ["github-light", "github-dark"] });
  const A = '{\n "a": 1\n}';
  const B = '{\n "b": 2\n}';
  const C = '{\n "c": 3\n}';
  const got = { A: null, B: null, C: null };
  got.A = plugin.highlight(json(A), (result) => {
    got.A = result;
  });
  await tick();
  // A 已转发；B、C 与 A 首行相同（同一 identity 槽位），却不是 A 的增长
  got.B = plugin.highlight(json(B), (result) => {
    got.B = result;
  });
  got.C = plugin.highlight(json(C), (result) => {
    got.C = result;
  });
  await tick();
  assert.equal(base.calls.length, 3, "unrelated blocks must forward, not throttle");
  assert.equal(got.A.tokens[0][0].content, A);
  assert.equal(got.B.tokens[0][0].content, B, "B must never show A's tokens");
  assert.equal(got.C.tokens[0][0].content, C);
});

test("a queued trailing run is not lost when a sibling block displaces it", async () => {
  const base = createFakeBase();
  const plugin = createThrottledCodePlugin(base.plugin);
  const json = (code) => ({ code, language: "json", themes: ["github-light", "github-dark"] });
  let latestA = null;
  plugin.highlight(json('{\n "a"'), (result) => {
    latestA = result;
  });
  await tick();
  // A 在节流窗口内继续增长：进入 pending
  const grownA = '{\n "a": 1\n}';
  plugin.highlight(json(grownA), (result) => {
    latestA = result;
  });
  // 兄弟块 B 到来：立即转发 B，同时把 A 的 pending 一起转发而非丢弃
  let latestB = null;
  plugin.highlight(json('{\n "b": 2\n}'), (result) => {
    latestB = result;
  });
  await tick();
  assert.equal(latestA.tokens[0][0].content, grownA, "A's newest content must land");
  assert.equal(latestB.tokens[0][0].content, '{\n "b": 2\n}');
  await sleep(350);
  assert.equal(base.calls.length, 3, "no stray trailing run after displacement");
});
