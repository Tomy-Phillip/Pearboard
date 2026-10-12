/* The TV's queue of remote photos: what to show next, and which "seen" reports
 * still have to reach the server. UMD so node --test can load it too. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PhotoQueue = factory();
})(this, function () {
  "use strict";

  function create() {
    const queue = [];      // messages to show; queue[0] is the one on screen
    const passed = {};     // id → true once passed on the TV, until the server stops listing it
    let unsent = [];       // passed ids whose "seen" hasn't been acknowledged

    function isQueued(id) {
      return queue.some(function (m) { return m.id === id; });
    }

    return {
      // Adds the server's unseen messages that aren't queued or already passed,
      // in the server's order (oldest first). Returns how many were added.
      merge: function (messages) {
        const listed = {};
        let added = 0;
        (messages || []).forEach(function (m) {
          if (!m || typeof m.id !== "string") return;
          listed[m.id] = true;
          if (passed[m.id] || isQueued(m.id)) return;
          queue.push(m);
          added++;
        });
        // Passed ids the server no longer lists (their "seen" landed): forget them.
        Object.keys(passed).forEach(function (id) {
          if (!listed[id] && unsent.indexOf(id) === -1) delete passed[id];
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
      // The shown message's photo wouldn't load: drop it for now; the next poll re-adds it.
      skip: function () { queue.shift(); },
      unsentSeen: function () { return unsent.slice(); },
      markSent: function (id) {
        unsent = unsent.filter(function (x) { return x !== id; });
      },
    };
  }

  return { create: create };
});
