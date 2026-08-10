/*!
 * NUS Coding Clinic — unread.js   (owner: F4)
 * The nav unread badge. Contract §10.3.
 *
 *   Clinic.unread.start()                    one probe, then event-driven only
 *   Clinic.unread.stop()                     messages.js calls this at boot
 *   Clinic.unread.refresh()   -> Promise     user-initiated re-check (Refresh button)
 *   Clinic.unread.get()       -> {total, by_conversation, at}
 *   Clinic.unread.set(total, byConversation) push a locally-known count, no network
 *   Clinic.unread.markSeen(conversationId, newestIso)   write the lag overlay
 *   Clinic.unread.seenAt(conversationId) -> ISO|''      read it back
 *
 * Fires a window CustomEvent 'clinic:unread' with detail {total, by_conversation}
 * every time the number changes.
 *
 * ===========================================================================
 * THIS IS DELIBERATELY NOT A POLLER. DO NOT ADD AN INTERVAL HERE.
 * ===========================================================================
 * An earlier draft started a 60 s badge poller on every content page. Contract
 * R1/R2 killed it with arithmetic: at N=60 students and C=3 Excel calls per
 * messages.unread, that is 60 x 3 = 180 Excel calls per minute with nobody
 * doing anything at all - 180% of the documented 100-per-60 s connector
 * ceiling, before a single page load, sign-in, post or booking is counted.
 * Over a day it is ~28,800 flow runs, which exhausts the tenant's whole daily
 * allocation. The flows share that allocation with AUTHENTICATION, so the
 * failure mode is not "the badge is stale", it is "nobody can sign in".
 * Jitter, hidden-tab suspend and the 10-minute idle stop do not help in the one
 * scenario that matters: a live lab where the entire cohort is interacting.
 *
 * So the badge refreshes on exactly four events, every one of which the user is
 * already causing and already paying for:
 *   1. the once-per-page-load probe below;
 *   2. visibilitychange -> visible, rate-limited to one call per 120 s across
 *      the session (a timestamp in this module, not a timer);
 *   3. the Refresh button on index.html, via refresh();
 *   4. set(), pushed by messages.js from a payload it already has - free.
 *
 * A student who never opens Messages therefore sees a badge that is at most one
 * page-load stale. That is the right trade at an effective ~5-minute cadence.
 * Clinic.poll still exists and messages.js still uses it; this file simply does
 * not create one.
 *
 * ===========================================================================
 * THE MSG_URL GATE IS WHAT MAKES WAVE 0 GENUINELY BACKEND-FREE
 * ===========================================================================
 * Without it, §4.2's endpointFor falls through to APP_URL before wave 3, so
 * every student, on the first page load of every session, fires a full app-flow
 * run - three Excel GetItems and 10-21 seconds - purely to be told
 * "Unknown action." api.hasMsgUrl() is FALSE for the PASTE_ placeholder and
 * TRUE in MOCK, which is exactly the test we want; raw truthiness of
 * CLINIC_CONFIG.MSG_URL is not, because a placeholder string is truthy.
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var SEEN_KEY = 'clinic_msg_seen';
  var VISIBILITY_MIN_GAP_MS = 120000;   /* §10.3 item 2 */
  var MANUAL_MIN_GAP_MS = 15000;        /* a floor under a mashed Refresh button */
  var SEEN_GRACE_MS = 180000;           /* see applyOverlay() */

  var state = {
    total: 0,
    by_conversation: [],
    at: 0
  };

  var probed = false;          /* the once-per-page-load probe has been issued */
  var stopped = false;         /* messages.js owns the counts on its own page */
  var dead = false;            /* feature absent: never call messages.unread again */
  var lastCallAt = 0;
  var inflight = null;
  var wired = false;

  /* ------------------------------------------------------------- utilities */

  function ui() { return (Clinic.ui || {}); }
  function api() { return (Clinic.api || {}); }

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function parseIso(v) {
    if (!v) return 0;
    var t = Date.parse(String(v));
    return isNaN(t) ? 0 : t;
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  /* ------------------------------------------------- the write-lag overlay
     localStorage clinic_msg_seen = { conversation_id: <ISO created_at of the
     newest message actually seen> }.

     Why it exists: tbl_MsgState is Patched by messages.read, and that write is
     subject to the same ~30 s visibility lag as everything else in this
     workbook. So for up to half a minute after a student opens and reads their
     conversation, the server still reports the old unread count. Without this
     overlay the badge zeroes on open and then BOUNCES BACK to 2 on the next
     read - which trains people to ignore it.

     The rule, stated honestly because it is not one rule but two:
       - when the caller gives us a last_at (messages.list does), the comparison
         is exact: a conversation whose newest message is not newer than what we
         have seen has nothing unread in it, full stop;
       - messages.unread returns NO timestamps (deliberately - it is the
         cheapest action in the system and reads only counters), so there we
         fall back to a time window: a conversation marked seen within the last
         SEEN_GRACE_MS is displayed as zero. Three minutes is comfortably past
         the ~30 s lag, and after it expires a non-zero server count is truthful
         again and we show it.
     Both directions are monotone-correct through the lag, which is the property
     §10.3 actually asks for. */

  /* NAMESPACED BY USER, and that is not tidiness. localStorage is per ORIGIN,
     not per account: on a shared lab machine (or in the demo, where the persona
     switcher swaps user in place) the previous person's "I have seen up to
     here" would suppress the next person's unread count on the same
     conversation id. Found in the browser: reading as the student and then
     switching to the instructor showed that conversation as 0 unread when the
     instructor genuinely had 2 waiting.
     §10.3 pins the INNER shape as {conversation_id: ISO}; this keeps that
     exactly and hangs one of those maps off each user_id. A blob in the old
     flat shape is discarded rather than migrated - it cannot be attributed to
     anyone, and the cost of throwing it away is one stale badge for ~30 s. */
  function myUid() {
    try {
      if (typeof api().getUser === 'function') {
        var u = api().getUser();
        if (u && u.user_id) return String(u.user_id);
      }
    } catch (e) { /* ignore */ }
    return '_anon';
  }

  function seenBlob() {
    var raw = lsGet(SEEN_KEY);
    if (!raw) return {};
    try {
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object' && !isArray(obj)) ? obj : {};
    } catch (e) { return {}; }
  }

  function seenMap() {
    var mine = seenBlob()[myUid()];
    /* a legacy flat map stores strings here, not an object: ignore it */
    return (mine && typeof mine === 'object' && !isArray(mine)) ? mine : {};
  }

  function markSeen(conversationId, newestIso) {
    var cid = String(conversationId || '').trim();
    if (!cid) return;
    var blob = seenBlob();
    var uid = myUid();
    var map = (blob[uid] && typeof blob[uid] === 'object' && !isArray(blob[uid]))
      ? blob[uid] : {};
    var next = newestIso ? String(newestIso) : new Date().toISOString();
    /* never move the mark backwards - a poll that returns an older page of
       history must not un-see newer messages */
    if (!map[cid] || parseIso(next) >= parseIso(map[cid])) map[cid] = next;
    blob[uid] = map;
    try { lsSet(SEEN_KEY, JSON.stringify(blob)); } catch (e) { /* ignore */ }
  }

  function seenAt(conversationId) {
    var map = seenMap();
    return map[String(conversationId || '')] || '';
  }

  function applyOverlay(entries) {
    var map = seenMap();
    var now = Date.now();
    var out = [];
    var total = 0;
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i] || {};
      var cid = String(e.conversation_id || '');
      var n = parseInt(e.unread, 10) || 0;
      var seen = map[cid];
      if (n > 0 && seen) {
        if (e.last_at) {
          if (parseIso(e.last_at) <= parseIso(seen)) n = 0;
        } else if ((now - parseIso(seen)) <= SEEN_GRACE_MS) {
          n = 0;
        }
      }
      total += n;
      out.push({ conversation_id: cid, unread: n });
    }
    return { entries: out, total: total };
  }

  /* ------------------------------------------------------------ publishing */

  function fire(total, by) {
    var ev;
    try {
      ev = new window.CustomEvent('clinic:unread', {
        detail: { total: total, by_conversation: by }
      });
    } catch (e) {
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('clinic:unread', false, false,
        { total: total, by_conversation: by });
    }
    window.dispatchEvent(ev);
  }

  function paintBadge(total) {
    var u = ui();
    /* The nav badge is NOT aria-live (§10.9): setNavBadge silently rewrites the
       anchor's aria-label instead, so a screen reader hears the new count when
       the user reaches the nav rather than being interrupted mid-sentence. */
    if (typeof u.setNavBadge === 'function') {
      try { u.setNavBadge('messages', total); } catch (e) { /* ignore */ }
    }
  }

  function publish(total, by, quiet) {
    var changed = (total !== state.total);
    state.total = total;
    state.by_conversation = by;
    state.at = Date.now();
    paintBadge(total);
    if (changed && !quiet) fire(total, by);
  }

  /* set() is how messages.js zeroes the badge the INSTANT a conversation opens,
     without waiting ~30 s for the read write to become visible. It costs
     nothing and it is the fourth of the four refresh events. */
  function set(total, byConversation) {
    var by = isArray(byConversation) ? byConversation : [];
    if (by.length) {
      var adj = applyOverlay(by);
      publish(adj.total, adj.entries);
    } else {
      publish(Math.max(0, parseInt(total, 10) || 0), []);
    }
  }

  function get() {
    return { total: state.total, by_conversation: state.by_conversation, at: state.at };
  }

  /* ------------------------------------------------------------- the probe */

  /* Chat can be switched off course-wide from Admin. When bootstrap says so
     EXPLICITLY we do not probe at all. Note the shape of the test: an ABSENT
     key must not disable the feature (contract §5 - every new field may be
     missing against a backend that has not been re-imported), so only a present
     and falsy value counts. ui.truthy(undefined) is false, which is why this
     cannot be a bare truthy() call. */
  function chatExplicitlyOff() {
    var cfg;
    try { cfg = ui().bootstrapConfig ? ui().bootstrapConfig() : {}; } catch (e) { cfg = {}; }
    var v = cfg ? cfg.chat_enabled : undefined;
    if (v === undefined || v === null || v === '') return false;
    return !ui().truthy(v);
  }

  function goInert() {
    dead = true;
    if (typeof ui().featureOff === 'function') {
      try { ui().featureOff('messages'); } catch (e) { /* ignore */ }
    }
    /* The TABS entry already ships hidden:true, so there is nothing to hide -
       we simply never reveal it. A nav item that promises a feature the backend
       has never heard of is worse than no nav item. */
  }

  function canCall(minGapMs) {
    if (dead || stopped) return false;
    if (typeof api().call !== 'function') return false;
    /* Signed out: api.call would bounce to login.html, and a badge probe is not
       a reason to interrupt someone reading login.html. */
    if (typeof api().getToken === 'function' && !api().getToken()) return false;
    if (typeof api().hasMsgUrl === 'function' && !api().hasMsgUrl()) return false;
    if (ui().featureState && ui().featureState('messages') === 'off') return false;
    if (chatExplicitlyOff()) return false;
    if (minGapMs && (Date.now() - lastCallAt) < minGapMs) return false;
    return true;
  }

  /* One call. NEVER retried on unknown-action; retried only implicitly, by the
     next page load or the next visibilitychange, on network/not_found - which
     §10.10 classes as inert-but-retryable. There is no console.error on any
     path in here: a not-yet-imported backend must produce a quiet, complete
     looking page. */
  function probe(minGapMs) {
    if (!canCall(minGapMs)) return Promise.resolve(get());
    if (inflight) return inflight;
    lastCallAt = Date.now();
    probed = true;

    inflight = api().call('messages.unread', {}).then(function (data) {
      inflight = null;
      if (typeof ui().featureOn === 'function') {
        try { ui().featureOn('messages'); } catch (e) { /* ignore */ }
      }
      if (typeof ui().setTabVisible === 'function') {
        try { ui().setTabVisible('messages', true); } catch (e) { /* ignore */ }
      }
      var by = (data && isArray(data.by_conversation)) ? data.by_conversation : [];
      var adj = applyOverlay(by);
      var total = by.length
        ? adj.total
        : Math.max(0, parseInt(data && data.unread_total, 10) || 0);
      publish(total, adj.entries);
      return get();
    }, function (err) {
      inflight = null;
      var unknown = false;
      try {
        unknown = (typeof api().isUnknownAction === 'function' && api().isUnknownAction(err)) ||
                  (typeof ui().isUnknownAction === 'function' && ui().isUnknownAction(err));
      } catch (e) { unknown = false; }
      if (unknown) { goInert(); return get(); }
      if (err && err.code === 'unauthorized') { dead = true; return get(); }
      if (err && err.code === 'forbidden') { goInert(); return get(); }
      /* network / not_found / anything else: inert but retryable. Stay quiet,
         leave the tab hidden, try again on the next page load. */
      return get();
    });
    return inflight;
  }

  /* -------------------------------------------------------------- lifecycle */

  function onVisibility() {
    if (document.hidden) return;
    probe(VISIBILITY_MIN_GAP_MS);
  }

  function onBootstrap() {
    /* renderHeader() blows the whole nav away and rebuilds it, and bootstrap
       can land after that has already happened, so the badge has to be
       repainted rather than assumed. Costs nothing: no network. */
    paintBadge(state.total);
    if (state.total > 0 || probed) {
      if (typeof ui().setTabVisible === 'function' && !dead && canCall(0)) {
        try { ui().setTabVisible('messages', true); } catch (e) { /* ignore */ }
      }
    }
  }

  function wire() {
    if (wired) return;
    wired = true;
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('clinic:bootstrap', onBootstrap);
  }

  function unwire() {
    if (!wired) return;
    wired = false;
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('clinic:bootstrap', onBootstrap);
  }

  function start() {
    if (stopped) return Promise.resolve(get());
    /* THE GATE. No MSG_URL (or a PASTE_ placeholder) means no request is ever
       issued - not one, not "just the probe". See the header block. */
    if (typeof api().hasMsgUrl === 'function' && !api().hasMsgUrl()) {
      goInert();
      return Promise.resolve(get());
    }
    if (chatExplicitlyOff()) { goInert(); return Promise.resolve(get()); }
    wire();
    return probe(0);
  }

  /* messages.js calls this at module-execution time, BEFORE DOMContentLoaded,
     so the auto-start below never runs on messages.html: that page's own two
     pollers already cover the counts and a second overlapping unread read would
     be pure waste. */
  function stop() {
    stopped = true;
    unwire();
    return get();
  }

  function refresh() {
    /* User-initiated (the Refresh button on index.html). Not subject to the
       120 s visibility limit, but not unlimited either. */
    return probe(MANUAL_MIN_GAP_MS);
  }

  Clinic.unread = {
    start: start,
    stop: stop,
    refresh: refresh,
    get: get,
    set: set,
    markSeen: markSeen,
    seenAt: seenAt,
    /* introspection, for the console and for tests */
    isInert: function () { return dead; },
    SEEN_KEY: SEEN_KEY
  };

  /* Auto-start on DOMContentLoaded. Every content page loads this file (§8.4),
     so no page has to remember to call start(). Defer scripts all execute
     before DOMContentLoaded fires, which is precisely why messages.js can
     cancel this by calling stop() at the top of its IIFE. */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { start(); });
  } else {
    start();
  }

})(window, document);
