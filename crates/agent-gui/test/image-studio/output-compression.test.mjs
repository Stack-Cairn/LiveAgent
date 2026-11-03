import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const loader = createTsModuleLoader();
const { updateParameterValue, keepDeclaredParameters, migrateParameters, defaultParameters } = loader.loadModule("@liveagent/ui/features/image-studio/parameterModel");
const { sanitizeDraft, draftKey } = loader.loadModule("@liveagent/ui/features/image-studio/drafts");
const { ImageStudioController } = loader.loadModule("@liveagent/ui/features/image-studio/studioController");
const wire = loader.loadModule("@liveagent/ui/lib/imaging/testdata/wire-v1.json");
const target = {parameters: [
  {key: "output_format", type: "string", required: false, enum: ["png", "jpeg", "webp"]},
  {key: "output_compression", type: "integer", required: false, minimum: 0, maximum: 100},
]};
test("lossy output formats start with 100 percent and preserve chosen compression including zero", () => {
  for (const format of ["jpeg", "webp"]) {
    assert.deepEqual(updateParameterValue(target, {}, "output_format", format), {output_format: format, output_compression: 100});
    for (const value of [0, 68, 100]) {
      const before = {output_format: "jpeg", output_compression: value};
      assert.equal(updateParameterValue(target, before, "output_format", format).output_compression, value);
      assert.deepEqual(before, {output_format: "jpeg", output_compression: value});
    }
  }
});
test("PNG and unset format omit compression while other optional parameters remain unchanged", () => {
  for (const format of ["png", undefined]) {
    const next = updateParameterValue(target, {output_format: "webp", output_compression: 0, quality: "high"}, "output_format", format);
    assert.equal(Object.hasOwn(next, "output_compression"), false);
    assert.equal(next.quality, "high");
    assert.equal(next.output_format, format);
  }
});
test("declared defaults are honored and targets without compression never acquire it", () => {
  const custom = {parameters: target.parameters.map(p => p.key === "output_compression" ? {...p, default: 80} : p)};
  assert.equal(updateParameterValue(custom, {}, "output_format", "jpeg").output_compression, 80);
  assert.deepEqual(updateParameterValue({parameters: [target.parameters[0]]}, {}, "output_format", "jpeg"), {output_format: "jpeg"});
});

test("legacy drafts, history and migrations omit compression outside JPEG and WebP", () => {
  const declared = {...target, id: "t"};
  for (const parameters of [{output_format: "png", output_compression: 80}, {output_compression: 0}]) {
    const expected = Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== "output_compression"));
    assert.deepEqual(keepDeclaredParameters(declared, parameters), {values: expected, dropped: []});
    assert.deepEqual(sanitizeDraft({targetId: "t", parameters}, [declared]).parameters, expected);
    assert.deepEqual(migrateParameters(declared, declared, parameters).values, expected);
  }
  const defaults = {parameters: target.parameters.map(spec => ({...spec, default: spec.key === "output_format" ? "png" : 80}))};
  assert.deepEqual(defaultParameters(defaults), {output_format: "png"});
  for (const format of ["jpeg", "webp"]) {
    for (const compression of [0, 80, 100]) {
      const parameters = {output_format: format, output_compression: compression};
      assert.deepEqual(keepDeclaredParameters(declared, parameters).values, parameters);
      assert.deepEqual(sanitizeDraft({targetId: "t", parameters}, [declared]).parameters, parameters);
    }
  }
});

test("restored legacy parameters can submit directly and saved JPEG/WebP zero is preserved", async () => {
  const declared = {...wire.settings.targets[0], ...target, id: "t", enabled: true,
    capabilities: {...wire.settings.targets[0].capabilities, operations: ["generate"], maxCount: 1}};
  const scope = {ownerId: "o", backendId: "b", projectId: "p"};
  for (const parameters of [{output_format: "png", output_compression: 80}, {output_compression: 0}, {output_format: "jpeg", output_compression: 0}, {output_format: "webp", output_compression: 0}]) {
    for (const source of ["draft", "history", "submit"]) {
      const draft = {targetId: "t", prompt: "original prompt", parameters, inputs: []};
      const stored = new Map();
      if (source === "draft") stored.set(draftKey("o", "b", "p"), JSON.stringify({version: 1, scope, ...draft}));
      const history = {id: "j", projectId: "p", revision: 1, lastEventSeq: 0, status: "failed", assetIds: [], items: [], request: {...draft, projectId: "p", operation: "generate", count: 1}};
      const calls = [];
      const controller = new ImageStudioController({
        capabilities: async () => ({supported: true}), listTargets: async () => [declared],
        listProjects: async () => ({items: [{id: "p", title: "P"}]}), listJobs: async () => ({items: [history]}),
        subscribe: async () => {}, createJob: async request => {calls.push(request); return {...history, id: "submitted", status: "cancelled", request};},
      }, "o", "b", {getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key)});
      try {
        await controller.start();
        if (source === "history") await controller.restoreJob("j");
        if (source === "submit") controller.updateDraft(draft);
        assert.deepEqual(controller.validation(), [], source);
        await controller.submit();
        assert.equal(calls.length, 1, source);
        const expected = {...parameters};
        if (!["jpeg", "webp"].includes(parameters.output_format)) delete expected.output_compression;
        assert.deepEqual(calls[0].parameters, expected, source);
        assert.equal(calls[0].prompt, "original prompt");
        assert.equal(history.request.parameters, parameters, "history snapshots remain untouched");
      } finally {controller.dispose();}
    }
  }
});
