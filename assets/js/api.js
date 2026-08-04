/*!
 * NUS Coding Clinic — api.js
 * The ONLY file in the site that is allowed to call fetch(). See SPEC.md §5.
 *
 * Public surface (everything hangs off window.Clinic.api):
 *
 *   call(action, data)        -> Promise<data>   every API action goes through here
 *   bootstrap()               -> Promise<boot>   cached-first config + user
 *   requireLogin()            -> bool            redirects to login.html if signed out
 *   logout()                                     clears session, goes to login.html
 *   getToken()                -> string          "" when signed out
 *   getUser()                 -> user|null       {user_id, display_name, role, email}
 *   setUser(user)                                update the cached user object
 *   cachedBootstrap()         -> boot|null       whatever is in localStorage, no network
 *   isInstructor()            -> bool
 *   isMock()                  -> bool
 *   isConfigured()            -> bool            false while config.js still says PASTE_
 *   nextUrl(fallback)         -> string          safe ?next= target for login.html
 *   loginUrl()                -> string          "login.html?next=<here>"
 *   ApiError                                     {code, message} constructor
 *
 * Errors: every rejection is an ApiError with a `.code` and a `.message`.
 *   code ∈ unauthorized | forbidden | not_found | conflict | bad_request |
 *          cutoff_passed | network
 * Pages should show `err.message` in a toast and, where useful, branch on `err.code`.
 * `unauthorized` is handled here (session cleared + bounce to login) and still
 * rejects, so page code can simply stop.
 *
 * localStorage keys owned by this file:
 *   clinic_token           session token string
 *   clinic_user            JSON of the user object
 *   clinic_token_expires   ISO timestamp, used to expire the session client-side
 *   clinic_bootstrap       JSON cache of meta.bootstrap
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var K_TOKEN = 'clinic_token';
  var K_USER = 'clinic_user';
  var K_EXPIRES = 'clinic_token_expires';
  var K_BOOT = 'clinic_bootstrap';

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

  function endpointFor(action) {
    var c = cfg();
    if (action.indexOf('auth.') === 0) return c.AUTH_URL;
    if (action.indexOf('admin.') === 0) return c.ADMIN_URL;
    return c.APP_URL;
  }

  function looksPlaceholder(url) {
    return !url || typeof url !== 'string' || url.indexOf('PASTE_') === 0 ||
      url.indexOf('http') !== 0;
  }

  function isConfigured() {
    var c = cfg();
    return !looksPlaceholder(c.AUTH_URL) && !looksPlaceholder(c.APP_URL) &&
      !looksPlaceholder(c.ADMIN_URL);
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
    if (token) lsSet(K_TOKEN, token);
    if (user) writeJSON(K_USER, user);
    if (expiresAt) lsSet(K_EXPIRES, expiresAt); else lsDel(K_EXPIRES);
  }

  function clearSession() {
    lsDel(K_TOKEN);
    lsDel(K_USER);
    lsDel(K_EXPIRES);
    lsDel(K_BOOT);
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
        return res.text();
      }).then(function (text) {
        var resp;
        try { resp = JSON.parse(text); }
        catch (e) { reject(new ApiError('network', MSG_NETWORK)); return; }
        if (resp && resp.ok) {
          resolve(resp.data === undefined || resp.data === null ? {} : resp.data);
        } else {
          reject(new ApiError(
            (resp && resp.code) || 'bad_request',
            (resp && resp.error) || 'Something went wrong.'
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

  function dispatch(action, data) {
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

  var DEDUPE = { 'meta.bootstrap': 1, 'threads.list': 1 };
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
    bootstrap: bootstrap,
    refreshBootstrap: refreshBootstrap,
    cachedBootstrap: cachedBootstrap,
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
