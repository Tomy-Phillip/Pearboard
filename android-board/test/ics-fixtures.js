"use strict";

// Shared feed builders for the calendar-ics tests (not a test file itself).

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

// Runs fn with console.warn captured, so expected warnings don't clutter test output.
function withWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    return { result: fn(), warnings };
  } finally {
    console.warn = original;
  }
}

module.exports = { vevent, ics, withWarnings };
