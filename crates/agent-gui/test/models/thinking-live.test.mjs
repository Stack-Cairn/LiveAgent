import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const thinkingLive = loader.loadModule("@liveagent/ui/lib/models/thinkingLive.ts");
const modelThinking = loader.loadModule("@liveagent/ui/lib/models/modelThinking.ts");

// models.dev/api.json 形状的迷你 fixture：覆盖 effort 梯子 / toggle / budget /
// 恒开不可调 / 非推理 / anthropic client-side-off 各形态。
const LIVE_FIXTURE = {
  zai: {
    models: {
      "glm-5.3-flashx": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
      },
      "glm-5.3-flash": {
        // 与快照命中数据不同，用于验证「快照命中时实时数据不夺权」。
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["minimal"] }],
      },
    },
  },
  deepseek: {
    models: {
      "deepseek-flash": {
        reasoning: true,
        reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
      },
      "deepseek-v4-flash": {
        // 同上：快照优先级的对照组。
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["minimal"] }],
      },
      "deepseek-budget-future": {
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", default: 8192 }],
      },
    },
  },
  anthropic: {
    models: {
      "claude-from-live": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
  xai: {
    models: {
      "grok-from-live": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "high"] }],
      },
    },
  },
  moonshotai: {
    models: {
      "kimi-toggle-only": { reasoning: true, reasoning_options: [{ type: "toggle" }] },
      "kimi-always-on": { reasoning: true, reasoning_options: [] },
      "kimi-none-folded": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "ultra"] }],
      },
      "kimi-not-reasoning": { reasoning: false, reasoning_options: [{ type: "effort" }] },
    },
  },
};

function version() {
  return thinkingLive.getThinkingLiveVersion();
}

test("extractLiveThinking mirrors the generator's normalizeThinking rules", () => {
  const model = (id) => LIVE_FIXTURE.moonshotai.models[id];
  assert.deepEqual(thinkingLive.extractLiveThinking(model("kimi-toggle-only")), {
    levels: ["high"],
    off: true,
  });
  assert.deepEqual(thinkingLive.extractLiveThinking(model("kimi-always-on")), {
    levels: [],
    off: false,
  });
  // "none" 折入 off；未知档位值（ultra）静默丢弃。
  assert.deepEqual(thinkingLive.extractLiveThinking(model("kimi-none-folded")), {
    levels: ["low"],
    off: true,
  });
  assert.equal(thinkingLive.extractLiveThinking(model("kimi-not-reasoning")), undefined);
  assert.equal(thinkingLive.extractLiveThinking(undefined), undefined);
  assert.deepEqual(
    thinkingLive.extractLiveThinking(LIVE_FIXTURE.deepseek.models["deepseek-budget-future"]),
    { levels: ["minimal", "low", "medium", "high"], off: false },
  );
});

test("ingest rebuilds the store, applies client-side-off for anthropic, and rejects empty data", () => {
  const before = version();
  assert.equal(thinkingLive.ingestLiveThinkingCatalog(LIVE_FIXTURE), true);
  assert.equal(version(), before + 1);

  assert.deepEqual(thinkingLive.resolveLiveThinking("glm-5.3-flashx"), {
    levels: ["low", "high", "max"],
    off: false,
  });
  // 候选链与目录同款：大小写、@版本装饰命中同一条目。
  assert.equal(thinkingLive.resolveLiveThinking("GLM-5.3-FLASHX@prod")?.levels.length, 3);
  // anthropic 分区条目一律可客户端关闭。
  assert.deepEqual(thinkingLive.resolveLiveThinking("claude-from-live"), {
    levels: ["low", "high"],
    off: true,
  });
  assert.equal(thinkingLive.resolveLiveThinking("kimi-not-reasoning"), undefined);
  assert.equal(thinkingLive.resolveLiveThinking("totally-absent"), undefined);

  // 空数据（schema 变更防御）：拒绝生效，版本与数据保持不变。
  assert.equal(thinkingLive.ingestLiveThinkingCatalog({ zai: { models: {} } }), false);
  assert.equal(thinkingLive.ingestLiveThinkingCatalog(null), false);
  assert.equal(version(), before + 1);
});

