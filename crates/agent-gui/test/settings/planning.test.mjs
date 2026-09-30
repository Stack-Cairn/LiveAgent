import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const loader = createTsModuleLoader({ mocks: { react: { useSyncExternalStore() {} }, "@liveagent/app/lib/planning/backend": { backend: { scope: () => "test" } } } });
const time = loader.loadModule("@liveagent/ui/lib/planning/time.ts");
const geometry = loader.loadModule("@liveagent/ui/lib/planning/geometry.ts");
const { createPlanningStore, PlanningConflictError } = loader.loadModule("@liveagent/ui/lib/planning/store.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("Planning drag preserves off-grid minute offsets, duration and independent edges", () => {
  const original = { kind: "timed", startAt: Date.parse("2026-09-07T10:07:00Z"), endAt: Date.parse("2026-09-07T11:22:00Z"), timeZone: "UTC" };
  const drag = { kind: "move", original, grabOffsetMs: 11 * time.MINUTE, durationMinutes: 75 };
  const moved = geometry.dragTime(drag, original.startAt + 11 * time.MINUTE + 31 * time.MINUTE, "UTC");
  assert.equal(moved.startAt, original.startAt + 30 * time.MINUTE);
  assert.equal(moved.endAt - moved.startAt, 75 * time.MINUTE);
  const top = geometry.dragTime({ ...drag, kind: "start" }, original.startAt - 16 * time.MINUTE, "UTC");
  assert.equal(top.startAt, original.startAt - 15 * time.MINUTE); assert.equal(top.endAt, original.endAt);
  const bottom = geometry.dragTime({ ...drag, kind: "end" }, original.startAt - time.HOUR, "UTC");
  assert.equal(bottom.startAt, original.startAt); assert.equal(bottom.endAt, original.startAt + 15 * time.MINUTE);
});
test("Planning time conversion distinguishes DST gaps, folds and 23/25-hour days", () => {
  assert.equal(time.localCandidates("2026-03-08", "02:30", "America/New_York").length, 0);
  assert.equal(time.localCandidates("2026-11-01", "01:30", "America/New_York").length, 2);
  assert.equal(time.dayStart("2026-03-09", "America/New_York") - time.dayStart("2026-03-08", "America/New_York"), 23 * time.HOUR);
  assert.equal(time.dayStart("2026-11-02", "America/New_York") - time.dayStart("2026-11-01", "America/New_York"), 25 * time.HOUR);
  assert.equal(time.addDays("2026-03-08", 1), "2026-03-09");
});
test("Planning overlap layout clips cross-midnight blocks and treats touching intervals as disjoint", () => {
  const from = Date.parse("2026-09-07T00:00:00Z");
  const event = (id, start, end) => ({ id, time: { kind: "timed", startAt: from + start * time.HOUR, endAt: from + end * time.HOUR, timeZone: "UTC" } });
  const items = geometry.layoutEvents([event("a", -1, 2), event("b", 1, 3), event("c", 3, 4)], from, from + 24 * time.HOUR, 64);
  assert.deepEqual(plain(items.map((e) => [e.event.id, e.column, e.columns, e.top, e.height, e.startsHere])), [["a", 0, 2, 0, 128, false], ["b", 1, 2, 64, 128, true], ["c", 0, 1, 192, 64, true]]);
});
test("Planning retries the same request after a lost response and never auto-overwrites conflicts", async () => {
  const writes = []; let querySeq = 0;
  const store = createPlanningStore({ scope: () => "a", subscribe: () => () => {}, async call(action, data) { if (action === "query") return { seq: ++querySeq }; writes.push(data); if (writes.length === 1) throw new Error("lost response"); return { status: "conflict", seq: 1, item: { revision: 2 } }; } });
  await assert.rejects(store.mutate({ requestId: "stable-request", action: "event.update", id: "event-1", expectedRevision: 1, data: { title: "draft" } }), PlanningConflictError);
  assert.equal(writes.length, 2); assert.deepEqual(plain(writes[0]), plain(writes[1])); assert.equal(writes[1].expectedRevision, 1);
});
test("Planning ignores late snapshots from a previous Agent", async () => {
  let scope = "a", resolveOld;
  const store = createPlanningStore({ scope: () => scope, subscribe: () => () => {}, call() { if (scope === "a") return new Promise((resolve) => { resolveOld = resolve; }); return Promise.resolve({ seq: 7, timeZone: "UTC" }); } });
  const old = store.refresh(); scope = "b"; await store.refresh(); resolveOld({ seq: 100, timeZone: "Asia/Shanghai" }); await old;
  assert.equal(store.getState().scope, "b"); assert.equal(store.getState().snapshot.seq, 7); assert.equal(store.getState().loading, false);
});

