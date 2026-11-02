import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

const source = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));
const device = Intl.DateTimeFormat().resolvedOptions().timeZone;
const backendZone = device === "Pacific/Auckland" ? "America/New_York" : "Pacific/Auckland";

// Two remote agents behind the Gateway: one follows the system, one has a custom zone.
const agents = {
  remote: { preference: "", zone: backendZone },
  custom: { preference: "Europe/Paris", zone: "Europe/Paris" },
};
let active = "remote";
const calls = [];
const socket = {
  getActiveAgent: () => active,
  async planningManage(action) {
    calls.push(`${active}:${action}`);
    const agent = agents[active];
    if (action === "query") return { seq: 1, timeZone: agent.zone };
    return { preference: agent.preference, timeZone: agent.zone, systemTimeZone: backendZone, revision: 1 };
  },
};
const loader = createWebModuleLoader({
  mocks: {
    [source("src/lib/gatewaySocket.ts")]: { getGatewayWebSocketClient: () => socket },
    [source("src/lib/storage.ts")]: { loadToken: () => "gateway-token" },
  },
});
const { backend } = loader.loadModule("src/lib/planning/backend.ts");

test("Gateway WebUI calendar follows this computer's zone like the direct browser host", async () => {
  assert.equal((await backend.call("query", {})).timeZone, device, "automatic shows this computer, not the remote host");
  const settings = await backend.call("timezone.get");
  assert.equal(settings.timeZone, device);
  assert.equal(settings.systemTimeZone, device);
  assert.ok(!calls.some((c) => c.endsWith(":timezone")), "the shared preference is never written");

  // Switching to another remote agent reads that agent's own preference.
  active = "custom";
  assert.equal((await backend.call("query", {})).timeZone, "Europe/Paris");
  assert.ok(calls.includes("custom:timezone.get"));
  active = "remote";
  assert.equal((await backend.call("query", {})).timeZone, device);
});
