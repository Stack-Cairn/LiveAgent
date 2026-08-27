import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

/**
 * PR-3 payload 拦截器注册化（feat-llm-interceptors）单元测试：
 *
 * 1. 默认注册顺序快照——10 个具名拦截器逐一断言，顺序即协议正确性的
 *    一部分，任何重排都必须显式改这里；
 * 2. 自定义拦截器语义——params 可见、options 可变换、执行位置在默认
 *    拦截器之后且在 payload-debug-logging 链尾之前；
 * 3. dispose 移除且幂等、同名重复注册抛错；
 * 4. 行为等价——空注册态下 finalizeProviderStreamOptions 的输出与
 *    直接用旧数组顺序 compose 的结果逐字段一致（配合 golden 两套件
 *    零修改通过构成 PR-3 的等价证据）。
 */

const loader = createTsModuleLoader();
// 先加载 payloadPipeline（安装默认拦截器），再取注册表 API。
const {
  finalizeProviderStreamOptions,
  composePayloadMiddlewares,
  attachPayloadDebugLogging,
} = loader.loadModule("src/lib/providers/runtime/payloadPipeline.ts");
const { listPayloadInterceptorNames, usePayloadInterceptor } = loader.loadModule(
  "src/lib/providers/service/interceptors.ts",
);
const { llm } = loader.loadModule("src/lib/providers/service/llmService.ts");

const EXPECTED_DEFAULT_ORDER = [
  "anthropic-automatic-caching",
  "anthropic-long-context-beta",
  "codex-responses-storage",
  "codex-prompt-cache-hint",
  "provider-native-web-search",
  "xai-responses-payload-compat",
  "deepseek-responses-payload-compat",
  "native-attachments",
  "gemini-thought-signature-guard",
  "payload-debug-logging",
];

function baseParams(overrides = {}) {
  return {
    providerId: "claude_code",
    baseUrl: "https://relay.example/v1",
    options: {},
    ...overrides,
  };
}

test("默认注册顺序快照：10 个具名拦截器逐一一致", () => {
  assert.deepEqual(listPayloadInterceptorNames(), EXPECTED_DEFAULT_ORDER);
});

test("llm.use 暴露注册入口且与 usePayloadInterceptor 同源", () => {
  assert.equal(llm.use, usePayloadInterceptor);
});

test("自定义拦截器：params 可见、options 可变换、dispose 后恢复原样", () => {
  const seen = [];
  const dispose = usePayloadInterceptor({
    name: "test-marker",
    intercept: (options, params) => {
      seen.push(params.providerId);
      return { ...options, headers: { ...(options.headers ?? {}), "x-test-marker": "1" } };
    },
  });
  try {
    const withMarker = finalizeProviderStreamOptions(baseParams());
    assert.equal(withMarker.headers["x-test-marker"], "1");
    assert.deepEqual(seen, ["claude_code"]);
  } finally {
    dispose();
  }
  const withoutMarker = finalizeProviderStreamOptions(baseParams());
  assert.equal(withoutMarker.headers?.["x-test-marker"], undefined);
});

test("自定义拦截器插入默认之后、payload-debug-logging 链尾之前", () => {
  const dispose = usePayloadInterceptor({
    name: "test-order",
    intercept: (options) => options,
  });
  try {
    const names = listPayloadInterceptorNames();
    assert.equal(names[names.length - 1], "payload-debug-logging");
    assert.equal(names[names.length - 2], "test-order");
    assert.deepEqual(
      names.slice(0, EXPECTED_DEFAULT_ORDER.length - 1),
      EXPECTED_DEFAULT_ORDER.slice(0, -1),
    );
  } finally {
    dispose();
  }
  assert.deepEqual(listPayloadInterceptorNames(), EXPECTED_DEFAULT_ORDER);
});

test("链尾观测不变量：自定义追加的 onPayload 变换仍被 debug logging 看到", async () => {
  const dispose = usePayloadInterceptor({
    name: "test-payload-mutator",
    intercept: (options) => ({
      ...options,
      onPayload: async (payload) => ({ ...payload, injected: true }),
    }),
  });
  const logged = [];
  try {
    const options = finalizeProviderStreamOptions(
      baseParams({
        debugLogger: { logRequest: (entry) => logged.push(entry) },
      }),
    );
    const result = await options.onPayload({ base: true }, { api: "anthropic-messages", provider: "anthropic" });
    assert.deepEqual(result, { base: true, injected: true });
    assert.equal(logged.length, 1);
    assert.deepEqual(logged[0].payload, { base: true, injected: true });
  } finally {
    dispose();
  }
});

test("dispose 幂等：重复调用不影响其他注册", () => {
  const disposeA = usePayloadInterceptor({ name: "test-a", intercept: (o) => o });
  const disposeB = usePayloadInterceptor({ name: "test-b", intercept: (o) => o });
  disposeA();
  disposeA();
  const names = listPayloadInterceptorNames();
  assert.ok(!names.includes("test-a"));
  assert.ok(names.includes("test-b"));
  disposeB();
  assert.deepEqual(listPayloadInterceptorNames(), EXPECTED_DEFAULT_ORDER);
});

test("同名重复注册抛错（含与默认拦截器同名）", () => {
  const dispose = usePayloadInterceptor({ name: "test-dup", intercept: (o) => o });
  try {
    assert.throws(
      () => usePayloadInterceptor({ name: "test-dup", intercept: (o) => o }),
      /already registered: test-dup/,
    );
  } finally {
    dispose();
  }
  assert.throws(
    () => usePayloadInterceptor({ name: "anthropic-automatic-caching", intercept: (o) => o }),
    /already registered: anthropic-automatic-caching/,
  );
  assert.throws(() => usePayloadInterceptor({ name: "", intercept: (o) => o }), /non-empty name/);
  assert.throws(
    () => usePayloadInterceptor({ name: "test-no-fn" }),
    /requires an intercept function/,
  );
});