test("Planning filled calendar colors choose readable text and reject malformed colors", () => {
  const { eventAppearance } = loader.loadModule("@liveagent/ui/pages/planning/eventAppearance.ts");
  for (const color of ["#000000", "#2c7370", "#2563eb"]) {
    assert.equal(eventAppearance(color).color, "var(--color-white)", color);
    assert.equal(eventAppearance(color).backgroundColor, color);
  }
  for (const color of ["#ffffff", "#e2aa3c", "#87943e", "#79a8b8"]) {
    assert.equal(eventAppearance(color).color, "var(--color-black)", color);
  }
  for (const color of [undefined, "", "#fff", "not-a-color"]) {
    assert.equal(eventAppearance(color).backgroundColor, "hsl(var(--muted))");
    assert.equal(eventAppearance(color).color, "hsl(var(--foreground))");
  }
});

test("Linked calendar entries always display the task title, including legacy overrides", () => {
  const event = { todoId: "task", title: "Snapshot", titleOverride: "Old override" };
  assert.equal(time.eventTitle(event, [{ id: "task", title: "Current task" }]), "Current task");
  assert.equal(time.eventTitle({ ...event, todoId: null }, []), "Old override");
});


test("Task list layers share names/colors and retain recursive hierarchy across filters", () => {
  const lists = loader.loadModule("@liveagent/ui/lib/planning/taskLists.ts");
  const { calendarLayer } = loader.loadModule("@liveagent/ui/pages/planning/calendarDisplay.ts");
  const { eventColor } = loader.loadModule("@liveagent/ui/pages/planning/eventAppearance.ts");
  const snapshot = { groups: [{id:"work",name:"工作",color:"#64748b"}], todos: [{id:"parent",title:"周会",groupId:"work"},{id:"child",title:"材料",parentId:"parent",groupId:"work"}], calendars:[{id:"cal",color:"#ffffff"}] };
  const event = {calendarId:"cal",todoId:"child"};
  assert.deepEqual(plain(lists.taskLists(snapshot)).map(v=>v.name),["我的任务","工作"]);
  assert.equal(calendarLayer(event,snapshot),lists.taskListLayer("work"));
  assert.equal(eventColor(event,snapshot),"#64748b");
  assert.equal(eventColor({calendarId:"cal"},snapshot),"#ffffff");
  const hidden = new Set([lists.taskListLayer("work")]);
  assert.equal(hidden.has(calendarLayer(event,snapshot)),true);
  snapshot.todos[1].groupId = null;
  assert.equal(hidden.has(calendarLayer(event,snapshot)),false);
  const tree = lists.taskTree(snapshot.todos);
  assert.equal(tree.length,1); assert.equal(tree[0].children[0].todo.id,"child");
  assert.equal(lists.taskTree([snapshot.todos[1]])[0].todo.id,"child");
});


