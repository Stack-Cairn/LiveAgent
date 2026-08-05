import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const thinking = loader.loadModule("src/lib/models/modelThinking.ts");
const catalog = loader.loadModule("src/lib/models/modelCatalog.ts");

const { resolveModelThinking, toThinkingLevelMap, clampThinkingLevelToList } = thinking;

test("catalog hit: levels/alwaysOn come straight from the generated data", () => {
  // claude-sonnet-4-6: effort ladder without minimal, client-side off.
  const sonnet = resolveModelThinking("claude_code", "claude-sonnet-4-6");
  assert.deepEqual(sonnet, {
    reasoning: true,
    levels: ["low", "medium", "high", "max"],
    alwaysOn: false,
    fromCatalog: true,
  });
  // gpt-5: minimal..high, no off in upstream ladder → always on.
  const gpt5 = resolveModelThinking("codex", "gpt-5");
  assert.deepEqual(gpt5.levels, ["minimal", "low", "medium", "high"]);
  assert.equal(gpt5.alwaysOn, true);
  // gpt-5.2: effort "none" folds into off.
  const gpt52 = resolveModelThinking("codex", "gpt-5.2");
  assert.equal(gpt52.alwaysOn, false);
  assert.ok(gpt52.levels.includes("xhigh"));
});

test("non-reasoning models expose no thinking controls", () => {
  const result = resolveModelThinking("codex", "gpt-4o");
  assert.deepEqual(result, { reasoning: false, levels: [], alwaysOn: false, fromCatalog: true });
});

test("always-on non-tunable models: reasoning with empty levels", () => {
  const reasoner = resolveModelThinking("claude_code", "deepseek-reasoner");
  assert.equal(reasoner.reasoning, true);
  assert.deepEqual(reasoner.levels, []);
  assert.equal(reasoner.alwaysOn, true);
});

test("decorated ids resolve through the candidate chain", () => {
  for (const id of [
    "claude-sonnet-4-6-20251114",
    "Claude-Sonnet-4-6",
    "claude-sonnet-4-6@20251114",
    "claude-sonnet-4-6[1m]",
  ]) {
    const result = resolveModelThinking("claude_code", id);
    assert.equal(result.fromCatalog, true, id);
    assert.deepEqual(result.levels, ["low", "medium", "high", "max"], id);
  }
});

test("cross-provider fallback finds vendor models behind relays", () => {
  // glm-4.6 lives in the zhipuai section but is often served via claude_code relays.
  // Pure-toggle upstream shape → single "high" notch + off.
  const glm = resolveModelThinking("claude_code", "glm-4.6");
  assert.equal(glm.fromCatalog, true);
  assert.deepEqual(glm.levels, ["high"]);
  assert.equal(glm.alwaysOn, false); // toggle → can be turned off
});

test("xai thinking can never be turned off, even for catalog off-capable ids", () => {
  const grok43 = resolveModelThinking("xai", "grok-4.3");
  assert.equal(grok43.alwaysOn, true);
  // but the same id resolved for codex keeps the catalog's off capability
  const viaCodex = resolveModelThinking("codex", "grok-4.3");
  assert.equal(viaCodex.alwaysOn, false);
});

test("unknown custom models fall back to the standard four levels", () => {
  const custom = resolveModelThinking("codex", "totally-custom-model");
  assert.deepEqual(custom, {
    reasoning: true,
    levels: ["minimal", "low", "medium", "high"],
    alwaysOn: false,
    fromCatalog: false,
  });
});

test("anthropic renamed ids fall back to the adaptive-generation heuristics", () => {
  // Opus 4.7+/Claude 5 family: xhigh present.
  for (const id of ["claude-4.7-opus", "claude-5-sonnet", "custom-fable-5-relay"]) {
    const result = resolveModelThinking("claude_code", id);
    assert.equal(result.fromCatalog, false, id);
    assert.deepEqual(result.levels, ["low", "medium", "high", "xhigh", "max"], id);
  }
  // 4.6 generation / Mythos Preview: max only.
  for (const id of ["claude-4.6-sonnet", "claude-mythos-preview"]) {
    const result = resolveModelThinking("claude_code", id);
    assert.deepEqual(result.levels, ["low", "medium", "high", "max"], id);
  }
  // Legacy/ambiguous ids stay on the standard ladder.
  for (const id of ["claude-3-5-sonnet-20241022", "claude-4-5-sonnet", "claude-3-haiku-20240307"]) {
    const result = resolveModelThinking("claude_code", id);
    assert.deepEqual(result.levels, ["minimal", "low", "medium", "high"], id);
  }
});

test("empty model id resolves to no thinking", () => {
  assert.deepEqual(resolveModelThinking("claude_code", undefined), {
    reasoning: false,
    levels: [],
    alwaysOn: false,
    fromCatalog: false,
  });
  assert.equal(resolveModelThinking("claude_code", "  ").reasoning, false);
});

test("toThinkingLevelMap mirrors capability into pi-ai map semantics", () => {
  // no minimal, has max, off allowed
  const map = toThinkingLevelMap(
    { reasoning: true, levels: ["low", "medium", "high", "max"], alwaysOn: false, fromCatalog: true },
  );
  assert.deepEqual(map, { minimal: null, max: "max" });
  // always-on pins off:null; wire values rewrite only existing levels
  const xai = toThinkingLevelMap(
    { reasoning: true, levels: ["low", "medium", "high", "xhigh"], alwaysOn: true, fromCatalog: true },
    { minimal: "low" },
  );
  assert.deepEqual(xai, { off: null, minimal: null, xhigh: "xhigh" });
  // non-reasoning → undefined
  assert.equal(
    toThinkingLevelMap({ reasoning: false, levels: [], alwaysOn: false, fromCatalog: true }),
    undefined,
  );
  // wire null (pi-ai "unsupported") never resurrects or kills availability
  const wired = toThinkingLevelMap(
    { reasoning: true, levels: ["minimal", "low", "medium", "high"], alwaysOn: false, fromCatalog: true },
    { off: "none", minimal: null, high: "HIGH" },
  );
  assert.deepEqual(wired, { off: "none", high: "HIGH" });
});

test("clampThinkingLevelToList picks the nearest level, preferring upward", () => {
  const levels = ["low", "medium", "high", "max"];
  assert.equal(clampThinkingLevelToList("minimal", levels), "low");
  assert.equal(clampThinkingLevelToList("xhigh", levels), "max");
  assert.equal(clampThinkingLevelToList("high", levels), "high");
  assert.equal(clampThinkingLevelToList("max", ["low"]), "low");
  assert.equal(clampThinkingLevelToList("medium", []), undefined);
});

test("every catalog thinking entry is well-formed for the resolver", () => {
  const LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"];
  for (const providerId of Object.keys(catalog.MODEL_CATALOG)) {
    for (const entry of catalog.MODEL_CATALOG[providerId]) {
      if (!entry.thinking) continue;
      const label = `${providerId}/${entry.id}`;
      const indices = entry.thinking.levels.map((level) => LADDER.indexOf(level));
      assert.ok(indices.every((index) => index >= 0), `${label}: unknown level`);
      assert.deepEqual(indices, [...indices].sort((a, b) => a - b), `${label}: levels must ascend`);
      assert.equal(new Set(indices).size, indices.length, `${label}: levels must be unique`);
      assert.equal(typeof entry.thinking.off, "boolean", label);
    }
  }
});
