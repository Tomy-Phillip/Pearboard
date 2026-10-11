/* Parses and expands the iCal feed off the UI thread: the first expansion of a
 * real feed takes seconds on a Fire TV and would freeze the remote otherwise. */
"use strict";
// ical.js declares a top-level `var ICAL`, which importScripts makes a worker global;
// calendar-ics.js then picks it up from `self` and defines CalendarIcs.
importScripts("ical.js", "calendar-ics.js");

let lastText = null;
let calendar = null;

self.onmessage = function (e) {
  const msg = e.data;
  if (msg.type === "load") {
    // Same text as last time (the usual 10-minute refresh): keep the warm cache.
    if (msg.text !== lastText) {
      try {
        calendar = CalendarIcs.parse(msg.text);
        lastText = msg.text;
      } catch (err) {
        self.postMessage({ id: msg.id, ok: false, error: String(err) });
        return;
      }
    }
    self.postMessage({ id: msg.id, ok: true });
  } else if (msg.type === "between") {
    let result;
    try {
      result = msg.ranges.map(function (r) {
        return calendar ? calendar.between(new Date(r[0]), new Date(r[1])) : [];
      });
    } catch (err) {
      self.postMessage({ id: msg.id, ok: false, error: String(err) });
      return;
    }
    self.postMessage({ id: msg.id, ok: true, result: result });
  }
};
