"use strict";

// Fix the zone before any Date is created: all-day ranges are local-midnight based.
process.env.TZ = "America/Toronto";

const test = require("node:test");
const assert = require("node:assert/strict");
const CalendarIcs = require("../app/src/main/assets/web/calendar-ics.js");

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  "TZID:America/Toronto",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
].join("\r\n");

const vevent = (...lines) => ["BEGIN:VEVENT", ...lines, "END:VEVENT"].join("\r\n");
const ics = (...events) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//pearboard//test//EN", VTIMEZONE, ...events, "END:VCALENDAR"]
    .join("\r\n");

const OCT_START = new Date(2026, 9, 1);
const OCT_END = new Date(2026, 10, 1);
const october = (text) => CalendarIcs.parse(text).between(OCT_START, OCT_END);

test("timed event with TZID becomes UTC dateTime", () => {
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

test("all-day event keeps date strings with exclusive end", () => {
  const evs = october(ics(vevent(
    "UID:b", "SUMMARY:Congé",
    "DTSTART;VALUE=DATE:20261020", "DTEND;VALUE=DATE:20261021",
  )));
  assert.deepEqual(evs, [{
    summary: "Congé",
    start: { date: "2026-10-20" },
    end: { date: "2026-10-21" },
  }]);
});

test("multi-day event starting before the range is included", () => {
  const evs = october(ics(vevent(
    "UID:c", "SUMMARY:Voyage",
    "DTSTART;VALUE=DATE:20260929", "DTEND;VALUE=DATE:20261003",
  )));
  assert.equal(evs.length, 1);
  assert.equal(evs[0].summary, "Voyage");
});

test("events outside the range are excluded", () => {
  const evs = october(ics(vevent(
    "UID:d", "SUMMARY:Noël",
    "DTSTART;VALUE=DATE:20261225", "DTEND;VALUE=DATE:20261226",
  )));
  assert.deepEqual(evs, []);
});

test("weekly recurrence honours EXDATE and the range end", () => {
  const evs = october(ics(vevent(
    "UID:e", "SUMMARY:Hockey",
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

test("moved occurrence (RECURRENCE-ID) replaces the original slot", () => {
  const evs = october(ics(
    // Exception listed before its master, as Google sometimes does.
    vevent(
      "UID:f", "SUMMARY:Cours (déplacé)",
      "RECURRENCE-ID;TZID=America/Toronto:20261008T120000",
      "DTSTART;TZID=America/Toronto:20261009T150000",
      "DTEND;TZID=America/Toronto:20261009T160000",
    ),
    vevent(
      "UID:f", "SUMMARY:Cours",
      "DTSTART;TZID=America/Toronto:20261001T120000",
      "DTEND;TZID=America/Toronto:20261001T130000",
      "RRULE:FREQ=WEEKLY;COUNT=3",
    ),
  ));
  assert.deepEqual(evs.map(e => [e.summary, e.start.dateTime]), [
    ["Cours", "2026-10-01T16:00:00.000Z"],
    ["Cours (déplacé)", "2026-10-09T19:00:00.000Z"],
    ["Cours", "2026-10-15T16:00:00.000Z"],
  ]);
});

test("cancelled occurrences and cancelled events are skipped", () => {
  const evs = october(ics(
    vevent(
      "UID:g", "SUMMARY:Yoga",
      "DTSTART;TZID=America/Toronto:20261002T070000",
      "DTEND;TZID=America/Toronto:20261002T080000",
      "RRULE:FREQ=WEEKLY;COUNT=2",
    ),
    vevent(
      "UID:g", "SUMMARY:Yoga", "STATUS:CANCELLED",
      "RECURRENCE-ID;TZID=America/Toronto:20261009T070000",
      "DTSTART;TZID=America/Toronto:20261009T070000",
      "DTEND;TZID=America/Toronto:20261009T080000",
    ),
    vevent(
      "UID:h", "SUMMARY:Annulé", "STATUS:CANCELLED",
      "DTSTART;VALUE=DATE:20261014", "DTEND;VALUE=DATE:20261015",
    ),
  ));
  assert.deepEqual(evs.map(e => e.start.dateTime), ["2026-10-02T11:00:00.000Z"]);
});

test("results are sorted by start", () => {
  const evs = october(ics(
    vevent("UID:i", "SUMMARY:B", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"),
    vevent("UID:j", "SUMMARY:A", "DTSTART;VALUE=DATE:20261011", "DTEND;VALUE=DATE:20261012"),
  ));
  assert.deepEqual(evs.map(e => e.summary), ["A", "B"]);
});

test("non-iCalendar text throws", () => {
  assert.throws(() => CalendarIcs.parse("<html>Not found</html>"));
});
