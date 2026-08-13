import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createWebModuleLoader } from "../../test/helpers/load-web-module.mjs";

// 后台任务共享 store 的镜像语义：一次性初始化、推送喂入、陈旧修订丢弃，
// 以及 refresh 自愈（失败的初始化可被 refresh 重试补齐）。

function snapshot(revision, overrides = {}) {
  return {
    ready: true,
    agentOnline: true,
    revision,
    processes: [
      {
        id: `p-${revision}`,
        label: "",
        command: "sleep 1000",
        cwd: "/tmp",
        shell: "zsh",
        pid: 4242,
        logPath: "/tmp/p.log",
        startedAt: 1000,
        finishedAt: null,
        exitCode: null,
        running: true,
        isolated: false,
        restored: false,
      },
    ],
    ...overrides,
  };
}

function createFakeBackend() {
  const listeners = new Set();
  const backend = {
    fetchCalls: 0,
    failNextFetch: false,
    nextState: snapshot(1),
    listeners,
    async fetchState() {
      backend.fetchCalls += 1;
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
      return { content: "", logPath: "/tmp/p.log", truncated: false };
    },
    subscribe(onState) {
      listeners.add(onState);
      return () => listeners.delete(onState);
    },
    push(state) {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
  return backend;
}

const backend = createFakeBackend();
const loader = createWebModuleLoader({
  rootDir: fileURLToPath(new URL("../", import.meta.url)),
  mocks: {
    "@liveagent/app/lib/managed-process/backend": { backend },
  },
});

const store = loader.loadModule("@liveagent/ui/lib/managed-process/store.ts");

test("失败的初始化不留僵尸订阅，refresh 可重试补齐", async () => {
  backend.failNextFetch = true;
  await assert.rejects(store.ensureManagedProcessInit(), /fetch failed/);
  assert.equal(store.getManagedProcessState().ready, false);
  assert.equal(backend.listeners.size, 0);

  backend.nextState = snapshot(5);
  await store.refreshManagedProcessState();
  const state = store.getManagedProcessState();
  assert.equal(state.ready, true);
  assert.equal(state.revision, 5);
  assert.equal(backend.listeners.size, 1);
});

test("后端推送直接喂入镜像", () => {
  backend.push(snapshot(6));
  assert.equal(store.getManagedProcessState().revision, 6);
});

test("陈旧修订被丢弃，但 agentOnline 仍被采纳", () => {
  backend.push(snapshot(3, { agentOnline: false, processes: [] }));
  const state = store.getManagedProcessState();
  assert.equal(state.revision, 6);
  assert.equal(state.processes.length, 1);
  assert.equal(state.agentOnline, false);
});

test("等修订快照被接受(在线位翻转不递增修订)", () => {
  backend.push(snapshot(6, { agentOnline: true }));
  assert.equal(store.getManagedProcessState().agentOnline, true);
});

test("refresh 拉取新快照对账", async () => {
  backend.nextState = snapshot(9);
  const before = backend.fetchCalls;
  await store.refreshManagedProcessState();
  assert.equal(backend.fetchCalls, before + 1);
  assert.equal(store.getManagedProcessState().revision, 9);
});
