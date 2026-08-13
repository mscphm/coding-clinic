/*!
 * MScPHMxAI Coding Clinic — api.js
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
 *   threadsList([opts])       -> Promise<list>  cached-first threads.list (v3.1);
 *                                               fires 'clinic:threads' when the
 *                                               background refresh lands.
 *                                               opts.force revalidates even
 *                                               inside the floor (see below)
 *   refreshThreads()          -> Promise<list>  force the network, then cache
 *   leaderboard(list)         -> Promise<{contrib, contrib_month}>
 *                                               contrib off the threads.list
 *                                               payload when it carries it, else
 *                                               meta.leaderboard, cached (v3.3)
 *   addPendingThread(thread)                    show a just-created thread on the
 *                                               board while Excel catches up
 *   pendingThreads()          -> [thread]       the ones still not landed
 *   pendingThreadById(id)     -> thread|null    ditto, one of them
 *   activeCallCount()         -> number         requests in flight right now;
 *                                               'clinic:activity' fires on change
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
 *                          age-capped. Deleted on sign-out; KEEP_BOARD_ACROSS_SIGNOUT
 *                          has the trade-off behind keeping it instead, and why
 *                          that is currently off
 *   clinic_pending_threads JSON {uid, items:[{at, thread}]} of threads this
 *                          browser created that threads.list has not caught up
 *                          on yet — see the note above addPendingThread()
 *
 * sessionStorage keys CLEARED (not written) by this file, in clearSession():
 *   clinic_leaderboard     written here, by leaderboard() — {uid, at, data}
 *   clinic_thread_v1       written by pages/thread.js, its threads.get cache
 * They are session-scoped rather than localStorage because both are short-lived
 * view caches, but "signed out" still has to mean the next person on a shared
 * lab machine sees nothing of the last one — so they go with the token.
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
  /* When K_BOOT was last written. Kept as its own key rather than folded into
     the blob so the shape meta.bootstrap returns stays exactly what the flow
     sends — every other consumer reads that blob straight through. */
  var K_BOOT_AT = 'clinic_bootstrap_at';
  var K_THREADS = 'clinic_threads';
  var K_PENDING = 'clinic_pending_threads';
  var SK_LEADERBOARD = 'clinic_leaderboard';
  /* Owned and written by pages/thread.js (its threads.get cache); named here
     only so clearSession() can drop it with everything else. Keep the two
     literals in step — thread.js has the matching comment. */
  var SK_THREAD_VIEW = 'clinic_thread_v1';
  /* Same arrangement for search-index.js's own board copy: it owns the key, we
     name it only so clearSession() can drop it. This matters more than it used
     to — since search-index.js started rebuilding from the 'clinic:threads'
     event it is written on any page that ships it, not just when someone
     actually searches, and unlike the localStorage board it carries no uid to
     guard on. sessionStorage survives a same-tab sign-out, so without this the
     next person to sign in on that tab could be handed the last person's rows. */
  var SK_SEARCH_CACHE = 'clinic_search_cache';

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

  /* sessionStorage throws in the same privacy modes localStorage does, and is
     absent entirely in a few embedded webviews. Every failure degrades to "no
     cache", i.e. to one ordinary network read. */
  function ssReadJSON(key) {
    try {
      var raw = window.sessionStorage.getItem(key);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) { return null; }
  }
  function ssWriteJSON(key, value) {
    try { window.sessionStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { /* quota or private mode */ }
  }
  function ssDel(key) {
    try { window.sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
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

  /* ------------------------------- the one knob on the sign-out trade-off ---
     OFF, deliberately, after review on 2026-08-12. Turning it on makes
     clearSession() keep the cached board (stripped of viewer-dependent fields
     by depersonaliseBoard) instead of deleting it, so the same student signing
     back in gets an instant board rather than a cold ~11 s threads.list.

     It is off because the saving does not pay for what it costs today, and all
     three costs are fixable — this is a "not yet", not a "never":

     1. booking.js:223 decides which threads are yours with `t.mine === true ||
        t.author.user_id === myId`, and the flow masks an anonymous thread's
        author to 'anon' for everybody INCLUDING its author. Strip `mine` and a
        student whose only question was anonymous is told "No thread, no slot —
        post your question first" and cannot book, for as long as the stale
        board is served. A student who cannot book is worse than an 11 s wait.
     2. The retained blob keeps `uid` next to the `users` directory, so the two
        together name the person who just signed out. Stripping the directory as
        well is easy, but it has to be done deliberately.
     3. V3_CONTRACT.md §10.11 states as load-bearing that this key is cleared by
        clearSession(), and PRIVACY.md tells students "All of it disappears when
        they sign out" — in the paragraph advising them to sign out on shared
        machines. Both documents would have to change first. Code that quietly
        disagrees with a promise made to students is how the booking bug above
        would have reached them unnoticed.

     Prerequisites for flipping it: make booking.js recompute on the
     'clinic:threads' event, strip the users directory too, and update both
     documents. Until then the cold-load pain it targets is answered instead by
     login.html warming the cache while the student is still on the sign-in
     page, which costs nothing and hides nothing. */
  var KEEP_BOARD_ACROSS_SIGNOUT = false;

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

  /* The keys in a cached threads.list row that are a function of WHO ASKED
     rather than of the thread. Checked against the `sel_threads` Select in
     flows/definitions/app.definition.json rather than assumed: of the eighteen
     keys that projection emits, exactly one is computed from the caller —
         "mine": "@equals(string(item()?['author_id']), outputs('my_uid'))"
     — and it happens to be the one that matters. The flow masks an anonymous
     thread's `author` to {user_id:'anon', display_name:'Anonymous'} for
     everybody INCLUDING its author, and then sets `mine` so the author still
     gets their own accept button. So a cached anonymous row carrying mine:true
     names the author of a post this project anonymises everywhere else — it is
     why the leaderboard excludes anonymous content — and it is exactly what a
     snoop reading localStorage after someone signs out would be looking for.

     Everything else the projection emits is byte-identical no matter who calls:
     thread_id, title, category, language, labels, the already-masked author,
     status, pinned, created_at, reply_count, upvotes, accepted, excerpt,
     locked, duplicate_of, instructor_replied, has_endorsed — as is the `users`
     directory in the same response, and the row set itself (f_threads filters
     on `deleted` only, not on role). All of that is cohort-public by
     construction. Add to this list if the projection ever grows another
     caller-dependent field. */
  var PERSONAL_THREAD_FIELDS = ['mine'];

  /* Rewrite the stored board in place so it holds only cohort-public content,
     keeping the uid so cachedThreads()'s guard still works unchanged. Answers
     false when that could not be done for ANY reason, and the caller then
     deletes the key: a half-stripped blob is the one outcome that must never
     survive, so every doubt resolves towards the old, safe behaviour. */
  function depersonaliseBoard() {
    var raw = lsGet(K_THREADS);
    if (!raw) return true;                   /* nothing cached, nothing to strip */
    try {
      var blob = JSON.parse(raw);
      if (!blob || typeof blob !== 'object' || !blob.data ||
          Object.prototype.toString.call(blob.data.threads) !== '[object Array]') {
        return false;
      }
      var rows = blob.data.threads, i, j, row;
      for (i = 0; i < rows.length; i++) {
        row = rows[i];
        if (!row || typeof row !== 'object') return false;
        for (j = 0; j < PERSONAL_THREAD_FIELDS.length; j++) {
          delete row[PERSONAL_THREAD_FIELDS[j]];
        }
      }
      /* Deliberately NOT writeJSON(): lsSet() swallows a quota or privacy-mode
         failure, and a swallowed failure here would leave the ORIGINAL blob —
         flags and all — sitting in storage while we believed we had stripped
         it. The write has to be allowed to throw so this can report false and
         the caller can fall back to deleting the key. */
      window.localStorage.setItem(K_THREADS, JSON.stringify(blob));
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearSession() {
    lsDel(K_TOKEN);
    lsDel(K_USER);
    lsDel(K_EXPIRES);
    lsDel(K_ISSUED);
    /* The bootstrap blob is the user's own profile and proficiency, not board
       content, so there is nothing here to strip down to something shareable. */
    lsDel(K_BOOT);
    lsDel(K_BOOT_AT);
    /* The board goes with the session. It is namespaced by uid anyway, so
       leaving it would be safe from the app's point of view — but on a shared
       lab machine "signed out" has to mean the next person finds nothing of the
       last one, not merely that the code declines to show it. With
       KEEP_BOARD_ACROSS_SIGNOUT off, the test short-circuits and
       depersonaliseBoard() is never called, so this is a plain delete. */
    if (!KEEP_BOARD_ACROSS_SIGNOUT || !depersonaliseBoard()) lsDel(K_THREADS);
    /* No equivalent argument for an un-landed post. It is the one row on the
       board that is not on the server yet, so nobody else can ever be shown it
       by accident — and it is also the one row whose author is unambiguous, and
       nothing survives stripping that. */
    lsDel(K_PENDING);
    /* The session-scoped view caches. The leaderboard is a list of names and
       scores, the thread cache holds whole posts, and the search cache holds
       the board rows again with no uid on them, so all three are exactly the
       kind of thing "sign out" has to mean the end of. */
    ssDel(SK_LEADERBOARD);
    ssDel(SK_THREAD_VIEW);
    ssDel(SK_SEARCH_CACHE);
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
     sign-in behind a full-length spinner.

     DELIBERATELY NOT COVERED: a token minted before this code shipped carries
     no stamp, so tokenAgeMs() reports Infinity and the old behaviour stands.
     That is the safe direction to fail.

     WHY THE BOUND IS TIME, NOT A COUNT OF ATTEMPTS (changed 2026-08-12).
     This used to give up after four retries, and that quietly failed the slow
     third of the distribution — because when the ladder runs out depends on how
     long the CALL takes, which differs per action, while the thing it is racing
     (the workbook write becoming readable, measured at 26.5 / 28.4 / 53.7 s) is
     the same for both. With waits [2,4,9,20] the schedule ran out after four
     retries, and where that landed in wall-clock depended on how long each
     attempt took: attempt k is fired at sum(waits before k) + k*D.

     What makes this bite is a fact about the flow rather than about the client.
     In app.definition.json `chk_auth` sits in the shared prologue, BEFORE
     `sw_action` — so a run that is going to answer `unauthorized` terminates
     right after list_sessions and list_users and never reaches the requested
     action's own reads. Every failing call therefore costs the same ~3 s
     preamble, whatever was asked for: the 3.2 s / 11 s difference between
     meta.bootstrap and threads.list exists only on the SUCCESS path. So both
     ladders ran the same five dispatches and both gave up together at ~50 s —
     just under the 53.7 s write-lag sample. The student watched a minute of
     honest progress and was then returned to the email step holding a code that
     was seconds from working: the exact loop this block exists to break,
     surviving inside it because the bound was the wrong shape.

     So the bound is now the one the prose above always described: keep asking
     while the token is YOUNG, stop when it is old enough that `unauthorized`
     can only mean what it says. RIPEN_WAITS is now only a spacing curve, its
     last entry repeating for as long as the window allows.

     THE WINDOW IS TESTED AGAINST THE TIME THE RETRY WOULD FIRE, not the time
     the rejection arrived — withinRipeningWindow() takes the pending wait and
     adds it to the age. Testing it on arrival would let an answer landing at
     119.9 s start a 20 s sleep and dispatch at 139.9 s, i.e. RIPEN_MS would not
     be a ceiling at all but a floor with the terminal wait added on top. That
     matters beyond tidiness: login.html sizes its own hold against this ceiling,
     and it can only do that if the number means what it says. See
     ripenCeilingMs(), which is what login.html actually reads.

     COST, which is what a time bound has to justify. Termination is guaranteed:
     every cycle advances the clock by at least one wait plus one call, and the
     age is re-tested each time. The dispatch count is NOT monotonic in D and is
     highest for the fastest failure — which, per chk_auth above, is the case we
     are actually in — so RIPEN_MAX_DISPATCHES backstops the curve at 8 rather
     than letting a sub-second failure reach ten. A cold index.html runs THREE of
     these chains, not two (meta.bootstrap, threads.list, and unread.js's badge
     probe against the msg flow), which is why decoration-only reads are exempted
     from ripening altogether — see NO_RIPEN. Worst case is then two chains x 8
     dispatches for one sign-in, against a ~40 k/day allocation shared by the
     cohort. Unlike a poller it cannot repeat on its own; it can only recur if
     the student signs in again, which mints a fresh stamp and a fresh window.
     Contract §8.3 rule 5 keeps recurring work in Clinic.poll; these are one-shot
     timers on a single call chain, so they belong here. */
  var RIPEN_MS = 120000;              /* lag tail (~54 s) + one ~11 s call + headroom */
  /* Spacing between attempts. The last entry repeats until RIPEN_MS is reached,
     so adding or removing entries changes how OFTEN we ask, never how long. */
  var RIPEN_WAITS = [2000, 4000, 9000, 20000];
  /* Backstop on the fastest-failure tail, where the time bound alone would allow
     ten. Counted in DISPATCHES, not retries — `attempt` is the retry index, so
     testing it directly would permit one more call than this number says, and a
     constant that overstates what it allows is how the quota arithmetic above
     goes quietly wrong. Never the binding constraint at realistic durations: at
     200 ms per failure the eighth dispatch still goes out at ~96 s, long past
     the 53.7 s the ladder exists to outlast. */
  var RIPEN_MAX_DISPATCHES = 8;
  /* Worst-case duration of the one Excel round trip a failing run still makes,
     from the 10-21 s band this file quotes elsewhere. Only used to state the
     ceiling conservatively. */
  var RIPEN_CALL_MAX_MS = 21000;

  /* Latest moment the ladder can still be talking to the server, measured from
     the token's issue stamp: the last dispatch fires at RIPEN_MS and one call
     duration passes before its answer. login.html reads this instead of
     re-deriving it — the two files disagreeing about this number is a bug that
     has now happened twice. */
  function ripenCeilingMs() { return RIPEN_MS + RIPEN_CALL_MAX_MS; }

  /* Actions for which a retry is not worth a flow run. unread.js's badge probe
     documents itself as "One call. NEVER retried" and goes quiet on the first
     `unauthorized`; ripening it would override that and spend 8 msg-flow runs on
     a nav decoration during the one window where the quota is most contended.
     The leaderboard is the same kind of thing — lazy, cached, and cosmetic.
     What the student is actually waiting for is the board and the bootstrap. */
  var NO_RIPEN = { 'messages.unread': 1, 'meta.leaderboard': 1 };

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
     by a mock reset). Retrying it would park the demo behind a stall instead of
     bouncing cleanly to the login page. */
  /* True while a token is young enough that `unauthorized` is better read as
     "the workbook has not published the session row yet" than as "no". */
  function tokenIsRipening() {
    return !isMock() && !!getToken() && tokenAgeMs() < RIPEN_MS;
  }

  function withinRipeningWindow(action, attempt, waitMs) {
    if (isMock() || NO_RIPEN[action] === 1) return false;
    if ((attempt + 1) >= RIPEN_MAX_DISPATCHES) return false;   /* attempt is 0-based */
    /* The age that matters is the one the RETRY would go out at, not the one it
       came back at — otherwise the terminal wait lands outside the window. */
    return !!getToken() && (tokenAgeMs() + (waitMs || 0)) < RIPEN_MS;
  }

  /* Hold the last spacing once the schedule is used up, so the ladder keeps
     asking at a sensible interval for the rest of the window instead of ending
     wherever the array happened to stop. */
  function ripenWaitMs(attempt) {
    var i = attempt < RIPEN_WAITS.length ? attempt : RIPEN_WAITS.length - 1;
    return RIPEN_WAITS[i];
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
        var wait = ripenWaitMs(attempt);
        if (withinRipeningWindow(action, attempt, wait)) {
          return delay(wait).then(function () {
            return dispatch(action, data, attempt + 1);
          });
        }
        /* A decoration-only read that comes back unauthorized while the token is
           STILL RIPENING must not be the call that declares the session dead.
           Exempting it from the ladder saves the quota it would spend retrying,
           but on a cold index.html its chain runs alongside the board's and the
           bootstrap's — and against the msg flow, whose chk_auth fires earliest,
           so it fails FIRST. Letting it fall through to clearSession() would
           destroy the very token those two are legitimately still retrying with,
           and bounceToLogin() would navigate off the page mid-warm: a nav badge
           would have ended the sign-in. So it goes quiet instead, exactly as
           unread.js's own unauthorized handler intends, and leaves the verdict on
           the session to the calls the student is actually waiting for. Past the
           window there is nothing left to protect and it behaves normally. */
        if (NO_RIPEN[action] === 1 && tokenIsRipening()) throw err;
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

  /* ------------------------------------------------------- activity signal ---
     EVERY call on this site is slow. 10-21 s per Excel round trip is the normal
     case, not the tail, and a page with nothing moving on it reads as a page
     that has died — which is precisely the misreading this release is trying to
     stop. So dispatch() is counted, and the count is announced.

     ui.js draws one thin bar at the top of the viewport from this event, and
     any page that wants a local indicator can listen to the same signal instead
     of inventing its own bookkeeping.

     Counted around dispatch(), never around call(), so a DEDUPE'd second caller
     riding the same in-flight promise does not double-count one request. The
     count is decremented in both settle paths; there is no path out of
     dispatch() that skips them. */
  var activeCalls = 0;

  function fireActivity() {
    var detail = { active: activeCalls };
    var ev;
    try {
      ev = new window.CustomEvent('clinic:activity', { detail: detail });
    } catch (e) {                                  // very old engines
      ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('clinic:activity', false, false, detail);
    }
    window.dispatchEvent(ev);
  }

  function tracked(p) {
    activeCalls++;
    fireActivity();
    function done() {
      activeCalls = activeCalls > 0 ? activeCalls - 1 : 0;
      fireActivity();
    }
    return p.then(function (v) { done(); return v; },
                  function (e) { done(); throw e; });
  }

  function activeCallCount() { return activeCalls; }

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
    var p = tracked(dispatch(action, data));
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
    lsSet(K_BOOT_AT, String(Date.now()));
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

  /* ------------------------------------------- the bootstrap revalidate floor
     threads.list has had one since v3.3 (REVALIDATE_MIN_AGE_MS below); this is
     the same idea applied to the other half of a page load, and it was costing
     a flow run on EVERY navigation. bootstrap() used to return the cache and
     then fire refreshBootstrap() unconditionally, so a student clicking board →
     thread → back → thread spent a ~3.2 s meta.bootstrap on each hop to re-read
     config that changes when the instructor edits the workbook, i.e. hardly
     ever. On a ~40 k/day allocation shared by the whole cohort that is the
     cheapest run in the system to stop making.

     It also makes login.html's warm-up honest. Priming the cache there would
     otherwise have turned index.html's single cold fetch into a cache hit PLUS
     an unconditional background refresh — two runs where there was one, on
     every sign-in, which is the opposite of the point.

     60 s is chosen against what the payload actually is: config (site title,
     notice, categories, clinic times) and the caller's own profile. A change
     to any of those showing up one minute late is invisible; the instructor
     editing the notice mid-class still sees it on their next navigation. */
  var BOOT_REVALIDATE_MIN_AGE_MS = 60000;

  function bootstrapAgeMs() {
    var raw = lsGet(K_BOOT_AT);
    if (!raw) return Infinity;              /* stamped by an older build: refresh */
    var t = parseInt(raw, 10);
    if (isNaN(t)) return Infinity;
    var age = Date.now() - t;
    return age < 0 ? Infinity : age;        /* clock moved backwards; do not trust it */
  }

  /* Pages call this. Returns instantly from cache when we have one, and quietly
     refreshes in the background — listen for the 'clinic:bootstrap' window event
     if you want to re-render when newer config lands (e.g. the instructor
     changed the notice text or the category list). */
  function bootstrap() {
    var cached = cachedBootstrap();
    if (cached) {
      if (getToken() && bootstrapAgeMs() >= BOOT_REVALIDATE_MIN_AGE_MS) {
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
        the bootstrap blob. KEEP_BOARD_ACROSS_SIGNOUT in the session section has
        the case for keeping a stripped copy instead, and the three things that
        must be fixed before that would be safe.

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
  /* ------------------------------------- the bootstrap riding on the board ---
     threads.list can answer the bootstrap payload too, under `boot`. When it does,
     opening the board costs ONE flow run instead of two - both used to pay the same
     ~24-action prologue and its three Excel reads, and the daily request quota is
     shared across the whole cohort, so halving that is worth more than it looks.

     Handled here rather than in each page so a caller cannot forget: any code path
     that lands a threads.list also lands the bootstrap.

     `boot` is deliberately NOT kept in the board blob. It holds the caller's own
     profile, and the board cache is cohort-public content that other code reads and
     reasons about; the bootstrap has its own uid-keyed key and its own lifecycle.

     An OLDER flow simply omits the key, and everything below no-ops - which is what
     makes this safe to deploy BEFORE the flow that produces it. */
  function absorbMergedBootstrap(list) {
    if (!list || !list.boot || !list.boot.config) return list;
    var boot = list.boot;
    var rest = {}, k;
    for (k in list) {
      if (Object.prototype.hasOwnProperty.call(list, k) && k !== 'boot') rest[k] = list[k];
    }
    /* storeBootstrap stamps K_BOOT_AT, so the 60 s revalidate floor treats this
       exactly like a real meta.bootstrap answer - which it is. */
    try { storeBootstrap(boot); } catch (e) { /* board must not depend on it */ }
    return rest;
  }

  function storeThreads(list) {
    list = absorbMergedBootstrap(list);
    if (!list || Object.prototype.toString.call(list.threads) !== '[object Array]') {
      return list;
    }
    /* The RAW server payload is what gets cached. Pending rows are merged on
       read (see withPending) so the cache never claims the server said
       something it did not. */
    writeJSON(K_THREADS, { uid: currentUid(), at: Date.now(), data: list });
    reconcilePending(list);
    var merged = withPending(list);
    fireThreadsEvent(merged);
    return merged;
  }

  function cachedThreads() {
    var blob = readJSON(K_THREADS);
    if (!blob || typeof blob !== 'object' || !blob.data) return null;
    if (String(blob.uid || '') !== currentUid()) { lsDel(K_THREADS); return null; }
    var at = Number(blob.at) || 0;
    if (!at || (Date.now() - at) > THREADS_MAX_AGE_MS) { lsDel(K_THREADS); return null; }
    var data = blob.data;
    if (Object.prototype.toString.call(data.threads) !== '[object Array]') return null;
    return withPending(data);
  }

  /* Age of the STORED payload in ms, Infinity when there is nothing usable.
     Deliberately not folded into cachedThreads(): that one returns the merged
     view a caller renders, and the merge would make "how old is the server's
     answer" ambiguous the moment a pending row is in it. */
  function cachedThreadsAgeMs() {
    var blob = readJSON(K_THREADS);
    if (!blob || typeof blob !== 'object' || !blob.data) return Infinity;
    if (String(blob.uid || '') !== currentUid()) return Infinity;
    var at = Number(blob.at) || 0;
    if (!at) return Infinity;
    var age = Date.now() - at;
    return age < 0 ? Infinity : age;      /* clock moved backwards; do not trust it */
  }

  /* ------------------------------------------- just-posted threads (v3.2) ---

     THE COMPLAINT THIS EXISTS TO ANSWER, IN THE STUDENT'S WORDS: "I pressed
     Start discussion, it showed me my question, I went back to the board — and
     it was not there. Did it post?"

     It did. A resolved threads.create means the row was written. But an Excel
     Online write is not READABLE for ~30 s, and threads.list itself costs
     10-21 s on top of that, so for up to about a minute the board genuinely
     cannot show the thread. Nothing on this end can shorten that window. What
     it can do is stop the board from making a truthful delay look like a lost
     post.

     new.js already hands the new thread to thread.html through a sessionStorage
     stash (PERF FIX 1b). This is the same trick for the BOARD, and it lives
     here rather than in index.js so that search.js — and any later list — get
     it without knowing about it.

     THE SAME THREE RULES THAT MAKE THE THREADS CACHE SAFE APPLY HERE:
       * NAMESPACED BY UID. On a shared lab machine one student's un-landed
         post must never appear on the next student's board.
       * TTL'd. Past PENDING_TTL_MS the copy is dropped rather than shown. A
         post that never lands must not haunt the board for a week: after the
         window, its absence is the truth and the student should see the truth.
       * CLEARED ON SIGN-OUT with the token, the user and the two caches.

     RECONCILIATION IS BY thread_id, ALWAYS — the same discipline thread.js
     uses for pending replies. The moment threads.list returns the id, the
     pending copy is dropped, so a row is never drawn twice and the REAL row,
     with its real reply count, votes and badges, always wins.

     The pending copy is merged ON READ and is never written into K_THREADS:
     the cache stays a faithful record of what the server actually said. */

  var PENDING_TTL_MS = 15 * 60 * 1000;

  function pendingWrite(items) {
    if (!items || !items.length) { lsDel(K_PENDING); return; }
    writeJSON(K_PENDING, { uid: currentUid(), items: items });
  }

  function pendingRead() {
    var blob = readJSON(K_PENDING);
    if (!blob || typeof blob !== 'object') return [];
    if (String(blob.uid || '') !== currentUid()) { lsDel(K_PENDING); return []; }
    var items = (Object.prototype.toString.call(blob.items) === '[object Array]')
      ? blob.items : [];
    var now = Date.now(), keep = [], i, it;
    for (i = 0; i < items.length; i++) {
      it = items[i];
      if (!it || !it.thread || !it.thread.thread_id) continue;
      if (!(Number(it.at) > 0) || (now - Number(it.at)) > PENDING_TTL_MS) continue;
      keep.push(it);
    }
    if (keep.length !== items.length) pendingWrite(keep);
    return keep;
  }

  /* Called by new.js the instant threads.create resolves. `thread` is the full
     ThreadFull shape it also stashes for thread.html, so the board can render a
     complete card — title, author, category, labels — not a placeholder. */
  function addPendingThread(thread) {
    if (!thread || !thread.thread_id) return;
    var items = pendingRead(), i;
    for (i = 0; i < items.length; i++) {
      if (String(items[i].thread.thread_id) === String(thread.thread_id)) return;
    }
    items.push({ at: Date.now(), thread: thread });
    pendingWrite(items);
  }

  function pendingThreads() {
    return pendingRead().map(function (it) { return it.thread; });
  }

  /* thread.js's fallback when its own single-thread sessionStorage stash is
     gone (a second visit, another tab) but the row still has not propagated. */
  function pendingThreadById(id) {
    var items = pendingRead(), i;
    for (i = 0; i < items.length; i++) {
      if (String(items[i].thread.thread_id) === String(id)) return items[i].thread;
    }
    return null;
  }

  /* NOTE — THERE IS DELIBERATELY NO dropPendingThread(id) IN THIS FILE.
     One existed briefly, called from thread.js when threads.get could see the
     row. It is the wrong evidence: index.js does not paint the board from
     threads.get, it paints it from the CACHED threads.list, which is a snapshot
     taken before the thread existed. Retiring the pending copy on a threads.get
     success therefore puts the student straight back into "I pressed Back and
     my question is gone". A pending row may be retired by exactly two things:
     threads.list returning the id (reconcilePending, below) or PENDING_TTL_MS. */

  function idSet(list) {
    var rows = (list && list.threads) || [];
    var seen = {}, i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].thread_id) seen[String(rows[i].thread_id)] = 1;
    }
    return seen;
  }

  /* Drop every pending copy the server has now caught up on. */
  function reconcilePending(list) {
    var items = pendingRead();
    if (!items.length) return false;
    var seen = idSet(list);
    var keep = items.filter(function (it) {
      return !seen[String(it.thread.thread_id)];
    });
    if (keep.length === items.length) return false;
    pendingWrite(keep);
    return true;
  }

  /* A COPY of the payload with the still-unlanded threads on the front, each
     flagged `_pending` so index.js can say "posting" rather than pretend the
     row is settled. Never mutates its argument: the caller may be holding the
     cached blob itself. The leading underscore marks it as client-side only —
     nothing on the wire ever carries it. */
  function withPending(list) {
    var items = pendingRead();
    if (!items.length) return list;
    var seen = idSet(list);
    var extra = [], i, k, t, copy;
    for (i = 0; i < items.length; i++) {
      t = items[i].thread;
      if (seen[String(t.thread_id)]) continue;
      copy = {};
      for (k in t) { if (Object.prototype.hasOwnProperty.call(t, k)) copy[k] = t[k]; }
      copy._pending = true;
      extra.push(copy);
    }
    if (!extra.length) return list;
    var out = {};
    for (k in list) { if (Object.prototype.hasOwnProperty.call(list, k)) out[k] = list[k]; }
    out.threads = extra.concat((list && list.threads) || []);
    return out;
  }

  function refreshThreads() {
    return call('threads.list', {}).then(storeThreads);
  }

  /* ------------------------------------------------- the revalidate floor ---
     v3.1 refreshed on EVERY threadsList() call, whatever the cache's age. That
     was right when index.html was the only caller and called it once a visit.
     It is wrong now: thread.js asks for the same board for its contributor
     badge and its duplicate picker, and a reader going board -> thread -> back
     -> thread was spending a 10-21 s flow run each time to re-fetch a payload
     that had not had time to change. On a shared connector with a daily
     allocation (R2/R22) that is the most expensive habit on the site.

     So a stored board younger than this is simply believed. The 12 h max-age
     is untouched — this is a floor on how OFTEN we revalidate, not a change to
     how long a payload stays usable.

     TWO EXCEPTIONS, both load-bearing:

     1. A NON-EMPTY PENDING STORE. A pending row is retired by exactly one
        thing — threads.list returning the id (see the note above
        pendingThreadById) — so while one is outstanding, revalidation IS the
        feature and must never be skipped. index.js's 30/45/60 s re-checks go
        through refreshThreads() and so bypass this function entirely, but a
        page LOAD inside that window comes through here, and skipping it would
        leave a "Posting" badge on a row that landed a minute ago.
     2. opts.force, for a caller that has just changed the board and knows it. */
  var REVALIDATE_MIN_AGE_MS = 75000;

  function hasPendingThreads() {
    return pendingRead().length > 0;
  }

  function shouldRevalidateThreads(opts) {
    if (opts && opts.force) return true;
    if (hasPendingThreads()) return true;
    return cachedThreadsAgeMs() >= REVALIDATE_MIN_AGE_MS;
  }

  /* Pages call this instead of call('threads.list', {}).
     Cache hit  -> resolves IMMEDIATELY with the cached board, and refreshes
                   behind you UNLESS the stored payload is younger than the
                   revalidate floor; 'clinic:threads' fires when a refresh lands.
     Cache miss -> behaves exactly like the old direct call, event included. */
  function threadsList(opts) {
    var cached = cachedThreads();
    if (cached) {
      if (getToken() && shouldRevalidateThreads(opts)) {
        refreshThreads()['catch'](function () { /* silent; stale beats blank */ });
      }
      return Promise.resolve(cached);
    }
    return refreshThreads();
  }

  /* ------------------------------------------------- the leaderboard (v3.3) --

     WHAT IS CHANGING, AND WHY THIS HELPER EXISTS BEFORE IT DOES.

     threads.list today returns `contrib` (and sometimes `contrib_month`)
     alongside the board, which is why it costs a ~44-action Query/Select
     /Compose chain on top of its three unfiltered Excel reads. A flow change
     being built in parallel splits that derivation OUT into its own read-only
     action, meta.leaderboard, returning {contrib, contrib_month} with item
     shapes identical to today's.

     The two backends therefore differ by the PRESENCE of a key, and this file
     is deployed to GitHub Pages independently of any flow import (contract
     §12), so both shapes are live at once for as long as the wave takes.

     THE RULE, AND THE ONE THING IT MUST NOT DO:
       contrib present  -> use it. NO extra request. Whatever the deployed
                           backend costs today, it must not cost one call more
                           because this helper exists.
       contrib absent   -> meta.leaderboard, once, cached per user for
                           LEADERBOARD_TTL_MS in sessionStorage.

     Note the test is Array.isArray, not truthiness: `contrib: []` is a real
     answer ("nobody has scored yet") from a backend that still sends the key,
     and treating it as absent would spend a flow run to be told the same thing.

     NEVER REJECTS. The leaderboard is decoration on every page that draws it —
     a sidebar panel and a badge. A failure resolves with the last cached copy
     if there is one, and with empty rows if there is not, so the caller's only
     job is to render what it gets. Unknown-action goes through callSafe, so a
     backend that predates meta.leaderboard costs exactly one probe per session
     rather than a red toast. */

  var LEADERBOARD_TTL_MS = 10 * 60 * 1000;
  var leaderboardInFlight = null;

  function emptyLeaderboard() { return { contrib: [], contrib_month: null }; }

  function isArr(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  /* The shape both branches resolve with, normalised so callers never have to
     ask which backend answered. */
  function shapeLeaderboard(src) {
    if (!src || !isArr(src.contrib)) return null;
    return {
      contrib: src.contrib,
      contrib_month: isArr(src.contrib_month) ? src.contrib_month : null
    };
  }

  /* maxAgeMs Infinity = "any age", which is the failure path: yesterday's
     ranking is a better answer than an empty panel, and it is never presented
     as anything other than what the caller already draws. */
  function cachedLeaderboard(maxAgeMs) {
    var blob = ssReadJSON(SK_LEADERBOARD);
    if (!blob || typeof blob !== 'object') return null;
    if (String(blob.uid || '') !== currentUid()) { ssDel(SK_LEADERBOARD); return null; }
    var at = Number(blob.at) || 0;
    if (!at) return null;
    if (maxAgeMs !== Infinity && (Date.now() - at) > maxAgeMs) return null;
    return shapeLeaderboard(blob.data);
  }

  function storeLeaderboard(data) {
    var shaped = shapeLeaderboard(data);
    if (!shaped) return null;
    ssWriteJSON(SK_LEADERBOARD, { uid: currentUid(), at: Date.now(), data: shaped });
    return shaped;
  }

  function leaderboard(list) {
    /* 1. The backend deployed today. Free. */
    var inline = shapeLeaderboard(list);
    if (inline) return Promise.resolve(inline);

    /* 2. This session already asked. */
    var fresh = cachedLeaderboard(LEADERBOARD_TTL_MS);
    if (fresh) return Promise.resolve(fresh);

    /* 3. One in flight is enough — the sidebar and a badge can both want this
          on the same paint, exactly as they can want the board. */
    if (leaderboardInFlight) return leaderboardInFlight;

    if (!getToken()) return Promise.resolve(cachedLeaderboard(Infinity) || emptyLeaderboard());

    var settle = function (out) {
      leaderboardInFlight = null;
      return out;
    };
    leaderboardInFlight = callSafe('meta.leaderboard', {}, null).then(function (d) {
      /* null = this backend has never heard of the action. Cache nothing: the
         next threads.list may well carry `contrib` inline, and a cached empty
         would then hide a leaderboard we can actually draw. */
      return settle(storeLeaderboard(d) || cachedLeaderboard(Infinity) || emptyLeaderboard());
    }, function () {
      /* network, throttle, anything else. Decoration never surfaces an error. */
      return settle(cachedLeaderboard(Infinity) || emptyLeaderboard());
    });
    return leaderboardInFlight;
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
    /* Exported for search-index.js, which builds its index straight off the
       cached board and has to know whether that board is minutes or hours old
       before trusting it for duplicate detection. */
    cachedThreadsAgeMs: cachedThreadsAgeMs,
    /* Exported for login.html, which holds the student while the board warms and
       must not give up while the ripening ladder is still working. */
    ripenCeilingMs: ripenCeilingMs,
    leaderboard: leaderboard,
    addPendingThread: addPendingThread,
    pendingThreads: pendingThreads,
    pendingThreadById: pendingThreadById,
    activeCallCount: activeCallCount,
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
