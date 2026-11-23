import assert from "node:assert/strict";
import test from "node:test";
import { createWebModuleLoader } from "../helpers/load-web-module.mjs";

const loader = createWebModuleLoader();
const auth = loader.loadModule("src/lib/gatewayAuth.ts");
const storage = loader.loadModule("src/lib/storage.ts");

function installWindow(overrides = {}) {
  const store = new Map();
  globalThis.window = {
    location: { origin: "https://gateway.example" },
    localStorage: {
      getItem(key) {
        return store.has(key) ? store.get(key) : null;
      },
      setItem(key, value) {
        store.set(key, String(value));
      },
      removeItem(key) {
        store.delete(key);
      },
    },
    ...overrides,
  };
  return store;
}

test("normalizeGatewayAccessToken trims plain and Bearer-prefixed tokens", () => {
  assert.equal(auth.normalizeGatewayAccessToken("  plain-token  "), "plain-token");
  assert.equal(auth.normalizeGatewayAccessToken("Bearer secret-token"), "secret-token");
  assert.equal(auth.normalizeGatewayAccessToken(" bearer   secret-token  "), "secret-token");
  assert.equal(auth.normalizeGatewayAccessToken("   "), "");
});

test("verifyGatewayAccessToken sends normalized bearer header and maps unauthorized errors", async () => {
  installWindow();
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return {
      ok: false,
      async text() {
        return JSON.stringify({ error: "unauthorized" });
      },
    };
  };

  await assert.rejects(
    () => auth.verifyGatewayAccessToken("Bearer bad-token"),
    // The error carries the translation key; the login page renders it.
    /^Error: login\.errorTokenInvalid$/,
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://gateway.example/api/status");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer bad-token");
});

test("verifyGatewayAccessToken returns normalized token after successful status check", async () => {
  installWindow();
  globalThis.fetch = async () => ({
    ok: true,
    async text() {
      return "";
    },
  });

  const token = await auth.verifyGatewayAccessToken(" bearer   good-token ");
  assert.equal(token, "good-token");
});

test("gateway token storage persists and clears the single WebUI token key", () => {
  installWindow();

  assert.equal(storage.loadToken(), "");
  storage.saveToken("abc123");
  assert.equal(storage.loadToken(), "abc123");
  storage.clearToken();
  assert.equal(storage.loadToken(), "");
});
