import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
import {
  commonPrefixLength,
  flattenAnthropicPayload,
  runCacheSimulation,
} from "../helpers/prompt-cache-sim.mjs";

const loader = createTsModuleLoader();
const providers = loader.loadModule("src/lib/providers/runtime/payloadPipeline.ts");

// ---------------------------------------------------------------------------
// 会话构造:一段稳定前缀 + 逐轮追加的历史。这是缓存友好写法的标准形状。

const SYSTEM_PROMPT = `You are LiveAgent, a local-first AI agent.
${"Follow the workspace conventions carefully. ".repeat(40)}`;

const TOOLS = [
  { name: "Bash", description: "Run a shell command", input_schema: { type: "object" } },
  { name: "Read", description: "Read a file from disk", input_schema: { type: "object" } },
  { name: "Write", description: "Write a file to disk", input_schema: { type: "object" } },
];

/** 第 n 轮的消息列表:前 n-1 轮的历史原样保留,只在尾部追加。 */
function buildMessages(turnCount, { mutateHistory = false, perTurnRepeat = 30 } = {}) {
  const messages = [];
  for (let turn = 1; turn <= turnCount; turn += 1) {
    const suffix = mutateHistory ? ` (rendered at turn ${turnCount})` : "";
    messages.push({
      role: "user",
      content: [
        { type: "text", text: `User request number ${turn}.${suffix} ${"detail ".repeat(perTurnRepeat)}` },
      ],
    });
    if (turn < turnCount) {
      messages.push({
        role: "assistant",
        content: [
          { type: "text", text: `Assistant reply number ${turn}. ${"answer ".repeat(perTurnRepeat)}` },
        ],
      });
    }
  }
  return messages;
}

/** 把一轮请求跑过真实的 payload 中间件链,拿到实际会上线的请求体。 */
async function runPipeline(payload, { baseUrl, cacheRetention = "short" }) {
  const options = providers.finalizeProviderStreamOptions({
    providerId: "claude_code",
    baseUrl,
    options: { cacheRetention },
  });
  const model = { api: "anthropic-messages", provider: "anthropic", id: "claude-sonnet-4-6" };
  return options.onPayload ? await options.onPayload(payload, model) : payload;
}

/**
 * 复刻 pi-ai 上游 buildParams 撒断点的位置,作为对照组。
 *
 * 证据(本机装的 0.80.10 dist):
 *   anthropic-messages.js:715 system 身份块 / :722 systemPrompt 块
 *   anthropic-messages.js:996 tools 最后一个(index === tools.length - 1)
 *   anthropic-messages.js:962 最后一条 user message 的最后一个 block
 * 这里只复刻**断点位置**,不复刻其余请求体细节 —— 本文件比较的就是断点分布。
 */
function applyUpstreamBreakpoints(payload) {
  const cacheControl = { type: "ephemeral" };
  const system = (payload.system ?? []).map((block, index, all) =>
    index === all.length - 1 || index === 0 ? { ...block, cache_control: cacheControl } : block,
  );
  const tools = (payload.tools ?? []).map((tool, index, all) =>
    index === all.length - 1 ? { ...tool, cache_control: cacheControl } : tool,
  );
  const messages = (payload.messages ?? []).map((message, index, all) => {
    if (index !== all.length - 1 || message.role !== "user") return message;
    const content = message.content.map((block, blockIndex, blocks) =>
      blockIndex === blocks.length - 1 ? { ...block, cache_control: cacheControl } : block,
    );
    return { ...message, content };
  });
  return { ...payload, system, tools, messages };
}

function buildBasePayload(turnCount, options = {}) {
  return {
    system: [{ type: "text", text: SYSTEM_PROMPT }],
    tools: TOOLS,
    messages: buildMessages(turnCount, options),
  };
}

async function buildConversation({
  turns = 5,
  baseUrl,
  cacheRetention = "short",
  mutateHistory = false,
  transform,
}) {
  const payloads = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const base = buildBasePayload(turn, { mutateHistory });
    const shaped = transform ? transform(base) : await runPipeline(base, { baseUrl, cacheRetention });
    payloads.push(shaped);
  }
  return payloads;
}

