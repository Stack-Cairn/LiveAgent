// Third review regressions for the K-brain memory master switch (MemorySwitch.tsx, ce6c90ab).
// Drives the shipped MemorySwitch through the real desktop kbrainSettingsAdapter and
// runtimeConnection module against a local HTTP K-brain stand-in.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const unhandled = [];
process.on("unhandledRejection", (reason) => unhandled.push(reason));

// put: "ok" | "lost" (write applied, response 503) | "rejected" (not applied, 503)
// afterPut: "ok" | "down" (every later request 503) | "unsupported" (capability gone)
function startKBrain() {
  const state = { enabled: true, down: false, supported: true, put: "ok", afterPut: "ok", puts: 0 };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      res.setHeader("Content-Type", "application/json");
      const fail = () => {
        res.statusCode = 503;
        res.end("K-brain unavailable");
      };
      if (state.down) return fail();
      if (req.url === "/v1/health") {
        res.end(
          JSON.stringify({
            status: "ok",
            version: "kbrain.agent.v1",
            capabilities: state.supported ? { memory_switch: 1 } : {},
          }),
        );
        return;
      }
      if (req.url === "/v1/settings") {
        if (req.method === "PUT") {
          state.puts += 1;
          const outcome = state.put;
          if (outcome !== "rejected") state.enabled = JSON.parse(body).memory.enabled;
          if (state.afterPut === "down") state.down = true;
          if (state.afterPut === "unsupported") state.supported = false;
          if (outcome !== "ok") return fail();
        }
        res.end(
          JSON.stringify({
            mode: "kbrain",
            defaultModel: "",
            defaultProvider: "",
            providers: [],
            models: [],
            ...(state.supported ? { memory: { enabled: state.enabled } } : {}),
          }),
        );
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })),
  );
}

async function mount({ port, connect = true }) {
  const toasts = [];
  const env = await createDomTestEnv({
    mocks: {
      "@liveagent/ui/components/ui/toast-manager": {
        toast: { error: (m) => toasts.push(m), success() {} },
      },
    },
  });
  const connection = env.loadModule("@liveagent/app/lib/kbrain/runtimeConnection.ts");
  const { kbrainSettingsAdapter } = env.loadModule("@liveagent/adapters/kbrainSettings.ts");
  const { MemorySwitch } = env.loadModule("@liveagent/ui/pages/settings/memory/MemorySwitch.tsx");
  const connectTo = (p) =>
    connection.setKBrainRuntimeConnection({
      baseUrl: `http://127.0.0.1:${p}`,
      token: "t",
      protocolVersion: "kbrain.agent.v1",
    });
  if (connect) connectTo(port);
  else connection.clearKBrainRuntimeConnection();
  const events = [];
  window.addEventListener("kbrain:settings-changed", () => events.push(Date.now()));
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  await env.act(async () =>
    root.render(env.React.createElement(MemorySwitch, { kbrain: kbrainSettingsAdapter })),
  );
  const tick = () =>
    env.act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  const settle = async () => {
    for (let i = 0; i < 15; i += 1) await tick();
  };
  const toggle = () => host.querySelector('[role="switch"]');
  const dispose = async () => {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  };
  return { env, toasts, events, toggle, settle, connectTo, dispose };
}

test("review3: switch hidden because K-brain was down at mount comes back after another section's save", async () => {
  const { server, state, port } = await startKBrain();
  state.down = true;
  const m = await mount({ port });
  try {
    await m.settle();
    assert.equal(m.toggle(), null, "hidden before the first answer");
    state.down = false;
    await m.env.act(async () => {
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    });
    await m.settle();
    assert.ok(m.toggle(), "switch reappears once K-brain answers");
    assert.equal(m.toggle().getAttribute("aria-checked"), "true");
  } finally {
    await m.dispose();
    server.close();
  }
});

// change() table after a click true -> false:
// [put, afterPut, expected aria-checked (null = row hidden), toast?, event?]
const cases = [
  ["ok", "ok", "false", false, true],
  ["lost", "ok", "false", false, true],
  ["rejected", "ok", "true", true, false],
  ["lost", "down", "true", true, false],
  ["rejected", "down", "true", true, false],
  ["lost", "unsupported", null, true, true],
  ["rejected", "unsupported", null, true, true],
];
for (const [put, afterPut, checked, toast, event] of cases) {
  test(`review3: save put=${put} read-back=${afterPut} -> checked=${checked} toast=${toast} event=${event}`, async () => {
    const { server, state, port } = await startKBrain();
    const m = await mount({ port });
    try {
      await m.settle();
      assert.equal(m.toggle().getAttribute("aria-checked"), "true");
      state.put = put;
      state.afterPut = afterPut;
      await m.env.act(async () => m.toggle().click());
      await m.settle();
      assert.equal(state.puts, 1);
      if (checked === null) assert.equal(m.toggle(), null);
      else {
        assert.equal(m.toggle().getAttribute("aria-checked"), checked);
        assert.equal(m.toggle().hasAttribute("data-disabled"), false, "usable again");
      }
      assert.equal(m.toasts.length > 0, toast, "toast");
      assert.equal(m.events.length > 0, event, "kbrain:settings-changed");
      assert.deepEqual(unhandled, [], "no unhandled rejection");
    } finally {
      await m.dispose();
      server.close();
    }
  });
}

test("review3: no unhandled rejection across a not-ready initial load and a failed refresh", async () => {
  const { server, state, port } = await startKBrain();
  const m = await mount({ port, connect: false });
  try {
    await m.settle();
    m.connectTo(port);
    state.down = true;
    await m.env.act(async () => {
      window.dispatchEvent(new Event("kbrain:settings-changed"));
    });
    await m.settle();
    assert.equal(m.toggle(), null);
    assert.deepEqual(unhandled, []);
  } finally {
    await m.dispose();
    server.close();
  }
});
