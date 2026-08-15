import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const prefixCacheShape = loader.loadModule("src/lib/debug/prefixCacheShape.ts");

const { capturePrefixShape, comparePrefixShape } = prefixCacheShape;

function tool(name, description = `${name} description`, parameters = { type: "object" }) {
  return { name, description, parameters };
}

const BASE_TOOLS = [tool("Bash"), tool("Read"), tool("Write")];

// ---------------------------------------------------------------------------
// 确定性:同一输入永远得到同一哈希,观测手段自身不得抖动

test("同一输入重复计算得到相同哈希", () => {
  const first = capturePrefixShape({ systemPrompt: "system base", tools: BASE_TOOLS });
  const second = capturePrefixShape({ systemPrompt: "system base", tools: BASE_TOOLS });

  assert.deepEqual(first, second);
  assert.equal(typeof first.prefixHash, "string");
  assert.equal(first.prefixHash.length, 16);
  assert.equal(first.toolCount, 3);
});

test("缺省的 systemPrompt / tools 不会抛错,且与空值等价", () => {
  const empty = capturePrefixShape({});
  const explicit = capturePrefixShape({ systemPrompt: "", tools: [] });

  assert.deepEqual(empty, explicit);
  assert.equal(empty.toolCount, 0);
});

test("system 与 tools 的哈希互不串扰", () => {
  const base = capturePrefixShape({ systemPrompt: "a", tools: BASE_TOOLS });
  const systemChanged = capturePrefixShape({ systemPrompt: "b", tools: BASE_TOOLS });
  const toolsChanged = capturePrefixShape({
    systemPrompt: "a",
    tools: [...BASE_TOOLS, tool("Grep")],
  });

  assert.notEqual(base.systemHash, systemChanged.systemHash);
  assert.equal(base.toolsHash, systemChanged.toolsHash);

  assert.equal(base.systemHash, toolsChanged.systemHash);
  assert.notEqual(base.toolsHash, toolsChanged.toolsHash);
  assert.notEqual(base.prefixHash, toolsChanged.prefixHash);
});

// ---------------------------------------------------------------------------
// 排序归一:registry 迭代顺序变化不得造成假阳性

test("工具顺序打乱后哈希不变", () => {
  const ordered = capturePrefixShape({ systemPrompt: "system", tools: BASE_TOOLS });
  const shuffled = capturePrefixShape({
    systemPrompt: "system",
    tools: [BASE_TOOLS[2], BASE_TOOLS[0], BASE_TOOLS[1]],
  });

  assert.equal(ordered.toolsHash, shuffled.toolsHash);
  assert.equal(ordered.prefixHash, shuffled.prefixHash);
  assert.equal(comparePrefixShape(ordered, shuffled).prefixChangeSummary, "unchanged");
});

test("同名工具按 description / parameters 继续确定性排序", () => {
  const a = tool("Bash", "alpha", { type: "object", properties: { a: { type: "string" } } });
  const b = tool("Bash", "alpha", { type: "object", properties: { b: { type: "string" } } });
  const c = tool("Bash", "beta");

  const ordered = capturePrefixShape({ tools: [a, b, c] });
  const shuffled = capturePrefixShape({ tools: [c, b, a] });

  assert.equal(ordered.toolsHash, shuffled.toolsHash);
});

test("排序用 code-unit 字典序,不受 locale 影响", () => {
  // localeCompare 在多数 locale 下把 "a" 排在 "B" 前,code-unit 序则相反。
  // 这里断言的是「顺序无关性」:两种输入顺序必须收敛到同一哈希。
  const tools = [tool("apply_patch"), tool("Bash"), tool("agent"), tool("Read")];
  const forward = capturePrefixShape({ tools });
  const backward = capturePrefixShape({ tools: [...tools].reverse() });

  assert.equal(forward.toolsHash, backward.toolsHash);
});

test("工具描述变化会被检出,不因排序归一而丢失", () => {
  const before = capturePrefixShape({ tools: [tool("Bash", "old description")] });
  const after = capturePrefixShape({ tools: [tool("Bash", "new description")] });

  assert.notEqual(before.toolsHash, after.toolsHash);
  assert.equal(comparePrefixShape(before, after).prefixChangeSummary, "tools");
});

