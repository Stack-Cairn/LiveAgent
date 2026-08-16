import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

function snapshot(revision, overrides = {}) {
  return {
    ready: true,
    agentOnline: true,
    revision,
    processes: [{ id: `p-${revision}`, running: true }],
    ...overrides,
  };
}

const listeners = new Set();
const backend = {
  failNextFetch: false,
  nextState: snapshot(1),
  async fetchState() {
    if (backend.failNextFetch) {
      backend.failNextFetch = false;
      throw new Error("fetch failed");
    }
    return backend.nextState;
  },
  async stop() {
    return null;
  },
  async clear() {
    return null;
  },
  async readLog() {
    return { content: "", logPath: "", truncated: false };
  },
  subscribe(onState) {
    listeners.add(onState);
    return () => listeners.delete(onState);
  },
  push(state) {
    for (const listener of listeners) listener(state);
  },
};

const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
  mocks: { "@liveagent/app/lib/managed-process/backend": { backend } },
});
const store = loader.loadModule("@liveagent/ui/lib/managed-process/store.ts");

test("managed-process store 镜像语义与 refresh 自愈", async () => {
  // 失败的初始化不留僵尸订阅,refresh 兼作重试补齐。
  backend.failNextFetch = true;
  await assert.rejects(store.ensureManagedProcessInit(), /fetch failed/);
  assert.equal(store.getManagedProcessState().ready, false);
  assert.equal(listeners.size, 0);

  backend.nextState = snapshot(5);
  await store.refreshManagedProcessState();
  assert.equal(store.getManagedProcessState().revision, 5);
  assert.equal(listeners.size, 1);

  // 后端推送直接喂入镜像。
  backend.push(snapshot(6));
  assert.equal(store.getManagedProcessState().revision, 6);

  // 陈旧修订丢弃列表但采纳 agentOnline;等修订放行(在线位翻转不递增修订)。
  backend.push(snapshot(3, { agentOnline: false, processes: [] }));
  const stale = store.getManagedProcessState();
  assert.equal(stale.revision, 6);
  assert.equal(stale.processes.length, 1);
  assert.equal(stale.agentOnline, false);
  backend.push(snapshot(6, { agentOnline: true }));
  assert.equal(store.getManagedProcessState().agentOnline, true);

  // refresh 拉取新快照对账。
  backend.nextState = snapshot(9);
  await store.refreshManagedProcessState();
  assert.equal(store.getManagedProcessState().revision, 9);
});
