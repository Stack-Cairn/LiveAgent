import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";

const loader = createTsModuleLoader({
  mocks: {
    react: {
      useSyncExternalStore(_subscribe, getSnapshot) {
        return getSnapshot();
      },
    },
  },
});
const i18n = loader.loadModule("@liveagent/ui/lib/planning/i18n.ts");
const cron = loader.loadModule("@liveagent/ui/lib/planning/cronLayer.ts");
const { describeCron } = loader.loadModule("@liveagent/ui/lib/planning/cronDescribe.ts");
const { calendarLayer } = loader.loadModule("@liveagent/ui/pages/planning/calendarDisplay.ts");

const MINUTE = 60_000;

function response() {
  return {
    timeZone: "Asia/Shanghai",
    now: 1_000,
    tasks: [
      { id: "daily:backup", name: "Backup", cron: "0 0 9 * * *", kind: "bash" },
      { id: "poll", name: "Poll", cron: "0 * * * * *", kind: "http" },
    ],
    occurrences: [{ taskId: "daily:backup", at: 5 * 60 * MINUTE }],
    runs: [
      {
        id: "run-ok",
        taskId: "daily:backup",
        startedAt: 60 * MINUTE,
        finishedAt: 60 * MINUTE + 2_000,
        state: "done",
        success: true,
        durationMs: 2_000,
        exitCode: 0,
        outputPreview: "ok",
      },
      {
        id: "run-long",
        taskId: "daily:backup",
        startedAt: 2 * 60 * MINUTE,
        state: "expired",
        success: false,
        durationMs: 40 * MINUTE,
        outputPreview: "",
      },
      {
        id: "run-orphan",
        taskId: "gone",
        startedAt: 3 * 60 * MINUTE,
        state: "done",
        success: true,
        durationMs: 1,
        outputPreview: "",
      },
    ],
    summaries: [
      {
        taskId: "poll",
        date: "2026-10-01",
        planned: 1440,
        plannedTruncated: true,
        ran: 3,
        failed: 2,
        firstAt: 0,
        lastAt: 10,
      },
    ],
  };
}

test("cron virtual events map planned fires, runs and day summaries", () => {
  i18n.setPlanningLocale("en-US");
  const events = cron.cronVirtualEvents(response(), "Asia/Shanghai");
  assert.equal(events.length, 4);
  assert.ok(events.every((event) => event.calendarId === cron.CRON_LAYER_ID));
  assert.ok(events.every((event) => cron.isCronEvent(event)));

  const [planned, ok, expired, summary] = events;
  assert.equal(planned.id, "cron:occ:daily:backup:18000000");
  assert.equal(planned.title, "Backup");
  assert.deepEqual(planned.time, {
    kind: "timed",
    startAt: 5 * 60 * MINUTE,
    endAt: 5 * 60 * MINUTE + 15 * MINUTE,
    timeZone: "Asia/Shanghai",
  });

  assert.equal(ok.id, "cron:run:run-ok");
  assert.equal(ok.title, "✓ Backup");
  // Short runs are stretched to the minimum block length; long runs keep their duration.
  assert.equal(ok.time.endAt - ok.time.startAt, 15 * MINUTE);
  assert.equal(expired.title, "✕ Backup");
  assert.equal(expired.time.endAt - expired.time.startAt, 40 * MINUTE);

  assert.equal(summary.id, "cron:day:poll:2026-10-01");
  assert.deepEqual(summary.time, {
    kind: "allDay",
    startDate: "2026-10-01",
    endDateExclusive: "2026-10-02",
    timeZone: "Asia/Shanghai",
  });
  assert.equal(summary.title, "Poll · 1443+×, 2 failed");

  i18n.setPlanningLocale("zh-CN");
  const zh = cron.cronVirtualEvents(response(), "Asia/Shanghai");
  assert.equal(zh[3].title, "Poll · 1443+ 次，2 次失败");
});

