import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    "@tauri-apps/api/core": {
      invoke(command) {
        if (command === "proxy_get_server_info") {
          return Promise.resolve({ baseUrl: "http://proxy.local:9999", token: "proxy-token" });
        }
        throw new Error(`unexpected invoke(${command})`);
      },
    },
  },
});
const providerUtils = loader.loadModule("src/pages/settings/providerUtils.ts");

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(JSON.stringify(payload)),
  };
}

function withFetchStub(responder, run) {
  const calls = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    calls.push({ url: String(url), options });
    return Promise.resolve(responder(String(url), calls.length));
  };
  return Promise.resolve()
    .then(() => run(calls))
    .finally(() => {
      if (previousFetch === undefined) delete globalThis.fetch;
      else globalThis.fetch = previousFetch;
    });
}

test("buildProviderModelsUrl defaults to /v1/models and falls back to official endpoints", () => {
  assert.equal(
    providerUtils.buildProviderModelsUrl("gemini", "https://relay.example.com", "default"),
    "https://relay.example.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("gemini", "https://relay.example.com", "official"),
    "https://relay.example.com/v1beta/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl(
      "gemini",
      "https://generativelanguage.googleapis.com/v1beta",
      "default",
    ),
    "https://generativelanguage.googleapis.com/v1beta/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("claude_code", "https://relay.example.com", "default"),
    "https://relay.example.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("claude_code", "https://relay.example.com", "official"),
    "https://relay.example.com/v1/models",
  );
  assert.equal(
    providerUtils.buildProviderModelsUrl("codex", "https://relay.example.com/v1", "default"),
    "https://relay.example.com/v1/models",
  );
});

test("provider model URL safety helpers identify local network targets", () => {
  assert.equal(providerUtils.isProviderModelsPrivateAddress("http://10.66.0.1:8787"), true);
  assert.equal(providerUtils.isProviderModelsPrivateAddress("http://10.66.0.1:8787/v1"), true);
  assert.equal(providerUtils.isProviderModelsPrivateAddress("http://127.0.0.1:11434"), true);
  assert.equal(providerUtils.isProviderModelsPrivateAddress("http://localhost:11434"), true);
  assert.equal(providerUtils.isProviderModelsPrivateAddress("https://api.example.com"), false);
  assert.equal(
    providerUtils.providerModelsConfirmationKey("HTTP://10.66.0.1:8787/v1"),
    "http://10.66.0.1:8787",
  );
});

test("buildProviderModelsAttempts orders default before official with provider headers", () => {
  const gemini = providerUtils.buildProviderModelsAttempts(
    "gemini",
    "https://relay.example.com",
    "test-key",
  );
  assert.equal(gemini.length, 2);
  assert.deepEqual(
    gemini.map((attempt) => attempt.kind),
    ["default", "official"],
  );
  assert.equal(gemini[0].headers.Authorization, "Bearer test-key");
  assert.equal(gemini[0].headers["x-goog-api-key"], "test-key");
  assert.equal(gemini[1].headers.Authorization, undefined);
  assert.equal(gemini[1].headers["x-goog-api-key"], "test-key");

  const claude = providerUtils.buildProviderModelsAttempts(
    "claude_code",
    "https://relay.example.com",
    "test-key",
  );
  assert.equal(claude.length, 2);
  assert.equal(claude[0].headers.Authorization, "Bearer test-key");
  assert.equal(claude[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(claude[1].headers.Authorization, undefined);
  assert.equal(claude[1].headers["x-api-key"], "test-key");
  assert.equal(claude[1].headers["anthropic-version"], "2023-06-01");

  const codex = providerUtils.buildProviderModelsAttempts(
    "codex",
    "https://relay.example.com",
    "test-key",
  );
  assert.equal(codex.length, 2);
  assert.equal(codex[0].headers["x-api-key"], "test-key");
  assert.equal(codex[1].headers["x-api-key"], undefined);
  assert.equal(codex[1].headers.Authorization, "Bearer test-key");
});

test("pickProviderModelsFailure prefers informative errors over missing-endpoint noise", () => {
  assert.deepEqual(
    providerUtils.pickProviderModelsFailure([
      { status: 401, message: "invalid api key" },
      { status: 404, message: "not found" },
    ]),
    { status: 401, message: "invalid api key" },
  );
  assert.deepEqual(
    providerUtils.pickProviderModelsFailure([
      { status: 404, message: "not found" },
      { status: 400, message: "api key invalid" },
    ]),
    { status: 400, message: "api key invalid" },
  );
  assert.deepEqual(
    providerUtils.pickProviderModelsFailure([
      { status: 404, message: "first" },
      { status: 404, message: "second" },
    ]),
    { status: 404, message: "second" },
  );
  assert.equal(providerUtils.pickProviderModelsFailure([]), null);
});

test("fetchModelsFromApi falls back to the official gemini endpoint on 404", async () => {
  await withFetchStub(
    (url) =>
      url.includes("/v1/models")
        ? jsonResponse(404, { error: "not found" })
        : jsonResponse(200, { models: [{ name: "models/gemini-2.5-pro" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "gemini",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 2);
      assert.ok(calls[0].url.endsWith("/proxy/gemini/v1/models"));
      assert.ok(calls[1].url.endsWith("/proxy/gemini/v1beta/models"));
      assert.deepEqual(
        models.map((model) => model.id),
        ["gemini-2.5-pro"],
      );
    },
  );
});

test("fetchModelsFromApi returns the default /v1/models result without falling back", async () => {
  await withFetchStub(
    () => jsonResponse(200, { data: [{ id: "gpt-5" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "codex",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 1);
      assert.ok(calls[0].url.endsWith("/proxy/codex/v1/models"));
      assert.deepEqual(
        models.map((model) => model.id),
        ["gpt-5"],
      );
    },
  );
});

test("fetchModelsFromApi falls back to official when the default list is empty", async () => {
  await withFetchStub(
    (url) =>
      url.includes("/v1/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(200, { models: [{ name: "models/gemini-2.5-flash" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "gemini",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 2);
      assert.deepEqual(
        models.map((model) => model.id),
        ["gemini-2.5-flash"],
      );
    },
  );
});

test("fetchModelsFromApi surfaces the informative failure when every attempt fails", async () => {
  await withFetchStub(
    (url) =>
      url.includes("/v1/models")
        ? jsonResponse(401, { error: "invalid api key" })
        : jsonResponse(404, { error: "not found" }),
    async (calls) => {
      await assert.rejects(
        providerUtils.fetchModelsFromApi("gemini", "https://relay.example.com", "test-key"),
        /invalid api key/,
      );
      assert.equal(calls.length, 2);
    },
  );
});

test("fetchModelsFromApi retries claude_code with official anthropic headers", async () => {
  await withFetchStub(
    (_url, callIndex) =>
      callIndex === 1
        ? jsonResponse(401, { error: "authorization header rejected" })
        : jsonResponse(200, { data: [{ id: "claude-opus-4-8" }] }),
    async (calls) => {
      const models = await providerUtils.fetchModelsFromApi(
        "claude_code",
        "https://relay.example.com",
        "test-key",
      );
      assert.equal(calls.length, 2);
      assert.equal(calls[0].options.headers.Authorization, "Bearer test-key");
      assert.equal(calls[1].options.headers.Authorization, undefined);
      assert.equal(calls[1].options.headers["x-api-key"], "test-key");
      assert.deepEqual(
        models.map((model) => model.id),
        ["claude-opus-4-8"],
      );
    },
  );
});
