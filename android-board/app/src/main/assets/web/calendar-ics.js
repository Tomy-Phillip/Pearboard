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

  // TZIDs already reported as unknown: the feed is re-parsed every refresh.
  const warnedTzids = new Set();

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
      warnUnknownZones(vevent);
      if (vevent.hasProperty("recurrence-id")) {
        const uid = vevent.getFirstPropertyValue("uid");
        if (!exceptionsByUid.has(uid)) exceptionsByUid.set(uid, []);
        exceptionsByUid.get(uid).push(vevent);
      } else {
        masters.push(vevent);
      }
    }

    const series = [];
    const masterUids = new Set();
    for (const vevent of masters) {
      const uid = vevent.getFirstPropertyValue("uid");
      masterUids.add(uid);
      const s = makeSeries(vevent, exceptionsByUid.get(uid) || []);
      if (s) series.push(s);
    }
    // Invited to a single instance of someone else's series: Google sends the
    // exception without its master. Show it as a plain event.
    for (const [uid, exceptions] of exceptionsByUid) {
      if (masterUids.has(uid)) continue;
      for (const vevent of exceptions) {
        const s = makeSeries(vevent, []);
        if (s) series.push(s);
      }
    }

    return { between: (rangeStart, rangeEnd) => between(series, rangeStart, rangeEnd) };
  }

  /* One VEVENT and its expanded occurrences, cached for the life of the parse.
   * Recurring events keep their iterator so later ranges only expand what is new;
   * earlier ranges are served from the cache. Returns null for broken events. */
  function makeSeries(vevent, exceptions) {
    const s = { vevent, occurrences: [], done: true };
    try {
      const event = new ICAL.Event(vevent, { exceptions });
      if (isCancelled(event)) return null;
      if (!event.isRecurring()) {
        s.occurrences.push(record(event, event.startDate, event.endDate));
        return s;
      }
      Object.assign(s, {
        event,
        iterator: event.iterator(),
        pending: null,
        count: 0,
        expandedToMs: -Infinity,
        maxForwardShiftMs: maxForwardShift(exceptions),
        done: false,
      });
      return s;
    } catch (err) {
      warnBroken(vevent, err);
      return null;
    }
  }

  // How far an exception was moved earlier than its slot: the slot of an occurrence
  // shown in the range can lie that much past rangeEnd, so expansion must reach it.
  function maxForwardShift(exceptions) {
    let max = 0;
    for (const vevent of exceptions) {
      try {
        const ex = new ICAL.Event(vevent);
        const shift = toJsDate(ex.recurrenceId).getTime() - toJsDate(ex.startDate).getTime();
        if (shift > max) max = shift;
      } catch (err) {
        // A broken exception can't move anything; ical.js will ignore it too.
      }
    }
    return max;
  }

  function between(series, rangeStart, rangeEnd) {
    const startMs = rangeStart.getTime();
    const endMs = rangeEnd.getTime();
    const found = [];
    for (const s of series) {
      // Pad by a day: ical.js compares all-day dates as UTC midnight.
      if (!s.done) expand(s, endMs + DAY_MS + s.maxForwardShiftMs);
      for (const occ of s.occurrences) {
        // [start, end) overlaps [rangeStart, rangeEnd); zero-length events count at their start.
        if (occ.startMs < endMs && (occ.endMs > startMs || occ.startMs >= startMs)) found.push(occ);
      }
    }
    return found.sort((a, b) => a.startMs - b.startMs).map(toApiEvent);
  }

  // Walks the series' iterator up to stopMs, appending to the cache.
  function expand(s, stopMs) {
    if (stopMs <= s.expandedToMs) return;
    try {
      const stop = ICAL.Time.fromJSDate(new Date(stopMs), true);
      for (;;) {
        // The first slot past the previous stop was fetched but not consumed.
        let next = s.pending;
        s.pending = null;
        if (!next) {
          if (s.count >= MAX_OCCURRENCES) {
            console.warn("calendar-ics: occurrence cap reached for", describe(s.vevent));
            s.done = true;
            break;
          }
          next = s.iterator.next();
          s.count++;
        }
        if (!next) {
          s.done = true;
          break;
        }
        if (next.compare(stop) >= 0) {
          s.pending = next;
          break;
        }
        const occ = s.event.getOccurrenceDetails(next);
        if (isCancelled(occ.item)) continue;
        s.occurrences.push(record(occ.item, occ.startDate, occ.endDate));
      }
      s.expandedToMs = stopMs;
    } catch (err) {
      // Keep what was expanded so far; never retry, so the warning is logged once.
      warnBroken(s.vevent, err);
      s.done = true;
    }
  }

  // Compact cached form of one occurrence; the API object is rebuilt per call
  // so callers can't mutate the cache.
  function record(item, startTime, endTime) {
    const end = endTime || startTime;
    return {
      startMs: toJsDate(startTime).getTime(),
      endMs: toJsDate(end).getTime(),
      summary: item.summary || "",
      startDate: startTime.isDate ? startTime.toString() : null,
      endDate: end.isDate ? end.toString() : null,
    };
  }

  function toApiEvent(occ) {
    return {
      summary: occ.summary,
      start: toApiTime(occ.startMs, occ.startDate),
      end: toApiTime(occ.endMs, occ.endDate),
    };
  }

  function toJsDate(t) {
    return t.isDate ? new Date(t.year, t.month - 1, t.day) : t.toJSDate();
  }

  function toApiTime(ms, date) {
    return date ? { date } : { dateTime: new Date(ms).toISOString() };
  }

  function isCancelled(event) {
    return String(event.component.getFirstPropertyValue("status") || "").toUpperCase() === "CANCELLED";
  }

  // Times in an unregistered TZID are read as device-local time by ical.js.
  function warnUnknownZones(vevent) {
    for (const name of ["dtstart", "dtend", "recurrence-id"]) {
      const prop = vevent.getFirstProperty(name);
      const tzid = prop && prop.getParameter("tzid");
      if (!tzid || warnedTzids.has(tzid) || ICAL.TimezoneService.has(tzid)) continue;
      warnedTzids.add(tzid);
      console.warn("calendar-ics: unknown TZID, times read as device-local:", tzid);
    }
  }

  function warnBroken(vevent, err) {
    console.warn("calendar-ics: skipping event", describe(vevent), "-", err && err.message);
  }

  function describe(vevent) {
    return JSON.stringify(vevent.getFirstPropertyValue("summary") || vevent.getFirstPropertyValue("uid") || "?");
  }

  return { parse };
});
