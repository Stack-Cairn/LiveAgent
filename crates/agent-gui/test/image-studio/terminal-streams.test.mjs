import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const { ImageStudioController } = loader.loadModule("@liveagent/ui/features/image-studio/studioController");
const { createImageStudioClient } = loader.loadModule("@liveagent/ui/lib/imaging/client");
const target = { id: "t", enabled: true, parameters: [], capabilities: { operations: ["generate"], maxCount: 4, maxInputs: 0 } };
const job = { id: "j", projectId: "p", revision: 3, lastEventSeq: 8, status: "succeeded", assetIds: ["a"], items: [], usage: null };
const settle = () => new Promise(resolve => setImmediate(resolve));
function client(overrides = {}) {
  return {
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [target],
    listProjects: async () => ({ items: [{ id: "p", title: "P" }] }),
    listJobs: async () => ({ items: [job] }),
    getJob: async () => job,
    ...overrides,
  };
}

test("complete terminal snapshots never open an empty EOF stream or exhaust its retry budget", async () => {
  let streams = 0;
  const transportClient = createImageStudioClient({
    reconnectDelaysMs: [0, 0, 0, 0, 0],
    transport: async () => {
      streams++;
      return new Response("", { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  for (const status of ["succeeded", "partial_succeeded", "failed", "result_unknown", "cancelled"]) {
    const snapshot = { ...job, status };
    const controller = new ImageStudioController(client({
      listJobs: async () => ({ items: [snapshot] }),
      getJob: async () => snapshot,
      subscribe: transportClient.subscribe,
    }), "owner", "backend");
    try {
      await controller.start();
      await controller.refreshJob(job.id);
      await settle();
      assert.equal(streams, 0, status);
      assert.doesNotMatch(controller.view.notice, /连接.*(中断|结束)/);
    } finally {
      controller.dispose();
    }
  }
});

test("gap recovery to a terminal snapshot stops watching instead of reconnecting at lastEventSeq", async () => {
  let subscriptions = 0;
  let snapshots = 0;
  const controller = new ImageStudioController(client({
    listJobs: async () => ({ items: [{ ...job, revision: 1, status: "running", lastEventSeq: 0 }] }),
    getJob: async () => { snapshots++; return job; },
    subscribe: async (_id, _seq, onEvent) => {
      subscriptions++;
      onEvent({ jobId: "j", seq: 5, revision: 2, type: "job.state_changed", data: { status: "running" } });
    },
  }), "owner", "backend");
  try {
    await controller.start();
    await settle();
    assert.equal(subscriptions, 1);
    assert.equal(snapshots, 1);
    assert.equal(controller.view.state.lastSeqByJob.j, 8);
    assert.equal(controller.view.notice, "");
  } finally {
    controller.dispose();
  }
});

test("cancelled snapshots explicitly allow manual refresh to recover late assets without SSE", async () => {
  let snapshot = { ...job, status: "cancelled", cancelEffect: "local_only", assetIds: [] };
  let subscriptions = 0;
  const controller = new ImageStudioController(client({
    listJobs: async () => ({ items: [snapshot] }),
    getJob: async () => snapshot,
    subscribe: async () => { subscriptions++; },
  }), "owner", "backend");
  try {
    await controller.start();
    assert.match(controller.view.notice, /刷新状态.*迟到结果/);
    snapshot = { ...snapshot, revision: 4, lastEventSeq: 9, assetIds: ["late-asset"] };
    await controller.refreshJob(job.id);
    assert.deepEqual(controller.view.state.jobs.j.assetIds, ["late-asset"]);
    assert.equal(controller.view.state.lastSeqByJob.j, 9);
    assert.equal(subscriptions, 0);
  } finally {
    controller.dispose();
  }
});

test("job.finished reads the complete snapshot and retires the stream even if its transport rejects on abort", async () => {
  let snapshots = 0;
  let signal;
  const controller = new ImageStudioController(client({
    listJobs: async () => ({ items: [{ ...job, revision: 1, status: "running", lastEventSeq: 0 }] }),
    getJob: async () => { snapshots++; return { ...job, status: "cancelled" }; },
    subscribe: async (_id, _seq, onEvent, active) => {
      signal = active;
      onEvent({ jobId: "j", seq: 1, revision: 2, type: "job.finished", data: { status: "cancelled" } });
      throw new Error("aborted stream");
    },
  }), "owner", "backend");
  try {
    await controller.start();
    await settle();
    assert.equal(signal.aborted, true);
    assert.equal(snapshots, 1);
    assert.equal(controller.view.state.jobs.j.lastEventSeq, 8);
    assert.match(controller.view.notice, /刷新状态.*迟到结果/);
    assert.doesNotMatch(controller.view.notice, /连接.*(中断|结束)/);
  } finally {
    controller.dispose();
  }
});
