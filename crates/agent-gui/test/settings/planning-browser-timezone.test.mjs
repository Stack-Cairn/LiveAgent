import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
// A backend zone that differs from this machine, like a remote K-brain host.
const backendZone = device === "Pacific/Auckland" ? "America/New_York" : "Pacific/Auckland";

test("automatic preference follows the browser zone; a custom zone is untouched", () => {
  const { followBrowserTimeZone } = createTsModuleLoader().loadModule("@liveagent/ui/lib/planning/browserTimeZone.ts");
  const settings = { preference: "", timeZone: backendZone, systemTimeZone: backendZone, revision: 1 };
  assert.deepEqual(followBrowserTimeZone("timezone.get", settings, "", "Asia/Shanghai"), {
    ...settings, timeZone: "Asia/Shanghai", systemTimeZone: "Asia/Shanghai",
  });
  assert.equal(followBrowserTimeZone("query", { timeZone: backendZone, seq: 2 }, "", "Asia/Shanghai").timeZone, "Asia/Shanghai");
  // Custom zone, unknown preference and other actions pass through unchanged.
  const custom = { preference: "Europe/Paris", timeZone: "Europe/Paris", systemTimeZone: backendZone };
  assert.equal(followBrowserTimeZone("timezone.get", custom, "Europe/Paris", "Asia/Shanghai"), custom);
  assert.equal(followBrowserTimeZone("query", { timeZone: backendZone }, null, "Asia/Shanghai").timeZone, backendZone);
  const exported = { timeZone: backendZone };
  assert.equal(followBrowserTimeZone("export", exported, "", "Asia/Shanghai"), exported);
});

test("browser Planning shows this computer's zone without writing the shared preference", async () => {
  const loader = createTsModuleLoader();
  loader.loadModule("src/lib/kbrain/runtimeConnection.ts").setKBrainRuntimeConnection({ baseUrl: "http://planning.test", token: "t", protocolVersion: "kbrain.agent.v1" });
  const { backend } = loader.loadModule("src/lib/planning/backend.ts");
  let preference = "";
  const actions = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const { action } = JSON.parse(init.body);
    actions.push(action);
    const body = action === "query"
      ? { seq: 1, timeZone: preference || backendZone }
      : { preference, timeZone: preference || backendZone, systemTimeZone: backendZone, revision: 1 };
    return { ok: true, json: async () => body };
  };
  try {
    assert.equal((await backend.call("query", {})).timeZone, device);
    const settings = await backend.call("timezone.get");
    assert.equal(settings.timeZone, device);
    assert.equal(settings.systemTimeZone, device, "the automatic label names this computer's zone");
    assert.ok(!actions.includes("timezone"), "the shared preference is never written");
    // A custom zone chosen in settings is shown as is.
    preference = "Europe/Paris";
    assert.equal((await backend.call("timezone", { preference })).timeZone, "Europe/Paris");
    assert.equal((await backend.call("query", {})).timeZone, "Europe/Paris");
  } finally {
    globalThis.fetch = original;
  }
});

test("the browser zone is read at startup; a change while running applies after a restart", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    const started = createTsModuleLoader().loadModule("@liveagent/ui/lib/planning/browserTimeZone.ts");
    assert.equal(started.startupTimeZone, "America/New_York");
    // The system zone changes while the page stays open.
    process.env.TZ = "Asia/Tokyo";
    assert.equal(started.browserTimeZone(), "Asia/Tokyo", "the live zone is still visible for the restart hint");
    assert.equal(started.followBrowserTimeZone("query", { timeZone: "UTC" }, "").timeZone, "America/New_York");
    // A restart reads the new zone.
    const restarted = createTsModuleLoader().loadModule("@liveagent/ui/lib/planning/browserTimeZone.ts");
    assert.equal(restarted.followBrowserTimeZone("query", { timeZone: "UTC" }, "").timeZone, "Asia/Tokyo");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
