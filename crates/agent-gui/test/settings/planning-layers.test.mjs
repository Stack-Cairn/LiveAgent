import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({ mocks: { react: { useSyncExternalStore() {} } } });
const layers = loader.loadModule("@liveagent/ui/lib/planning/layers.ts");

const calendar = (id, color, extra = {}) => ({ id, name: id, color, sortOrder: 0, isDefault: false, reminderMinutes: null, sourceKind: "local", readOnly: false, revision: 1, ...extra });
const snapshot = {
  calendars: [calendar("work", "#2563EB", { isDefault: true }), calendar("hol", "#16A34A", { readOnly: true, sourceKind: "subscription" })],
  groups: [{ id: "g1", name: "Work", color: "#7C3AED", sortOrder: 1 }],
  todos: [{ id: "t1", groupId: "g1" }, { id: "t2", groupId: "" }],
  events: [],
  myTasksColor: "#DB2777",
};

test("Planning layer colors resolve calendars, task lists, My Tasks and the cron layer", () => {
  assert.equal(layers.layerColor(snapshot, { kind: "calendar", id: "work" }), "#2563EB");
  assert.equal(layers.layerColor(snapshot, { kind: "taskList", id: "g1" }), "#7C3AED");
  assert.equal(layers.layerColor(snapshot, { kind: "taskList", id: "" }), "#DB2777");
  // A list that no longer exists falls back to My Tasks rather than an unrelated default.
  assert.equal(layers.layerColor(snapshot, { kind: "taskList", id: "gone" }), "#DB2777");
  assert.equal(layers.layerColor(snapshot, { kind: "cron" }, "#0F766E"), "#0F766E");
  assert.equal(layers.layerColor(snapshot, { kind: "calendar", id: "missing" }), undefined);
  const block = { id: "e", calendarId: "work", todoId: "t1" };
  assert.deepEqual(JSON.parse(JSON.stringify(layers.eventLayer(block, snapshot))), { kind: "taskList", id: "g1" });
  assert.equal(layers.layerIdOf({ kind: "taskList", id: "" }), "planning:tasks");
});

test("Planning layer list keeps the sidebar order and groups", () => {
  const list = layers.listLayers(snapshot, "#64748b");
  assert.deepEqual(list.map((l) => `${l.group}:${l.layerId}`), [
    "mine:work",
    "tasks:planning:tasks",
    "tasks:planning:tasks:g1",
    "other:hol",
    "cron:cron",
  ]);
  assert.equal(list[1].color, "#DB2777");
  assert.equal(list[3].subscription, true);
  assert.equal(list[4].color, "#64748b");
});

test("Planning next palette color skips used colors case-insensitively and cycles", () => {
  assert.equal(layers.nextPaletteColor(["#2563eb"]), "#0F766E");
  const all = [...layers.PLANNING_COLORS];
  assert.equal(layers.nextPaletteColor(all), layers.PLANNING_COLORS[0]);
});
