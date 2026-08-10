/*!
 * MScPHMxAI Coding Clinic — poll.js   (owner: F4)
 * The ONE polling primitive for the whole site. Contract §10.2.
 *
 *   Clinic.poll.create(opts) -> poller
 *   opts = { name:'messages', fn: function () { return Promise; },
 *            intervalMs:90000, hiddenIntervalMs:0, onData:fn, onError:fn,
 *            maxBackoffMs:300000, immediate:true, jitterPct:0.2 }
 *
 *   poller.start() / .stop() / .now() / .setInterval(ms) / .isRunning()
 *   poller.state() -> {running, lastOkAt, lastErrorAt, consecutiveErrors,
 *                      intervalMs, hidden, busy, idle, stoppedReason}
 *   poller.destroy()          stop + drop out of the module registry
 *
 *   Clinic.poll.stopAll([reason])       every live poller, immediately
 *   Clinic.poll.count()                 how many pollers exist (leak check)
 *   Clinic.poll.secondsFromConfig(key, fallbackSeconds) -> ms   (see below)
 *
 * NOBODY ELSE MAY CALL setInterval (contract §8.3 rule 5). Every recurring
 * request in this site goes through here, because the cost model is brutal and
 * has to be enforced in exactly one place:
 *
 *   - one Excel-backed call takes 10-21 SECONDS;
 *   - the tenant has a hard daily request quota (R2) that sign-in shares, so a
 *     runaway poller does not degrade chat, it takes AUTHENTICATION down;
 *   - a lecture hall of 60 browsers that all opened the page at 14:00 would,
 *     without jitter, hit the connector in one synchronised spike every tick.
 *
 * THE SEVEN HARD GUARANTEES (§10.2), and why each one is load-bearing:
 *
 *  1. AT MOST ONE IN-FLIGHT fn. A tick that fires while the previous call is
 *     still running is SKIPPED, never queued. With a 90 s interval and a 21 s
 *     call this looks impossible - until the connector throttles and calls
 *     start taking 200 s, at which point a queueing poller turns one slow user
 *     into an ever-growing backlog and throttles everyone else too.
 *  2. visibilitychange is wired INSIDE this module. Coming back to the tab
 *     ticks immediately rather than waiting out the remaining interval, so the
 *     first thing you see on returning is fresh.
 *  3. Exponential backoff x2 on rejection, capped at maxBackoffMs, reset to
 *     intervalMs on the first success. A dead flow must get quieter, not louder.
 *  4. A rejection with .code === 'unauthorized' stops the poller PERMANENTLY.
 *     api.js has already cleared the session and bounced to login.html; a
 *     poller that kept firing during the redirect would spend the rest of the
 *     page's life re-triggering that bounce.
 *  5. Auto-stop on pagehide, plus a module registry, so a poller cannot outlive
 *     the page that made it. (pageshow/persisted restores them for bfcache.)
 *  6. +/- jitterPct on EVERY scheduled delay - see the lecture hall above.
 *  7. Stop after 10 minutes with no user interaction. pointerdown/keydown (and
 *     returning to the tab) reset the timer AND wake a poller that idled out,
 *     because a laptop left open on the messages page overnight must cost zero
 *     and must still work when its owner comes back to it.
 *
 * DELIBERATELY NOT HERE: any network code. fn() is supplied by the caller and
 * is the only thing that touches Clinic.api. This file has no idea what an
 * action is.
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  /* R1 overruled the original 15 s design; 90 s is the documented default and
     messages_poll_seconds is what actually decides it at runtime. */
  var DEFAULT_INTERVAL_MS = 90000;
  var MIN_INTERVAL_MS = 5000;          /* a floor, so a bad config cannot DoS the tenant */
  var DEFAULT_MAX_BACKOFF_MS = 300000;
  var DEFAULT_JITTER_PCT = 0.2;
  var IDLE_MS = 10 * 60 * 1000;

  var POLLERS = [];
  var lastActivityAt = Date.now();
  var listenersBound = false;

  /* --------------------------------------------------------------- helpers */

  function num(v, fallback) {
    var n = Number(v);
    return (typeof n === 'number' && isFinite(n)) ? n : fallback;
  }

  function clampInterval(v, fallback) {
    var n = num(v, fallback);
    if (n < MIN_INTERVAL_MS) n = MIN_INTERVAL_MS;
    return n;
  }

  function isHidden() {
    /* Page Visibility API. Absent on very old engines - treat as visible, which
       is the safe direction: we poll a little more, we never go silent. */
    return document.hidden === true;
  }

  function safeCall(fn, a, b) {
    if (typeof fn !== 'function') return;
    /* A throwing onData/onError must never break the scheduling loop, or one
       bad render kills polling for the rest of the page's life. */
    try { fn(a, b); } catch (e) { /* deliberately swallowed */ }
  }

  function touchActivity() { lastActivityAt = Date.now(); }

  /* --------------------------------------------------------- shared listeners
     Bound ONCE for the whole page rather than once per poller: three pollers
     each adding their own pointerdown listener is three handlers on every tap
     of a phone screen, and three chances to leak one. */

  function bindListeners() {
    if (listenersBound) return;
    listenersBound = true;

    document.addEventListener('visibilitychange', function () {
      if (isHidden()) {
        eachPoller(function (p) { p._onHidden(); });
        return;
      }
      /* Coming back to the tab IS the user interacting with the page, so it
         resets the idle clock as well as waking anything that idled out. */
      touchActivity();
      eachPoller(function (p) { p._onVisible(); });
    });

    /* passive+capture: never block a tap, and still see the event when a page
       handler calls stopPropagation() on it. */
    var wake = function () {
      touchActivity();
      eachPoller(function (p) { p._onActivity(); });
    };
    document.addEventListener('pointerdown', wake, true);
    document.addEventListener('keydown', wake, true);

    /* pagehide covers navigation AND the back/forward cache, which 'unload'
       does not. This is the guarantee that a poller cannot leak past its page. */
    window.addEventListener('pagehide', function () {
      eachPoller(function (p) { p._onPageHide(); });
    });
    window.addEventListener('pageshow', function (ev) {
      if (!ev || !ev.persisted) return;      /* a normal load re-runs the scripts */
      touchActivity();
      eachPoller(function (p) { p._onPageShow(); });
    });
  }

  function eachPoller(fn) {
    /* copy first: a handler may destroy() the poller it is called on */
    var list = POLLERS.slice(0);
    for (var i = 0; i < list.length; i++) {
      try { fn(list[i]); } catch (e) { /* one bad poller must not stop the rest */ }
    }
  }

  /* ------------------------------------------------------------------ poller */

  function create(opts) {
    opts = opts || {};
    bindListeners();

    var name = String(opts.name || 'poll');
    var fn = typeof opts.fn === 'function' ? opts.fn : null;
    var onData = opts.onData;
    var onError = opts.onError;
    var intervalMs = clampInterval(opts.intervalMs, DEFAULT_INTERVAL_MS);
    var hiddenIntervalMs = Math.max(0, num(opts.hiddenIntervalMs, 0));
    var maxBackoffMs = Math.max(intervalMs, num(opts.maxBackoffMs, DEFAULT_MAX_BACKOFF_MS));
    var jitterPct = Math.max(0, Math.min(0.9, num(opts.jitterPct, DEFAULT_JITTER_PCT)));
    var immediate = opts.immediate !== false;

    var running = false;
    var busy = false;
    var timer = null;
    var inflight = null;
    var currentDelay = intervalMs;
    var consecutiveErrors = 0;
    var lastOkAt = 0;
    var lastErrorAt = 0;
    var stoppedReason = null;      /* null | 'manual' | 'idle' | 'unauthorized' | 'pagehide' */
    var wasRunningAtHide = false;

    var poller = {};

    function clearTimer() {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
    }

    function jitter(base) {
      if (!jitterPct) return base;
      var spread = base * jitterPct;
      return Math.max(1000, Math.round(base - spread + Math.random() * spread * 2));
    }

    function schedule() {
      clearTimer();
      if (!running) return;
      /* hiddenIntervalMs === 0 means STOP ENTIRELY while hidden (§10.2). We stay
         "running" so state() is honest and _onVisible can tick, but no timer
         exists, so a backgrounded tab costs literally nothing. */
      if (isHidden() && hiddenIntervalMs === 0) return;
      /* max(), not a plain swap: found in the browser that a hidden tab polling
         at hiddenIntervalMs threw away the error backoff entirely — a dead flow
         kept being hit every 5 s forever with currentDelay sitting at its 40 s
         cap. Whichever of the two is SLOWER is the one that must win. */
      var base = isHidden() ? Math.max(hiddenIntervalMs, currentDelay) : currentDelay;
      timer = window.setTimeout(tick, jitter(base));
    }

    function idleExpired() {
      return (Date.now() - lastActivityAt) > IDLE_MS;
    }

    function tick() {
      timer = null;
      if (!running) return;
      if (idleExpired()) { halt('idle'); return; }
      /* SKIPPED, never queued. See guarantee 1. */
      if (busy) { schedule(); return; }
      run();
    }

    function run() {
      if (!fn) { halt('manual'); return Promise.resolve(null); }
      busy = true;
      var p;
      try { p = fn(); } catch (e) { p = Promise.reject(e); }
      if (!p || typeof p.then !== 'function') p = Promise.resolve(p);

      /* NOTE the two-argument then(): Promise.finally does not exist in the
         engine floor this project targets, and .catch is written in bracket
         form everywhere in this codebase for the same reason. */
      inflight = p.then(function (data) {
        busy = false;
        inflight = null;
        lastOkAt = Date.now();
        consecutiveErrors = 0;
        currentDelay = intervalMs;              /* backoff resets on first success */
        safeCall(onData, data, poller);
        schedule();
        return data;
      }, function (err) {
        busy = false;
        inflight = null;
        lastErrorAt = Date.now();
        consecutiveErrors += 1;

        if (err && err.code === 'unauthorized') {
          /* api.js has already cleared the session and started the bounce to
             login.html. Anything we do from here races that redirect. */
          halt('unauthorized');
          safeCall(onError, err, poller);
          return null;
        }
        currentDelay = Math.min(maxBackoffMs, currentDelay * 2);
        safeCall(onError, err, poller);
        schedule();
        return null;
      });
      return inflight;
    }

    function halt(reason) {
      running = false;
      stoppedReason = reason || 'manual';
      clearTimer();
    }

    /* ---- events from the shared listeners ---- */

    poller._onHidden = function () {
      if (!running) return;
      if (hiddenIntervalMs === 0) clearTimer();   /* suspend */
      else schedule();                            /* re-time at the hidden cadence */
    };

    poller._onVisible = function () {
      if (stoppedReason === 'idle') { poller.start(); return; }
      if (!running) return;
      clearTimer();
      if (busy) { schedule(); return; }
      run();                                      /* guarantee 2: immediate, not deferred */
    };

    poller._onActivity = function () {
      if (stoppedReason !== 'idle') return;
      poller.start();                             /* guarantee 7, the waking half */
    };

    poller._onPageHide = function () {
      wasRunningAtHide = running;
      if (running) halt('pagehide');
      else clearTimer();
    };

    poller._onPageShow = function () {
      if (wasRunningAtHide && stoppedReason === 'pagehide') poller.start();
    };

    /* ---------------------------------------------------------- public API */

    poller.name = name;

    poller.start = function () {
      if (running) return poller;
      if (stoppedReason === 'unauthorized') return poller;   /* permanent, guarantee 4 */
      running = true;
      stoppedReason = null;
      consecutiveErrors = 0;
      currentDelay = intervalMs;
      touchActivity();
      if (immediate && !(isHidden() && hiddenIntervalMs === 0)) run();
      else schedule();
      return poller;
    };

    poller.stop = function (reason) {
      halt(reason || 'manual');
      wasRunningAtHide = false;
      return poller;
    };

    /* The manual "check now" trigger. Returns the promise for the tick so a
       Retry button can show a spinner. Never starts a second call: if one is
       already in flight the CALLER GETS THAT ONE, which is the same
       at-most-one-in-flight rule as the scheduler. */
    poller.now = function () {
      touchActivity();
      if (stoppedReason === 'unauthorized') return Promise.resolve(null);
      if (stoppedReason === 'idle') { poller.start(); return inflight || Promise.resolve(null); }
      if (busy) return inflight || Promise.resolve(null);
      clearTimer();
      return run();
    };

    poller.setInterval = function (ms) {
      intervalMs = clampInterval(ms, intervalMs);
      if (maxBackoffMs < intervalMs) maxBackoffMs = intervalMs;
      /* Do not throw away an in-progress backoff: a config change should not
         reset a poller that is currently backing off a dead flow. */
      if (consecutiveErrors === 0) currentDelay = intervalMs;
      if (running && !busy) schedule();
      return poller;
    };

    poller.isRunning = function () { return running; };

    poller.state = function () {
      return {
        running: running,
        lastOkAt: lastOkAt,
        lastErrorAt: lastErrorAt,
        consecutiveErrors: consecutiveErrors,
        intervalMs: intervalMs,
        hidden: isHidden(),
        /* extras, for debugging a stuck page from the console */
        busy: busy,
        nextDelayMs: currentDelay,
        idle: (Date.now() - lastActivityAt) > IDLE_MS,
        stoppedReason: stoppedReason
      };
    };

    poller.destroy = function () {
      poller.stop('manual');
      for (var i = 0; i < POLLERS.length; i++) {
        if (POLLERS[i] === poller) { POLLERS.splice(i, 1); break; }
      }
      return null;
    };

    POLLERS.push(poller);
    return poller;
  }

  /* ------------------------------------------------------------------ module */

  function stopAll(reason) {
    eachPoller(function (p) { p.stop(reason || 'manual'); });
  }

  /* Config values arrive from Excel as STRINGS ('90'), or as real numbers from
     the mock, or missing entirely on a backend that has not been re-imported.
     One parser here means no page has to remember that. Returns MILLISECONDS. */
  function secondsFromConfig(key, fallbackSeconds) {
    var fallback = num(fallbackSeconds, DEFAULT_INTERVAL_MS / 1000);
    var cfg = null;
    try {
      if (Clinic.ui && typeof Clinic.ui.bootstrapConfig === 'function') {
        cfg = Clinic.ui.bootstrapConfig();
      }
    } catch (e) { cfg = null; }
    var raw = cfg ? cfg[key] : null;
    var secs = parseInt(raw, 10);
    if (!(secs > 0)) secs = fallback;
    return clampInterval(secs * 1000, fallback * 1000);
  }

  Clinic.poll = {
    create: create,
    stopAll: stopAll,
    count: function () { return POLLERS.length; },
    /* A copy, never the live array. Handy from the console when a page feels
       stuck ("Clinic.poll.list()[0].state()") and it is how the leak check is
       done: navigate away and back, count() must not climb. */
    list: function () { return POLLERS.slice(0); },
    secondsFromConfig: secondsFromConfig,
    DEFAULT_INTERVAL_MS: DEFAULT_INTERVAL_MS,
    IDLE_MS: IDLE_MS
  };

})(window, document);
