/* Turns a Google Calendar iCal feed into the event shape app.js already uses
 * (Google Calendar API style: { summary, start: {dateTime|date}, end: {...} }).
 * Loads as a plain <script> in the WebView (global ICAL → global CalendarIcs)
 * and through require() in Node for the tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./ical.js"));
  } else {
    root.CalendarIcs = factory(root.ICAL);
  }
})(typeof self !== "undefined" ? self : this, function (ICAL) {
  "use strict";

  // Safety cap per recurring event: a daily event started decades ago still fits.
  const MAX_OCCURRENCES = 20000;
  const DAY_MS = 24 * 60 * 60 * 1000;

  function parse(icsText) {
    const jcal = ICAL.parse(icsText);
    if (!Array.isArray(jcal) || jcal[0] !== "vcalendar") {
      throw new Error("Not an iCalendar feed");
    }
    const cal = new ICAL.Component(jcal);
    for (const tz of cal.getAllSubcomponents("vtimezone")) {
      ICAL.TimezoneService.register(tz);
    }

    // Exceptions (RECURRENCE-ID) may appear before their master in the feed.
    const masters = [];
    const exceptionsByUid = new Map();
    for (const vevent of cal.getAllSubcomponents("vevent")) {
      if (vevent.hasProperty("recurrence-id")) {
        const uid = vevent.getFirstPropertyValue("uid");
        if (!exceptionsByUid.has(uid)) exceptionsByUid.set(uid, []);
        exceptionsByUid.get(uid).push(vevent);
      } else {
        masters.push(vevent);
      }
    }
    const events = masters.map((vevent) => new ICAL.Event(vevent, {
      exceptions: exceptionsByUid.get(vevent.getFirstPropertyValue("uid")) || [],
    }));

    return { between: (rangeStart, rangeEnd) => between(events, rangeStart, rangeEnd) };
  }

  function between(events, rangeStart, rangeEnd) {
    const found = [];
    for (const event of events) {
      if (isCancelled(event)) continue;
      if (!event.isRecurring()) {
        collect(found, event, event.startDate, event.endDate, rangeStart, rangeEnd);
        continue;
      }
      // Pad by a day: ical.js compares all-day dates as UTC midnight.
      const stop = ICAL.Time.fromJSDate(new Date(rangeEnd.getTime() + DAY_MS), true);
      const it = event.iterator();
      let next;
      let count = 0;
      while ((next = it.next()) && count++ < MAX_OCCURRENCES) {
        if (next.compare(stop) >= 0) break;
        const occ = event.getOccurrenceDetails(next);
        if (isCancelled(occ.item)) continue;
        collect(found, occ.item, occ.startDate, occ.endDate, rangeStart, rangeEnd);
      }
    }
    return found.sort((a, b) => a.startMs - b.startMs).map((f) => f.event);
  }

  function collect(found, item, startTime, endTime, rangeStart, rangeEnd) {
    const end = endTime || startTime;
    const startMs = toJsDate(startTime).getTime();
    const endMs = toJsDate(end).getTime();
    // [start, end) overlaps [rangeStart, rangeEnd); zero-length events count at their start.
    const overlaps = startMs < rangeEnd.getTime()
      && (endMs > rangeStart.getTime() || startMs >= rangeStart.getTime());
    if (!overlaps) return;
    found.push({
      startMs,
      event: { summary: item.summary || "", start: toApiTime(startTime), end: toApiTime(end) },
    });
  }

  function toJsDate(t) {
    return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate();
  }

  function toApiTime(t) {
    return t.isDate ? { date: t.toString() } : { dateTime: t.toJSDate().toISOString() };
  }

  function isCancelled(event) {
    return String(event.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED";
  }

  return { parse };
});
