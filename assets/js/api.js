/*!
 * NUS Coding Clinic — api.js
 * The ONLY file in the site that is allowed to call fetch(). See SPEC.md §5.
 *
 * Public surface (everything hangs off window.Clinic.api):
 *
 *   call(action, data)        -> Promise<data>   every API action goes through here
 *   callSafe(action, data, fallback)
 *                             -> Promise<data|fallback>  degrades instead of throwing
 *                                when the backend does not know the action yet (v3)
 *   callResult(action, data)  -> Promise<{ok, data, err}>  never rejects at all (v3)
 *   isUnknownAction(err)      -> bool            "this backend is older than this UI"
 *   bootstrap()               -> Promise<boot>   cached-first config + user
 *   threadsList()             -> Promise<list>  cached-first threads.list (v3.1);
 *                                               fires 'clinic:threads' when the
 *                                               background refresh lands
 *   refreshThreads()          -> Promise<list>  force the network, then cache
 *   cachedThreads()           -> list|null      whatever is in localStorage,
 *                                               no network
 *   requireLogin()            -> bool            redirects to login.html if signed out
 *   logout()                                     clears session, goes to login.html
 *   getToken()                -> string          "" when signed out
 *   getUser()                 -> user|null       {user_id, display_name, role, email}
 *   setUser(user)                                update the cached user object
 *   cachedBootstrap()         -> boot|null       whatever is in localStorage, no network
 *   isInstructor()            -> bool
 *   isMock()                  -> bool
 *   isConfigured()            -> bool            false while config.js still says PASTE_
 *                                                (MSG_URL is NOT part of this test)
 *   hasMsgUrl()               -> bool            true when chat/attachments have a
 *                                                flow to talk to (or MOCK is on)
 *   nextUrl(fallback)         -> string          safe ?next= target for login.html
 *   loginUrl()                -> string          "login.html?next=<here>"
 *   ApiError                                     {code, message} constructor
 *
 * Errors: every rejection is an ApiError with a `.code` and a `.message`.
 *   code ∈ unauthorized | forbidden | not_found | conflict | bad_request |
 *          cutoff_passed | network
 * `network` means TRANSPORT, and it is decided by the HTTP status line before
 * the body is looked at: a dropped connection, a non-2xx (502/504 gateway
 * fault, 429 throttle, flow switched off), or a 2xx whose body is not one of
 * our envelopes. It never means "the server said no" — every real answer,
 * including every application error, comes back 200 with `code` in the body.
 * Callers may treat `network` as retryable and as "the write may still have
 * landed"; they may not treat any other code that way.
 * Pages should show `err.message` in a toast and, where useful, branch on `err.code`.
 * `unauthorized` is handled here (session cleared + bounce to login) and still
 * rejects, so page code can simply stop.
 *
 * localStorage keys owned by this file:
 *   clinic_token           session token string
 *   clinic_user            JSON of the user object
 *   clinic_token_expires   ISO timestamp, used to expire the session client-side
 *   clinic_token_issued    epoch ms the token was stored, read only by the
 *                          ripening retry in dispatch() — see the note there
 *   clinic_bootstrap       JSON cache of meta.bootstrap
 *   clinic_threads         JSON cache of threads.list, {uid, at, data} — see the
 *                          note on threadsList() for why it is per-user and
 *                          age-capped
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var K_TOKEN = 'clinic_token';
  var K_USER = 'clinic_user';
  var K_EXPIRES = 'clinic_token_expires';
  var K_ISSUED = 'clinic_token_issued';
  var K_BOOT = 'clinic_bootstrap';
  var K_THREADS = 'clinic_threads';

  /* — is an em dash; escaped so user-visible strings survive any charset. */
  var MSG_NETWORK = "Can't reach the server \u2014 check your connection and try again.";
  var MSG_UNCONFIGURED = 'This site has not been connected to its backend yet. ' +
    'The flow URLs in assets/js/config.js are still placeholders.';

  /* ---------------------------------------------------------------- storage */
  /* localStorage throws in some privacy modes; never let that break a page. */

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* full or blocked */ }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }
  function readJSON(key) {
    var raw = lsGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { lsDel(key); return null; }
  }
  function writeJSON(key, value) {
    try { lsSet(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
  }

  /* ----------------------------------------------------------------- errors */

  function ApiError(code, message) {
    this.name = 'ApiError';
    this.code = code || 'bad_request';
    this.message = message || 'Something went wrong.';
  }
  ApiError.prototype.toString = function () {
    return 'ApiError [' + this.code + '] ' + this.message;
  };

  function toApiError(e) {
    if (e instanceof ApiError) return e;
    if (e && typeof e === 'object' && e.code) {
      return new ApiError(e.code, e.message || e.error || 'Something went wrong.');
    }
    if (e && e.message) return new ApiError('network', MSG_NETWORK);
    return new ApiError('network', MSG_NETWORK);
  }

  /* ----------------------------------------------------------------- config */

  function cfg() { return window.CLINIC_CONFIG || {}; }

  function isMock() { return cfg().MOCK === true; }

  /* v3: 'messages.' and 'attach.' are served by a SEPARATE flow, [clinic]_msg_api,
     because chat is polled and image reads are expensive — putting them on APP_URL
     would let a busy chat starve sign-in through the shared Excel connection.

     The `&& c.MSG_URL` guard is load-bearing, not defensive tidiness. Before the msg
     flow exists MSG_URL is still the PASTE_ placeholder, and netCall's looksPlaceholder
     check then rejects with a clean 'network' instead of silently posting a
     'messages.unread' at the app flow — which would burn a full 10-21 s app-flow run
     (three Excel GetItems) per user per session purely to be told "Unknown action."
     Note the ordering: this branch is checked BEFORE the APP_URL fallback, and
     ui.js keeps its own independent copy of this prefix table (contract §4.2) — if you
     add a prefix here, add it there too. */
  function endpointFor(action) {
    var c = cfg();
    if (action.indexOf('auth.') === 0) return c.AUTH_URL;
    if (action.indexOf('admin.') === 0) return c.ADMIN_URL;
    if ((action.indexOf('messages.') === 0 || action.indexOf('attach.') === 0) && c.MSG_URL) {
      return c.MSG_URL;
    }
    return c.APP_URL;
  }

  function looksPlaceholder(url) {
    return !url || typeof url !== 'string' || url.indexOf('PASTE_') === 0 ||
      url.indexOf('http') !== 0;
  }

  /* MSG_URL is DELIBERATELY not part of this test. The site is fully usable without
     chat and without image attachments — those features hide themselves (contract
     §10.10) rather than blocking the board — so requiring MSG_URL here would put the
     whole site behind "This site has not been connected to its backend yet" for the
     entire window between the wave-2 and wave-3 imports. Ask hasMsgUrl() instead if
     you need to know whether chat can work. */
  function isConfigured() {
    var c = cfg();
    return !looksPlaceholder(c.AUTH_URL) && !looksPlaceholder(c.APP_URL) &&
      !looksPlaceholder(c.ADMIN_URL);
  }

  /* True when chat/attachments have somewhere to go: either the msg flow URL is
     pasted in, or we are in demo mode where mock-data.js answers everything. */
  function hasMsgUrl() {
    return isMock() || !looksPlaceholder(cfg().MSG_URL);
  }

  /* ---------------------------------------------------------------- session */

  function getToken() {
    var token = lsGet(K_TOKEN);
    if (!token) return '';
    var expires = lsGet(K_EXPIRES);
    if (expires) {
      var t = Date.parse(expires);
      if (!isNaN(t) && t <= Date.now()) { clearSession(); return ''; }
    }
    return token;
  }

  function getUser() { return readJSON(K_USER); }

  function setUser(user) {
    if (user && user.user_id) writeJSON(K_USER, user);
  }

  function setSession(token, user, expiresAt) {
    /* The issue stamp is written with the token and only with the token: it is
       the clock the ripening retry measures against, and a token whose age we
       cannot establish must fall straight through to the old behaviour. */
    if (token) { lsSet(K_TOKEN, token); lsSet(K_ISSUED, String(Date.now())); }
    if (user) writeJSON(K_USER, user);
    if (expiresAt) lsSet(K_EXPIRES, expiresAt); else lsDel(K_EXPIRES);
  }

  function clearSession() {
    lsDel(K_TOKEN);
    lsDel(K_USER);
    lsDel(K_EXPIRES);
    lsDel(K_ISSUED);
    lsDel(K_BOOT);
    /* The cached board goes with the session. It is namespaced by uid anyway, so
       leaving it would be safe — but on a shared lab machine "signed out" has to
       mean the next person sees nothing of the last one, not merely that the
       code declines to show it. */
    lsDel(K_THREADS);
  }

  function isInstructor() {
    var u = getUser();
    return !!(u && u.role === 'instructor');
  }

  /* -------------------------------------------------------------- redirects */

  /* Current page as a relative URL, e.g. "thread.html?id=t_7". Pages are all
     siblings at the site root, so a bare filename is a valid ?next= target. */
  function hereRelative() {
    var path = window.location.pathname || '';
    var file = path.substring(path.lastIndexOf('/') + 1) || 'index.html';
    return file + (window.location.search || '') + (window.location.hash || '');
  }

  function onLoginPage() {
    return /(^|\/)login\.html$/i.test(window.location.pathname || '');
  }

  function loginUrl() {
    return 'login.html?next=' + encodeURIComponent(hereRelative());
  }

  /* Read ?next= and hand back something safe to assign to location.href.
     Anything absolute, protocol-relative, or climbing out of the folder is
     rejected — an open redirect on a login page is a real phishing vector. */
  function nextUrl(fallback) {
    var fb = fallback || 'index.html';
    var match = /[?&]next=([^&]*)/.exec(window.location.search || '');
    if (!match) return fb;
    var raw;
    try { raw = decodeURIComponent(match[1]); } catch (e) { return fb; }
    if (!raw) return fb;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return fb;   // has a scheme
    if (raw.charAt(0) === '/' || raw.indexOf('\\') !== -1) return fb;
    if (raw.indexOf('..') !== -1) return fb;
    if (!/^[A-Za-z0-9._~-]+\.html([?#].*)?$/.test(raw)) return fb;
    return raw;
  }

  var redirecting = false;
  function bounceToLogin() {
    if (redirecting || onLoginPage()) return;
    redirecting = true;
    window.location.href = loginUrl();
  }

  /* ------------------------------------------------------------- transport */

  function mockCall(action, data, token) {
    if (!Clinic.mock || typeof Clinic.mock.handle !== 'function') {
      return Promise.reject(new ApiError('network',
        'Demo mode is on but assets/js/mock-data.js did not load.'));
    }
    return Clinic.mock.handle(action, data, token);
  }

  /* ------------------------------------------------- HTTP-level verdicts ---
     THE STATUS LINE IS READ BEFORE THE BODY, AND IT WINS.

     Every Response action in every flow answers 200 — all of them, on the
     success path and on every application error alike (`code` in the body is
     what carries unauthorized / conflict / cutoff_passed / …). So a non-2xx
     status can only have come from the platform, never from our own logic:
     a 502 gateway fault, a 429 throttle, a 401 on a rotated `sig`, a flow
     that has been turned off, an Excel connector timeout surfacing as 504.
     None of those are answers. All of them are worth retrying.

     Getting this wrong was a real, live defect, not a tidy-up. A Power
     Platform fault body is ITSELF valid JSON —
         {"error":{"code":"NoResponse","message":"The server did not receive…"}}
     — so the old code's JSON.parse succeeded, `resp.ok` was undefined and
     `resp.code` was undefined, and every gateway fault fell out of the else
     branch as ApiError('bad_request', 'Something went wrong.').

     The damage was downstream: booking.js's onBookingTransportFailure() — the
     routine that rechecks whether a lost-response booking actually went
     through and reassures the student — is gated on code === 'network', so it
     was unreachable dead code, and a 502 mid-booking surfaced as a flat
     "Could not book that slot." while the row may well have been written. */

  function httpOk(res) {
    if (!res) return false;
    if (typeof res.status === 'number' && res.status) {
      return res.status >= 200 && res.status < 300;
    }
    return res.ok !== false;          /* odd/opaque responses: trust .ok */
  }

  /* A plain JSON object — our envelope always is one. An array, a bare string
     or a number parsed cleanly but is not something this API ever sends, so it
     is a proxy/error page, i.e. transport noise. */
  function isPlainObject(v) {
    return !!v && typeof v === 'object' && Object.prototype.toString.call(v) !== '[object Array]';
  }

  /* A Power Platform / gateway fault nests an OBJECT under `error`. The
     application envelope's `error` is always a STRING (the human sentence), so
     an object here is never one of ours — check this even on a 2xx, so a fault
     can never be mistaken for an application error. */
  function isGatewayFault(resp) {
    return !!(resp && typeof resp === 'object' && resp.error &&
      typeof resp.error === 'object' &&
      (resp.error.code !== undefined || resp.error.message !== undefined));
  }

  /* The one thing allowed to survive a non-2xx: an unmistakable application
     envelope ({ok:false, code:'…'}). No flow answers non-2xx today, so this is
     dead weight now — but it is what keeps the session path (clear + bounce to
     login.html) alive if one ever starts to. A gateway fault cannot reach here:
     it has no `ok` key, and isGatewayFault() has already excluded it. */
  function appCodeOf(resp) {
    if (!isPlainObject(resp) || isGatewayFault(resp)) return '';
    if (resp.ok !== false) return '';
    return typeof resp.code === 'string' ? resp.code : '';
  }

  function netCall(action, envelope) {
    var url = endpointFor(action);
    if (looksPlaceholder(url)) {
      return Promise.reject(new ApiError('network', MSG_UNCONFIGURED));
    }
    var body;
    try { body = JSON.stringify(envelope); }
    catch (e) { return Promise.reject(new ApiError('bad_request', 'Could not encode the request.')); }

    return new Promise(function (resolve, reject) {
      /* text/plain keeps this a CORS-"simple" request: no preflight, which a
         Power Automate HTTP trigger cannot answer. Do NOT add other headers. */
      window.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: body
      }).then(function (res) {
        /* Capture the verdict now — res.text() is a second promise and a
           failure to read the body must not lose the status we already have. */
        var ok = httpOk(res);
        var status = (res && typeof res.status === 'number') ? res.status : 0;
        return res.text().then(function (text) {
          return { ok: ok, status: status, text: text };
        }, function () {
          return { ok: ok, status: status, text: '' };
        });
      }).then(function (r) {
        var resp = null;
        if (r.text) { try { resp = JSON.parse(r.text); } catch (e) { resp = null; } }

        /* 1. Status first, before the body is trusted for anything. */
        if (!r.ok) {
          var code = appCodeOf(resp);
          if (code === 'unauthorized' || code === 'forbidden') {
            reject(new ApiError(code,
              (typeof resp.error === 'string' && resp.error) || 'Please sign in again.'));
            return;
          }
          reject(new ApiError('network', MSG_NETWORK));
          return;
        }

        /* 2. A 2xx that is not one of our envelopes is still transport noise:
              unparseable text, an array/scalar root, or a nested fault object. */
        if (!isPlainObject(resp) || isGatewayFault(resp)) {
          reject(new ApiError('network', MSG_NETWORK));
          return;
        }

        /* 3. A genuine envelope — unchanged behaviour, including {ok:false}. */
        if (resp.ok) {
          resolve(resp.data === undefined || resp.data === null ? {} : resp.data);
        } else {
          reject(new ApiError(
            (typeof resp.code === 'string' && resp.code) || 'bad_request',
            (typeof resp.error === 'string' && resp.error) || 'Something went wrong.'
          ));
        }
      })['catch'](function () {
        reject(new ApiError('network', MSG_NETWORK));
      });
    });
  }

  /* --------------------------------------------------------------- dispatch */

  /* Actions whose responses carry a fresh session. */
  function isAuthGrant(action) {
    return action === 'auth.verify' || action === 'auth.passcode';
  }

  function afterSuccess(action, out) {
    if (isAuthGrant(action) && out && out.token) {
      setSession(out.token, out.user, out.expires_at);
    } else if (action === 'profile.update' && out && out.user) {
      setUser(out.user);
      var boot = readJSON(K_BOOT);
      if (boot) { boot.user = out.user; writeJSON(K_BOOT, boot); }
    }
    return out;
  }

  /* ------------------------------------------------ the ripening window ----
     THE LOGIN LOOP THIS EXISTS TO BREAK (2026-08-10, browser-confirmed).

     auth.verify writes the tbl_Sessions row and returns the token in the SAME
     run. login.html stores it and loads index.html, which asks meta.bootstrap
     about a second later. The app flow looks that token up in the workbook —
     and a write to this workbook takes up to ~30 s to become readable, the
     gotcha that governs the whole project. It finds no row, so auth_ok is 'no'
     and it answers `unauthorized`. We then did the one thing that makes this
     unrecoverable: cleared the session and bounced to login.html, which has no
     token and therefore shows the email step. Sign in again, same thing.

     Every attempt destroyed its own credential a few seconds before that
     credential became readable, so the loop never converged, at any typing
     speed, and showed no error — the whole failure looked like "the passcode
     screen keeps sending me back to the email screen".

     A token this young failing to resolve is not evidence that it is invalid;
     it is evidence that we asked too early. So while it is young we wait and
     ask again instead of destroying it. Once it is older than the write can
     possibly be late, `unauthorized` means what it always meant.

     WHY THE WAITS ARE STEPPED, NOT ONE LONG SLEEP
     The row is usually readable well inside 30 s, so stepping recovers in a
     few seconds in the common case rather than parking every first-time
     sign-in behind a full-length spinner. Cost is bounded and rare: sign-in
     puts two authenticated calls in flight (meta.bootstrap, threads.list), so
     the worst case is 2 x 4 = 8 extra flow runs ONCE per sign-in — nothing
     against the daily allocation the contract's R22 arithmetic is protecting,
     and unlike a poller it cannot repeat. Contract §8.3 rule 5 keeps recurring
     work in Clinic.poll; these are one-shot timers on a single call chain, so
     they belong here.

     DELIBERATELY NOT COVERED: a token minted before this code shipped carries
     no stamp, so tokenAgeMs() reports Infinity and the old behaviour stands.
     That is the safe direction to fail. */
  var RIPEN_MS = 60000;                             /* ~30 s lag plus headroom */
  var RIPEN_WAITS = [2000, 4000, 9000, 20000];      /* ≈35 s of retries, then stop */

  function tokenAgeMs() {
    var raw = lsGet(K_ISSUED);
    if (!raw) return Infinity;
    var t = parseInt(raw, 10);
    if (isNaN(t)) return Infinity;
    var age = Date.now() - t;
    return age < 0 ? Infinity : age;   /* clock moved backwards; do not trust it */
  }

  /* Young enough that "not found" is more likely to mean "not yet" than "no".
     Never in demo mode: mock-data.js answers from memory, so there is no write
     to be late, and an `unauthorized` there is a real one (a token left behind
     by a mock reset). Retrying it would park the demo behind a 35 s stall
     instead of bouncing cleanly to the login page. */
  function withinRipeningWindow(attempt) {
    return !isMock() && attempt < RIPEN_WAITS.length &&
      !!getToken() && tokenAgeMs() < RIPEN_MS;
  }

  function delay(ms) {
    return new Promise(function (resolve) { window.setTimeout(resolve, ms); });
  }

  function dispatch(action, data, attempt) {
    attempt = attempt || 0;
    var token = getToken();
    var envelope = { action: action, data: data || {} };
    if (token && action.indexOf('auth.') !== 0) envelope.token = token;

    var p = isMock()
      ? mockCall(action, envelope.data, token)
      : netCall(action, envelope);

    return p.then(function (out) {
      return afterSuccess(action, out);
    }, function (raw) {
      var err = toApiError(raw);
      if (err.code === 'unauthorized') {
        if (withinRipeningWindow(attempt)) {
          return delay(RIPEN_WAITS[attempt]).then(function () {
            return dispatch(action, data, attempt + 1);
          });
        }
        clearSession();
        bounceToLogin();
      }
      throw err;
    });
  }

  /* ------------------------------------------------- single-flight dedupe */
  /* index.html and the shared header can both want threads.list / the
     bootstrap on the same paint. Collapse identical in-flight reads into one
     request instead of hammering the flow (and the Excel connector). */

  /* v3 additions: the unread badge and the inbox are both wanted by the header AND
     by messages.js on the same paint, and a poll tick can land on top of a manual
     Refresh. Both are pure reads with an empty payload, so collapsing them is free.
     'messages.get' is deliberately NOT here — its `since` differs on every tick, so
     the signature would never match anyway, and a stale collapse there would hide a
     poll that actually needed to run (contract §10.8). */
  var DEDUPE = {
    'meta.bootstrap': 1, 'threads.list': 1,
    'messages.unread': 1, 'messages.list': 1
  };
  var inFlight = {};

  function call(action, data) {
    if (typeof action !== 'string' || !action) {
      return Promise.reject(new ApiError('bad_request', 'Missing action name.'));
    }
    var key = null;
    if (DEDUPE[action]) {
      var sig;
      try { sig = JSON.stringify(data || {}); } catch (e) { sig = ''; }
      key = action + '|' + sig;
      if (inFlight[key]) return inFlight[key];
    }
    var p = dispatch(action, data);
    if (key) {
      var done = function () { delete inFlight[key]; };
      p = p.then(function (v) { done(); return v; }, function (e) { done(); throw e; });
      inFlight[key] = p;
    }
    return p;
  }

  /* --------------------------------------------------- degradation primitive */
  /* v3. The backend is imported in waves (contract §12) and the site is pushed to
     GitHub Pages before any of them land, so for days at a time the flows behind
     APP_URL/ADMIN_URL are OLDER than this JavaScript. A page that calls a brand new
     action and lets the rejection escape shows a red toast, an empty region, or a
     spinner that never stops — for a feature the instructor has not switched on yet.
     That is the single most likely way v3 looks broken in front of a cohort.

     So: every new-in-v3 action is called through callSafe(), which turns exactly one
     class of failure — "this backend has never heard of that" — into the caller's
     chosen fallback value, and lets every other failure through untouched.

     WHAT COUNTS AS "THE BACKEND IS BEHIND"
       * the app flow's Switch default:      {code:'bad_request', error:'Unknown action.'}
       * admin.moderate's op Switch default: {code:'bad_request', error:'Unknown moderation action: <op>'}
       * the mock's dispatcher:              {code:'bad_request', message:'Unknown action in demo mode: <action>'}
     All three are bad_request with "unknown ... action" in the sentence, which is why
     RE_UNKNOWN is a little looser than ui.js's isUnknownAction(): the ADMIN flow's
     wording has a word in the middle, and F7's lock/endorse buttons are exactly the
     case that hits it. Both detectors must agree on the app-flow and mock wording;
     this one additionally catches the admin op wording.

     WHAT DOES *NOT* FALL BACK, AND WHY EACH ONE MATTERS
       unauthorized  the session really has gone. dispatch() has already cleared it
                     and bounced to login.html; swallowing it here would leave the
                     page rendering a fallback on top of a redirect.
       network       the flow is down, throttled, or the URL is still a placeholder.
                     A user staring at a permanently empty panel with no error is
                     worse than a toast — and R22 says throttling is unhandled, so
                     this is the one signal that a throttle is happening at all.
       forbidden     a REAL answer from a working backend (chat disabled, archive
                     mode, locked thread). The caller must show the reason.
       conflict / cutoff_passed / not_found / any other bad_request
                     genuine, actionable answers. A validation message that silently
                     became "nothing happened" is how data loss gets reported as
                     "the button does nothing".

     Contract §10.10's "treat a first `network` or `not_found` as inert-but-retryable"
     is a rule about what the CALLER renders next, not about swallowing the rejection:
     the caller still has to know which of the two it got, so both still reject. */

  var RE_UNKNOWN = /unknown\s+(?:[a-z]+\s+)?(?:action|op|operation)\b/i;

  function isUnknownAction(err) {
    return !!(err && err.code === 'bad_request' &&
      RE_UNKNOWN.test(err.message || err.error || ''));
  }

  /* Resolves with the server's data, or with `fallback` when the backend does not
     know this action yet. Rejects for every other error, exactly like call().
     `fallback` defaults to null so `callSafe(a, d)` is still meaningful. */
  function callSafe(action, data, fallback) {
    var fb = (arguments.length >= 3) ? fallback : null;
    return call(action, data)['catch'](function (err) {
      if (isUnknownAction(err)) return fb;
      throw err;
    });
  }

  /* The zero-branches variant: never rejects, for a caller that wants to inspect the
     failure without a catch block (a one-shot feature probe, typically).
       {ok:true,  data:<server data>, err:null}
       {ok:false, data:<fallback>,    err:<ApiError>}
     `err.code` and isUnknownAction(err) tell the caller whether to go permanently
     inert (unknown action) or to try again later (network / not_found). */
  function callResult(action, data, fallback) {
    var fb = (arguments.length >= 3) ? fallback : null;
    return call(action, data).then(
      function (d) { return { ok: true, data: d, err: null }; },
      function (e) { return { ok: false, data: fb, err: e }; }
    );
  }

  /* -------------------------------------------------------------- bootstrap */

  function fireBootstrapEvent(boot) {
    var ev;
    try {
      ev = new window.CustomEvent('clinic:bootstrap', { detail: boot });
    } catch (e) {                                  // very old engines
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('clinic:bootstrap', false, false, boot);
    }
    window.dispatchEvent(ev);
  }

  function storeBootstrap(boot) {
    if (!boot || !boot.config) return boot;
    writeJSON(K_BOOT, boot);
    if (boot.user) setUser(boot.user);
    fireBootstrapEvent(boot);
    return boot;
  }

  function cachedBootstrap() {
    var boot = readJSON(K_BOOT);
    return (boot && boot.config) ? boot : null;
  }

  function refreshBootstrap() {
    return call('meta.bootstrap', {}).then(storeBootstrap);
  }

  /* Pages call this. Returns instantly from cache when we have one, and quietly
     refreshes in the background — listen for the 'clinic:bootstrap' window event
     if you want to re-render when newer config lands (e.g. the instructor
     changed the notice text or the category list). */
  function bootstrap() {
    var cached = cachedBootstrap();
    if (cached) {
      if (getToken()) {
        refreshBootstrap()['catch'](function () { /* silent; unauthorized already bounced */ });
      }
      return Promise.resolve(cached);
    }
    return refreshBootstrap();
  }

  /* ------------------------------------------------- threads.list cache (v3.1)

     threads.list is the most expensive action in the system by a wide margin:
     three UNFILTERED Excel GetItems (tbl_Threads, tbl_Posts, tbl_Votes) and then
     a ~44-action serial Query/Select/Compose chain to derive the leaderboard and
     the card badges. At 10-21 s per Excel call that is a 10-20 second spinner on
     index.html, on EVERY visit, growing all semester because nothing about it is
     filtered or paginated.

     None of that is fixable from the client. Painting the board we already have
     while the new one is fetched is — and it is the same stale-while-revalidate
     deal bootstrap() has had since v1, with the same 'refresh in the background
     and fire an event' shape, so this adds no new concept to the codebase.

     THREE THINGS MAKE IT SAFE RATHER THAN MERELY FAST:

     1. NAMESPACED BY USER. localStorage is per ORIGIN, not per account, and
        threads.list is ROLE-DEPENDENT — gotcha 16 has the instructor's list as
        the unfiltered sibling of the student's, expressed as two GetItems in a
        Condition. On a shared lab machine, or after the demo persona switcher
        swaps user in place, an instructor's cached board must never be painted
        for the next student. A blob whose uid is not the current user is
        DISCARDED, not migrated: it cannot be attributed to anyone else, and the
        cost of throwing it away is one ordinary spinner.
     2. AGE-CAPPED. Past MAX_AGE_MS the blob is dropped rather than shown,
        because at that point a spinner is more honest than yesterday's board.
        This is what stops an exhausted daily quota (R2) or a switched-off flow
        from presenting stale data as current for a week — the failure mode there
        is silence, so the cache must not help it stay silent.
     3. CLEARED ON SIGN-OUT by clearSession(), alongside the token, the user and
        the bootstrap blob.

     Concurrent refreshes need no guard here: 'threads.list' is already in
     DEDUPE, so two callers share one in-flight request. */

  var THREADS_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  function fireThreadsEvent(list) {
    var ev;
    try {
      ev = new window.CustomEvent('clinic:threads', { detail: list });
    } catch (e) {                                  // very old engines
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('clinic:threads', false, false, list);
    }
    window.dispatchEvent(ev);
  }

  function currentUid() {
    var u = getUser();
    return (u && u.user_id) ? String(u.user_id) : '';
  }

  /* Only a payload we recognise is ever written. A `threads` array is the one
     key index.js cannot work without, and caching an error envelope or a
     half-shaped response would be worse than caching nothing. */
  function storeThreads(list) {
    if (!list || Object.prototype.toString.call(list.threads) !== '[object Array]') {
      return list;
    }
    writeJSON(K_THREADS, { uid: currentUid(), at: Date.now(), data: list });
    fireThreadsEvent(list);
    return list;
  }

  function cachedThreads() {
    var blob = readJSON(K_THREADS);
    if (!blob || typeof blob !== 'object' || !blob.data) return null;
    if (String(blob.uid || '') !== currentUid()) { lsDel(K_THREADS); return null; }
    var at = Number(blob.at) || 0;
    if (!at || (Date.now() - at) > THREADS_MAX_AGE_MS) { lsDel(K_THREADS); return null; }
    var data = blob.data;
    return (Object.prototype.toString.call(data.threads) === '[object Array]') ? data : null;
  }

  function refreshThreads() {
    return call('threads.list', {}).then(storeThreads);
  }

  /* Pages call this instead of call('threads.list', {}).
     Cache hit  -> resolves IMMEDIATELY with the cached board and refreshes behind
                   you; 'clinic:threads' fires when the fresh payload lands.
     Cache miss -> behaves exactly like the old direct call, event included. */
  function threadsList() {
    var cached = cachedThreads();
    if (cached) {
      if (getToken()) {
        refreshThreads()['catch'](function () { /* silent; stale beats blank */ });
      }
      return Promise.resolve(cached);
    }
    return refreshThreads();
  }

  /* ------------------------------------------------------------ entry gates */

  function requireLogin() {
    if (!getToken()) { bounceToLogin(); return false; }
    return true;
  }

  function logout() {
    if (isMock() && Clinic.mock && typeof Clinic.mock.signOut === 'function') {
      try { Clinic.mock.signOut(); } catch (e) { /* ignore */ }
    }
    clearSession();
    window.location.href = 'login.html';
  }

  /* ------------------------------------------------------------------ export */

  Clinic.api = {
    ApiError: ApiError,
    call: call,
    callSafe: callSafe,
    callResult: callResult,
    isUnknownAction: isUnknownAction,
    hasMsgUrl: hasMsgUrl,
    bootstrap: bootstrap,
    refreshBootstrap: refreshBootstrap,
    cachedBootstrap: cachedBootstrap,
    threadsList: threadsList,
    refreshThreads: refreshThreads,
    cachedThreads: cachedThreads,
    requireLogin: requireLogin,
    logout: logout,
    getToken: getToken,
    getUser: getUser,
    setUser: setUser,
    setSession: setSession,
    clearSession: clearSession,
    isInstructor: isInstructor,
    isMock: isMock,
    isConfigured: isConfigured,
    nextUrl: nextUrl,
    loginUrl: loginUrl
  };

})(window, document);
