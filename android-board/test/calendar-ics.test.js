"use strict";

// Fix the zone before any Date is created: all-day ranges are local-midnight based.
process.env.TZ = "America/Toronto";

const test = require("node:test");
const assert = require("node:assert/strict");
const CalendarIcs = require("../app/src/main/assets/web/calendar-ics.js");
const { vevent, ics, withWarnings } = require("./ics-fixtures.js");

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

test("exception without a master (invited to one instance) is kept", () => {
  const evs = october(ics(
    vevent(
      "UID:orphan", "SUMMARY:Invité",
      "RECURRENCE-ID;TZID=America/Toronto:20261008T120000",
      "DTSTART;TZID=America/Toronto:20261008T120000",
      "DTEND;TZID=America/Toronto:20261008T130000",
    ),
    vevent(
      "UID:orphan-cancelled", "SUMMARY:Annulé", "STATUS:CANCELLED",
      "RECURRENCE-ID;TZID=America/Toronto:20261009T120000",
      "DTSTART;TZID=America/Toronto:20261009T120000",
      "DTEND;TZID=America/Toronto:20261009T130000",
    ),
  ));
  assert.deepEqual(evs, [{
    summary: "Invité",
    start: { dateTime: "2026-10-08T16:00:00.000Z" },
    end: { dateTime: "2026-10-08T17:00:00.000Z" },
  }]);
});

test("occurrence moved into the range from weeks later is found", () => {
  const evs = october(ics(
    vevent(
      "UID:m", "SUMMARY:Mensuel",
      "DTSTART;TZID=America/Toronto:20261001T120000",
      "DTEND;TZID=America/Toronto:20261001T130000",
      "RRULE:FREQ=MONTHLY;COUNT=3",
    ),
    vevent(
      "UID:m", "SUMMARY:Avancé",
      "RECURRENCE-ID;TZID=America/Toronto:20261201T120000",
      "DTSTART;TZID=America/Toronto:20261030T120000",
      "DTEND;TZID=America/Toronto:20261030T130000",
    ),
  ));
  assert.deepEqual(evs.map(e => [e.summary, e.start.dateTime]), [
    ["Mensuel", "2026-10-01T16:00:00.000Z"],
    ["Avancé", "2026-10-30T16:00:00.000Z"],
  ]);
});

test("occurrence moved out of the range (earlier) is not shown", () => {
  const evs = october(ics(
    vevent(
      "UID:m2", "SUMMARY:Mensuel",
      "DTSTART;TZID=America/Toronto:20260901T120000",
      "DTEND;TZID=America/Toronto:20260901T130000",
      "RRULE:FREQ=MONTHLY;COUNT=2",
    ),
    vevent(
      "UID:m2", "SUMMARY:Reculé",
      "RECURRENCE-ID;TZID=America/Toronto:20261001T120000",
      "DTSTART;TZID=America/Toronto:20260929T120000",
      "DTEND;TZID=America/Toronto:20260929T130000",
    ),
  ));
  assert.deepEqual(evs, []);
});

test("a malformed VEVENT is skipped without hiding the others", () => {
  const { result: evs, warnings } = withWarnings(() => october(ics(
    vevent("UID:broken", "SUMMARY:Cassé"),
    vevent("UID:broken-rec", "SUMMARY:Cassé aussi", "RRULE:FREQ=DAILY"),
    vevent("UID:ok", "SUMMARY:OK", "DTSTART;VALUE=DATE:20261012", "DTEND;VALUE=DATE:20261013"),
  )));
  assert.deepEqual(evs.map(e => e.summary), ["OK"]);
  assert.ok(warnings.length >= 1, "a warning is logged for the broken event");
});

test("a broken event warns once, not on every between() call", () => {
  const { warnings } = withWarnings(() => {
    const cal = CalendarIcs.parse(ics(vevent("UID:broken2", "SUMMARY:Cassé", "RRULE:FREQ=DAILY")));
    cal.between(OCT_START, OCT_END);
    cal.between(OCT_START, OCT_END);
    cal.between(new Date(2026, 10, 1), new Date(2026, 11, 1));
  });
  assert.equal(warnings.length, 1);
});

