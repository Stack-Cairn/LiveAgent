import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const schema = loader.loadModule("src/lib/memory/schema.ts");

test("scope/type/confidence enums are complete and closed", () => {
  assert.deepEqual(schema.MEMORY_SCOPES, ["global", "project"]);
  assert.deepEqual(schema.MEMORY_TYPES, ["user", "feedback", "project", "reference"]);
  assert.deepEqual(schema.MEMORY_CONFIDENCES, ["high", "medium", "low", "unknown"]);
  assert.deepEqual(schema.MEMORY_UPDATE_MODES, ["replace", "merge", "append"]);
});

test("extraction plan actions cover the five mutations", () => {
  assert.deepEqual(schema.EXTRACTION_PLAN_ACTIONS, [
    "write",
    "update",
    "accept",
    "delete",
    "append_daily",
  ]);
});

test("apply decision ops match the Rust batch surface", () => {
  assert.deepEqual(schema.APPLY_DECISION_OPS, ["upsert", "update", "delete", "accept"]);
});

test("confidence contract constants pin the Rust enforcement thresholds", () => {
  assert.equal(schema.CONFIDENCE_CONTRACT.highMinQuoteChars, 5);
  assert.equal(schema.CONFIDENCE_CONTRACT.mediumMinQuoteChars, 1);
});

test("guards accept members and reject outsiders", () => {
  assert.equal(schema.isMemoryScope("global"), true);
  assert.equal(schema.isMemoryScope("auto"), false);
  assert.equal(schema.isMemoryType("feedback"), true);
  assert.equal(schema.isMemoryType("daily"), false);
  assert.equal(schema.normalizeMemoryConfidence("high"), "high");
  assert.equal(schema.normalizeMemoryConfidence("HIGH"), "unknown");
  assert.equal(schema.normalizeMemoryConfidence(undefined), "unknown");
});

test("reviewer modes default to standard", () => {
  assert.deepEqual(schema.MEMORY_REVIEWER_MODES, ["strict", "standard", "lenient"]);
  assert.equal(schema.DEFAULT_MEMORY_REVIEWER_MODE, "standard");
});