test("resolveModelThinking prefers snapshot, then live supplement, then fallback", () => {
  // 快照命中（含 thinking）：实时数据即使存在也不夺权。
  const snapshotHit = modelThinking.resolveModelThinking("deepseek", "deepseek-v4-flash");
  assert.equal(snapshotHit.fromCatalog, true);
  assert.equal(snapshotHit.fromLive, undefined);
  assert.deepEqual(snapshotHit.levels, ["low", "high", "max"]);
  // glm-5.3-flash 快照命中：恒开（off:false）语义不受实时数据影响。
  const flash = modelThinking.resolveModelThinking("codex", "glm-5.3-flash");
  assert.equal(flash.fromCatalog, true);
  assert.deepEqual(flash.levels, ["low", "high", "max"]);
  assert.equal(flash.alwaysOn, true);

  // 快照未命中 + 实时命中：中转/供应商作用域都查不到的 deepseek-flash 走补充层。
  const liveOnly = modelThinking.resolveModelThinking("codex", "deepseek-flash");
  assert.deepEqual(
    { levels: liveOnly.levels, alwaysOn: liveOnly.alwaysOn, fromLive: liveOnly.fromLive },
    { levels: ["low", "high", "max"], alwaysOn: false, fromLive: true },
  );

  // 快照未命中 + 实时未命中：维持通用兜底（标准四档、可关闭）。
  const fallback = modelThinking.resolveModelThinking("codex", "model-not-anywhere");
  assert.equal(fallback.fromCatalog, false);
  assert.equal(fallback.fromLive, undefined);
  assert.deepEqual(fallback.levels, ["minimal", "low", "medium", "high"]);

  // xai 供应商例外：实时数据声明可关，也强制恒开（wire 无法表达 off）。
  const xai = modelThinking.resolveModelThinking("xai", "grok-from-live");
  assert.equal(xai.fromLive, true);
  assert.equal(xai.alwaysOn, true);
});

test("loadThinkingLiveSupplement fetches once per TTL and degrades silently on failure", async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  let shouldFail = false;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    if (shouldFail) throw new Error("network down");
    return new Response(JSON.stringify(LIVE_FIXTURE), { status: 200 });
  };
  try {
    const before = version();
    // TTL 内首次调用走网络并生效。
    assert.equal(await thinkingLive.loadThinkingLiveSupplement({ ttlMs: 60_000 }), true);
    assert.equal(fetchCalls, 1);
    assert.equal(version(), before + 1);
    // TTL 内重复调用：直接命中，不再发请求。
    assert.equal(await thinkingLive.loadThinkingLiveSupplement({ ttlMs: 60_000 }), true);
    assert.equal(fetchCalls, 1);
    // force + 网络失败：静默返回 false，旧数据原样保留。
    shouldFail = true;
    assert.equal(await thinkingLive.loadThinkingLiveSupplement({ force: true }), false);
    assert.equal(fetchCalls, 2);
    assert.equal(thinkingLive.resolveLiveThinking("deepseek-flash")?.levels.length, 3);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("official sections adjudicate duplicate ids ahead of aggregator sections regardless of key order", () => {
  // api.json 的真实键序把聚合商排在官方分区之前；fixture 刻意复现这一顺序，
  // 且把 zhipuai 放在 zai 之前——验证裁决序来自 OFFICIAL_SECTION_ORDER 而非
  // 对象插入序。
  const upstream = {
    greenpt: {
      models: {
        // 聚合商把官方 effort 梯子改写成四档 budget 型：不得夺权。
        "kimi-k9": {
          reasoning: true,
          reasoning_options: [{ type: "budget_tokens", default: 4096 }],
        },
        // 官方没有的 id：聚合商仍是合法补充源。
        "aggregator-only-model": { reasoning: true, reasoning_options: [{ type: "toggle" }] },
        // 聚合商镜像的 anthropic 模型：官方 anthropic 分区的 client-side-off 优先。
        "claude-k9": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
      },
    },
    zhipuai: {
      models: {
        "glm-k9": { reasoning: true, reasoning_options: [{ type: "toggle" }] },
      },
    },
    zai: {
      models: {
        "glm-k9": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "max"] }],
        },
      },
    },
    "moonshotai-cn": {
      models: {
        "kimi-k9": {
          reasoning: true,
          reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
        },
      },
    },
    anthropic: {
      models: {
        "claude-k9": {
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
        },
      },
    },
  };
  assert.equal(thinkingLive.ingestLiveThinkingCatalog(upstream), true);
  assert.deepEqual(thinkingLive.resolveLiveThinking("kimi-k9"), {
    levels: ["low", "high", "max"],
    off: true,
  });
  // 生成器 SECTIONS 内序：zai 先于 zhipuai。
  assert.deepEqual(thinkingLive.resolveLiveThinking("glm-k9"), {
    levels: ["low", "max"],
    off: false,
  });
  assert.deepEqual(thinkingLive.resolveLiveThinking("claude-k9"), {
    levels: ["low", "high"],
    off: true,
  });
  assert.deepEqual(thinkingLive.resolveLiveThinking("aggregator-only-model"), {
    levels: ["high"],
    off: true,
  });

  // 恢复共享 fixture，避免本用例的裁决数据泄漏给后续新增用例。
  assert.equal(thinkingLive.ingestLiveThinkingCatalog(LIVE_FIXTURE), true);
});
