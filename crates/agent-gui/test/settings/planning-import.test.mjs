import assert from "node:assert/strict";
import test from "node:test";
import { createTsModuleLoader } from "../helpers/load-ts-module.mjs";
const loader = createTsModuleLoader({ mocks: { react: {} } });
const { parseCalendar, readCalendarFile } = loader.loadModule("@liveagent/ui/lib/planning/calendarImport.ts");
const { isoWeek, lunarDate, zoneOffset, activeEvent, calendarLayer } = loader.loadModule("@liveagent/ui/pages/planning/calendarDisplay.ts");
const range = {from: "2026-09-01", to: "2026-09-30", zone: "Asia/Shanghai"};
const ics = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join("\r\n")}\r\nEND:VCALENDAR`;
const event = (lines) => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT`;
test("ICS imports UTC, IANA floating-zone and exclusive all-day dates", () => {
 const result = parseCalendar(ics(event(["UID:utc", "SUMMARY:UTC", "DTSTART:20260927T010000Z", "DTEND:20260927T020000Z"]),event(["UID:local", "SUMMARY:Local", "DTSTART;TZID=Asia/Shanghai:20260927T090000", "DTEND;TZID=Asia/Shanghai:20260927T100000"]),event(["UID:day", "DTSTART;VALUE=DATE:20260927", "DTEND;VALUE=DATE:20260929"])),range);
 assert.equal(result.warnings.length,0); assert.equal(result.entries.length,3);
 assert.equal(result.entries[0].time.startAt,Date.parse("2026-09-27T01:00Z"));
 assert.equal(result.entries[1].time.startAt,result.entries[0].time.startAt);
 assert.equal(result.entries[2].time.endDateExclusive,"2026-09-29");
});
test("ICS expands recurrences, exclusions and moved exceptions with stable source keys", () => {
 const source = ics(event(["UID:daily", "SUMMARY:Daily", "DTSTART:20260926T010000Z", "DTEND:20260926T020000Z", "RRULE:FREQ=DAILY;COUNT=4", "EXDATE:20260927T010000Z"]),event(["UID:daily", "RECURRENCE-ID:20260928T010000Z", "SUMMARY:Moved", "DTSTART:20260928T030000Z", "DTEND:20260928T040000Z"]));
 const result = parseCalendar(source,range);
 assert.equal(result.warnings.length,0); assert.equal(result.entries.length,3);
 assert.equal(result.entries[1].title,"Moved"); assert.equal(result.entries[1].time.startAt,Date.parse("2026-09-28T03:00Z"));
 assert.equal(result.entries[1].uid,"daily/2026-09-28T01:00:00Z");
 assert.deepEqual(result, parseCalendar(source,range));
});
test("ICS skips cancelled items, reports malformed items, rejects non-calendars and invalid ranges", () => {
 const result = parseCalendar(ics(event(["UID:cancel", "STATUS:CANCELLED", "DTSTART:20260927T010000Z", "DTEND:20260927T020000Z"]),event(["UID:short", "SUMMARY:Short", "DTSTART:20260927T010000Z", "DTEND:20260927T010100Z"])), range);
 assert.equal(result.entries.length,0); assert.equal(result.warnings.length,1);
 assert.throws(() => parseCalendar("garbage",range));
 assert.throws(() => parseCalendar(ics(),{...range,to:"2026-08-01"}));
});
test("EML extracts MIME calendar invitations without contacting a mailbox", async () => {
 const source = ics(event(["UID:mail", "SUMMARY:Invitation", "DTSTART:20260927T010000Z", "DTEND:20260927T020000Z"]));
 const eml = `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=test\r\n\r\n--test\r\nContent-Type: text/calendar; charset=utf-8\r\nContent-Disposition: attachment; filename=invite.ics\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(source).toString("base64")}\r\n--test--`;
 const result = await readCalendarFile(new File([eml],"invite.eml"),range);
 assert.equal(result.entries.length,1); assert.equal(result.entries[0].title,"Invitation");
});
test("Calendar display handles ISO week boundaries, lunar dates, zones and task trash layers", () => {
 assert.equal(isoWeek("2021-01-01"),53); assert.equal(isoWeek("2021-01-04"),1); assert.equal(isoWeek("2021-01-11"),2); assert.equal(isoWeek("2026-09-27"),39);
 assert.equal(lunarDate("2026-09-25"),"十五");
 assert.equal(zoneOffset("2026-07-01","America/New_York"),"GMT-4");
 const e={id:"event",todoId:"todo",calendarId:"cal"};
 assert.equal(calendarLayer(e,{todos:[{id:"todo"}]}),"planning:tasks");
 assert.equal(activeEvent(e,{events:[e],todos:[{id:"todo",deletedAt:1}]}),false);
 assert.equal(activeEvent({...e,seriesId:"series"},{events:[{id:"series",deletedAt:1}],todos:[]}),false);
});
