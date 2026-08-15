import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const codexCache = loader.loadModule("src/lib/providers/runtime/codexPromptCache.ts");

// 这组契约测试对标 OpenAI 官方 codex CLI 的 cache key 测试
// (codex-rs 的 review_session / guardian 测试):key 必须确定、必须区分会话、
// 必须落在 Responses API 的 64 字符上限内。官方的 key 永不为空;我们的
// sessionId 可能为空,所以额外守一条 —— 空值降级必须在归因里可见,不能只是
// 命中率悄悄变差。

const OPENAI_BASE = "https://api.openai.com/v1";

test("codex cache key:同一 sessionId 恒产出同一 key(确定性)", () => {
  const first = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "short",
  );
  const second = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "short",
  );
  assert.equal(first.cacheKey, second.cacheKey);
  assert.ok(first.cacheKey, "官方域名 + responses API 下 key 必须有值");
});

test("codex cache key:不同 sessionId 产出不同 key(分片隔离)", () => {
  const a = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-a",
    "short",
  );
  const b = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-b",
    "short",
  );
  assert.notEqual(a.cacheKey, b.cacheKey);
});

test("codex cache key:长 sessionId 截断到 64 字符(Responses API 上限)", () => {
  const long = "s".repeat(200);
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    long,
    "short",
  );
  assert.equal(shape.cacheKey.length, 64);
});

test("codex cache key:sessionId 缺失时归因必须暴露空 key —— 静默降级唯一可见处", () => {
  // attachCodexPromptCacheHint 在 sessionId 为空时不注入 prompt_cache_key,
  // 服务端退回默认路由,请求不报错、命中率只是变差。归因里 cacheKey 为空串
  // 是这次降级唯一留下的痕迹,这条断言就是在守它。
  const missing = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    undefined,
    "short",
  );
  assert.equal(missing.cacheKey, "");
  assert.equal(missing.breakpointStrategy, "codex-openai-key", "模式仍在,只是 key 没上线");

  const blank = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "   ",
    "short",
  );
  assert.equal(blank.cacheKey, "", "空白 sessionId 与缺失同等对待");
});

test("codex cache shape:cacheRetention=none 时整体归 none,与注入侧同源", () => {
  // attachCodexPromptCacheHint 在 retention=none 时把 mode 压成 none,
  // 从源头不生成任何缓存提示。归因必须描述同一现实,不能自说自话。
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "none",
  );
  assert.equal(shape.breakpointStrategy, "none");
  assert.equal(shape.cacheKey, "");
});

test("codex cache shape:非 codex 协议族恒 none", () => {
  const shape = codexCache.describeCodexCacheShape(
    "claude_code",
    "https://api.anthropic.com/v1",
    undefined,
    undefined,
    "session-abc",
    "short",
  );
  assert.equal(shape.breakpointStrategy, "none");
});

test("codex cache shape:openrouter 走 x-session-id,key 上限放宽到 256", () => {
  const long = "r".repeat(300);
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    "https://openrouter.ai/api/v1",
    undefined,
    undefined,
    long,
    "short",
  );
  assert.equal(shape.breakpointStrategy, "codex-openrouter-session");
  assert.equal(shape.cacheKey.length, 256);
});

test("codex cache shape:请求已带 x-session-id 头时,describe 以头值为准(与 attach 同源)", () => {
  const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  // attach 侧:头已存在则跳过注入,生效的路由键是既有头的值。describe 若仍报
  // clamp(sessionId),描述的就是一个不存在的请求。
  const withHeader = codexCache.describeCodexCacheShape(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    "session-configured",
    "short",
    { "X-Session-Id": "custom-upstream-key" },
  );
  assert.equal(withHeader.cacheKey, "custom-upstream-key");

  const withoutHeader = codexCache.describeCodexCacheShape(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    "session-configured",
    "short",
    { "x-other-header": "1" },
  );
  assert.equal(withoutHeader.cacheKey, "session-configured");
  assert.notEqual(withHeader.cacheKey, withoutHeader.cacheKey);
});

test("codex cache shape:x-session-id 头判定大小写不敏感,且与注入侧行为互证", async () => {
  const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
  // 先证 attach 在头已存在时确实不覆盖(同源前提),再证 describe 报同一个值。
  const attached = codexCache.attachCodexPromptCacheHint(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    {
      sessionId: "session-configured",
      cacheRetention: "short",
      headers: { "X-SESSION-ID": "upstream-value" },
    },
  );
  assert.equal(attached.headers["X-SESSION-ID"], "upstream-value");
  assert.equal(
    Object.keys(attached.headers).filter((key) => key.toLowerCase() === "x-session-id").length,
    1,
    "attach 不得再注入第二个 x-session-id",
  );

  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENROUTER_BASE,
    undefined,
    undefined,
    "session-configured",
    "short",
    attached.headers,
  );
  assert.equal(shape.cacheKey, "upstream-value");
});

test("codex cache shape:openai-key 模式不受 x-session-id 头影响", () => {
  // prompt_cache_key 走 payload 注入,与 x-session-id 头无关;头存在不得改变
  // openai 路径的 cacheKey 口径。
  const shape = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-abc",
    "short",
    { "x-session-id": "should-not-matter" },
  );
  assert.equal(shape.cacheKey, "session-abc");
});

test("codex cache shape:sessionId 变更会反映为 cacheKey 变更,可被前缀归因抓到", () => {
  // 换 sessionId = 换缓存分片 = 前缀字节再稳也全量 miss。归因维度必须动。
  const before = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-before",
    "short",
  );
  const after = codexCache.describeCodexCacheShape(
    "codex",
    OPENAI_BASE,
    undefined,
    "openai-responses",
    "session-after",
    "short",
  );
  assert.notEqual(
    JSON.stringify(before),
    JSON.stringify(after),
    "cacheKey 是 shape 的一部分,sessionId 变更必须让 shape 不相等",
  );
});
