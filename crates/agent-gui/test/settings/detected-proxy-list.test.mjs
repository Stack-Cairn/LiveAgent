import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const locale = { locale: "en-US", t: (key) => key };
let handleInvoke = async () => {
  throw new Error("invoke not stubbed");
};
const calls = [];
const env = await createDomTestEnv({
  mocks: {
    "@liveagent/ui/i18n/index": { useLocale: () => locale },
    "@liveagent/ui/components/IconSet": { RefreshCw: () => null },
    "@liveagent/app/shims/tauriCore": {
      invoke: (command, args) => {
        calls.push({ command, args });
        return handleInvoke(command, args);
      },
    },
  },
});
const { DetectedProxyList } = env.loadModule("@liveagent/ui/pages/settings/DetectedProxyList.tsx");

const flashCore = {
  id: "http://127.0.0.1:7890",
  type: "http",
  host: "127.0.0.1",
  port: 7890,
  processName: "FlClashCore",
  sources: ["os", "listen"],
  authRequired: false,
};
const routerSocks = {
  id: "socks5://192.168.1.1:7891",
  type: "socks5",
  host: "192.168.1.1",
  port: 7891,
  processName: null,
  sources: ["gateway"],
  authRequired: true,
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount(current, onSelect = () => {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  await env.act(async () =>
    root.render(env.React.createElement(DetectedProxyList, { current, onSelect })),
  );
  return {
    host,
    buttons: () => [...host.querySelectorAll("li button")],
    unmount: async () => {
      await env.act(async () => root.unmount());
      host.remove();
    },
  };
}

const settle = () => env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const noProxy = { type: "http", host: "", port: 0 };

test("lists detected services, fills in latency as tests finish, and fills the form on click", async () => {
  calls.length = 0;
  const slowTest = deferred();
  handleInvoke = async (command, args) => {
    if (command === "system_proxy_detect") return { candidates: [flashCore, routerSocks] };
    if (args.input.port === 7890) return { ok: true, latencyMs: 86, error: null };
    return slowTest.promise;
  };
  const selected = [];
  const view = await mount({ type: "http", host: "127.0.0.1 ", port: 7890 }, (proxy) =>
    selected.push(proxy),
  );
  await settle();

  const [first, second] = view.buttons();
  assert.equal(view.buttons().length, 2);
  assert.match(first.textContent, /HTTP127\.0\.0\.1:7890· FlClashCore· 86ms/);
  assert.equal(first.getAttribute("aria-pressed"), "true", "matches the current config");
  assert.match(first.textContent, /settings\.systemProxyDetectCurrent/);
  // 没有进程名的候选用来源名代替；测速未完成时显示测速中。
  assert.match(second.textContent, /SOCKS5192\.168\.1\.1:7891· settings\.systemProxySourceGateway/);
  assert.match(second.textContent, /settings\.systemProxyDetectTesting/);
  assert.match(second.textContent, /settings\.systemProxyDetectAuth/);
  assert.equal(second.getAttribute("aria-pressed"), "false");
  assert.deepEqual(
    calls.filter((call) => call.command === "system_proxy_test").map((call) => call.args),
    [
      { input: { type: "http", host: "127.0.0.1", port: 7890 } },
      { input: { type: "socks5", host: "192.168.1.1", port: 7891 } },
    ],
  );

  await env.act(async () => slowTest.resolve({ ok: false, latencyMs: null, error: "status:403" }));
  assert.match(second.textContent, /settings\.systemProxyDetectUnavailable/);
  assert.match(second.title, /settings\.systemProxyTestStatus/);

  await env.act(async () => second.click());
  assert.deepEqual(selected, [routerSocks]);
  await view.unmount();
});

test("a late test result from an earlier detection run is discarded", async () => {
  const firstRunTest = deferred();
  let run = 0;
  handleInvoke = async (command) => {
    if (command === "system_proxy_detect") {
      run += 1;
      return { candidates: [flashCore] };
    }
    return run === 1 ? firstRunTest.promise : { ok: false, latencyMs: null, error: "timeout" };
  };
  const view = await mount(noProxy);
  await settle();
  assert.match(view.buttons()[0].textContent, /settings\.systemProxyDetectTesting/);

  const again = [...view.host.querySelectorAll("button")].find((button) =>
    button.textContent.includes("settings.systemProxyDetectAgain"),
  );
  await env.act(async () => again.click());
  await settle();
  assert.match(view.buttons()[0].textContent, /settings\.systemProxyDetectUnavailable/);

  await env.act(async () => firstRunTest.resolve({ ok: true, latencyMs: 12, error: null }));
  assert.match(view.buttons()[0].textContent, /settings\.systemProxyDetectUnavailable/);
  assert.doesNotMatch(view.buttons()[0].textContent, /12ms/);
  await view.unmount();
});

test("shows the empty and failure states", async () => {
  handleInvoke = async () => ({ candidates: [] });
  let view = await mount(noProxy);
  await settle();
  assert.match(view.host.textContent, /settings\.systemProxyDetectEmpty/);
  assert.equal(view.buttons().length, 0);
  await view.unmount();

  handleInvoke = async () => {
    throw new Error("gateway offline");
  };
  view = await mount(noProxy);
  await settle();
  assert.match(view.host.textContent, /settings\.systemProxyDetectFailed/);
  await view.unmount();
});