test("参数 schema 变化会被检出", () => {
  const before = capturePrefixShape({ tools: [tool("Bash", "d", { type: "object" })] });
  const after = capturePrefixShape({
    tools: [tool("Bash", "d", { type: "object", required: ["command"] })],
  });

  assert.notEqual(before.toolsHash, after.toolsHash);
});

// ---------------------------------------------------------------------------
// 归因:四种变化情况

test("仅 system 变 → system", () => {
  const previous = capturePrefixShape({ systemPrompt: "old", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "new", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "system");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system"]);
  assert.equal(diagnostics.prefixHash, current.prefixHash);
});

test("仅 tools 变 → tools", () => {
  const previous = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const current = capturePrefixShape({
    systemPrompt: "same",
    tools: [...BASE_TOOLS, tool("Grep")],
  });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "tools");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["tools"]);
  assert.equal(diagnostics.toolCount, 4);
});

test("两者都变 → both", () => {
  const previous = capturePrefixShape({ systemPrompt: "old", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "new", tools: [tool("Bash")] });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "both");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system", "tools"]);
});

test("均未变 → unchanged", () => {
  const previous = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, false);
  assert.equal(diagnostics.prefixChangeSummary, "unchanged");
  assert.deepEqual(diagnostics.prefixChangeReasons, []);
});

test("首轮无可比对象 → initial,且不报 changed", () => {
  const current = capturePrefixShape({ systemPrompt: "first", tools: BASE_TOOLS });

  for (const previous of [null, undefined]) {
    const diagnostics = comparePrefixShape(previous, current);
    assert.equal(diagnostics.prefixChanged, false);
    assert.equal(diagnostics.prefixChangeSummary, "initial");
    assert.deepEqual(diagnostics.prefixChangeReasons, []);
    assert.equal(diagnostics.systemHash, current.systemHash);
    assert.equal(diagnostics.toolsHash, current.toolsHash);
  }
});

// ---------------------------------------------------------------------------
// 逐轮对账:模拟 memory 段跨零点漂移这类真实场景

test("逐轮对账能定位到把前缀顶掉的那一轮", () => {
  const rounds = [
    { systemPrompt: "base\n\nmemory: today", tools: BASE_TOOLS },
    { systemPrompt: "base\n\nmemory: today", tools: BASE_TOOLS },
    // 跨零点:memory 段的天级标签漂移,system 前缀整体作废
    { systemPrompt: "base\n\nmemory: 1 days ago", tools: BASE_TOOLS },
    { systemPrompt: "base\n\nmemory: 1 days ago", tools: BASE_TOOLS },
  ];

  let previous = null;
  const summaries = rounds.map((round) => {
    const shape = capturePrefixShape(round);
    const diagnostics = comparePrefixShape(previous, shape);
    previous = shape;
    return diagnostics.prefixChangeSummary;
  });

  assert.deepEqual(summaries, ["initial", "unchanged", "system", "unchanged"]);
});

// ---------------------------------------------------------------------------
// 纯函数:无时间量、无随机量,且不改动入参

test("哈希不含时间量:跨时间重复计算结果一致", async () => {
  const shape = capturePrefixShape({ systemPrompt: "stable", tools: BASE_TOOLS });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const later = capturePrefixShape({ systemPrompt: "stable", tools: BASE_TOOLS });

  assert.deepEqual(shape, later);
});

test("capturePrefixShape 不改动传入的工具数组", () => {
  const tools = [tool("Write"), tool("Bash"), tool("Read")];
  const snapshot = tools.map((item) => item.name);
  capturePrefixShape({ systemPrompt: "system", tools });

  assert.deepEqual(
    tools.map((item) => item.name),
    snapshot,
  );
});

test("不可序列化的 parameters 不会让对账链路抛错", () => {
  const circular = { type: "object" };
  circular.self = circular;

  const shape = capturePrefixShape({ tools: [tool("Bash", "d", circular)] });
  assert.equal(typeof shape.toolsHash, "string");
  assert.equal(shape.toolsHash.length, 16);
});
