"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PhotoQueue = require("../app/src/main/assets/web/photo-queue.js");

const msg = (id, createdAt) => ({ id, text: "t" + id, author: "Tomy", createdAt });

test("starts empty", () => {
  const q = PhotoQueue.create();
  assert.equal(q.current(), null);
  assert.equal(q.size(), 0);
});

test("keeps the server's order and doesn't duplicate on later polls", () => {
  const q = PhotoQueue.create();
  assert.equal(q.merge([msg("a", 1), msg("b", 2)]), 2);
  assert.equal(q.merge([msg("a", 1), msg("b", 2), msg("c", 3)]), 1);
  assert.deepEqual(q.ids(), ["a", "b", "c"]);
  assert.equal(q.current().id, "a");
});

test("a message arriving while one is shown goes to the end", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.equal(q.current().id, "a");
  assert.equal(q.size(), 2);
});

test("dismiss moves to the next and remembers the seen id to send", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.equal(q.dismiss(), "a");
  assert.equal(q.current().id, "b");
  assert.deepEqual(q.unsentSeen(), ["a"]);
});

test("a dismissed message is not re-queued while its seen is unsent", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.dismiss();
  // The server still lists it (the "seen" POST failed): don't show it again.
  assert.equal(q.merge([msg("a", 1)]), 0);
  assert.equal(q.current(), null);
});

test("markSent clears the pending seen; the id is forgotten once the server drops it", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.dismiss();
  q.markSent("a");
  assert.deepEqual(q.unsentSeen(), []);
  // Still listed by a poll that raced the POST: still not shown.
  assert.equal(q.merge([msg("a", 1)]), 0);
  // Server no longer lists it: forgotten (keeps memory bounded).
  q.merge([]);
  assert.equal(q.knows("a"), false);
});

test("skip drops the current message without marking it seen, so a later poll brings it back", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1), msg("b", 2)]);
  q.skip();
  assert.equal(q.current().id, "b");
  assert.deepEqual(q.unsentSeen(), []);
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.deepEqual(q.ids(), ["b", "a"]);
});

test("ignores malformed entries", () => {
  const q = PhotoQueue.create();
  assert.equal(q.merge([null, {}, { id: 5 }, msg("a", 1)]), 1);
  assert.deepEqual(q.ids(), ["a"]);
});
