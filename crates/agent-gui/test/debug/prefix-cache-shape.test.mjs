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
// 工具顺序:上线侧有序,诊断必须如实反映,不得靠排序掩盖

test("工具顺序变化会被检出 —— 顺序变化是真失效,不是假阳性", () => {
  // filterRequestTools 只过滤不重排,工具数组在请求体里是有序的。MCP server
  // 重连打乱 registry 顺序 → provider 前缀真的作废。诊断此时必须报出来。
  const ordered = capturePrefixShape({ systemPrompt: "system", tools: BASE_TOOLS });
  const shuffled = capturePrefixShape({
    systemPrompt: "system",
    tools: [BASE_TOOLS[2], BASE_TOOLS[0], BASE_TOOLS[1]],
  });

  assert.notEqual(ordered.toolsHash, shuffled.toolsHash);
  assert.equal(comparePrefixShape(ordered, shuffled).prefixChangeSummary, "tools");
});

test("同一顺序重复采样仍然稳定", () => {
  const tools = [tool("apply_patch"), tool("Bash"), tool("agent"), tool("Read")];
  const first = capturePrefixShape({ tools });
  const second = capturePrefixShape({ tools: [...tools] });

  assert.equal(first.toolsHash, second.toolsHash);
});

test("工具描述变化会被检出", () => {
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

test("constrainedSampling 变化会被检出 —— 与 parameters 同为请求体字节的一部分", () => {
  const base = capturePrefixShape({ tools: [tool("Bash")] });
  const withSampling = capturePrefixShape({
    tools: [{ ...tool("Bash"), constrainedSampling: { grammar: "shell" } }],
  });
  const changedSampling = capturePrefixShape({
    tools: [{ ...tool("Bash"), constrainedSampling: { grammar: "json" } }],
  });

  assert.notEqual(base.toolsHash, withSampling.toolsHash);
  assert.notEqual(withSampling.toolsHash, changedSampling.toolsHash);
  assert.equal(comparePrefixShape(base, withSampling).prefixChangeSummary, "tools");
});

test("constrainedSampling 缺省与 undefined 等价,不因字段缺失抖动", () => {
  const absent = capturePrefixShape({ tools: [tool("Bash")] });
  const explicitUndefined = capturePrefixShape({
    tools: [{ ...tool("Bash"), constrainedSampling: undefined }],
  });

  assert.deepEqual(absent, explicitUndefined);
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

test("多维同时变 → multiple", () => {
  const previous = capturePrefixShape({ systemPrompt: "old", tools: BASE_TOOLS });
  const current = capturePrefixShape({ systemPrompt: "new", tools: [tool("Bash")] });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "multiple");
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
    assert.equal(diagnostics.cacheControlHash, current.cacheControlHash);
  }
});

// ---------------------------------------------------------------------------
// 缓存参数维度:字节一模一样,但 TTL / 断点策略变了,缓存同样作废

test("TTL 翻转会被检出 —— system 与 tools 字节完全相同", () => {
  const base = { systemPrompt: "same", tools: BASE_TOOLS };
  const short = capturePrefixShape({
    ...base,
    cacheControl: { cacheRetention: "short", ttl: "", breakpointStrategy: "anthropic-top-level" },
  });
  const long = capturePrefixShape({
    ...base,
    cacheControl: { cacheRetention: "long", ttl: "1h", breakpointStrategy: "anthropic-top-level" },
  });

  // 前两维必须纹丝不动,否则这条断言证明不了「只有缓存参数变了」。
  assert.equal(short.systemHash, long.systemHash);
  assert.equal(short.toolsHash, long.toolsHash);
  assert.notEqual(short.cacheControlHash, long.cacheControlHash);

  const diagnostics = comparePrefixShape(short, long);
  assert.equal(diagnostics.prefixChanged, true);
  assert.equal(diagnostics.prefixChangeSummary, "cacheControl");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["cacheControl"]);
});

test("断点策略在 top-level 与 explicit 之间切换会被检出", () => {
  const topLevel = capturePrefixShape({
    systemPrompt: "same",
    cacheControl: { cacheRetention: "short", ttl: "", breakpointStrategy: "anthropic-top-level" },
  });
  const explicit = capturePrefixShape({
    systemPrompt: "same",
    cacheControl: { cacheRetention: "short", ttl: "", breakpointStrategy: "anthropic-explicit" },
  });

  assert.equal(comparePrefixShape(topLevel, explicit).prefixChangeSummary, "cacheControl");
});

test("缺省 cacheControl 与逐字段空串等价,不因 undefined 抖动", () => {
  const omitted = capturePrefixShape({ systemPrompt: "same", tools: BASE_TOOLS });
  const empty = capturePrefixShape({
    systemPrompt: "same",
    tools: BASE_TOOLS,
    cacheControl: { cacheRetention: "", ttl: "", breakpointStrategy: "" },
  });

  assert.deepEqual(omitted, empty);
  assert.equal(comparePrefixShape(omitted, empty).prefixChangeSummary, "unchanged");
});

test("同一份缓存参数重复采样保持稳定", () => {
  const cacheControl = {
    cacheRetention: "long",
    ttl: "1h",
    breakpointStrategy: "anthropic-top-level",
  };
  const first = capturePrefixShape({ systemPrompt: "s", cacheControl });
  const second = capturePrefixShape({ systemPrompt: "s", cacheControl: { ...cacheControl } });

  assert.deepEqual(first, second);
});

test("三维同时变 → multiple,且原因按 system / tools / cacheControl 顺序列出", () => {
  const previous = capturePrefixShape({
    systemPrompt: "old",
    tools: BASE_TOOLS,
    cacheControl: { cacheRetention: "short", breakpointStrategy: "anthropic-top-level" },
  });
  const current = capturePrefixShape({
    systemPrompt: "new",
    tools: [tool("Bash")],
    cacheControl: { cacheRetention: "long", ttl: "1h", breakpointStrategy: "anthropic-explicit" },
  });
  const diagnostics = comparePrefixShape(previous, current);

  assert.equal(diagnostics.prefixChangeSummary, "multiple");
  assert.deepEqual(diagnostics.prefixChangeReasons, ["system", "tools", "cacheControl"]);
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

// ---------------------------------------------------------------------------
// 快照存储:按 sessionId 隔离,多会话交错不得互相污染基线

const prefixShapeStore = loader.loadModule("src/lib/debug/prefixShapeStore.ts");
const { readPreviousPrefixShape, recordPrefixShape } = prefixShapeStore;

test("多会话交错写入互不污染:各自读回各自的上一轮快照", () => {
  const shapeA = capturePrefixShape({ systemPrompt: "session-a", tools: BASE_TOOLS });
  const shapeB = capturePrefixShape({ systemPrompt: "session-b", tools: BASE_TOOLS });

  // 模拟主会话与子代理交错:A 写 → B 写 → A 读,A 不能拿到 B 的快照。
  recordPrefixShape("store-session-a", shapeA);
  recordPrefixShape("store-session-b", shapeB);

  assert.deepEqual(readPreviousPrefixShape("store-session-a"), shapeA);
  assert.deepEqual(readPreviousPrefixShape("store-session-b"), shapeB);

  // 交错下 A 的下一轮归因必须是 unchanged,而不是被 B 顶掉后误报 system 变更。
  const nextA = capturePrefixShape({ systemPrompt: "session-a", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(readPreviousPrefixShape("store-session-a"), nextA);
  assert.equal(diagnostics.prefixChangeSummary, "unchanged");
});

test("快照跨读取存续:同一会话先后两次读取拿到同一份基线", () => {
  const shape = capturePrefixShape({ systemPrompt: "persist", tools: BASE_TOOLS });
  recordPrefixShape("store-session-persist", shape);

  assert.deepEqual(readPreviousPrefixShape("store-session-persist"), shape);
  assert.deepEqual(readPreviousPrefixShape("store-session-persist"), shape);
});

test("未知会话读回 null,归因回到 initial 而不是报 changed", () => {
  assert.equal(readPreviousPrefixShape("store-session-unknown"), null);

  const shape = capturePrefixShape({ systemPrompt: "fresh", tools: BASE_TOOLS });
  const diagnostics = comparePrefixShape(readPreviousPrefixShape("store-session-unknown"), shape);
  assert.equal(diagnostics.prefixChangeSummary, "initial");
  assert.equal(diagnostics.prefixChanged, false);
});

test("sessionId 缺失时退化为单槽,与旧局部变量语义等价", () => {
  const first = capturePrefixShape({ systemPrompt: "anon-1", tools: BASE_TOOLS });
  const second = capturePrefixShape({ systemPrompt: "anon-2", tools: BASE_TOOLS });

  recordPrefixShape(undefined, first);
  assert.deepEqual(readPreviousPrefixShape(undefined), first);
  // 空白串与缺失同口径。
  recordPrefixShape("   ", second);
  assert.deepEqual(readPreviousPrefixShape(""), second);
});

test("LRU 上限淘汰最久未触碰的会话,活跃会话存活", () => {
  const shape = capturePrefixShape({ systemPrompt: "evict", tools: BASE_TOOLS });
  recordPrefixShape("store-evict-victim", shape);

  // 压入远超上限(32)的会话数,再回读最早写入的那个:应已被淘汰。
  for (let index = 0; index < 40; index += 1) {
    recordPrefixShape(`store-evict-filler-${index}`, shape);
  }

  assert.equal(readPreviousPrefixShape("store-evict-victim"), null);
  // 最近写入的仍在。
  assert.deepEqual(readPreviousPrefixShape("store-evict-filler-39"), shape);
});