async function simulateConversation(options) {
  return runCacheSimulation(await buildConversation(options), { model: "anthropic" });
}

/**
 * 前缀稳定性断言 —— 借鉴 grok-build 的做法(`xai-chat-state` 的 actor 测试):
 * 不去猜命中率该是多少,只断言「第 n 轮上线的字节序列是第 n+1 轮的前缀」,
 * 一旦不是,就报出**第一个分叉的字节位置**并把上下文打印出来。
 *
 * 这比阈值断言强在两点:一是无阈值可调,不存在把数字调好看的空间;二是失败时
 * 直接给出归因位置,而不是只告诉你「命中率掉了」。追加式会话本该满足这个性质,
 * 任何违反都意味着我们在请求体里塞了非确定性内容(时间戳、随机 id、重排的
 * 工具列表),那才是真正会毁掉缓存的东西。
 */
function assertPrefixStable(payloads) {
  const flattened = payloads.map(flattenAnthropicPayload);
  for (let index = 1; index < flattened.length; index += 1) {
    const previous = flattened[index - 1].text;
    const current = flattened[index].text;
    const shared = commonPrefixLength(previous, current);
    if (shared === previous.length) continue;

    assert.fail(
      `第 ${index} 轮与第 ${index + 1} 轮在第 ${shared} 字节处分叉(上一轮总长 ${previous.length})\n` +
        `  上一轮: ${JSON.stringify(previous.slice(shared, shared + 60))}\n` +
        `  本一轮: ${JSON.stringify(current.slice(shared, shared + 60))}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 模拟器自身的自检。标尺不先校准,后面所有数字都不可信。

test("模拟器:完全相同的两轮请求命中全部前缀", () => {
  const payload = applyUpstreamBreakpoints(buildBasePayload(3));
  const result = runCacheSimulation([payload, payload], { model: "anthropic" });

  assert.equal(result.rounds[0].hit, 0, "首轮没有可比对象,必然全 miss");
  assert.equal(result.rounds[1].hit, result.rounds[1].total, "第二轮应命中全部");
  assert.equal(result.steadyStateHitRate, 1);
});

test("模拟器:首字节变动让命中归零", () => {
  const first = applyUpstreamBreakpoints(buildBasePayload(3));
  const second = applyUpstreamBreakpoints({
    ...buildBasePayload(3),
    system: [{ type: "text", text: `X${SYSTEM_PROMPT}` }],
  });
  const result = runCacheSimulation([first, second], { model: "anthropic" });

  assert.equal(result.rounds[1].hit, 0, "system 首字节变了,后面全部作废");
});

test("模拟器:没有任何断点时命中恒为 0", () => {
  const payload = buildBasePayload(3); // 未施加任何 cache_control
  const result = runCacheSimulation([payload, payload], { model: "anthropic" });

  assert.equal(result.rounds[1].breakpointCount, 0);
  assert.equal(result.rounds[1].hit, 0, "Anthropic 不会缓存没有断点的请求");
});

// ---------------------------------------------------------------------------
// 上线路径的真实回归。这些跑的是 finalizeProviderStreamOptions,不是复刻品。
//
// 关于「99% 命中率」这个目标,先把话说清楚,否则下面的阈值会被误读:
//
// 纯追加会话的稳态命中率有一个纯数学上限 —— 第 n 轮最多只能命中第 n-1 轮的
// 全量,本轮新增的内容上一轮根本不存在。展开即
//     steady_max = Σ(n=2..N) T_{n-1} / Σ(n=2..N) T_n
// 代入实测:要让它 ≥ 99%,需要 base/delta ≈ 74x(50 轮)到 98x(3 轮)。真实
// coding agent 的形状(system+tools 40K 字符、每轮增量 2K)上限只有 95.7%~96.8%;
// 就算工具表撑到 80K,也只到 98.0%。
//
// 也就是说:**绝对命中率主要由会话形状决定,而不是由我们的实现决定**。同一份
// 代码,把 system prompt 调大就能把数字刷到 99% —— 那测的是 fixture,不是代码。
// 所以这里断言两件与形状无关的事:
//   1. efficiency(实际命中 ÷ 理论上限)== 100%,即没有漏掉任何本可命中的字节;
//   2. 字节级前缀稳定性,即我们没有往请求体里塞进非确定性内容。
// 真实的百分比数字用 benchmark 去量(见 PR #489),不用单测去锁。

test("官方域名:追加式会话吃满理论上限,一个可命中的字节都没漏", async () => {
  const payloads = await buildConversation({
    turns: 5,
    baseUrl: "https://api.anthropic.com/v1",
    cacheRetention: "long",
  });
  assertPrefixStable(payloads);

  const result = runCacheSimulation(payloads, { model: "anthropic" });
  assert.equal(
    result.efficiency,
    1,
    `efficiency ${(result.efficiency * 100).toFixed(2)}% —— 有本可命中的前缀没被断点覆盖`,
  );
});

test("第三方代理:显式断点路径同样吃满理论上限", async () => {
  const payloads = await buildConversation({
    turns: 5,
    baseUrl: "https://proxy.example.com/anthropic",
    cacheRetention: "short",
  });
  assertPrefixStable(payloads);

  const result = runCacheSimulation(payloads, { model: "anthropic" });
  assert.equal(
    result.efficiency,
    1,
    `efficiency ${(result.efficiency * 100).toFixed(2)}% —— 代理路径漏掉了可命中前缀`,
  );
});

test("高 base/低增量的会话形状确实能到 99% —— 证明上限公式与模拟器一致", async () => {
  // 把 system prompt 撑大、每轮增量压小,即 base/delta 比拉高。这是「99%」真正
  // 的来源:会话形状,不是断点策略。放在这里是为了让上面那段说明可被验证,
  // 而不是留一句无法复核的断言。
  const payloads = [];
  const bigSystem = `You are LiveAgent.\n${"Follow the workspace conventions carefully. ".repeat(600)}`;
  for (let turn = 1; turn <= 10; turn += 1) {
    const base = {
      system: [{ type: "text", text: bigSystem }],
      tools: TOOLS,
      messages: buildMessages(turn, { perTurnRepeat: 10 }),
    };
    payloads.push(await runPipeline(base, { baseUrl: "https://api.anthropic.com/v1" }));
  }

  const result = runCacheSimulation(payloads, { model: "anthropic" });
  assert.equal(result.efficiency, 1, "同样必须吃满上限");
  assert.ok(
    result.steadyStateHitRate >= 0.99,
    `稳态命中率 ${(result.steadyStateHitRate * 100).toFixed(2)}%,未达 99%`,
  );
});

test("改写历史消息会把命中率打穿 —— 这是回归的护栏,不是缺陷", async () => {
  const clean = await simulateConversation({
    turns: 5,
    baseUrl: "https://api.anthropic.com/v1",
  });
  const mutatedPayloads = await buildConversation({
    turns: 5,
    baseUrl: "https://api.anthropic.com/v1",
    mutateHistory: true,
  });
  const mutated = runCacheSimulation(mutatedPayloads, { model: "anthropic" });

  // 每轮都把历史里的渲染标记重写一遍 → 公共前缀止步于第一条消息之前。
  assert.ok(
    mutated.steadyStateHitRate < clean.steadyStateHitRate,
    "改写历史必须表现为命中率下降,否则模拟器没有在真的比对字节",
  );
  assert.ok(
    mutated.steadyStateHitRate < 0.5,
    `改写历史后命中率应显著劣化,实际 ${(mutated.steadyStateHitRate * 100).toFixed(2)}%`,
  );

  // 反过来验证前缀稳定性检查器本身有效:它必须在这里失败。检查器如果永远
  // 通过,上面那两个 assertPrefixStable 就是摆设。
  assert.throws(
    () => assertPrefixStable(mutatedPayloads),
    /分叉/,
    "前缀稳定性检查器必须能抓到改写历史,否则它没有在做事",
  );
});

// ---------------------------------------------------------------------------
// 断点数量之争:1 个 vs 4 个,在同一把标尺下直接量。

test("追加式会话:单断点与上游多断点命中率完全相同", async () => {
  const single = await simulateConversation({
    turns: 5,
    baseUrl: "https://proxy.example.com/anthropic",
  });
  const upstream = await simulateConversation({
    turns: 5,
    transform: applyUpstreamBreakpoints,
  });

  // 纯追加时,上一轮末尾那个断点始终落在本轮公共前缀内,阶梯没有用武之地 ——
  // 靠前的那几个断点覆盖的内容,末尾断点已经全覆盖了。所以这里是**严格相等**,
  // 不是「相当」。写成不等式会掩盖掉一个有信息量的事实:在这个场景下,把 4 个
  // 断点压成 1 个是零代价的。真正的代价在下一个测试里。
  assert.equal(single.efficiency, 1);
  assert.equal(upstream.efficiency, 1);
  assert.equal(
    single.steadyStateHitRate,
    upstream.steadyStateHitRate,
    "追加式会话下断点数量不影响命中率,两者应严格相等",
  );
});

test("前缀尾部变动:多断点保住阶梯,单断点全部归零", async () => {
  // 构造一轮「历史尾部被改写、但 system 与 tools 纹丝不动」的请求。
  // 这正是压缩、重试改写、工具结果回填等场景的形状。
  const buildPair = async (transform) => {
    const first = buildBasePayload(4);
    const second = {
      ...buildBasePayload(4),
      messages: buildMessages(4).map((message, index, all) =>
        index === all.length - 1
          ? { ...message, content: [{ type: "text", text: "COMPLETELY DIFFERENT TAIL" }] }
          : message,
      ),
    };
    return [
      transform
        ? transform(first)
        : await runPipeline(first, { baseUrl: "https://proxy.example.com/anthropic" }),
      transform
        ? transform(second)
        : await runPipeline(second, { baseUrl: "https://proxy.example.com/anthropic" }),
    ];
  };

  const singleResult = runCacheSimulation(await buildPair(null), { model: "anthropic" });
  const upstreamResult = runCacheSimulation(await buildPair(applyUpstreamBreakpoints), {
    model: "anthropic",
  });

  assert.equal(
    singleResult.rounds[1].hit,
    0,
    "单断点在末尾:尾部一变,唯一的断点就落到公共前缀之外,命中归零",
  );
  assert.ok(
    upstreamResult.rounds[1].hit > 0,
    "多断点:system / tools 上的断点仍在公共前缀内,阶梯生效",
  );
  assert.ok(
    upstreamResult.rounds[1].hitRate > singleResult.rounds[1].hitRate,
    "这就是把 4 个断点压成 1 个所付出的代价",
  );
});

// ---------------------------------------------------------------------------
// DeepSeek 隐式缓存:128 token 块量化,解释为什么实测停在 98.9% 而不是 100%

test("DeepSeek 隐式缓存:命中量始终是 128 的整数倍,且损耗不超过一个块", async () => {
  const payloads = [];
  for (let turn = 1; turn <= 5; turn += 1) payloads.push(buildBasePayload(turn));
  const result = runCacheSimulation(payloads, { model: "deepseek" });

  for (const round of result.rounds) {
    assert.equal(round.hit % 128, 0, `第 ${round.round} 轮命中 ${round.hit} 不是 128 的整数倍`);

    // 与上限的差距必须**只**来自块量化,也就是严格小于一个块。
    // 这比「命中率 > 0.9」有意义得多:0.9 是拍出来的,会随 fixture 形状漂移;
    // 「损耗 < 128 token」是块量化这一机制的直接推论,换任何 fixture 都成立。
    // 实测的 98.9% 上限就是这么来的 —— 不是实现有缺陷,是块边界吃不满。
    const lost = round.ceiling - round.hit;
    assert.ok(
      lost >= 0 && lost < 128,
      `第 ${round.round} 轮损失 ${lost} token,超出块量化能解释的范围`,
    );
  }

  assert.ok(
    result.efficiency < 1,
    "块量化决定了永远吃不满上限 —— 这是上限,不是缺陷",
  );
});
