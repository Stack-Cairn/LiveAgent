import assert from "node:assert/strict";
import test from "node:test";
import { createDomTestEnv } from "../helpers/dom-test-env.mjs";

const PATH = "/work/project";

function fakeClient({ supported = true, status = { workdir: PATH, trusted: false }, failGet } = {}) {
  const state = { status, calls: [] };
  state.client = {
    supported: async () => {
      state.calls.push("supported");
      return supported;
    },
    get: async (path) => {
      state.calls.push(`get ${path}`);
      if (failGet) throw new Error(failGet);
      return state.status;
    },
    trust: async (path) => {
      state.calls.push(`trust ${path}`);
      state.status = { workdir: PATH, trusted: true, source: PATH };
      return state.status;
    },
    revoke: async (path) => {
      state.calls.push(`revoke ${path}`);
      state.status = { workdir: PATH, trusted: false };
      return state.status;
    },
  };
  return state;
}

async function render(client, task) {
  // Icons are build-time SVG modules; they carry no state worth asserting here.
  const env = await createDomTestEnv({
    mocks: { "@liveagent/ui/components/IconSet": new Proxy({}, { get: () => () => null }) },
  });
  const { WorkspaceFolderTrustSection } = env.loadModule(
    "@liveagent/ui/components/chat/workspace-project-settings/WorkspaceFolderTrustSection.tsx",
  );
  const host = document.body.appendChild(document.createElement("div"));
  const root = env.createRoot(host);
  const settle = () =>
    env.act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  const section = () => host.querySelector('[data-testid="workspace-folder-trust"]');
  const button = () => section().querySelector("button");
  try {
    await env.act(async () =>
      root.render(env.React.createElement(WorkspaceFolderTrustSection, { path: PATH, client })),
    );
    await settle();
    await task({ env, section, button, settle });
  } finally {
    await env.act(async () => root.unmount());
    host.remove();
    env.cleanup();
  }
}

test("folder trust section explains trust and grants then revokes it", async () => {
  const state = fakeClient();
  await render(state.client, async ({ env, section, button, settle }) => {
    assert.match(section().textContent, /未信任/);
    assert.match(section().textContent, /项目提示词、斜杠指令和其他项目文件/);
    assert.equal(button().textContent, "信任此目录");

    await env.act(async () => button().click());
    await settle();
    assert.match(section().textContent, /已信任/);
    assert.equal(button().textContent, "撤销信任");

    await env.act(async () => button().click());
    await settle();
    assert.match(section().textContent, /未信任/);
    assert.deepEqual(state.calls, ["supported", `get ${PATH}`, `trust ${PATH}`, `revoke ${PATH}`]);
  });
});

test("folder trust section names a trusted parent folder", async () => {
  const state = fakeClient({ status: { workdir: PATH, trusted: true, source: "/work" } });
  await render(state.client, async ({ section, button }) => {
    assert.match(section().textContent, /上级目录 \/work 已受信任/);
    assert.equal(button().textContent, "撤销信任");
  });
});

test("folder trust section offers no action on a backend without the trust API", async () => {
  const state = fakeClient({ supported: false });
  await render(state.client, async ({ section, button }) => {
    assert.equal(button(), null);
    assert.match(section().textContent, /不可用/);
    assert.match(section().textContent, /kn 终端/);
    assert.deepEqual(state.calls, ["supported"], "status is not read from a backend that lacks it");
  });
});

test("folder trust section shows a read failure without offering a change", async () => {
  const state = fakeClient({ failGet: "workdir: no such file or directory" });
  await render(state.client, async ({ section, button }) => {
    assert.equal(button(), null);
    assert.match(section().querySelector('[role="alert"]').textContent, /no such file/);
  });
});
