import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();

test("host and provider runtime are always K-brain", () => {
  const host = loader.loadModule("src/lib/host.ts");
  const runtime = loader.loadModule("src/lib/providers/runtime/providerRuntimeConfig.ts");
  assert.equal(host.isKBrainBackendEnabled(), true);
  assert.equal(host.isKBrainBrowserHost(), true);
  assert.equal(runtime.getProviderRuntimeBackend(), "kbrain");
});

test("main waits for backend readiness before dynamically importing App", () => {
  const source = readFileSync(new URL("../../src/main.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import App from ["']\.\/App["']/);
  assert.match(source, /await connectKBrainBackendWithRetry\(\)/);
  assert.match(source, /await import\(["']\.\/App["']\)/);
  assert.match(source, /notifyFrontendReady\(\)/);
});
