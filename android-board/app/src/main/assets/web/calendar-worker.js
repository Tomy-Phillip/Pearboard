/* Parses and expands the iCal feeds off the UI thread: the first expansion of a
 * real feed takes seconds on a Fire TV and would freeze the remote otherwise. */
"use strict";
// ical.js declares a top-level `var ICAL`, which importScripts makes a worker global;
// calendar-ics.js then picks it up from `self` and defines CalendarIcs.
importScripts("ical.js", "calendar-ics.js");

// calId (index in config.js's calendars) → { text, calendar }
const feeds = new Map();

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === "load") {
    // Same text as last time (the usual 10-minute refresh): keep the warm cache.
    // `changed` tells app.js whether the feed needs writing to localStorage again.
    const prev = feeds.get(msg.calId);
    const changed = !prev || msg.text !== prev.text;
    if (changed) {
      try {
        feeds.set(msg.calId, { text: msg.text, calendar: CalendarIcs.parse(msg.text) });
      } catch (err) {
        self.postMessage({ id: msg.id, ok: false, error: String(err) });
        return;
      }
    }
    self.postMessage({ id: msg.id, ok: true, result: { changed: changed } });
  } else if (msg.type === "between") {
    // One merged list per range, each event tagged with the calendar it came from.
    let result;
    try {
      result = msg.ranges.map(function (r) {
        let out = [];
        feeds.forEach(function (feed, calId) {
          const evs = feed.calendar.between(new Date(r[0]), new Date(r[1]));
          evs.forEach(function (ev) { ev.calId = calId; });
          out = out.concat(evs);
        });
        return out;
      });
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: String(err) });
      return;
    }
    self.postMessage({ id: msg.id, ok: true, result: result });
  }
};
