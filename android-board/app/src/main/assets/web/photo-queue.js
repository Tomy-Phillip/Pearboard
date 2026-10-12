/* The TV's queue of remote photos: what to show next, and which "seen" reports
 * still have to reach the server. UMD so node --test can load it too. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PhotoQueue = factory();
})(this, function () {
  "use strict";

  const ID = /^[a-f0-9]{32}$/; // the relay's message ids; anything else never reaches a URL
  // Wait before retrying a photo that failed to load, by failure count; the last one repeats.
  const RETRY_MS = [30 * 1000, 2 * 60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];

  // options.now: the clock (Date.now by default; tests pass their own).
  function create(options) {
    const now = (options && options.now) || Date.now;
    let queue = [];        // messages to show; queue[0] is the one on screen (or loading)
    const passed = {};     // id → true once passed on the TV, until the server stops listing it
    let unsent = [];       // passed ids whose "seen" hasn't been acknowledged
    const failed = {};     // id → { count, retryAt } for photos that wouldn't load

    function isQueued(id) {
      return queue.some(function (m) { return m.id === id; });
    }

    function str(v) { return typeof v === "string" ? v : ""; }

    return {
      // Adds the server's unseen messages that aren't queued, already passed or
      // waiting out a retry delay, in the server's order (oldest first), and drops
      // queued ones it no longer lists. Returns how many were added.
      merge: function (messages) {
        const listed = {};
        let added = 0;
        (messages || []).forEach(function (m) {
          if (!m || typeof m.id !== "string" || !ID.test(m.id)) return;
          listed[m.id] = true;
          if (passed[m.id] || isQueued(m.id)) return;
          if (failed[m.id] && failed[m.id].retryAt > now()) return;
          queue.push({ id: m.id, text: str(m.text), author: str(m.author), createdAt: m.createdAt });
          added++;
        });
        // Deleted from the upload page: drop them, except the one on screen or loading.
        queue = queue.filter(function (m, i) { return i === 0 || listed[m.id]; });
        // Passed ids the server no longer lists (their "seen" landed): forget them.
        Object.keys(passed).forEach(function (id) {
          if (!listed[id] && unsent.indexOf(id) === -1) delete passed[id];
        });
        Object.keys(failed).forEach(function (id) {
          if (!listed[id]) delete failed[id];
        });
        return added;
      },
      current: function () { return queue.length ? queue[0] : null; },
      size: function () { return queue.length; },
      ids: function () { return queue.map(function (m) { return m.id; }); },
      knows: function (id) { return !!passed[id] || isQueued(id); },
      // The viewer pressed a key: drop the shown message and remember to report it.
      dismiss: function () {
        const m = queue.shift();
        if (!m) return null;
        passed[m.id] = true;
        unsent.push(m.id);
        return m.id;
      },
      // The shown message's photo wouldn't load: drop it for now; a poll re-adds it
      // once its retry delay (longer after each failure) has passed.
      skip: function () {
        const m = queue.shift();
        if (!m) return;
        const count = failed[m.id] ? failed[m.id].count + 1 : 1;
        failed[m.id] = { count: count, retryAt: now() + RETRY_MS[Math.min(count, RETRY_MS.length) - 1] };
      },
      // The photo loaded: its earlier failures no longer count.
      loaded: function (id) { delete failed[id]; },
      unsentSeen: function () { return unsent.slice(); },
      markSent: function (id) {
        unsent = unsent.filter(function (x) { return x !== id; });
      },
    };
  }

  return { create: create };
});