test("加载顺序反转：自定义先注册且与默认名撞名时，安装默认链抛错且不留部分状态", () => {
  // 独立 loader 模拟"插件/测试先 import 服务层并注册自定义拦截器，之后
  // payloadPipeline 才被加载"的顺序（llmService 不传递性求值 payloadPipeline，
  // 这一顺序在真实模块图上可达）。
  const isolated = createTsModuleLoader();
  const api = isolated.loadModule("src/lib/providers/service/interceptors.ts");
  api.usePayloadInterceptor({
    name: "anthropic-automatic-caching",
    intercept: (o) => o,
  });
  assert.throws(
    () => isolated.loadModule("src/lib/providers/runtime/payloadPipeline.ts"),
    /already taken by a custom interceptor: anthropic-automatic-caching/,
  );
  // 安装失败必须不留部分注册状态：链上只有先注册的那个自定义拦截器。
  assert.deepEqual(api.listPayloadInterceptorNames(), ["anthropic-automatic-caching"]);
});

test("行为等价：空注册态 finalize 输出与旧数组组合逐字段一致", async () => {
  // 按注册化前的 finalizePayloadMiddlewares 数组原样重建旧组合链
  // （同一批 attach* 实现、同一顺序），对非平凡参数逐字段对比输出。
  const { attachAnthropicAutomaticCaching } = loader.loadModule(
    "src/lib/providers/runtime/anthropicCache.ts",
  );
  const { attachAnthropicLongContextBeta } = loader.loadModule(
    "src/lib/providers/runtime/anthropicLongContext.ts",
  );
  const { attachCodexResponsesStorage } = loader.loadModule(
    "src/lib/providers/runtime/codexStorage.ts",
  );
  const { attachCodexPromptCacheHint } = loader.loadModule(
    "src/lib/providers/runtime/codexPromptCache.ts",
  );
  const { attachProviderNativeWebSearch } = loader.loadModule(
    "src/lib/providers/runtime/nativeSearchPayload.ts",
  );
  const { attachXaiResponsesPayloadCompat } = loader.loadModule(
    "src/lib/providers/runtime/xaiResponsesPayload.ts",
  );
  const { attachDeepSeekResponsesPayloadCompat } = loader.loadModule(
    "src/lib/providers/runtime/deepSeekResponsesPayload.ts",
  );
  const attachments = loader.loadModule("src/lib/providers/nativeResponsesAttachments.ts");
  const { attachGeminiThoughtSignatureGuard } = loader.loadModule(
    "src/lib/providers/runtime/geminiToolPayload.ts",
  );

  const legacyChain = composePayloadMiddlewares([
    (options, params) =>
      attachAnthropicAutomaticCaching(params.providerId, params.baseUrl, options),
    (options, params) =>
      attachAnthropicLongContextBeta(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
        model: params.model,
        context: params.context,
      }),
    (options, params) => attachCodexResponsesStorage(params.providerId, options),
    (options, params) =>
      attachCodexPromptCacheHint(
        params.providerId,
        params.baseUrl,
        params.promptCacheHintMode,
        params.model,
        options,
      ),
    (options, params) =>
      attachProviderNativeWebSearch(params.providerId, options, params.nativeWebSearch, {
        baseUrl: params.baseUrl,
      }),
    (options, params) =>
      attachXaiResponsesPayloadCompat(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
    (options, params) =>
      attachDeepSeekResponsesPayloadCompat(options, {
        providerId: params.providerId,
        model: params.model,
        context: params.context,
      }),
    (options, params) => {
      if (!params.context || !params.model) return options;
      let nextOptions = attachments.attachOpenAIResponsesNativeAttachments(options, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      nextOptions = attachments.attachOpenAICompletionsNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      nextOptions = attachments.attachAnthropicMessagesNativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
      return attachments.attachGeminiGenerativeAINativeAttachments(nextOptions, {
        context: params.context,
        model: params.model,
        providerId: params.providerId,
        workdir: params.workdir,
      });
    },
    (options, params) =>
      attachGeminiThoughtSignatureGuard(options, {
        providerId: params.providerId,
        baseUrl: params.baseUrl,
      }),
    (options, params) => attachPayloadDebugLogging(options, params.debugLogger, params.extra),
  ]);

  // 覆盖多形态参数：anthropic 缓存路径、codex cache hint 路径、debug 链尾。
  const paramMatrix = [
    baseParams(),
    baseParams({ providerId: "claude_code", options: { headers: { "x-a": "1" } } }),
    baseParams({
      providerId: "codex",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      promptCacheHintMode: "auto",
    }),
    baseParams({ providerId: "gemini", baseUrl: "https://generativelanguage.googleapis.com" }),
  ];
  for (const params of paramMatrix) {
    const viaRegistry = finalizeProviderStreamOptions(params);
    const viaLegacy = legacyChain(params.options, params);
    // onPayload 是闭包无法 deepEqual；先断言存在性一致，再剥离比较其余字段。
    assert.equal(
      typeof viaRegistry.onPayload,
      typeof viaLegacy.onPayload,
      `onPayload presence must match for ${params.providerId}`,
    );
    const { onPayload: _a, ...restRegistry } = viaRegistry;
    const { onPayload: _b, ...restLegacy } = viaLegacy;
    assert.deepEqual(restRegistry, restLegacy, `options must match for ${params.providerId}`);
  }
});
