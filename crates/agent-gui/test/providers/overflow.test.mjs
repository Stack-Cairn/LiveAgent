import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { isOverflowError, AssistantResponseError, readAssistantFromError } = loader.loadModule(
  "src/lib/providers/runtime/overflow.ts",
);
const { isFailoverEligibleAssistantError } = loader.loadModule(
  "src/lib/providers/runtime/providerFailover.ts",
);
const { normalizeErrorMessage } = loader.loadModule("src/lib/providers/runtime/errors.ts");
const piAiOverflow = await import(
  new URL("../../node_modules/@earendil-works/pi-ai/dist/utils/overflow.js", import.meta.url).href
);

function createAssistant(stopReason, extra = {}) {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
    ...extra,
  };
}

function errorAssistant(errorMessage) {
  return createAssistant("error", { errorMessage });
}

const ANTHROPIC_EXCEED_CONTEXT_LIMIT =
  "input length and `max_tokens` exceed context limit: 195031 + 32000 > 200000, decrease input length or `max_tokens` and try again";
const ANTHROPIC_REQUEST_TOO_LARGE =
  '413 {"error":{"type":"request_too_large","message":"Request exceeds the maximum size"}}';

test("isOverflowError recognizes pi-ai's overflow wordings", () => {
  assert.equal(
    isOverflowError(errorAssistant("prompt is too long: 205031 tokens > 200000 maximum")),
    true,
  );
  assert.equal(
    isOverflowError(errorAssistant("Your input exceeds the context window of this model")),
    true,
  );
  assert.equal(isOverflowError(errorAssistant(ANTHROPIC_REQUEST_TOO_LARGE)), true);
});

test("isOverflowError recognizes Anthropic's 'exceed context limit', which pi-ai misses", () => {
  assert.equal(
    piAiOverflow.isContextOverflow(errorAssistant(ANTHROPIC_EXCEED_CONTEXT_LIMIT)),
    false,
  );
  assert.equal(isOverflowError(errorAssistant(ANTHROPIC_EXCEED_CONTEXT_LIMIT)), true);
  assert.equal(isOverflowError(errorAssistant("request exceeds context limit")), true);
});

test("isOverflowError excludes pi-ai's bodiless 4xx pattern", () => {
  const bodiless = ["400 status code (no body)", "413 status code (no body)", "400 (no body)"];
  for (const errorMessage of bodiless) {
    // pi-ai alone would call these overflow (its Cerebras fallback).
    assert.equal(piAiOverflow.isContextOverflow(errorAssistant(errorMessage)), true, errorMessage);
    assert.equal(isOverflowError(errorAssistant(errorMessage)), false, errorMessage);
  }
});

test("isOverflowError ignores unrelated errors, rate limits and non-error stops", () => {
  assert.equal(isOverflowError(undefined), false);
  assert.equal(isOverflowError(errorAssistant("503 service unavailable")), false);
  assert.equal(isOverflowError(errorAssistant("rate limit: too many tokens per minute")), false);
  assert.equal(
    isOverflowError(createAssistant("stop", { errorMessage: ANTHROPIC_EXCEED_CONTEXT_LIMIT })),
    false,
  );
});

test("isOverflowError never calls a throttle overflow, however it is worded", () => {
  const throttles = [
    '429 litellm.RateLimitError: BedrockException - {"message":"Too many tokens, please wait before trying again."}',
    "litellm.RateLimitError: BedrockException - Too many tokens, please wait before trying again.",
    "ThrottlingException: Too many tokens, please wait before trying again.",
    "429 Token limit exceeded for this minute, please retry later",
    '429 {"error":{"message":"The number of concurrent requests exceeds the limit of 5"}}',
    "429 Request rate exceeds the limit of 60 requests per minute",
  ];
  for (const errorMessage of throttles) {
    // pi-ai's generic fallbacks ("too many tokens", "exceeds the limit of N")
    // match these because its own exclusion only knows "rate limit" with a space.
    assert.equal(piAiOverflow.isContextOverflow(errorAssistant(errorMessage)), true, errorMessage);
    assert.equal(isOverflowError(errorAssistant(errorMessage)), false, errorMessage);
  }
  // A real 429 throttle is failover-eligible again.
  assert.equal(
    isFailoverEligibleAssistantError(
      errorAssistant("429 Request rate exceeds the limit of 60 requests per minute"),
    ),
    true,
  );
});

