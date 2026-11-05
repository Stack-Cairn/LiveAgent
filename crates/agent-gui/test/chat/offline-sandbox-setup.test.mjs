// Windows offline sandbox setup (K-brain capability sandbox_setup, POST /v1/sandbox/setup):
// what the desktop reads from health, how each response status is reported, and that a
// finished setup refreshes the capability every mounted selector sees.
import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const env = await createDomTestEnv();
window.__TAURI_INTERNALS__ = {};
const { sandboxCapabilityFromHealth, setUpOfflineSandbox, useSandboxCapability } = env.loadModule(
  "src/agent-ui-adapters/sandboxCapability",
);
const { offersRunSandboxSetup, supportsRunSandbox } = env.loadModule(
  "@liveagent/ui/lib/kbrain/health",
);
const { sandboxSetupOutcome } = env.loadModule("@liveagent/ui/lib/kbrain/sandboxSetup");
const { setKBrainRuntimeConnection } = env.loadModule("src/lib/kbrain/runtimeConnection");

const HINT = "Run sandbox setup to enable offline sandboxing and workspace isolation";
const lowIntegrity = {
  supported: true,
  mechanism: "low-integrity",
  platform: "windows",
  network_control: false,
  read_masking: true,
  path_protection: true,
  setup_available: true,
  setup_hint: HINT,
};
const sandboxUser = {
  ...lowIntegrity,
  mechanism: "sandbox-user",
  network_control: true,
  setup_hint: "",
};

test("the desktop offers setup only when K-brain can run it and the network cannot be cut yet", () => {
  const windows = sandboxCapabilityFromHealth({
    capabilities: { sandbox_setup: 1, run_sandbox: lowIntegrity },
  });
  assert.deepEqual(windows, {
    supported: true,
    mechanism: "low-integrity",
    platform: "windows",
    network_control: false,
    read_masking: true,
    path_protection: true,
    setup_available: true,
    setup_hint: HINT,
  });

  // A backend that predates sandbox_setup, or reports the fields without it, offers nothing.
  for (const capabilities of [
    { run_sandbox: lowIntegrity },
    { sandbox_setup: 2, run_sandbox: lowIntegrity },
    { sandbox_setup: 1, run_sandbox: { ...lowIntegrity, setup_available: false } },
    { sandbox_setup: 1, run_sandbox: { ...lowIntegrity, setup_available: undefined } },
    // After setup: sandbox-user cuts the network.
    { sandbox_setup: 1, run_sandbox: sandboxUser },
    // Protected paths left writable stay unavailable (#1235); setup is no fix for that.
    { sandbox_setup: 1, run_sandbox: { ...lowIntegrity, path_protection: false } },
    // Old K-brain without run_sandbox at all.
    { sandbox_setup: 1 },
  ]) {
    const capability = sandboxCapabilityFromHealth({ capabilities });
    assert.equal("setup_available" in capability, false, JSON.stringify(capabilities));
    assert.equal("setup_hint" in capability, false, JSON.stringify(capabilities));
    assert.equal(offersRunSandboxSetup({ capabilities }), false, JSON.stringify(capabilities));
  }
  const unprotected = sandboxCapabilityFromHealth({
    capabilities: { sandbox_setup: 1, run_sandbox: { ...lowIntegrity, path_protection: false } },
  });
  assert.equal(unprotected.supported, false);
  assert.equal(unprotected.path_protection, false);

  // A sandbox the backend cannot run yet may still be fixed by setup.
  assert.equal(
    offersRunSandboxSetup({
      capabilities: { sandbox_setup: 1, run_sandbox: { ...lowIntegrity, supported: false } },
    }),
    true,
  );
  // The UAC prompt appears where K-brain runs: a remote backend never offers it.
  const remote = sandboxCapabilityFromHealth(
    { capabilities: { sandbox_setup: 1, run_sandbox: lowIntegrity } },
    { setupHost: false },
  );
  assert.equal("setup_available" in remote, false);
  // An empty hint is left out.
  const noHint = sandboxCapabilityFromHealth({
    capabilities: { sandbox_setup: 1, run_sandbox: { ...lowIntegrity, setup_hint: " " } },
  });
  assert.equal(noHint.setup_available, true);
  assert.equal("setup_hint" in noHint, false);

  // The run gate is unchanged: offline needs network control, path protection still counts.
  assert.equal(supportsRunSandbox({ capabilities: { run_sandbox: lowIntegrity } }, { network: false }), false);
  assert.equal(supportsRunSandbox({ capabilities: { run_sandbox: sandboxUser } }, { network: false }), true);
});

