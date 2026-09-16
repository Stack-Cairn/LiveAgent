import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

// 端点地址版本段规则的反漂移锁：设置页预览、路由结果、模型列表推导共用这一口径。
const loader = createTsModuleLoader();
const registry = loader.loadModule("@liveagent/ui/lib/providers/registry/protocols.ts");
const { resolveEndpointRequestBase, hasApiVersionSegment } = registry;

test("OpenAI family adds /v1 only when the path has no version segment", () => {
  assert.deepEqual(resolveEndpointRequestBase("openai-completions", "https://relay.example"), {
    base: "https://relay.example/v1",
    requestUrl: "https://relay.example/v1/chat/completions",
    verbatim: false,
  });
  assert.equal(
    resolveEndpointRequestBase("openai-responses", "https://relay.example/").requestUrl,
    "https://relay.example/v1/responses",
  );
  assert.equal(
    resolveEndpointRequestBase("openai-completions", "https://relay.example/v1/").base,
    "https://relay.example/v1",
  );
  assert.equal(
    resolveEndpointRequestBase("openai-completions", "https://open.bigmodel.cn/api/paas/v4").base,
    "https://open.bigmodel.cn/api/paas/v4",
  );
  assert.equal(
    resolveEndpointRequestBase("openai-completions", "https://ark.example/api/v3").requestUrl,
    "https://ark.example/api/v3/chat/completions",
  );
  // 版本段可以在路径中间（/v1/custom-path）。
  assert.equal(
    resolveEndpointRequestBase("openai-completions", "https://relay.example/v1/custom").base,
    "https://relay.example/v1/custom",
  );
  // 主机名里的 v2 不算版本段。
  assert.equal(
    resolveEndpointRequestBase("openai-completions", "https://v2.relay.example/api").base,
    "https://v2.relay.example/api/v1",
  );
});

test("a trailing # keeps the address as-is and a full URL is untouched", () => {
  assert.deepEqual(resolveEndpointRequestBase("openai-completions", "https://relay.example#"), {
    base: "https://relay.example",
    requestUrl: "https://relay.example/chat/completions",
    verbatim: true,
  });
  assert.equal(
    resolveEndpointRequestBase("google-generative-ai", "https://relay.example/gemini/#").base,
    "https://relay.example/gemini",
  );
  assert.deepEqual(
    resolveEndpointRequestBase(
      "openai-completions",
      "https://relay.example/custom/final?region=cn",
      true,
    ),
    {
      base: "https://relay.example/custom/final?region=cn",
      requestUrl: "https://relay.example/custom/final?region=cn",
      verbatim: false,
    },
  );
  assert.deepEqual(resolveEndpointRequestBase("openai-completions", "  "), {
    base: "",
    requestUrl: "",
    verbatim: false,
  });
});

test("Anthropic keeps the base and only avoids doubling /v1 in the request path", () => {
  assert.deepEqual(resolveEndpointRequestBase("anthropic-messages", "https://relay.example"), {
    base: "https://relay.example",
    requestUrl: "https://relay.example/v1/messages",
    verbatim: false,
  });
  assert.deepEqual(resolveEndpointRequestBase("anthropic-messages", "https://relay.example/v1/"), {
    base: "https://relay.example/v1",
    requestUrl: "https://relay.example/v1/messages",
    verbatim: false,
  });
});

test("Gemini adds /v1beta when the path has no version segment", () => {
  assert.equal(
    resolveEndpointRequestBase("google-generative-ai", "https://generativelanguage.googleapis.com")
      .requestUrl,
    "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
  );
  assert.equal(
    resolveEndpointRequestBase("google-generative-ai", "https://relay.example/v1beta").base,
    "https://relay.example/v1beta",
  );
  assert.equal(
    resolveEndpointRequestBase("google-generative-ai", "https://relay.example/v1").base,
    "https://relay.example/v1",
  );
});

test("hasApiVersionSegment only looks at the path", () => {
  assert.equal(hasApiVersionSegment("https://relay.example"), false);
  assert.equal(hasApiVersionSegment("https://relay.example/v1"), true);
  assert.equal(hasApiVersionSegment("https://relay.example/api/paas/v4/"), true);
  assert.equal(hasApiVersionSegment("https://relay.example/v1beta/models"), true);
  assert.equal(hasApiVersionSegment("https://relay.example/v1x"), true);
  assert.equal(hasApiVersionSegment("https://relay.example/version1"), false);
  assert.equal(hasApiVersionSegment("https://v1.relay.example/api"), false);
  assert.equal(hasApiVersionSegment("relay.example/v3"), true);
});