test("withCronLayer derives a snapshot without touching the original", () => {
  const snapshot = {
    seq: 1,
    timeZone: "UTC",
    calendars: [{ id: "work", name: "Work", color: "#2563eb", readOnly: false }],
    todos: [],
    events: [{ id: "e1", calendarId: "work" }],
    reminders: [],
    sources: [],
  };
  const frozen = JSON.stringify(snapshot);
  const events = cron.cronVirtualEvents(response(), "UTC");
  const derived = cron.withCronLayer(snapshot, events);
  assert.equal(JSON.stringify(snapshot), frozen);
  assert.notEqual(derived, snapshot);
  assert.equal(derived.events.length, 1 + events.length);
  const layer = derived.calendars.at(-1);
  assert.equal(layer.id, "cron");
  assert.equal(layer.readOnly, true);
  assert.equal(layer.sourceKind, "cron");
  assert.equal(layer.color, cron.CRON_LAYER_COLOR);
  assert.equal(calendarLayer(events[0], derived), "cron");
});

test("cron event ids round-trip, including task ids with colons", () => {
  assert.deepEqual(cron.parseCronEventId(cron.occurrenceEventId("a:b", 42)), {
    kind: "occurrence",
    taskId: "a:b",
    at: 42,
  });
  assert.deepEqual(cron.parseCronEventId(cron.runEventId("run:1")), {
    kind: "run",
    runId: "run:1",
  });
  assert.deepEqual(cron.parseCronEventId(cron.dayEventId("t", "2026-10-01")), {
    kind: "day",
    taskId: "t",
    date: "2026-10-01",
  });
  assert.equal(cron.parseCronEventId("event-1"), null);
  assert.equal(cron.parseCronEventId("cron:occ:task:notanumber"), null);
  assert.equal(cron.parseCronEventId("cron:day:task:yesterday"), null);
  assert.equal(cron.isCronEvent({ id: "cron:run:x", calendarId: "work" }), false);
});

test("showCronTasks is off by default and only true when explicitly saved", () => {
  const load = (saved) => {
    const store = new Map(saved === undefined ? [] : [["planning.display", saved]]);
    globalThis.localStorage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    };
    try {
      const fresh = createTsModuleLoader({
        mocks: {
          react: {
            useSyncExternalStore(_subscribe, getSnapshot) {
              return getSnapshot();
            },
          },
        },
      });
      const display = fresh.loadModule("@liveagent/ui/pages/planning/calendarDisplay.ts");
      return display.useCalendarPreferences()[0].showCronTasks;
    } finally {
      delete globalThis.localStorage;
    }
  };
  assert.equal(load(undefined), false);
  assert.equal(load(JSON.stringify({ showCronTasks: "yes" })), false);
  assert.equal(load(JSON.stringify({ showCronTasks: true })), true);
});

test("describeCron covers common six-field shapes in both locales", () => {
  const cases = [
    ["* * * * * *", "每秒", "Every second"],
    ["*/10 * * * * *", "每 10 秒", "Every 10 seconds"],
    ["0 * * * * *", "每分钟", "Every minute"],
    ["0 */15 * * * *", "每 15 分钟", "Every 15 minutes"],
    ["0 0 * * * *", "每小时", "Every hour"],
    ["0 0 */2 * * *", "每 2 小时", "Every 2 hours"],
    ["0 30 9 * * *", "每天 09:30", "Every day at 09:30"],
    ["0 0 9 * * MON", "每星期一 09:00", "Every Monday at 09:00"],
    ["0 0 18 * * 0", "每星期日 18:00", "Every Sunday at 18:00"],
    ["0 5 8 15 * *", "每月 15 日 08:05", "Monthly on day 15 at 08:05"],
  ];
  for (const [expression, zh, en] of cases) {
    assert.equal(describeCron(expression, "zh-CN"), zh, expression);
    assert.equal(describeCron(expression, "en-US"), en, expression);
  }
  for (const raw of ["0 30 9 * * 1-5", "15 30 9 * * *", "0 0 9 1 1 *", "* * * * *"]) {
    assert.equal(describeCron(raw, "zh-CN"), raw);
    assert.equal(describeCron(raw, "en-US"), raw);
  }
});
