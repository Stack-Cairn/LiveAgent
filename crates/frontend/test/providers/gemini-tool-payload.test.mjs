import assert from "node:assert/strict";
import test from "node:test";

import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const {
  GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL,
  appendGeminiGoogleSearchToolToPayload,
  attachGeminiThoughtSignatureGuard,
  geminiToolsHaveFunctionDeclarations,
  hasGeminiBuiltinServerSideTool,
  isGemini3PlusModelId,
  isOfficialGeminiApiBaseUrl,
  normalizeGeminiThoughtSignatures,
} = loader.loadModule("src/lib/providers/runtime/geminiToolPayload.ts");

const OFFICIAL_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const RELAY_BASE_URL = "https://gemini-relay.example.com";
const { attachProviderNativeWebSearch } = loader.loadModule(
  "src/lib/providers/runtime/nativeSearchPayload.ts",
);

const FUNCTION_TOOLS = [
  {
    functionDeclarations: [
      { name: "Bash", description: "run a command", parametersJsonSchema: { type: "object" } },
    ],
  },
];

function createGeminiModel(id, overrides = {}) {
  return {
    id,
    name: id,
    api: "google-generative-ai",
    provider: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
    ...overrides,
  };
}

function buildAgentPayload(overrides = {}) {
  return {
    model: "gemini-3-pro-preview",
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    config: {
      tools: FUNCTION_TOOLS,
      toolConfig: { functionCallingConfig: { mode: "AUTO" } },
      ...overrides,
    },
  };
}

test("isGemini3PlusModelId matches Gemini 3+ ids and rolling flash aliases only", () => {
  assert.equal(isGemini3PlusModelId("gemini-3-pro-preview"), true);
  assert.equal(isGemini3PlusModelId("gemini-3-flash-preview"), true);
  assert.equal(isGemini3PlusModelId("gemini-3.1-flash-lite"), true);
  assert.equal(isGemini3PlusModelId("gemini-3.1-pro-preview-customtools"), true);
  assert.equal(isGemini3PlusModelId("gemini-3.5-flash"), true);
  assert.equal(isGemini3PlusModelId("models/gemini-3-pro-preview"), true);
  assert.equal(isGemini3PlusModelId("Gemini-3-Pro-Preview"), true);
  assert.equal(isGemini3PlusModelId("gemini-flash-latest"), true);
  assert.equal(isGemini3PlusModelId("gemini-flash-lite-latest"), true);

  assert.equal(isGemini3PlusModelId("gemini-2.5-pro"), false);
  assert.equal(isGemini3PlusModelId("gemini-2.5-flash"), false);
  assert.equal(isGemini3PlusModelId("gemini-2.0-flash"), false);
  assert.equal(isGemini3PlusModelId("gemini-exp-1206"), false);
  assert.equal(isGemini3PlusModelId("gemma-4-27b"), false);
  assert.equal(isGemini3PlusModelId(""), false);
});

test("hasGeminiBuiltinServerSideTool covers camelCase and snake_case built-in tools", () => {
  assert.equal(hasGeminiBuiltinServerSideTool({ googleSearch: {} }), true);
  assert.equal(hasGeminiBuiltinServerSideTool({ google_search: {} }), true);
  assert.equal(hasGeminiBuiltinServerSideTool({ googleSearchRetrieval: {} }), true);
  assert.equal(hasGeminiBuiltinServerSideTool({ urlContext: {} }), true);
  assert.equal(hasGeminiBuiltinServerSideTool({ codeExecution: {} }), true);
  assert.equal(hasGeminiBuiltinServerSideTool({ fileSearch: {} }), true);
  assert.equal(hasGeminiBuiltinServerSideTool(FUNCTION_TOOLS[0]), false);
  assert.equal(hasGeminiBuiltinServerSideTool(null), false);
});

