import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { createProviderRuntimeConfig } = loader.loadModule("src/lib/providers/runtime/providerRuntimeConfig.ts");
const { normalizeCustomProvider, DEFAULT_CHAT_RUNTIME_CONTROLS, normalizeChatRuntimeControlsForProvider } = loader.loadModule("src/lib/settings/index.ts");
const { providerSupportsNativeWebSearch, resolveProviderApi } = loader.loadModule("../agent-ui/src/lib/providers/providerCapabilities.ts");
const { buildModelOptions } = loader.loadModule("../agent-ui/src/lib/models/modelOptions.ts");
const fallback = loader.loadModule("../agent-ui/src/lib/providers/webSearchFallback.ts");

for (const type of ["deepseek", "codex"]) {
  for (const available of [true, false]) {
    for (const nativeWebSearchSupported of [undefined, false, true]) {
      test(`${type}: model switches preserve Flash and fallback (available=${available}, native=${nativeWebSearchSupported})`, () => {
        fallback.recordWebSearchFallbackState({ available, provider: "searxng" });
        try {
          const provider = normalizeCustomProvider({
            id: "mixed", name: "Mixed", type, requestFormat: "openai-completions",
            models: ["deepseek-flash", "deepseek-pro", "fixture-model"],
            activeModels: ["deepseek-flash", "deepseek-pro", "fixture-model"],
            nativeWebSearchSupported,
          });
          const options = buildModelOptions({ customProviders: [provider] });
          for (const option of [...options, options[0]]) {
            const native = option.model === "deepseek-flash" || nativeWebSearchSupported === true;
            assert.equal(option.nativeWebSearchSupported, native);
            assert.equal(fallback.resolveWebSearchToggle({ nativeSupported: native, fallback: { available, provider: "searxng" } }).via, native ? "native" : available ? "fallback" : null);
            for (const enabled of [true, false]) {
              for (const thinkingEnabled of [true, false]) {
                const controls = Object.freeze({ ...DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: enabled, thinkingEnabled });
                const expected = enabled && (native || available);
                assert.equal(normalizeChatRuntimeControlsForProvider(controls, {
                  providerId: type, requestFormat: provider.requestFormat, modelId: option.model,
                  nativeWebSearchSupported,
                }).nativeWebSearchEnabled, expected);
                assert.equal(createProviderRuntimeConfig(provider, option.model, controls).nativeWebSearchEnabled, expected);
                assert.equal(controls.nativeWebSearchEnabled, enabled);
              }
            }
          }
        } finally {
          fallback.recordWebSearchFallbackState(null);
        }
      });
    }
  }
}

for (const type of ["deepseek", "codex"]) {
  for (const model of ["deepseek-flash", "deepseek-chat", "deepseek-pro", "deepseek-v4-flash", "gpt-4o-search-preview"]) {
    test(`${type}/${model} only enables the documented Flash server tools`, () => {
      const provider = normalizeCustomProvider({ id: "deepseek", name: "DeepSeek", type, requestFormat: "openai-completions", baseUrl: "https://relay.test/v1", models: [model], activeModels: [model] });
      assert.equal(buildModelOptions({ customProviders: [provider] })[0].nativeWebSearchSupported, model === "deepseek-flash");
      for (const enabled of [true, false]) {
        for (const thinkingEnabled of [true, false]) {
          const controls = Object.freeze({ ...DEFAULT_CHAT_RUNTIME_CONTROLS, nativeWebSearchEnabled: enabled, thinkingEnabled });
          const expected = enabled && model === "deepseek-flash";
          const normalized = normalizeChatRuntimeControlsForProvider(controls, { providerId: type, requestFormat: provider.requestFormat, modelId: model });
          const runtime = createProviderRuntimeConfig(provider, model, controls);
          assert.equal(normalized.nativeWebSearchEnabled, expected);
          assert.equal(runtime.nativeWebSearchEnabled, expected);
          assert.equal(providerSupportsNativeWebSearch(type, resolveProviderApi(type, provider.requestFormat), { modelId: model }), model === "deepseek-flash");
          assert.equal(controls.nativeWebSearchEnabled, enabled);
        }
      }
    });
  }
}
