"use strict";

// Same core expectations as calendar-ics.test.js, on a device far east of UTC (UTC+14),
// where local midnight falls on the previous UTC day. TZ is process-wide, hence its own file.
process.env.TZ = "Pacific/Kiritimati";

const test = require("node:test");
const assert = require("node:assert/strict");
const CalendarIcs = require("../app/src/main/assets/web/calendar-ics.js");
const { vevent, ics } = require("./ics-fixtures.js");

const OCT_START = new Date(2026, 9, 1);
const OCT_END = new Date(2026, 10, 1);
const october = (text) => CalendarIcs.parse(text).between(OCT_START, OCT_END);

test("east of UTC: device zone is really UTC+14", () => {
  assert.equal(OCT_START.getTimezoneOffset(), -14 * 60);
});

test("east of UTC: timed event with TZID becomes UTC dateTime", () => {
  const evs = october(ics(vevent(
    "UID:a", "SUMMARY:Dentiste",
    "DTSTART;TZID=America/Toronto:20261015T090000",
    "DTEND;TZID=America/Toronto:20261015T100000",
  )));
  assert.deepEqual(evs, [{
    summary: "Dentiste",
    start: { dateTime: "2026-10-15T13:00:00.000Z" },
    end: { dateTime: "2026-10-15T14:00:00.000Z" },
  }]);
});

test("east of UTC: all-day events keep their dates, range edges respected", () => {
  const evs = october(ics(
    vevent("UID:b", "SUMMARY:Congé", "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261021"),
    vevent("UID:c", "SUMMARY:Avant", "DTSTART;VALUE=DATE:20260930", "DTEND;VALUE=DATE:20261001"),
    vevent("UID:d", "SUMMARY:Après", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261102"),
    vevent("UID:e", "SUMMARY:Voyage", "DTSTART;VALUE=DATE:20260929", "DTEND;VALUE=DATE:20261003"),
  ));
  assert.deepEqual(evs.map(e => [e.summary, e.start.date, e.end.date]), [
    ["Voyage", "2026-09-29", "2026-10-03"],
    ["Congé", "2026-10-20", "2026-10-21"],
  ]);
});

test("east of UTC: weekly all-day recurrence, last day in, rangeEnd's day out", () => {
  const evs = october(ics(vevent(
    "UID:we", "SUMMARY:Week-end",
    "DTSTART;VALUE=DATE:20261003", "DTEND;VALUE=DATE:20261004",
    "RRULE:FREQ=WEEKLY;BYDAY=SA,SU",
  )));
  const starts = evs.map(e => e.start.date);
  assert.equal(starts[0], "2026-10-03");
  assert.equal(starts[starts.length - 1], "2026-10-31");
  assert.equal(starts.length, 9);
});

test("east of UTC: weekly timed recurrence honours EXDATE", () => {
  const evs = october(ics(vevent(
    "UID:h", "SUMMARY:Hockey",
    "DTSTART;TZID=America/Toronto:20261005T180000",
    "DTEND;TZID=America/Toronto:20261005T193000",
    "RRULE:FREQ=WEEKLY",
    "EXDATE;TZID=America/Toronto:20261012T180000",
  )));
  assert.deepEqual(evs.map(e => e.start.dateTime), [
    "2026-10-05T22:00:00.000Z",
    "2026-10-19T22:00:00.000Z",
    "2026-10-26T22:00:00.000Z",
  ]);
});