test("geminiToolsHaveFunctionDeclarations detects camelCase and snake_case declarations", () => {
  assert.equal(geminiToolsHaveFunctionDeclarations(FUNCTION_TOOLS), true);
  assert.equal(geminiToolsHaveFunctionDeclarations([{ function_declarations: [{ name: "x" }] }]), true);
  assert.equal(geminiToolsHaveFunctionDeclarations([{ functionDeclarations: [] }]), false);
  assert.equal(geminiToolsHaveFunctionDeclarations([{ googleSearch: {} }]), false);
  assert.equal(geminiToolsHaveFunctionDeclarations(undefined), false);
});

test("text-only payloads (no function tools) get googleSearch appended untouched", () => {
  const payload = {
    model: "gemini-2.5-flash",
    contents: [],
    config: { temperature: 1 },
  };
  const next = appendGeminiGoogleSearchToolToPayload(payload, { modelId: "gemini-2.5-flash" });
  assert.deepEqual(next.config.tools, [{ googleSearch: {} }]);
  assert.equal(next.config.toolConfig, undefined);
  assert.equal(next.config.temperature, 1);
});

test("payloads that already carry a google search tool are returned as-is", () => {
  const payload = {
    model: "gemini-3-pro-preview",
    contents: [],
    config: { tools: [{ googleSearch: {} }] },
  };
  const next = appendGeminiGoogleSearchToolToPayload(payload, {
    modelId: "gemini-3-pro-preview",
  });
  assert.equal(next, payload);
});

test("Gemini 3 + function tools: googleSearch appended with includeServerSideToolInvocations and AUTO mode dropped", () => {
  const payload = buildAgentPayload();
  const next = appendGeminiGoogleSearchToolToPayload(payload, {
    modelId: "gemini-3-pro-preview",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  });
  assert.deepEqual(next.config.tools, [...FUNCTION_TOOLS, { googleSearch: {} }]);
  assert.equal(next.config.toolConfig.includeServerSideToolInvocations, true);
  // AUTO is rejected alongside the flag; the server default (VALIDATED) applies.
  assert.equal(next.config.toolConfig.functionCallingConfig, undefined);
});

test("Gemini 3 + function tools: ANY mode with allowedFunctionNames is preserved", () => {
  const payload = buildAgentPayload({
    toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["Bash"] } },
  });
  const next = appendGeminiGoogleSearchToolToPayload(payload, {
    modelId: "gemini-3-flash-preview",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  });
  assert.equal(next.config.toolConfig.includeServerSideToolInvocations, true);
  assert.deepEqual(next.config.toolConfig.functionCallingConfig, {
    mode: "ANY",
    allowedFunctionNames: ["Bash"],
  });
});

test("Gemini 3 + function tools with mode NONE keeps the payload unchanged", () => {
  const payload = buildAgentPayload({
    toolConfig: { functionCallingConfig: { mode: "NONE" } },
  });
  const next = appendGeminiGoogleSearchToolToPayload(payload, {
    modelId: "gemini-3-pro-preview",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  });
  assert.equal(next, payload);
});