test("each setup response status maps to its own outcome", () => {
  assert.deepEqual(
    sandboxSetupOutcome(200, { version: "kbrain.agent.v1", status: { installed: true, active: true }, run_sandbox: sandboxUser }),
    { status: "ready" },
  );
  // Installed but the self-test still fails: K-brain's hint says why.
  assert.deepEqual(
    sandboxSetupOutcome(200, {
      status: { installed: true, active: false, problem: "offline account reached loopback" },
      run_sandbox: { ...lowIntegrity, setup_hint: "Sandbox self-test failed; rerun setup" },
    }),
    { status: "incomplete", hint: "Sandbox self-test failed; rerun setup" },
  );
  assert.deepEqual(
    sandboxSetupOutcome(200, { status: { problem: "offline account reached loopback" }, run_sandbox: { ...lowIntegrity, setup_hint: "" } }),
    { status: "incomplete", hint: "offline account reached loopback" },
  );
  assert.deepEqual(
    sandboxSetupOutcome(403, { code: "declined", error: "administrator approval was declined" }),
    { status: "declined" },
  );
  assert.deepEqual(sandboxSetupOutcome(409, { code: "busy", error: "sandbox setup is already running" }), {
    status: "busy",
  });
  assert.deepEqual(
    sandboxSetupOutcome(500, { code: "failed", error: "creating account KBrainSbx-1a2b3c-Off: access denied" }),
    { status: "failed", message: "creating account KBrainSbx-1a2b3c-Off: access denied" },
  );
  assert.deepEqual(sandboxSetupOutcome(500, "setup crashed\n"), { status: "failed", message: "setup crashed" });
  assert.deepEqual(sandboxSetupOutcome(500, {}), { status: "failed" });
  assert.deepEqual(sandboxSetupOutcome(501, { code: "unsupported", error: "sandbox setup is only available on Windows" }), {
    status: "unsupported",
  });
  assert.deepEqual(sandboxSetupOutcome(405, ""), { status: "error", message: "K-brain request failed (405)" });
  assert.deepEqual(sandboxSetupOutcome(401, { error: "unauthorized" }), { status: "error", message: "unauthorized" });
});

function backend(setupStatus, setupBody, afterSetup) {
  const calls = [];
  let runSandbox = lowIntegrity;
  let revision = 4;
  globalThis.fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? "GET", auth: init.headers?.Authorization });
    if (path === "/v1/sandbox/setup") {
      if (setupStatus !== 501) {
        revision += 1;
        if (afterSetup) runSandbox = afterSetup;
      }
      if (setupStatus === "drop") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(setupBody), { status: setupStatus });
    }
    if (path === "/v1/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          version: "kbrain.agent.v1",
          protocol: { name: "kbrain.agent", major: 1, minor: 3 },
          capabilityRevision: revision,
          capabilities: { sandbox_setup: 1, run_sandbox: runSandbox },
        }),
        { status: 200 },
      );
    }
    return new Response("not found", { status: 404 });
  };
  return calls;
}

async function mountProbe() {
  const seen = [];
  function Probe() {
    seen.push(useSandboxCapability());
    return null;
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(container);
  await env.act(async () => root.render(env.React.createElement(Probe)));
  await env.act(async () => {});
  return {
    latest: () => seen.at(-1),
    close: async () => {
      await env.act(async () => root.unmount());
      container.remove();
    },
  };
}

test("a successful setup re-reads health and the offline sandbox becomes selectable", async () => {
  setKBrainRuntimeConnection({ baseUrl: "http://127.0.0.1:47321", token: "secret", protocolVersion: "kbrain.agent.v1" });
  const calls = backend(200, { version: "kbrain.agent.v1", status: { installed: true }, run_sandbox: sandboxUser }, sandboxUser);
  const probe = await mountProbe();
  try {
    assert.equal(probe.latest().setup_available, true);
    assert.equal(probe.latest().network_control, false);
    let outcome;
    await env.act(async () => {
      outcome = await setUpOfflineSandbox();
    });
    assert.deepEqual(outcome, { status: "ready" });
    const setup = calls.find((call) => call.path === "/v1/sandbox/setup");
    assert.equal(setup.method, "POST");
    assert.equal(setup.auth, "Bearer secret");
    assert.equal(calls.at(-1).path, "/v1/health", "health is read again after setup");
    assert.equal(probe.latest().network_control, true);
    assert.equal(probe.latest().mechanism, "sandbox-user");
    assert.equal("setup_available" in probe.latest(), false, "the setup action goes away");
  } finally {
    await probe.close();
  }
});

test("declined, busy and failed setups still re-read health; unsupported does not", async () => {
  for (const [status, body, expected, rereads] of [
    [403, { code: "declined", error: "administrator approval was declined" }, { status: "declined" }, true],
    [409, { code: "busy", error: "sandbox setup is already running" }, { status: "busy" }, true],
    [500, { code: "failed", error: "WFP filter add failed" }, { status: "failed", message: "WFP filter add failed" }, true],
    [501, { code: "unsupported", error: "not windows" }, { status: "unsupported" }, false],
    ["drop", null, { status: "error", message: "Failed to fetch" }, true],
  ]) {
    const calls = backend(status, body);
    const outcome = await setUpOfflineSandbox();
    assert.deepEqual(outcome, expected, String(status));
    const after = calls.slice(calls.findIndex((call) => call.path === "/v1/sandbox/setup") + 1);
    assert.equal(after.some((call) => call.path === "/v1/health"), rereads, String(status));
  }
});

test("a finished setup whose self-test still fails reports the refreshed hint", async () => {
  const stillLow = { ...lowIntegrity, setup_hint: "Sandbox self-test failed: offline account reached loopback; rerun setup" };
  backend(200, { status: { installed: true, active: false }, run_sandbox: stillLow }, stillLow);
  assert.deepEqual(await setUpOfflineSandbox(), { status: "incomplete", hint: stillLow.setup_hint });
});

test("a remote K-brain never offers setup", async () => {
  setKBrainRuntimeConnection({ baseUrl: "http://192.168.1.20:47321", token: "t", protocolVersion: "kbrain.agent.v1" });
  backend(200, {});
  const { refreshSandboxCapability } = env.loadModule("src/agent-ui-adapters/sandboxCapability");
  const capability = await refreshSandboxCapability();
  assert.equal("setup_available" in capability, false);
});
