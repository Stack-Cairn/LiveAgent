// 用真实 SystemSettingsForm + 真实 DetectedProxyList，只 mock 桌面 invoke，
// 核对点击检测到的代理后写进设置的内容。
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const iconSetMock = new Proxy({}, { get: () => () => null });
const iconSetPath = fileURLToPath(
  new URL("../../../agent-ui/src/components/IconSet.tsx", import.meta.url),
);

let handleInvoke = async () => {
  throw new Error("invoke not stubbed");
};
const env = await createDomTestEnv({
  mocks: {
    // 图标与本问题无关；~icons 的默认 mock 产出普通对象，真实 react-dom 无法渲染。
    "@liveagent/ui/components/IconSet": iconSetMock,
    [iconSetPath]: iconSetMock,
    "@liveagent/app/shims/tauriCore": {
      invoke: (command, args) => handleInvoke(command, args),
    },
    "@tauri-apps/api/core": {
      invoke: (command, args) => handleInvoke(command, args),
    },
  },
});
const settingsLib = env.loadModule("@liveagent/app/lib/settings");
const { SystemSettingsForm } = env.loadModule(
  "@liveagent/ui/pages/settings/SystemSettingsForm.tsx",
);

const settle = () => env.act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function mountForm(initialSystemProxy) {
  let current = settingsLib.normalizeSettings({ system: { systemProxy: initialSystemProxy } });
  const host = document.createElement("div");
  document.body.append(host);
  const root = env.createRoot(host);
  function Harness() {
    const [settings, setSettingsState] = env.React.useState(current);
    const setSettings = (updater) =>
      setSettingsState((prev) => {
        const next = typeof updater === "function" ? updater(prev) : updater;
        current = next;
        return next;
      });
    return env.React.createElement(SystemSettingsForm, { settings, setSettings });
  }
  await env.act(async () => root.render(env.React.createElement(Harness)));
  return {
    host,
    systemProxy: () => current.system.systemProxy,
    unmount: async () => {
      await env.act(async () => root.unmount());
      host.remove();
    },
  };
}

// 已为公司代理 proxy.corp.example:3128 保存了用户名密码；本机检测到一个不需要认证的
// 局域网/路由器代理，点它之后旧凭据仍留在配置里，下一次请求就会把公司账号以
// Proxy-Authorization 发给新主机（system_proxy::proxy_url 把凭据拼进代理 URL）。
test("selecting a detected proxy on another host does not carry the old proxy credentials", async () => {
  const router = {
    id: "http://192.168.1.1:7890",
    type: "http",
    host: "192.168.1.1",
    port: 7890,
    processName: null,
    sources: ["gateway"],
    authRequired: false,
  };
  handleInvoke = async (command) => {
    if (command === "system_proxy_detect") return { candidates: [router] };
    if (command === "system_proxy_test") return { ok: true, latencyMs: 40, error: null };
    if (command === "system_list_font_families") return [];
    return null;
  };
  const view = await mountForm({
    enabled: true,
    type: "http",
    host: "proxy.corp.example",
    port: 3128,
    username: "alice",
    password: "corp-secret",
  });
  const open = document.querySelector('button[aria-controls="system-proxy-details"]');
  assert.ok(open, "proxy settings button rendered");
  await env.act(async () => open.click());
  await settle();
  await settle();

  const candidate = [...document.querySelectorAll("li button")].find((button) =>
    button.textContent.includes("192.168.1.1:7890"),
  );
  assert.ok(candidate, "detected proxy button rendered inside the real dialog");
  await env.act(async () => candidate.click());

  const proxy = view.systemProxy();
  await view.unmount();
  assert.equal(proxy.host, "192.168.1.1");
  assert.equal(proxy.port, 7890);
  assert.equal(proxy.enabled, true, "the switch stays on, so the next request already uses it");
  assert.deepEqual(
    { username: proxy.username, password: proxy.password },
    { username: "", password: "" },
    `credentials saved for proxy.corp.example are now attached to ${proxy.host}:${proxy.port}`,
  );
});

// 主机输入框里有未提交草稿时点候选：失焦提交草稿发生在点击前，点击结果不应被
// 草稿覆盖，再次失焦也不应写回旧草稿。
test("a pending host/port draft committed on blur does not override the clicked candidate", async () => {
  const local = {
    id: "socks5://127.0.0.1:7891",
    type: "socks5",
    host: "127.0.0.1",
    port: 7891,
    processName: "mihomo",
    sources: ["listen"],
    authRequired: false,
  };
  handleInvoke = async (command) => {
    if (command === "system_proxy_detect") return { candidates: [local] };
    if (command === "system_proxy_test") return { ok: true, latencyMs: 40, error: null };
    if (command === "system_list_font_families") return [];
    return null;
  };
  const view = await mountForm({ enabled: false, type: "http", host: "", port: 0 });
  await env.act(async () =>
    document.querySelector('button[aria-controls="system-proxy-details"]').click(),
  );
  await settle();
  await settle();
  const hostInput = document.getElementById("system-proxy-host");
  assert.ok(
    hostInput,
    `dialog open; toggles=${document.querySelectorAll('button[aria-controls="system-proxy-details"]').length} body=${document.body.innerHTML.length}`,
  );
  const portInput = document.getElementById("system-proxy-port");
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  await env.act(async () => {
    hostInput.focus();
    setValue(hostInput, "10.9.9.9");
  });
  await env.act(async () => {
    portInput.focus();
    setValue(portInput, "8080");
  });
  const candidate = [...document.querySelectorAll("li button")].find((button) =>
    button.textContent.includes("127.0.0.1:7891"),
  );
  await env.act(async () => {
    candidate.focus();
    candidate.click();
  });
  await env.act(async () => hostInput.focus());
  await env.act(async () => portInput.focus());
  await env.act(async () => candidate.focus());
  const proxy = view.systemProxy();
  assert.deepEqual(
    { type: proxy.type, host: proxy.host, port: proxy.port, enabled: proxy.enabled },
    { type: "socks5", host: "127.0.0.1", port: 7891, enabled: false },
  );
  assert.equal(hostInput.value, "127.0.0.1");
  assert.equal(portInput.value, "7891");
  assert.equal(candidate.getAttribute("aria-pressed"), "true");
  await view.unmount();
});

// 点的就是当前这台代理（只是补测速或换协议）时，已保存的认证信息保留。
test("selecting the proxy already configured keeps its credentials", async () => {
  const corp = {
    id: "http://10.0.0.8:3128",
    type: "http",
    host: "10.0.0.8",
    port: 3128,
    processName: null,
    sources: ["os"],
    authRequired: true,
  };
  handleInvoke = async (command) => {
    if (command === "system_proxy_detect") return { candidates: [corp] };
    if (command === "system_proxy_test") return { ok: false, latencyMs: null, error: "status:407" };
    if (command === "system_list_font_families") return [];
    return null;
  };
  const view = await mountForm({
    enabled: true,
    type: "http",
    host: "10.0.0.8",
    port: 3128,
    username: "alice",
    password: "corp-secret",
  });
  await env.act(async () =>
    document.querySelector('button[aria-controls="system-proxy-details"]').click(),
  );
  await settle();
  await settle();
  const candidate = [...document.querySelectorAll("li button")].find((button) =>
    button.textContent.includes("10.0.0.8:3128"),
  );
  await env.act(async () => candidate.click());
  const proxy = view.systemProxy();
  await view.unmount();
  assert.deepEqual(
    { host: proxy.host, port: proxy.port, username: proxy.username, password: proxy.password },
    { host: "10.0.0.8", port: 3128, username: "alice", password: "corp-secret" },
  );
});