test("Gemini 2.x + function tools never mixes in googleSearch (mixing is rejected upstream)", () => {
  for (const modelId of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"]) {
    const payload = buildAgentPayload();
    const next = appendGeminiGoogleSearchToolToPayload(payload, {
      modelId,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
    assert.equal(next, payload, modelId);
  }
});

test("isOfficialGeminiApiBaseUrl accepts only the Gemini Developer API host", () => {
  assert.equal(
    isOfficialGeminiApiBaseUrl("https://generativelanguage.googleapis.com/v1beta"),
    true,
  );
  assert.equal(isOfficialGeminiApiBaseUrl("https://generativelanguage.googleapis.com"), true);
  assert.equal(isOfficialGeminiApiBaseUrl("https://gemini-relay.example.com"), false);
  assert.equal(isOfficialGeminiApiBaseUrl("https://api.example.com/gemini"), false);
  assert.equal(isOfficialGeminiApiBaseUrl("https://us-central1-aiplatform.googleapis.com"), false);
  assert.equal(isOfficialGeminiApiBaseUrl(""), false);
  assert.equal(isOfficialGeminiApiBaseUrl(undefined), false);
});

test("non-official endpoints (relays/Vertex) never mix googleSearch into function tools", () => {
  // Relays re-serialize requests and drop includeServerSideToolInvocations
  // before forwarding, so the mixed request would 400 upstream regardless.
  for (const baseUrl of [
    "https://gemini-relay.example.com",
    "https://api.example.com/gemini",
    "https://us-central1-aiplatform.googleapis.com/v1",
    undefined,
  ]) {
    const payload = buildAgentPayload();
    const next = appendGeminiGoogleSearchToolToPayload(payload, {
      modelId: "gemini-3-pro-preview",
      baseUrl,
    });
    assert.equal(next, payload, String(baseUrl));
  }
});

test("non-official endpoints still get googleSearch in text-only payloads", () => {
  const payload = { model: "gemini-3-pro-preview", contents: [], config: {} };
  const next = appendGeminiGoogleSearchToolToPayload(payload, {
    modelId: "gemini-3-pro-preview",
    baseUrl: RELAY_BASE_URL,
  });
  assert.deepEqual(next.config.tools, [{ googleSearch: {} }]);
});

function buildSignaturePayload() {
  return {
    model: "gemini-3-pro-preview",
    contents: [
      { role: "user", parts: [{ text: "question" }] },
      {
        role: "model",
        parts: [
          { text: "answer text", thoughtSignature: "dGV4dHNpZw==" },
          { functionCall: { name: "Bash", args: {} }, thoughtSignature: "aGVsbG8=" },
          { functionCall: { name: "Read", args: {} } },
        ],
      },
      { role: "user", parts: [{ functionResponse: { name: "Bash", response: { output: "ok" } } }] },
    ],
    config: {},
  };
}

test("official endpoint: real signatures echoed, only missing functionCall signatures filled", () => {
  const payload = buildSignaturePayload();
  const next = normalizeGeminiThoughtSignatures(payload, {
    modelId: "gemini-3-pro-preview",
    baseUrl: OFFICIAL_BASE_URL,
  });
  const modelParts = next.contents[1].parts;
  assert.equal(modelParts[0].thoughtSignature, "dGV4dHNpZw==");
  assert.equal(modelParts[1].thoughtSignature, "aGVsbG8=");
  assert.equal(modelParts[2].thoughtSignature, GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL);
  assert.equal(next.contents[0], payload.contents[0]);
  assert.equal(next.contents[2], payload.contents[2]);
});

test("relay endpoints: functionCall signatures replaced with the sentinel, other signatures stripped", () => {
  // Real signatures replayed through rotating relay channels intermittently
  // fail upstream with "Corrupted thought signature."; the sentinel does not.
  const payload = buildSignaturePayload();
  const next = normalizeGeminiThoughtSignatures(payload, {
    modelId: "gemini-3-pro-preview",
    baseUrl: RELAY_BASE_URL,
  });
  const modelParts = next.contents[1].parts;
  assert.equal(modelParts[0].thoughtSignature, undefined);
  assert.equal(modelParts[0].text, "answer text");
  assert.equal(modelParts[1].thoughtSignature, GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL);
  assert.equal(modelParts[2].thoughtSignature, GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL);
});

test("normalizeGeminiThoughtSignatures is a no-op for pre-Gemini-3 models and covered payloads", () => {
  const covered = {
    contents: [
      {
        role: "model",
        parts: [{ functionCall: { name: "Bash", args: {} }, thoughtSignature: "aGVsbG8=" }],
      },
    ],
  };
  assert.equal(
    normalizeGeminiThoughtSignatures(covered, {
      modelId: "gemini-3-pro-preview",
      baseUrl: OFFICIAL_BASE_URL,
    }),
    covered,
  );

  const relayCoveredBySentinel = {
    contents: [
      {
        role: "model",
        parts: [
          {
            functionCall: { name: "Bash", args: {} },
            thoughtSignature: GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL,
          },
        ],
      },
    ],
  };
  assert.equal(
    normalizeGeminiThoughtSignatures(relayCoveredBySentinel, {
      modelId: "gemini-3-pro-preview",
      baseUrl: RELAY_BASE_URL,
    }),
    relayCoveredBySentinel,
  );

  const uncovered = {
    contents: [{ role: "model", parts: [{ functionCall: { name: "Bash", args: {} } }] }],
  };
  assert.equal(
    normalizeGeminiThoughtSignatures(uncovered, {
      modelId: "gemini-2.5-pro",
      baseUrl: RELAY_BASE_URL,
    }),
    uncovered,
  );
});

test("attachGeminiThoughtSignatureGuard chains prior onPayload and gates by provider/api", async () => {
  const model = createGeminiModel("gemini-3-pro-preview");
  const basePayload = {
    contents: [
      {
        role: "model",
        parts: [
          { functionCall: { name: "Bash", args: {} } },
          { functionCall: { name: "Read", args: {} }, thoughtSignature: "cmVhbHNpZw==" },
        ],
      },
    ],
    config: {},
  };

  const guarded = attachGeminiThoughtSignatureGuard(
    {
      onPayload: async (payload) => ({ ...payload, marked: true }),
    },
    { providerId: "gemini", baseUrl: RELAY_BASE_URL },
  );
  const result = await guarded.onPayload(basePayload, model);
  assert.equal(result.marked, true);
  assert.equal(
    result.contents[0].parts[0].thoughtSignature,
    GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL,
  );
  assert.equal(
    result.contents[0].parts[1].thoughtSignature,
    GEMINI_SKIP_THOUGHT_SIGNATURE_SENTINEL,
    "relay requests must not echo real signatures",
  );

  const official = attachGeminiThoughtSignatureGuard(
    {},
    { providerId: "gemini", baseUrl: OFFICIAL_BASE_URL },
  );
  const officialResult = await official.onPayload(basePayload, model);
  assert.equal(officialResult.contents[0].parts[1].thoughtSignature, "cmVhbHNpZw==");

  const otherProvider = attachGeminiThoughtSignatureGuard({}, { providerId: "codex" });
  assert.equal(otherProvider.onPayload, undefined);

  const nonGoogleModel = createGeminiModel("claude-x", { api: "anthropic-messages" });
  const guardedNonGoogle = attachGeminiThoughtSignatureGuard(
    {},
    { providerId: "gemini", baseUrl: RELAY_BASE_URL },
  );
  const untouched = await guardedNonGoogle.onPayload(basePayload, nonGoogleModel);
  assert.equal(untouched, basePayload);
});

test("attachProviderNativeWebSearch(gemini) routes agent payloads through the mixing rules", async () => {
  const options = attachProviderNativeWebSearch("gemini", {}, true, {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  });

  const gemini3 = createGeminiModel("gemini-3-pro-preview");
  const mixed = await options.onPayload(buildAgentPayload(), gemini3);
  assert.deepEqual(mixed.config.tools, [...FUNCTION_TOOLS, { googleSearch: {} }]);
  assert.equal(mixed.config.toolConfig.includeServerSideToolInvocations, true);
  assert.equal(mixed.config.toolConfig.functionCallingConfig, undefined);

  const gemini25 = createGeminiModel("gemini-2.5-flash");
  const untouched = await options.onPayload(buildAgentPayload(), gemini25);
  assert.deepEqual(
    untouched.config.tools,
    FUNCTION_TOOLS,
    "Gemini 2.x agent requests must not mix googleSearch into function tools",
  );

  const textPayload = { model: "gemini-2.5-flash", contents: [], config: {} };
  const textMode = await options.onPayload(textPayload, gemini25);
  assert.deepEqual(textMode.config.tools, [{ googleSearch: {} }]);

  const relayOptions = attachProviderNativeWebSearch("gemini", {}, true, {
    baseUrl: RELAY_BASE_URL,
  });
  const relayAgent = await relayOptions.onPayload(buildAgentPayload(), gemini3);
  assert.deepEqual(
    relayAgent.config.tools,
    FUNCTION_TOOLS,
    "relay endpoints must not mix googleSearch into function tools",
  );

  const disabled = attachProviderNativeWebSearch("gemini", {}, false, {});
  assert.equal(disabled.onPayload, undefined);
});