test("isOverflowError still sees overflow when a token count merely contains 429", () => {
  for (const errorMessage of [
    "prompt is too long: 205429 tokens > 200000 maximum",
    "This model's maximum context length is 128000 tokens. However, your messages resulted in 130,429 tokens.",
    "input length and `max_tokens` exceed context limit: 195429 + 32000 > 200000",
  ]) {
    assert.equal(isOverflowError(errorAssistant(errorMessage)), true, errorMessage);
  }
});

test("isOverflowError ignores quota, auth and gateway errors that only hit pi-ai's catch-alls", () => {
  for (const errorMessage of [
    "403 Monthly token limit exceeded for this key",
    "401 Unauthorized: daily token limit exceeded",
    "502 Bad Gateway: too many tokens in flight",
    "402 Payment Required: too many tokens used this month",
    "Your daily usage exceeds the limit of 1000000 tokens",
  ]) {
    assert.equal(isOverflowError(errorAssistant(errorMessage)), false, errorMessage);
  }
  // Specific overflow wordings still win, and token counts are not status codes.
  for (const errorMessage of [
    "500 upstream error: prompt is too long: 213462 tokens > 200000 maximum",
    "too many tokens: 205031 > 200000",
  ]) {
    assert.equal(isOverflowError(errorAssistant(errorMessage)), true, errorMessage);
  }
  // Main's behaviour is back: an auth / quota 40x fails over again.
  assert.equal(
    isFailoverEligibleAssistantError(errorAssistant("403 Monthly token limit exceeded for this key")),
    true,
  );
});

test("isOverflowError forwards contextWindow for pi-ai's silent overflow", () => {
  const silent = createAssistant("stop", {
    usage: { ...createAssistant("stop").usage, input: 150_000, cacheRead: 60_000 },
  });
  assert.equal(isOverflowError(silent), false);
  assert.equal(isOverflowError(silent, 200_000), true);
});

test("the raw message is required: normalizing drops request_too_large", () => {
  const normalized = normalizeErrorMessage(ANTHROPIC_REQUEST_TOO_LARGE);
  assert.equal(normalized, "Request exceeds the maximum size");
  assert.equal(isOverflowError(errorAssistant(normalized)), false);
  assert.equal(isOverflowError(errorAssistant(ANTHROPIC_REQUEST_TOO_LARGE)), true);
});

test("AssistantResponseError keeps the message text and carries the raw assistant", () => {
  const raw = errorAssistant(ANTHROPIC_REQUEST_TOO_LARGE);
  const error = new AssistantResponseError(normalizeErrorMessage(raw.errorMessage), raw);
  assert.ok(error instanceof Error);
  assert.equal(error.message, "Request exceeds the maximum size");
  // `name` stays "Error" so String(error) paths are byte-identical.
  assert.equal(String(error), "Error: Request exceeds the maximum size");
  assert.equal(error.assistant, raw);
  assert.equal(readAssistantFromError(error), raw);
  assert.equal(isOverflowError(readAssistantFromError(error)), true);
});

test("readAssistantFromError returns undefined for anything else", () => {
  assert.equal(readAssistantFromError(new Error("Request failed")), undefined);
  assert.equal(readAssistantFromError("Request failed"), undefined);
  assert.equal(readAssistantFromError(undefined), undefined);
});

test("isFailoverEligibleAssistantError rejects overflow even when its digits look like a 5xx", () => {
  // "195031" contains "503", which pi-ai's unanchored pattern treats as retryable.
  for (const errorMessage of [ANTHROPIC_EXCEED_CONTEXT_LIMIT, ANTHROPIC_REQUEST_TOO_LARGE]) {
    assert.equal(isFailoverEligibleAssistantError(errorAssistant(errorMessage)), false);
  }
  // A real 503 still fails over.
  assert.equal(isFailoverEligibleAssistantError(errorAssistant("503 service unavailable")), true);
});
