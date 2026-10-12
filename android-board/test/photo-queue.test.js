"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const PhotoQueue = require("../app/src/main/assets/web/photo-queue.js");

// Message ids are 32 hex chars, like the relay's; id("a") = "aaaa…a".
const id = (c) => c.repeat(32);
const msg = (c, createdAt) => ({ id: id(c), text: "t" + c, author: "Tomy", createdAt });

// A queue on a clock the test moves by hand.
function clocked() {
  const clock = { t: 1000000 };
  const q = PhotoQueue.create({ now: () => clock.t });
  return { q, clock };
}

test("starts empty", () => {
  const q = PhotoQueue.create();
  assert.equal(q.current(), null);
  assert.equal(q.size(), 0);
});

test("keeps the server's order and doesn't duplicate on later polls", () => {
  const q = PhotoQueue.create();
  assert.equal(q.merge([msg("a", 1), msg("b", 2)]), 2);
  assert.equal(q.merge([msg("a", 1), msg("b", 2), msg("c", 3)]), 1);
  assert.deepEqual(q.ids(), [id("a"), id("b"), id("c")]);
  assert.equal(q.current().id, id("a"));
});

test("a message arriving while one is shown goes to the end", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1)]);
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.equal(q.current().id, id("a"));
  assert.equal(q.size(), 2);
});

test("dismiss moves to the next and remembers the seen id to send", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.equal(q.dismiss(), id("a"));
  assert.equal(q.current().id, id("b"));
  assert.deepEqual(q.unsentSeen(), [id("a")]);
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
  q.markSent(id("a"));
  assert.deepEqual(q.unsentSeen(), []);
  // Still listed by a poll that raced the POST: still not shown.
  assert.equal(q.merge([msg("a", 1)]), 0);
  // Server no longer lists it: forgotten (keeps memory bounded).
  q.merge([]);
  assert.equal(q.knows(id("a")), false);
});

test("skip drops the current message without marking it seen; a poll after the backoff brings it back", () => {
  const { q, clock } = clocked();
  q.merge([msg("a", 1), msg("b", 2)]);
  q.skip();
  assert.equal(q.current().id, id("b"));
  assert.deepEqual(q.unsentSeen(), []);
  clock.t += 30 * 1000;
  q.merge([msg("a", 1), msg("b", 2)]);
  assert.deepEqual(q.ids(), [id("b"), id("a")]);
});

test("a skipped message isn't re-queued before its retry time", () => {
  const { q, clock } = clocked();
  q.merge([msg("a", 1)]);
  q.skip();
  clock.t += 29 * 1000;
  assert.equal(q.merge([msg("a", 1)]), 0);
  assert.equal(q.current(), null);
});

test("the retry delay grows with each failure: 30 s, 2 min, 10 min, then 1 h", () => {
  const { q, clock } = clocked();
  const delays = [30, 120, 600, 3600, 3600].map((s) => s * 1000);
  q.merge([msg("a", 1)]);
  delays.forEach((delay) => {
    q.skip();
    clock.t += delay - 1;
    assert.equal(q.merge([msg("a", 1)]), 0, "too early after " + delay + " ms");
    clock.t += 1;
    assert.equal(q.merge([msg("a", 1)]), 1, "due after " + delay + " ms");
  });
});

test("a photo that loads clears its failure history", () => {
  const { q, clock } = clocked();
  q.merge([msg("a", 1)]);
  q.skip();
  clock.t += 30 * 1000;
  q.merge([msg("a", 1)]);
  q.loaded(id("a"));
  q.skip();
  // Back to the first delay, not the second.
  clock.t += 30 * 1000;
  assert.equal(q.merge([msg("a", 1)]), 1);
});

test("a failed id the server stops listing is forgotten", () => {
  const { q } = clocked();
  q.merge([msg("a", 1)]);
  q.skip();
  q.merge([]);
  // Listed again (same id): no backoff left over.
  assert.equal(q.merge([msg("a", 1)]), 1);
});

test("queued messages the server stops listing are dropped, except the one on screen", () => {
  const q = PhotoQueue.create();
  q.merge([msg("a", 1), msg("b", 2), msg("c", 3)]);
  q.merge([msg("c", 3)]);
  assert.deepEqual(q.ids(), [id("a"), id("c")]);
});

test("ignores malformed entries", () => {
  const q = PhotoQueue.create();
  assert.equal(q.merge([null, {}, { id: 5 }, msg("a", 1)]), 1);
  assert.deepEqual(q.ids(), [id("a")]);
});

test("ignores ids that aren't 32 lowercase hex chars", () => {
  const q = PhotoQueue.create();
  const bad = ["a", "../photo", id("g"), id("A"), id("a") + "0"];
  assert.equal(q.merge(bad.map((x) => ({ id: x, text: "", author: "", createdAt: 1 }))), 0);
  assert.equal(q.size(), 0);
});

test("missing author and text default to empty strings", () => {
  const q = PhotoQueue.create();
  q.merge([{ id: id("a"), createdAt: 1 }]);
  assert.equal(q.current().author, "");
  assert.equal(q.current().text, "");
});
