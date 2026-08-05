import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const searchStatus = loader.loadModule("src/lib/chat/search/providerNativeSearchStatus.ts");

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("provider native search status resolves only for enabled hosted search providers", () => {
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "codex",
      api: "openai-responses",
      enabled: true,
    }),
    searchStatus.PROVIDER_NATIVE_WEB_SEARCH_STATUS,
  );
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "claude_code",
      api: "anthropic-messages",
      enabled: true,
    }),
    searchStatus.PROVIDER_NATIVE_WEB_SEARCH_STATUS,
  );
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "gemini",
      api: "google-generative-ai",
      enabled: true,
    }),
    searchStatus.PROVIDER_NATIVE_WEB_SEARCH_STATUS,
  );
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "codex",
      api: "openai-completions",
      enabled: true,
    }),
    null,
  );
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "codex",
      api: "openai-completions",
      enabled: true,
      baseUrl: "https://api.example.test/v1",
      modelId: "deepseek-v4-flash",
    }),
    searchStatus.PROVIDER_NATIVE_WEB_SEARCH_STATUS,
  );
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "codex",
      api: "openai-completions",
      enabled: true,
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-search-preview",
    }),
    searchStatus.PROVIDER_NATIVE_WEB_SEARCH_STATUS,
  );
  assert.equal(
    searchStatus.resolveProviderNativeWebSearchStatus({
      providerId: "codex",
      api: "openai-responses",
      enabled: false,
    }),
    null,
  );
});

test("deferred provider native search status clears and reschedules around visible activity", async () => {
  const events = [];
  const controller = searchStatus.createDeferredProviderNativeWebSearchStatus({
    status: "searching",
    delayMs: 0,
    onStatus: (status) => events.push(status),
  });

  controller.schedule();
  await wait();
  assert.deepEqual(events, ["searching"]);

  controller.noteVisibleActivity();
  assert.deepEqual(events, ["searching", null]);
  await wait();
  assert.deepEqual(events, ["searching", null, "searching"]);

  controller.finish();
  assert.deepEqual(events, ["searching", null, "searching", null]);
});

test("deferred provider native search status is not armed by ordinary visible activity", async () => {
  const events = [];
  const controller = searchStatus.createDeferredProviderNativeWebSearchStatus({
    status: "searching",
    delayMs: 0,
    onStatus: (status) => events.push(status),
  });

  controller.noteVisibleActivity();
  await wait();
  assert.deepEqual(events, []);

  controller.schedule();
  await wait();
  assert.deepEqual(events, ["searching"]);
});

test("deferred provider native search status is inert without a status", async () => {
  const events = [];
  const controller = searchStatus.createDeferredProviderNativeWebSearchStatus({
    status: null,
    delayMs: 0,
    onStatus: (status) => events.push(status),
  });

  controller.schedule();
  controller.noteVisibleActivity();
  controller.pause();
  controller.finish();
  await wait();
  assert.deepEqual(events, []);
});
