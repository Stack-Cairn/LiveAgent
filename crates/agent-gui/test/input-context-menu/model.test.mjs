import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader();
const model = loader.loadModule("src/components/input-context-menu/model.ts");

const { isMenuEligibleTarget, computeMenuItems, clampMenuPosition, resolveOpenSelection } = model;

function makeSnapshot(overrides = {}) {
  return {
    x: 100,
    y: 100,
    start: 0,
    end: 0,
    hasSelection: false,
    hasContent: true,
    readOnly: false,
    isPassword: false,
    ...overrides,
  };
}

test("isMenuEligibleTarget accepts textareas and selection-capable inputs", () => {
  assert.equal(isMenuEligibleTarget({ tagName: "TEXTAREA" }), true);
  for (const type of ["text", "search", "url", "tel", "password"]) {
    assert.equal(isMenuEligibleTarget({ tagName: "INPUT", type }), true, `type=${type}`);
  }
  // Missing/empty type defaults to text.
  assert.equal(isMenuEligibleTarget({ tagName: "INPUT" }), true);
  assert.equal(isMenuEligibleTarget({ tagName: "INPUT", type: "" }), true);
  // Uppercase attribute values normalize.
  assert.equal(isMenuEligibleTarget({ tagName: "INPUT", type: "TEXT" }), true);
});

test("isMenuEligibleTarget rejects unsupported inputs and non-inputs", () => {
  for (const type of ["number", "time", "email", "date", "checkbox", "radio", "file", "range"]) {
    assert.equal(isMenuEligibleTarget({ tagName: "INPUT", type }), false, `type=${type}`);
  }
  assert.equal(isMenuEligibleTarget({ tagName: "INPUT", type: "text", disabled: true }), false);
  assert.equal(isMenuEligibleTarget({ tagName: "TEXTAREA", disabled: true }), false);
  assert.equal(isMenuEligibleTarget({ tagName: "DIV" }), false);
  assert.equal(isMenuEligibleTarget({}), false);
});

test("computeMenuItems disables copy/cut without a selection", () => {
  const items = computeMenuItems(makeSnapshot());
  assert.deepEqual(items, {
    canCopy: false,
    canCut: false,
    canPaste: true,
    canSelectAll: true,
  });
});

test("computeMenuItems enables copy/cut with a selection", () => {
  const items = computeMenuItems(makeSnapshot({ start: 0, end: 3, hasSelection: true }));
  assert.deepEqual(items, {
    canCopy: true,
    canCut: true,
    canPaste: true,
    canSelectAll: true,
  });
});

test("computeMenuItems never copies passwords", () => {
  const items = computeMenuItems(
    makeSnapshot({ start: 0, end: 3, hasSelection: true, isPassword: true }),
  );
  assert.deepEqual(items, {
    canCopy: false,
    canCut: false,
    canPaste: true,
    canSelectAll: true,
  });
});

test("computeMenuItems keeps read-only inputs immutable but copyable", () => {
  const items = computeMenuItems(
    makeSnapshot({ start: 0, end: 3, hasSelection: true, readOnly: true }),
  );
  assert.deepEqual(items, {
    canCopy: true,
    canCut: false,
    canPaste: false,
    canSelectAll: true,
  });
});

test("computeMenuItems disables select-all for empty inputs", () => {
  const items = computeMenuItems(makeSnapshot({ hasContent: false }));
  assert.equal(items.canSelectAll, false);
});

test("clampMenuPosition keeps an in-bounds menu untouched", () => {
  assert.deepEqual(clampMenuPosition(100, 120, 160, 140, 1280, 800), { left: 100, top: 120 });
});

test("clampMenuPosition clamps right/bottom overflow with the margin", () => {
  assert.deepEqual(clampMenuPosition(1250, 780, 160, 140, 1280, 800), {
    left: 1280 - 160 - 8,
    top: 800 - 140 - 8,
  });
});

test("clampMenuPosition pins to the margin in tiny viewports", () => {
  assert.deepEqual(clampMenuPosition(50, 50, 300, 300, 200, 200), { left: 8, top: 8 });
});

test("resolveOpenSelection keeps the live selection of a focused input", () => {
  assert.deepEqual(resolveOpenSelection(true, 2, 5, 10), { start: 2, end: 5 });
  assert.deepEqual(resolveOpenSelection(true, 3, 3, 10), { start: 3, end: 3 });
});

test("resolveOpenSelection falls back to the end when a focused input reports no selection", () => {
  assert.deepEqual(resolveOpenSelection(true, null, null, 10), { start: 10, end: 10 });
});

test("resolveOpenSelection collapses to the end for unfocused inputs", () => {
  // A stale selection must not resurface on right-click (reads as select-all).
  assert.deepEqual(resolveOpenSelection(false, 0, 10, 10), { start: 10, end: 10 });
  assert.deepEqual(resolveOpenSelection(false, null, null, 7), { start: 7, end: 7 });
});