test("Task hierarchy renders recursively and moving a subtree can exclude all descendants", () => {
 const {taskTree,taskDescendants,compareTaskOrder}=loader.loadModule("@liveagent/ui/lib/planning/taskLists.ts");
 const items=[{id:"a",createdAt:3,sortOrder:2048},{id:"b",createdAt:2,parentId:"a"},{id:"c",createdAt:1,parentId:"b"},{id:"d",createdAt:4,sortOrder:1024}];
 const tree=taskTree(items.sort(compareTaskOrder));
 assert.equal(tree.find(t=>t.todo.id==="a").children[0].children[0].todo.id,"c");
 assert.deepEqual([...taskDescendants(items,"a")].sort(),["a","b","c"]);
 assert.equal(tree[0].todo.id,"d");
});
test("Unified date/time selection validates ranges, multi-day all-day and DST gaps", () => {
 const {dateTimeEvent,moveDate}=loader.loadModule("@liveagent/ui/lib/planning/dateTime.ts");
 const range={date:"2026-09-27",time:"09:07",endDate:"2026-09-27",endTime:"10:22"};
 const event=dateTimeEvent(range,"Asia/Shanghai");assert.equal(event.endAt-event.startAt,75*60000);
 assert.equal(dateTimeEvent({date:"2026-09-27",time:"",endDate:"2026-09-29"},"UTC").endDateExclusive,"2026-09-30");
 assert.throws(()=>dateTimeEvent({...range,endTime:"09:10"},"UTC"),/15/);
 assert.throws(()=>dateTimeEvent({date:"2026-03-08",time:"02:30",endTime:"03:30"},"America\/New_York"));
 assert.equal(moveDate({...range,endDate:"2026-09-29"},"2026-10-01").endDate,"2026-10-03");
});

test("Overlap layout lets a block expand into columns that stay free for its whole duration", () => {
  const from = Date.parse("2026-09-07T00:00:00Z");
  const event = (id, start, end) => ({ id, time: { kind: "timed", startAt: from + start * time.HOUR, endAt: from + end * time.HOUR, timeZone: "UTC" } });
  // Same start, longer first: a 9–10 (col 0), c 9–9.75 (col 1), b 9–9.5 (col 2); d 9.75–10 reuses col 1.
  const placed = Object.fromEntries(geometry.layoutEvents([event("a", 9, 10), event("b", 9, 9.5), event("c", 9, 9.75), event("d", 9.75, 10)], from, from + 24 * time.HOUR, 48).map((p) => [p.event.id, p]));
  assert.deepEqual([placed.a.column, placed.b.column, placed.c.column, placed.d.column], [0, 2, 1, 1]);
  assert.equal(placed.a.columns, 3);
  // d starts when b and c have ended, so it widens across the free columns 1–2; a stays single.
  assert.equal(placed.d.span, 2);
  assert.equal(placed.a.span, 1);
  assert.equal(placed.b.span, 1);
});

test("Planning deadline chips share columns with events instead of covering them", () => {
  const from = Date.parse("2026-09-07T00:00:00Z");
  const hourHeight = 48;
  const chipMs = ((22 + 2) / hourHeight) * time.HOUR;
  const at = (h) => from + h * time.HOUR;
  const item = (id, start, end) => ({ id, time: { kind: "timed", startAt: start, endAt: end, timeZone: "UTC" } });
  // A 10:00–11:00 event and a chip due 10:00: the event keeps column 0, the chip goes right.
  const placed = Object.fromEntries(geometry.layoutEvents([item("deadline:t", at(10), at(10) + chipMs), item("e", at(10), at(11))], from, at(24), hourHeight).map((p) => [p.event.id, p]));
  assert.equal(placed.e.column, 0);
  assert.equal(placed["deadline:t"].column, 1);
  assert.equal(placed.e.columns, 2);
  // A chip due 10:45 overlaps the event only while it lasts; an event after the chip is free.
  const later = Object.fromEntries(geometry.layoutEvents([item("e", at(10), at(11)), item("deadline:t", at(10.75), at(10.75) + chipMs), item("f", at(11.5), at(12))], from, at(24), hourHeight).map((p) => [p.event.id, p]));
  assert.equal(later["deadline:t"].column, 1);
  assert.equal(later.f.columns, 1);
});
