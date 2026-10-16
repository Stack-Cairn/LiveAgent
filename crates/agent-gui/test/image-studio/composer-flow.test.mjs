import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const { ImageStudioController } = createTsModuleLoader().loadModule(
  "@liveagent/ui/features/image-studio/studioController",
);
const target = {
  id: "it_t",
  name: "RollDek · gpt-image-2",
  remoteId: "gpt-image-2",
  enabled: true,
  parameters: [{ key: "size", label: "size", type: "string", required: false }],
  capabilities: { operations: ["generate", "reference"], maxCount: 4, maxInputs: 3 },
};
const textOnly = { ...target, id: "it_text", capabilities: { operations: ["generate"], maxCount: 1, maxInputs: 0 } };
let seq = 0;
const asset = (id) => ({ id, hash: "h", mime: "image/png", bytes: 1, width: 1, height: 1, source: "upload", parentAssetIds: [], createdAt: "2026-10-16T00:00:00Z", available: true });

function fakeClient(projects = []) {
  const calls = { created: [], jobs: [] };
  const client = {
    calls,
    capabilities: async () => ({ supported: true }),
    listTargets: async () => [target, textOnly],
    listProjects: async () => ({ items: projects }),
    createProject: async (title) => {
      calls.created.push(title);
      return { id: "p_default", title, revision: 1, createdAt: "", updatedAt: "" };
    },
    listJobs: async () => ({ items: [] }),
    readAsset: async () => new Blob(),
    upload: async () => asset(`ia_up${++seq}`),
    subscribe: () => new Promise(() => {}),
    createJob: async (request, key) => {
      calls.jobs.push({ request, key });
      return { id: `j${calls.jobs.length}`, projectId: request.projectId, request, targetSnapshot: target, status: "running", revision: 1, lastEventSeq: 0, assetIds: [], items: [], usage: null, createdAt: `2026-10-16T00:00:0${calls.jobs.length}Z`, updatedAt: "" };
    },
  };
  return client;
}

test("the workbench opens without a project picker: a default project is created once", async () => {
  const client = fakeClient();
  const c = new ImageStudioController(client, "o", "b");
  await c.start();
  assert.deepEqual(client.calls.created, ["默认"]);
  assert.equal(c.view.projectId, "p_default");
  assert.equal(c.view.draftReady, true);
  c.dispose();
  const existing = fakeClient([{ id: "p_old", title: "旧项目", revision: 1 }]);
  const again = new ImageStudioController(existing, "o", "b");
  await again.start();
  assert.deepEqual(existing.calls.created, []);
  assert.equal(again.view.projectId, "p_old");
  again.dispose();
});

test("each send starts a new task, like another chat message", async () => {
  const client = fakeClient();
  const c = new ImageStudioController(client, "o", "b");
  await c.start();
  c.setTarget("it_t");
  c.updateDraft({ prompt: "一只猫" });
  await c.send();
  await c.send();
  assert.equal(client.calls.jobs.length, 2);
  assert.notEqual(client.calls.jobs[0].key, client.calls.jobs[1].key);
  assert.equal(client.calls.jobs[0].request.operation, "generate");
  assert.deepEqual(client.calls.jobs[0].request.inputs, []);
  c.dispose();
});

test("adding reference images switches to 图生图", async () => {
  const client = fakeClient();
  const c = new ImageStudioController(client, "o", "b");
  await c.start();
  c.setTarget("it_t");
  assert.equal(c.acceptsImages, true);
  await c.upload(new Blob(["x"], { type: "image/png" }), "a.png", "reference");
  await c.upload(new Blob(["y"], { type: "image/png" }), "b.png", "reference");
  assert.equal(c.mode, "image");
  c.updateDraft({ prompt: "换成水彩风格" });
  await c.send();
  const sent = client.calls.jobs.at(-1).request;
  assert.equal(sent.operation, "reference");
  assert.deepEqual(sent.inputs.map((i) => i.role), ["reference", "reference"]);
  c.removeInput(sent.inputs[0].assetId);
  c.removeInput(sent.inputs[1].assetId);
  assert.equal(c.mode, "text");
  c.dispose();
});

test("a result can be reused as a reference, and text-only models refuse images", async () => {
  const client = fakeClient();
  const c = new ImageStudioController(client, "o", "b");
  await c.start();
  c.setTarget("it_t");
  c.editAsset("ia_result");
  assert.deepEqual(c.view.draft.inputs, [{ assetId: "ia_result", role: "reference" }]);
  c.setTarget("it_text");
  assert.equal(c.acceptsImages, false);
  c.updateDraft({ prompt: "x" });
  assert.match(c.validation().join(" "), /不支持图生图/);
  c.dispose();
});