test("weekly all-day recurrence: last day included, rangeEnd's day excluded", () => {
  const evs = october(ics(vevent(
    "UID:we", "SUMMARY:Week-end",
    "DTSTART;VALUE=DATE:20261003", "DTEND;VALUE=DATE:20261004",
    "RRULE:FREQ=WEEKLY;BYDAY=SA,SU",
  )));
  assert.deepEqual(evs.map(e => [e.start.date, e.end.date]), [
    ["2026-10-03", "2026-10-04"],
    ["2026-10-04", "2026-10-05"],
    ["2026-10-10", "2026-10-11"],
    ["2026-10-11", "2026-10-12"],
    ["2026-10-17", "2026-10-18"],
    ["2026-10-18", "2026-10-19"],
    ["2026-10-24", "2026-10-25"],
    ["2026-10-25", "2026-10-26"],
    ["2026-10-31", "2026-11-01"],
  ]);
});

test("all-day event without DTEND lasts one day", () => {
  const evs = october(ics(vevent("UID:nd", "SUMMARY:Jour", "DTSTART;VALUE=DATE:20261010")));
  assert.deepEqual(evs, [{ summary: "Jour", start: { date: "2026-10-10" }, end: { date: "2026-10-11" } }]);
});

test("timed event without DTEND is zero-length and kept at its start", () => {
  const evs = october(ics(vevent("UID:zl", "SUMMARY:Rappel", "DTSTART:20261010T150000Z")));
  assert.deepEqual(evs, [{
    summary: "Rappel",
    start: { dateTime: "2026-10-10T15:00:00.000Z" },
    end: { dateTime: "2026-10-10T15:00:00.000Z" },
  }]);
});

test("recurring occurrence starting before the range but overlapping it is included", () => {
  const evs = october(ics(vevent(
    "UID:ov", "SUMMARY:Camp",
    "DTSTART;VALUE=DATE:20260930", "DTEND;VALUE=DATE:20261003",
    "RRULE:FREQ=WEEKLY;COUNT=2",
  )));
  assert.deepEqual(evs.map(e => [e.start.date, e.end.date]), [
    ["2026-09-30", "2026-10-03"],
    ["2026-10-07", "2026-10-10"],
  ]);
});

// A busy feed: decades-old daily and weekly series, as Google keeps them forever.
function busyFeed() {
  const events = [];
  for (let i = 0; i < 10; i++) {
    events.push(vevent(
      `UID:daily${i}`, `SUMMARY:Daily ${i}`,
      "DTSTART;TZID=America/Toronto:20160101T080000",
      "DTEND;TZID=America/Toronto:20160101T083000",
      "RRULE:FREQ=DAILY",
    ));
  }
  for (let i = 0; i < 20; i++) {
    events.push(vevent(
      `UID:weekly${i}`, `SUMMARY:Weekly ${i}`,
      "DTSTART;TZID=America/Toronto:20100104T180000",
      "DTEND;TZID=America/Toronto:20100104T190000",
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR",
    ));
  }
  return ics(...events);
}

test("between() reuses expanded occurrences across calls", () => {
  const text = busyFeed();
  const sept = [new Date(2026, 8, 1), new Date(2026, 9, 1)];
  const nov = [new Date(2026, 10, 1), new Date(2026, 11, 1)];

  const cal = CalendarIcs.parse(text);
  cal.between(OCT_START, OCT_END);
  const t0 = performance.now();
  const novEvs = cal.between(...nov);
  const elapsed = performance.now() - t0;
  // Re-walking from DTSTART took ~2.5 s here; extending the cache by a month takes ~20 ms.
  // 100 ms leaves a wide margin against slow machines while still catching a regression.
  assert.ok(elapsed < 100, `second between() took ${elapsed.toFixed(1)} ms`);

  // Cached results match a fresh parse, including an earlier range after a later one.
  assert.deepEqual(novEvs, CalendarIcs.parse(text).between(...nov));
  assert.deepEqual(cal.between(...sept), CalendarIcs.parse(text).between(...sept));
  assert.deepEqual(cal.between(OCT_START, OCT_END), CalendarIcs.parse(text).between(OCT_START, OCT_END));
  assert.equal(novEvs.length, 30 * 10 + 20 * 13);
});
