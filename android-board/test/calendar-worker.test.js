"use strict";

// Fix the zone before any Date is created: all-day ranges are local-midnight based.
process.env.TZ = "America/Toronto";

// Runs calendar-worker.js in a sandbox with a stand-in importScripts/postMessage,
// to check that it keeps one feed per calendar and tags events with their calId.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { vevent, ics } = require("./ics-fixtures.js");

const WEB_DIR = path.join(__dirname, "..", "app", "src", "main", "assets", "web");
const OCTOBER = [new Date(2026, 9, 1).getTime(), new Date(2026, 10, 1).getTime()];

function startWorker() {
  const replies = [];
  const sandbox = { console, Date, Map };
  sandbox.self = sandbox;
  // Copied like a real postMessage would; also turns sandbox arrays into this realm's.
  sandbox.postMessage = (msg) => replies.push(JSON.parse(JSON.stringify(msg)));
  sandbox.importScripts = (...names) => {
    for (const name of names) vm.runInContext(fs.readFileSync(path.join(WEB_DIR, name), "utf8"), sandbox);
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WEB_DIR, "calendar-worker.js"), "utf8"), sandbox);
  let nextId = 1;
  // Synchronous round trip: the worker answers inside onmessage.
  const send = (msg) => {
    const id = nextId++;
    sandbox.onmessage({ data: Object.assign({ id }, msg) });
    const reply = replies.find((r) => r.id === id);
    assert.ok(reply, `no reply to ${msg.type}`);
    return reply;
  };
  return { send };
}

const feed = (uid, summary, day) => ics(vevent(
  `UID:${uid}`, `SUMMARY:${summary}`,
  `DTSTART;TZID=America/Toronto:202610${day}T090000`,
  `DTEND;TZID=America/Toronto:202610${day}T100000`,
));

test("merges every calendar's events, tagged with their calId", () => {
  const { send } = startWorker();
  assert.equal(send({ type: "load", calId: 0, text: feed("a", "Dentiste", "15") }).ok, true);
  assert.equal(send({ type: "load", calId: 1, text: feed("b", "Piano", "16") }).ok, true);

  const reply = send({ type: "between", ranges: [OCTOBER] });
  assert.equal(reply.ok, true);
  const got = reply.result[0].map((ev) => [ev.summary, ev.calId]).sort();
  assert.deepEqual(got, [["Dentiste", 0], ["Piano", 1]]);
});

test("reloading a calendar replaces only that calendar, and reports changes", () => {
  const { send } = startWorker();
  send({ type: "load", calId: 0, text: feed("a", "Dentiste", "15") });
  send({ type: "load", calId: 1, text: feed("b", "Piano", "16") });

  assert.equal(send({ type: "load", calId: 1, text: feed("b", "Piano", "16") }).result.changed, false);
  assert.equal(send({ type: "load", calId: 1, text: feed("b", "Soccer", "17") }).result.changed, true);

  const summaries = send({ type: "between", ranges: [OCTOBER] }).result[0].map((ev) => ev.summary).sort();
  assert.deepEqual(summaries, ["Dentiste", "Soccer"]);
});

test("a broken feed is rejected and the calendar keeps its last good feed", () => {
  const { send } = startWorker();
  send({ type: "load", calId: 0, text: feed("a", "Dentiste", "15") });
  assert.equal(send({ type: "load", calId: 0, text: "not a calendar" }).ok, false);

  const summaries = send({ type: "between", ranges: [OCTOBER] }).result[0].map((ev) => ev.summary);
  assert.deepEqual(summaries, ["Dentiste"]);
});

test("nothing loaded yet: every range is empty", () => {
  const { send } = startWorker();
  assert.deepEqual(send({ type: "between", ranges: [OCTOBER, OCTOBER] }).result, [[], []]);
});
