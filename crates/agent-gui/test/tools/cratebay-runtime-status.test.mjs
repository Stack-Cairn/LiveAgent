import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const runtimeStatus = loader.loadModule("src/lib/cratebay/runtimeStatus.ts");

test("CrateBay runtime summary normalizes camelCase CLI payloads", () => {
  assert.deepEqual(
    runtimeStatus.normalizeCrateBayRuntimeSummary({
      state: "ready",
      engineResponsive: true,
      engine: {
        name: "CrateBay Engine",
        backendRuntime: "containerd",
        ociRuntime: "runc",
        networkStack: "CNI",
        api: "cratebay.engine.v1",
      },
    }),
    {
      state: "ready",
      engineResponsive: true,
      engineName: "CrateBay Engine",
      backendRuntime: "containerd",
      ociRuntime: "runc",
      networkStack: "CNI",
      engineApi: "cratebay.engine.v1",
    },
  );
});

test("CrateBay runtime summary normalizes snake_case compatibility payloads", () => {
  assert.deepEqual(
    runtimeStatus.normalizeCrateBayRuntimeSummary({
      state: "starting",
      engine_responsive: false,
      engine: {
        backend_runtime: "containerd-shim",
        oci_runtime: "youki",
        network_stack: "CNI bridge",
      },
    }),
    {
      state: "starting",
      engineResponsive: false,
      engineName: "CrateBay Engine",
      backendRuntime: "containerd-shim",
      ociRuntime: "youki",
      networkStack: "CNI bridge",
      engineApi: "cratebay.engine.v1",
    },
  );
});

test("CrateBay runtime summary falls back when runtime JSON is unavailable", () => {
  assert.deepEqual(runtimeStatus.normalizeCrateBayRuntimeSummary(null, "not installed"), {
    state: "not installed",
    engineResponsive: undefined,
    engineName: "CrateBay Engine",
    backendRuntime: "containerd",
    ociRuntime: "runc",
    networkStack: "CNI",
    engineApi: "cratebay.engine.v1",
  });
});
