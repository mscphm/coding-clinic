/* =========================================================================
   MScPHMxAI Coding Clinic — ui.js   (owner: agent A1)
   Shared chrome + helpers. Everything hangs off window.Clinic.ui.
   Vanilla ES2018, loaded with <script defer>. No fetch() in here — all
   network access goes through Clinic.api (agent A4).

   FAVICON — every page must carry this exact line in <head>
   (copy the whole line, it is a self-contained data: URI, no asset file):

<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath fill='%231f6feb' d='M1.25 3A1.75 1.75 0 0 1 3 1.25h10A1.75 1.75 0 0 1 14.75 3v7A1.75 1.75 0 0 1 13 11.75H7.5L4 14.75V11.75H3A1.75 1.75 0 0 1 1.25 10Z'/%3E%3Cpath fill='none' stroke='%23ffffff' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round' d='M6.25 5.5 4.25 7.5l2 2M9.75 5.5l2 2-2 2'/%3E%3C/svg%3E">

   PUBLIC API
     Clinic.ui.esc(s)                     -> HTML-escaped string
     Clinic.ui.relTime(iso)               -> "just now" | "5 minutes ago" | "12 Aug"
     Clinic.ui.fmtDateTime(iso)           -> "12 Aug 2026, 13:00"  (SGT)
     Clinic.ui.fmtDate(iso) / fmtTime(iso) / fmtDayDate(iso)       (SGT)
     Clinic.ui.avatar(author[, size])     -> <span class="avatar">   (see NOTE)
     Clinic.ui.icon(name[, className])    -> <svg class="octicon">   (see NOTE)
     Clinic.ui.pill(text[, className])    -> <span class="pill">     (see NOTE)
     Clinic.ui.toast(msg[, type[, ms]])   type: "success" | "error" | ""
     Clinic.ui.confirmModal(msg[, opts])  -> Promise<boolean>
     Clinic.ui.renderHeader([activeTab])  -> fills #app-header
     Clinic.ui.renderSidebarShell()       -> returns the .sidebar element
     Clinic.ui.currentUser() / cachedBootstrap() / siteTitle()
     Clinic.ui.getTheme() / setTheme(t) / toggleTheme()
     Clinic.ui.apiCall(action, data)      -> Promise<data>  (compat shim over Clinic.api)

   v3 ADDITIONS (contract §10.6) — nobody re-implements these
     Clinic.ui.setNavBadge(tabKey, count) stash + draw the nav unread counter
     Clinic.ui.setTabVisible(key, bool)   show/hide a nav tab, then re-render
     Clinic.ui.truthy(v)                  the ONE mixed-type wire-boolean test
     Clinic.ui.instructorIds()            -> [] when config is absent
     Clinic.ui.instructorUserId()         -> '' when config is absent
     Clinic.ui.isInstructorAuthor(author) -> false for anon and for no config
     Clinic.ui.featureOn/Off/State(name)  'unknown' | 'on' | 'off'
     Clinic.ui.isUnknownAction(err)       the FEATURE-ABSENT detector
     Clinic.ui.endpointFor(action)        'auth' | 'admin' | 'msg' | 'app'

   WAITING (see the long note in the file — one vocabulary, three sizes)
     Clinic.ui.spinner([cls])             -> <span class="spinner">
     Clinic.ui.busy(btn, label)           -> restore()   spinner + verb, disabled
     Clinic.ui.skeleton(kind[, n])        -> grey rows shaped like what is coming
     Clinic.ui.loadingBlock(msg, kind, n) -> live-region message + skeleton
     Clinic.ui.mountNetBar()              the site-wide activity bar (automatic
                                          for any page that calls renderHeader)

   NOTE — avatar(), icon() and pill() return real DOM elements whose
   toString() is overridden to return outerHTML, so BOTH styles work:
       box.appendChild(Clinic.ui.icon('tag'));
       html += '<span>' + Clinic.ui.icon('tag') + '</span>';   // template literals too
   ========================================================================= */

(function () {
  'use strict';

  var Clinic = (window.Clinic = window.Clinic || {});
  var ui = (Clinic.ui = Clinic.ui || {});

  var LS_THEME = 'clinic_theme';
  var LS_USER = 'clinic_user';
  var LS_TOKEN = 'clinic_token';
  var LS_BOOTSTRAP = 'clinic_bootstrap';
  var SGT_OFFSET_MS = 8 * 60 * 60 * 1000; /* Asia/Singapore, no DST */
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  /* ---------------------------------------------------------------------
     Storage helpers (never throw — private mode / disabled storage)
     ------------------------------------------------------------------ */

  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }
  function lsJson(key) {
    var raw = lsGet(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ---------------------------------------------------------------------
     Theme — applied immediately at script load so there is no flash
     ------------------------------------------------------------------ */

  function applyStoredTheme() {
    var t = lsGet(LS_THEME);
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  }
  applyStoredTheme();

  function systemTheme() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark' : 'light';
    } catch (e) { return 'light'; }
  }

  function getTheme() {
    var t = document.documentElement.getAttribute('data-theme');
    return t === 'dark' || t === 'light' ? t : systemTheme();
  }

  function setTheme(theme) {
    if (theme !== 'dark' && theme !== 'light') return;
    document.documentElement.setAttribute('data-theme', theme);
    lsSet(LS_THEME, theme);
    try {
      document.dispatchEvent(new CustomEvent('clinic:themechange', { detail: { theme: theme } }));
    } catch (e) { /* older browsers: no event */ }
    refreshThemeToggle();
  }

  function toggleTheme() { setTheme(getTheme() === 'dark' ? 'light' : 'dark'); }

  /* ---------------------------------------------------------------------
     Escaping + small utilities
     ------------------------------------------------------------------ */

  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }

  function hash32(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function hashHue(str) { return hash32(String(str == null ? '' : str)) % 360; }

  /* make a DOM element usable inside template strings */
  function stringable(el) {
    el.toString = function () { return el.outerHTML; };
    return el;
  }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  /* ---------------------------------------------------------------------
     Dates — everything user-facing is Asia/Singapore (fixed UTC+8)
     ------------------------------------------------------------------ */

  function parseIso(value) {
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') { var n = new Date(value); return isNaN(n.getTime()) ? null : n; }
    if (!value) return null;
    var s = String(value).trim();
    if (!s) return null;
    /* bare SGT date, e.g. a Slots.date value */
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += 'T00:00:00+08:00';
    else {
      s = s.replace(' ', 'T');
      /* tables store UTC; add the marker when it is missing */
      if (!/[zZ]$/.test(s) && !/[+-]\d{2}:?\d{2}$/.test(s)) s += 'Z';
    }
    var d = new Date(s);
    if (isNaN(d.getTime())) d = new Date(String(value));
    return isNaN(d.getTime()) ? null : d;
  }

  /* date parts as seen in Singapore */
  function sgParts(d) {
    var t = new Date(d.getTime() + SGT_OFFSET_MS);
    return {
      year: t.getUTCFullYear(),
      month: t.getUTCMonth(),
      day: t.getUTCDate(),
      hour: t.getUTCHours(),
      minute: t.getUTCMinutes(),
      dow: t.getUTCDay()
    };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtDate(iso) {
    var d = parseIso(iso); if (!d) return '';
    var p = sgParts(d);
    return p.day + ' ' + MONTHS[p.month] + ' ' + p.year;
  }

  function fmtDayDate(iso) {
    var d = parseIso(iso); if (!d) return '';
    var p = sgParts(d);
    return DAYS[p.dow] + ', ' + p.day + ' ' + MONTHS[p.month] + ' ' + p.year;
  }

  function fmtTime(iso) {
    var d = parseIso(iso); if (!d) return '';
    var p = sgParts(d);
    return pad2(p.hour) + ':' + pad2(p.minute);
  }

  function fmtDateTime(iso) {
    var d = parseIso(iso); if (!d) return '';
    return fmtDate(d) + ', ' + fmtTime(d);
  }

  function shortDate(d) {
    var p = sgParts(d);
    var nowY = sgParts(new Date()).year;
    return p.day + ' ' + MONTHS[p.month] + (p.year === nowY ? '' : ' ' + p.year);
  }

  function relTime(iso) {
    var d = parseIso(iso); if (!d) return '';
    var delta = Date.now() - d.getTime();
    var future = delta < 0;
    var sec = Math.round(Math.abs(delta) / 1000);

    if (sec < 45) return future ? 'in a moment' : 'just now';
    if (sec < 90) return future ? 'in 1 minute' : '1 minute ago';
    var min = Math.round(sec / 60);
    if (min < 60) return future ? ('in ' + min + ' minutes') : (min + ' minutes ago');
    if (min < 90) return future ? 'in 1 hour' : '1 hour ago';
    var hr = Math.round(min / 60);
    if (hr < 24) return future ? ('in ' + hr + ' hours') : (hr + ' hours ago');
    var day = Math.round(hr / 24);
    if (day <= 1) return future ? 'tomorrow' : 'yesterday';
    if (day < 30) return future ? ('in ' + day + ' days') : (day + ' days ago');
    return shortDate(d);
  }

  /* ---------------------------------------------------------------------
     Icons — hand-drawn 16x16 octicon-style outlines (no icon dependency)
     ------------------------------------------------------------------ */

  var DOT = ' fill="currentColor" stroke="none"';

  var ICONS = {
    'comment-discussion':
      '<path d="M1.25 3A1.75 1.75 0 0 1 3 1.25h5.5A1.75 1.75 0 0 1 10.25 3v3A1.75 1.75 0 0 1 8.5 7.75H5.75L3.5 9.75V7.75H3A1.75 1.75 0 0 1 1.25 6Z"/>' +
      '<path d="M7.5 8.25A1.75 1.75 0 0 1 9.25 6.5h4A1.75 1.75 0 0 1 15 8.25v3A1.75 1.75 0 0 1 13.25 13h-.5v2l-2.25-2H9.25A1.75 1.75 0 0 1 7.5 11.25Z"/>',
    'comment':
      '<path d="M1.75 3.25A1.75 1.75 0 0 1 3.5 1.5h9A1.75 1.75 0 0 1 14.25 3.25v6A1.75 1.75 0 0 1 12.5 11H7.25L4 14V11H3.5A1.75 1.75 0 0 1 1.75 9.25Z"/>',
    'check-circle':
      '<circle cx="8" cy="8" r="6.75"/><path d="M5.25 8.25 7.25 10.25 10.75 6"/>',
    'check':
      '<path d="M3.5 8.5 6.5 11.5 12.5 4.5"/>',
    'arrow-up':
      '<path d="M8 13.5V3.4"/><path d="M3.5 7.9 8 3.4l4.5 4.5"/>',
    'tag':
      '<path d="M7.7 1.75H3.25a1.5 1.5 0 0 0-1.5 1.5V7.7a1.5 1.5 0 0 0 .44 1.06l5.05 5.05a1.5 1.5 0 0 0 2.12 0l4.45-4.45a1.5 1.5 0 0 0 0-2.12L8.76 2.19a1.5 1.5 0 0 0-1.06-.44Z"/>' +
      '<circle cx="5.25" cy="5.25" r=".95"' + DOT + '/>',
    'calendar':
      '<rect x="1.75" y="3.25" width="12.5" height="11" rx="1.5"/>' +
      '<path d="M1.75 6.75h12.5M5.25 1.75v3M10.75 1.75v3"/>',
    'search':
      '<circle cx="7" cy="7" r="4.75"/><path d="M10.5 10.5 14.25 14.25"/>',
    'gear':
      '<circle cx="8" cy="8" r="2.2"/><circle cx="8" cy="8" r="4.6"/>' +
      '<path d="M8 1.7v1.7M8 12.6v1.7M14.3 8h-1.7M1.7 8h1.7' +
      'M12.46 3.54l-1.21 1.21M3.54 12.46l1.21-1.21' +
      'M12.46 12.46l-1.21-1.21M3.54 3.54l1.21 1.21"/>',
    'person':
      '<circle cx="8" cy="5" r="2.75"/><path d="M2.75 14.25a5.25 5.25 0 0 1 10.5 0"/>',
    'people':
      '<circle cx="6" cy="5.25" r="2.5"/><path d="M1.75 13.75a4.25 4.25 0 0 1 8.5 0"/>' +
      '<path d="M10.6 3.15a2.5 2.5 0 0 1 0 4.2M11.6 9.9a4.25 4.25 0 0 1 2.65 3.85"/>',
    'sun':
      '<circle cx="8" cy="8" r="3.25"/>' +
      '<path d="M8 1.25v1.6M8 13.15v1.6M14.75 8h-1.6M1.25 8h1.6' +
      'M12.77 3.23l-1.13 1.13M3.23 12.77l1.13-1.13' +
      'M12.77 12.77l-1.13-1.13M3.23 3.23l1.13 1.13"/>',
    'moon':
      '<path d="M12.6 10.6A6.2 6.2 0 0 1 5.4 3.4 6.2 6.2 0 1 0 12.6 10.6Z"/>',
    /* r was 1.15. Three 1.15px dots in --fg-muted inside a transparent,
       borderless button is a control the instructor reported not being able to
       FIND — the affordance is now mostly on .btn-kebab in main.css §6, but the
       glyph itself was also below the size where three dots read as "menu"
       rather than as a rendering artefact. 1.45 is still GitHub-ish; it is just
       actually visible at 16px on a laptop screen. */
    'kebab':
      '<circle cx="8" cy="3" r="1.45"' + DOT + '/>' +
      '<circle cx="8" cy="8" r="1.45"' + DOT + '/>' +
      '<circle cx="8" cy="13" r="1.45"' + DOT + '/>',
    'x':
      '<path d="M4 4 12 12M12 4 4 12"/>',
    'plus':
      '<path d="M8 2.75v10.5M2.75 8h10.5"/>',
    'link':
      '<path d="M6.5 9.5 9.5 6.5"/>' +
      '<path d="M7.4 4.9 8.75 3.55a3.25 3.25 0 0 1 4.6 4.6L12 9.5"/>' +
      '<path d="M8.6 11.1 7.25 12.45a3.25 3.25 0 0 1-4.6-4.6L4 6.5"/>',
    'trophy':
      '<path d="M5 1.75h6v3.5a3 3 0 0 1-6 0Z"/>' +
      '<path d="M5 2.75H2.75v1a2.5 2.5 0 0 0 2.15 2.47M11 2.75h2.25v1a2.5 2.5 0 0 1-2.15 2.47"/>' +
      '<path d="M8 8.25v2.5"/>' +
      '<path d="M6.25 14.25c0-1.9.78-3.5 1.75-3.5s1.75 1.6 1.75 3.5Z"/>' +
      '<path d="M4.75 14.25h6.5"/>',
    'eye-closed':
      '<path d="M2 6.5c1.65 2.4 3.6 3.75 6 3.75s4.35-1.35 6-3.75"/>' +
      '<path d="M3.4 9.1 2.1 10.9M6.3 10.55 5.7 12.6M9.7 10.55l.6 2.05M12.6 9.1l1.3 1.8"/>',
    /* --- extras (safe for any page to use) --- */
    'chevron-down': '<path d="M4 6.25 8 10.25 12 6.25"/>',
    'chevron-right': '<path d="M6 3.5 10.5 8 6 12.5"/>',
    'pencil':
      '<path d="M11.9 2.1a1.55 1.55 0 0 1 2.2 2.2l-8 8-3 .8.8-3Z"/><path d="M10.4 3.6 12.6 5.8"/>',
    'trash':
      '<path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5"/>' +
      '<path d="M4.25 4.25l.6 9.1a1 1 0 0 0 1 .9h4.3a1 1 0 0 0 1-.9l.6-9.1"/>',
    'sign-out':
      '<path d="M6.25 2.75H3.25a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h3"/>' +
      '<path d="M10.5 5 13.5 8l-3 3M13.25 8H6"/>',
    'alert':
      '<path d="M8 2.25 14.5 13.5h-13Z"/><path d="M8 6.4v3M8 11.5v.01"/>',
    'info':
      '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4M8 4.75v.01"/>',
    'clock':
      '<circle cx="8" cy="8" r="6.25"/><path d="M8 4.25V8l2.5 1.75"/>',
    'pin':
      '<path d="M6 1.75h4l-.75 4 2.5 2.5v1.5H4.25V8.25l2.5-2.5Z"/><path d="M8 9.75v4.5"/>',
    'filter':
      '<path d="M1.75 3.25h12.5l-4.75 5.5v4.5l-3-1.75V8.75Z"/>',
    'download':
      '<path d="M8 2v8.25M4.75 7 8 10.25 11.25 7M2.75 13.25h10.5"/>',
    'copy':
      '<rect x="5.75" y="5.75" width="8.5" height="8.5" rx="1.5"/>' +
      '<path d="M3.5 10.25h-.25A1.5 1.5 0 0 1 1.75 8.75v-5.5a1.5 1.5 0 0 1 1.5-1.5h5.5a1.5 1.5 0 0 1 1.5 1.5v.25"/>',
    'mail':
      '<rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.5"/><path d="M2.25 4.5 8 8.75l5.75-4.25"/>',
    'shield':
      '<path d="M8 1.5 13.5 3.5v4.25c0 3.2-2.2 5.65-5.5 6.75-3.3-1.1-5.5-3.55-5.5-6.75V3.5Z"/>',
    'book':
      '<path d="M8 3.5S6.5 2.25 2.25 2.25v9.5C6.5 11.75 8 13 8 13s1.5-1.25 5.75-1.25v-9.5C9.5 2.25 8 3.5 8 3.5Z"/>' +
      '<path d="M8 3.5V13"/>',
    'code':
      '<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
    'bold':
      '<path d="M5 2.75h3.6a2.62 2.62 0 0 1 0 5.25H5Z"/><path d="M5 8h4.1a2.62 2.62 0 0 1 0 5.25H5Z"/>',
    'italic':
      '<path d="M10.75 2.75h-4M9.25 13.25h-4M9.5 2.75 6.5 13.25"/>',
    'quote':
      '<path d="M3.25 3.25v9.5M6.75 5.5h6.5M6.75 9.5h6.5"/>',
    'heading':
      '<path d="M4 2.75v10.5M12 2.75v10.5M4 8h8"/>',
    'list-unordered':
      '<path d="M5.75 4h8.5M5.75 8h8.5M5.75 12h8.5"/>' +
      '<circle cx="2.75" cy="4" r=".95"' + DOT + '/>' +
      '<circle cx="2.75" cy="8" r=".95"' + DOT + '/>' +
      '<circle cx="2.75" cy="12" r=".95"' + DOT + '/>',
    'list-ordered':
      '<path d="M5.75 4h8.5M5.75 8h8.5M5.75 12h8.5"/>' +
      '<path d="M1.6 2.9 2.6 2.4V5.5M1.5 7.2h1.9L1.5 9.6h2M1.5 10.6h2l-1.1 1.3a1 1 0 1 1-.7 1.7"/>',
    'three-bars':
      '<path d="M2 4h12M2 8h12M2 12h12"/>',
    'sort':
      '<path d="M4 3.5v9M1.75 10.25 4 12.5l2.25-2.25M12 12.5v-9M9.75 5.75 12 3.5l2.25 2.25"/>',
    /* --- v3 additions. Exactly three; everything else the v3 contract needs
       (mail, search, shield, comment-discussion, check-circle, trophy, copy)
       already existed. Same 16x16 outline grammar as everything above:
       stroke-only paths, currentColor, no fill unless DOT says so. --- */
    'lock':
      '<rect x="2.75" y="7" width="10.5" height="7.25" rx="1.6"/>' +
      '<path d="M5.25 7V4.9a2.75 2.75 0 0 1 5.5 0V7"/>' +
      '<circle cx="8" cy="10.6" r=".95"' + DOT + '/>',
    'star':
      '<path d="M8 1.75l1.93 3.91 4.32.63-3.13 3.05.74 4.3L8 11.61l-3.86 2.03' +
      '.74-4.3-3.13-3.05 4.32-.63Z"/>',
    'image':
      '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/>' +
      '<circle cx="5.6" cy="6.2" r="1.1"' + DOT + '/>' +
      '<path d="M2.25 11.75 6 8.25l2.4 2.2 2.35-2.35 2.9 2.9"/>',
    /* Two panes side by side — the live-preview toggle in the composer. */
    'columns':
      '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.75"/>' +
      '<path d="M8 2.75v10.5"/>'
  };

  function iconMarkup(name, className) {
    var body = ICONS[name];
    var cls = 'octicon octicon-' + String(name || 'blank').replace(/[^a-z0-9-]/gi, '') +
      (className ? ' ' + className : '');
    return '<svg class="' + cls + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"' +
      ' width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.55"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
      (body || '') + '</svg>';
  }

  function icon(name, className) {
    var host = document.createElement('div');
    host.innerHTML = iconMarkup(name, className);
    return stringable(host.firstChild);
  }

  /* ---------------------------------------------------------------------
     Avatars + pills
     ------------------------------------------------------------------ */

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) {
      var chars = Array.from(parts[0]);
      return (chars.length > 1 ? chars[0] + chars[1] : chars[0]).toUpperCase();
    }
    var a = Array.from(parts[0])[0] || '';
    var b = Array.from(parts[parts.length - 1])[0] || '';
    return (a + b).toUpperCase();
  }

  function isAnon(author) {
    if (!author) return false;
    if (author.user_id === 'anon' || author.id === 'anon') return true;
    if (author.is_anonymous === true || author.is_anonymous === 'TRUE') return true;
    return false;
  }

  function avatar(author, size) {
    author = author || {};
    var node = el('span', 'avatar');
    if (size) {
      node.style.setProperty('--av-size', typeof size === 'number' ? size + 'px' : String(size));
    }
    if (isAnon(author)) {
      node.className = 'avatar avatar-anon';
      node.title = 'Posted anonymously';
      node.appendChild(icon('eye-closed'));
    } else {
      var id = String(author.user_id || author.id || author.display_name || '?');
      var name = String(author.display_name || author.name || 'Unknown');
      node.style.setProperty('--av-h', String(hashHue(id)));
      node.textContent = initials(name);
      node.title = name;
    }
    node.setAttribute('aria-hidden', 'true');
    return stringable(node);
  }

  function pill(text, className) {
    var node = el('span', 'pill' + (className ? ' ' + className : ''), text);
    node.style.setProperty('--pill-h', String(hashHue(String(text || '').toLowerCase())));
    return stringable(node);
  }

  function pillCategory(text) {
    var node = el('span', 'pill pill-category', text);
    return stringable(node);
  }

  /* ---------------------------------------------------------------------
     Toasts
     ------------------------------------------------------------------ */

  function toastHost() {
    var host = document.getElementById('toasts');
    if (!host) {
      host = el('div');
      host.id = 'toasts';
      document.body.appendChild(host);
    }
    return host;
  }

  function toast(msg, type, ms) {
    if (!document.body) return null;
    var kind = type === 'error' || type === 'success' ? type : '';
    var node = el('div', 'toast' + (kind ? ' toast-' + kind : ''));
    node.setAttribute('role', kind === 'error' ? 'alert' : 'status');

    node.appendChild(icon(kind === 'error' ? 'alert' : kind === 'success' ? 'check-circle' : 'info',
      'toast-icon'));
    node.appendChild(el('div', 'toast-msg', msg === null || msg === undefined ? '' : msg));

    var close = el('button', 'toast-close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.appendChild(icon('x'));
    node.appendChild(close);

    var timer = null;
    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      node.classList.add('is-leaving');
      setTimeout(function () { if (node.parentNode) node.parentNode.removeChild(node); }, 160);
    }
    close.addEventListener('click', dismiss);
    toastHost().appendChild(node);
    timer = setTimeout(dismiss, typeof ms === 'number' ? ms : (kind === 'error' ? 6500 : 4000));
    return node;
  }

  /* ---------------------------------------------------------------------
     Confirm modal
     ------------------------------------------------------------------ */

  function confirmModal(message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var previous = document.activeElement;
      var backdrop = el('div', 'modal-backdrop');
      var modal = el('div', 'modal');
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-modal', 'true');

      var header = el('div', 'modal-header', opts.title || 'Are you sure?');
      var body = el('div', 'modal-body');
      body.appendChild(el('p', null, message === undefined ? '' : message));

      var footer = el('div', 'modal-footer');
      var cancel = el('button', 'btn', opts.cancelText || 'Cancel');
      cancel.type = 'button';
      var ok = el('button', 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary'),
        opts.confirmText || 'OK');
      ok.type = 'button';
      footer.appendChild(cancel);
      footer.appendChild(ok);

      modal.appendChild(header);
      modal.appendChild(body);
      modal.appendChild(footer);
      backdrop.appendChild(modal);

      var done = false;
      function finish(value) {
        if (done) return;
        done = true;
        document.removeEventListener('keydown', onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (previous && previous.focus) { try { previous.focus(); } catch (e) { /* ignore */ } }
        resolve(value);
      }
      function onKey(ev) {
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
        if (ev.key === 'Enter' && document.activeElement !== cancel) { ev.preventDefault(); finish(true); }
      }

      cancel.addEventListener('click', function () { finish(false); });
      ok.addEventListener('click', function () { finish(true); });
      backdrop.addEventListener('mousedown', function (ev) {
        if (ev.target === backdrop) finish(false);
      });
      document.addEventListener('keydown', onKey, true);

      document.body.appendChild(backdrop);
      try { ok.focus(); } catch (e) { /* ignore */ }
    });
  }

  /* ---------------------------------------------------------------------
     Config / session helpers
     ------------------------------------------------------------------ */

  function config() {
    return (Clinic && Clinic.config) || window.CLINIC_CONFIG || {};
  }

  function isMock() {
    var c = config();
    return !!(c.MOCK || c.mock);
  }

  function currentUser() {
    var u = lsJson(LS_USER);
    return u && typeof u === 'object' ? u : null;
  }

  function isInstructor() {
    var u = currentUser();
    return !!(u && String(u.role || '').toLowerCase() === 'instructor');
  }

  function cachedBootstrap() {
    var b = lsJson(LS_BOOTSTRAP);
    if (!b || typeof b !== 'object') return null;
    if (b.data && b.data.config) return b.data;   /* whole envelope was cached */
    return b;
  }

  function bootstrapConfig() {
    var b = cachedBootstrap();
    if (!b) return {};
    if (b.config && typeof b.config === 'object') return b.config;
    return b;
  }

  function siteTitle() {
    var t = bootstrapConfig().site_title;
    return t ? String(t) : 'MScPHMxAI Coding Clinic';
  }

  /* Compatibility shim over Clinic.api.
     The contract is Clinic.api.call(action, data) -> Promise<data>, but this
     also copes with call(endpoint, action, data) and with the convenience
     methods, and normalises {ok,data,error,code} envelopes / thrown errors. */
  /* action prefix -> flow endpoint (only used by the 3-arg fallback) */
  /* v3: mirrors api.js's endpointFor (site/assets/js/api.js) including the
     MSG_URL condition. The condition is NOT decoration — before wave 3 the
     config has no MSG_URL, api.js falls through to APP_URL, and this copy has
     to agree with it or the 3-arg fallback would post a messages.* action to a
     flow name that does not exist. */
  function endpointFor(action) {
    var prefix = String(action).split('.')[0];
    if (prefix === 'auth') return 'auth';
    if (prefix === 'admin') return 'admin';
    if ((prefix === 'messages' || prefix === 'attach') && config().MSG_URL) return 'msg';
    return 'app';
  }

  function apiCall(action, data) {
    var api = Clinic.api;
    if (!api) return Promise.reject({ code: 'network', message: 'API is not loaded' });

    var attempt;
    try {
      if (typeof api.call === 'function') {
        attempt = api.call.length >= 3
          ? api.call(endpointFor(action), action, data || {})
          : api.call(action, data || {});
      } else {
        var camel = String(action).split('.').slice(1).join('_')
          .replace(/_([a-z])/g, function (m, c) { return c.toUpperCase(); });
        if (typeof api[camel] === 'function') attempt = api[camel](data || {});
        else return Promise.reject({ code: 'network', message: 'Unsupported action: ' + action });
      }
    } catch (e) {
      return Promise.reject(normaliseError(e));
    }

    return Promise.resolve(attempt).then(function (res) {
      if (res && typeof res === 'object' && 'ok' in res) {
        if (res.ok === false) throw normaliseError(res);
        return res.data === undefined ? res : res.data;
      }
      return res;
    }, function (err) { throw normaliseError(err); });
  }

  function normaliseError(e) {
    if (!e) return { code: '', message: 'Something went wrong' };
    if (typeof e === 'string') return { code: '', message: e };
    return {
      code: e.code || e.error_code || '',
      message: e.message || e.error || 'Something went wrong',
      raw: e
    };
  }

  /* ---------------------------------------------------------------------
     Header
     ------------------------------------------------------------------ */

  /* TABS entries carry three pieces of mutable state that setNavBadge() and
     setTabVisible() write and renderHeader() reads:
       hidden : true  -> not rendered at all
       count  : N     -> a .counter.nav-counter and ", N unread" on aria-label
     They live on the entry, NOT in the DOM, because renderHeader() does
     host.innerHTML = '' and runs at least twice on every page load (once from
     the DOMContentLoaded safety net, once from the page script). A badge
     patched only into the DOM disappears on the second render, and which
     render wins depends on load timing — a genuinely horrible bug to chase. */
  var TABS = [
    {
      key: 'discussions', label: 'Discussions', href: 'index.html',
      icon: 'comment-discussion',
      match: ['discussions', 'index', 'index.html', 'thread', 'thread.html', 'new', 'new.html', '']
    },
    {
      key: 'search', label: 'Search', href: 'search.html',
      icon: 'search',
      match: ['search', 'search.html']
    },
    {
      /* ships hidden. unread.js reveals it with setTabVisible('messages',true)
         only after messages.unread has actually answered, so a backend that
         has not been imported yet shows no dead nav entry. */
      key: 'messages', label: 'Messages', href: 'messages.html',
      icon: 'mail', hidden: true,
      match: ['messages', 'messages.html']
    },
    {
      key: 'booking', label: 'Clinic booking', href: 'booking.html',
      icon: 'calendar',
      match: ['booking', 'booking.html', 'clinic', 'clinic booking', 'slots']
    },
    {
      key: 'admin', label: 'Admin', href: 'admin.html',
      icon: 'gear', instructorOnly: true,
      match: ['admin', 'admin.html', 'dashboard']
    }
  ];

  function tabByKey(key) {
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === key) return TABS[i];
    return null;
  }

  var lastActive = null;

  function pageKey() {
    var file = String(location.pathname || '').split('/').pop().toLowerCase();
    return file || 'index.html';
  }

  function resolveActive(active) {
    var want = String(active === undefined || active === null ? pageKey() : active)
      .toLowerCase().replace(/^\.\//, '').split('?')[0].split('#')[0].trim();
    for (var i = 0; i < TABS.length; i++) {
      var t = TABS[i];
      if (t.key === want || t.label.toLowerCase() === want) return t.key;
      if (t.match.indexOf(want) !== -1) return t.key;
    }
    return null;
  }

  function brandMark() {
    var host = el('span', 'brand-mark');
    host.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="26" height="26"' +
      ' aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M1.25 3A1.75 1.75 0 0 1 3 1.25h10A1.75 1.75 0 0 1 14.75 3v7A1.75 1.75 0 0 1 13 11.75H7.5L4 14.75V11.75H3A1.75 1.75 0 0 1 1.25 10Z"/>' +
      '<path fill="none" stroke="var(--bg-header)" stroke-width="1.4" stroke-linecap="round"' +
      ' stroke-linejoin="round" d="M6.25 5.5 4.25 7.5l2 2M9.75 5.5l2 2-2 2"/>' +
      '</svg>';
    return host;
  }

  var themeToggleRef = null;

  function refreshThemeToggle() {
    if (!themeToggleRef) return;
    var dark = getTheme() === 'dark';
    themeToggleRef.innerHTML = '';
    themeToggleRef.appendChild(icon(dark ? 'sun' : 'moon'));
    themeToggleRef.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
    themeToggleRef.setAttribute('aria-label', themeToggleRef.title);
  }

  function makeThemeToggle() {
    var btn = el('button', 'theme-toggle');
    btn.type = 'button';
    btn.addEventListener('click', toggleTheme);
    themeToggleRef = btn;
    refreshThemeToggle();
    return btn;
  }

  /* login.html (and anything else without the full header) can reuse this */
  function mountThemeToggle(container) {
    if (!container) return null;
    var btn = makeThemeToggle();
    container.appendChild(btn);
    return btn;
  }

  /* The "?" that replays a walkthrough. tour.js owns the menu and every
     behaviour behind it; this is only the affordance, and it returns null
     when tour.js is absent so a page that never loads it gets a header with
     no dead button in it (same rule as the Messages tab in TABS). */
  function makeTourButton() {
    var t = window.Clinic && Clinic.tour;
    if (!t || typeof t.available !== 'function' || !t.available()) return null;

    var wrap = el('div', 'tour-help-wrap');
    var btn = el('button', 'tour-help', '?');
    btn.id = 'tour-help';
    btn.type = 'button';
    btn.title = 'Replay a walkthrough';
    btn.setAttribute('aria-label', 'Replay a walkthrough');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (Clinic.tour && Clinic.tour.toggleMenu) Clinic.tour.toggleMenu();
    });
    wrap.appendChild(btn);
    return wrap;
  }

  /* =========================================================================
     WAITING, SAID OUT LOUD
     -------------------------------------------------------------------------
     Every backend call on this site takes 10-21 s, because every one of them is
     an Excel Online round trip. That is not going to change from this end. What
     it does mean is that "nothing is moving" is the DEFAULT state of the page
     for most of a normal interaction, and a page where nothing moves is read as
     a page that is broken — which is exactly the misreading that produced this
     release ("did my post go through?").

     So there is one vocabulary for waiting, in three sizes, and every page uses
     it instead of inventing its own:

       netBar()            the site-wide thread. One 2px bar under the header
                           that moves whenever ANY request is in flight, driven
                           off api.js's 'clinic:activity'. Mounted once, by the
                           header. Nothing has to opt in.
       busy(btn, label)    the local one. Swaps a button's contents for a
                           spinner and a verb, disables it, and returns the
                           function that puts it back. Every submit button on
                           the site is meant to go through this, so "Posting…"
                           can never again be a word with nothing moving beside
                           it.
       skeleton(kind, n)   the first-paint one. Grey rows shaped like the thing
                           that is coming, instead of a lone spinner in the
                           middle of an empty page.

     All three respect prefers-reduced-motion through main.css §15 — the
     animations slow and stop moving, the INFORMATION never disappears.
     ====================================================================== */

  function spinner(extraClass) {
    return el('span', 'spinner' + (extraClass ? ' ' + extraClass : ''));
  }

  /* Returns restore(). Calling it twice is harmless. `busy()` on a button that
     is already busy is a no-op that returns the ORIGINAL restore, so a
     double-clicked submit cannot lose the button's real label. */
  function busy(btn, label) {
    if (!btn) return function () {};
    if (btn.__clinicRestore) return btn.__clinicRestore;

    var kids = [], i;
    for (i = 0; i < btn.childNodes.length; i++) kids.push(btn.childNodes[i]);
    var wasDisabled = !!btn.disabled;
    var hadBusyAttr = btn.getAttribute('aria-busy');

    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(spinner('spinner-inline'));
    btn.appendChild(el('span', null, label || 'Working…'));
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');

    function restore() {
      if (btn.__clinicRestore !== restore) return;
      btn.__clinicRestore = null;
      while (btn.firstChild) btn.removeChild(btn.firstChild);
      for (var k = 0; k < kids.length; k++) btn.appendChild(kids[k]);
      btn.disabled = wasDisabled;
      if (hadBusyAttr === null) btn.removeAttribute('aria-busy');
      else btn.setAttribute('aria-busy', hadBusyAttr);
    }
    btn.__clinicRestore = restore;
    return restore;
  }

  /* 'thread' | 'comment' | 'row' | 'line'. Shaped like what is loading rather
     than generic, because the shape is half of what tells someone the page is
     working and not blank. */
  function skeleton(kind, count) {
    var host = el('div', 'skeleton-set');
    host.setAttribute('aria-hidden', 'true');       /* the live region says it */
    var n = Math.max(1, count || 3), i;
    for (i = 0; i < n; i++) {
      var row = el('div', 'skeleton-row skeleton-' + (kind || 'row'));
      row.appendChild(el('span', 'skeleton-bar skeleton-bar-title'));
      row.appendChild(el('span', 'skeleton-bar skeleton-bar-meta'));
      if (kind === 'thread' || kind === 'comment') {
        row.appendChild(el('span', 'skeleton-bar skeleton-bar-body'));
      }
      host.appendChild(row);
    }
    return host;
  }

  /* A skeleton with a polite live region above it, for the case where the
     region being filled is the whole point of the page. */
  function loadingBlock(message, kind, count) {
    var box = el('div', 'loading-block');
    var say = el('p', 'loading-block-msg');
    say.setAttribute('role', 'status');
    say.appendChild(spinner('spinner-inline'));
    say.appendChild(el('span', null, message || 'Loading…'));
    box.appendChild(say);
    box.appendChild(skeleton(kind, count));
    return box;
  }

  /* ---- the site-wide bar -------------------------------------------------
     One node, created on first use and never removed. It is deliberately NOT a
     percentage: we cannot know how far through a 10-21 s Excel call we are, and
     a bar that claims 80% and then sits there is a worse lie than one that only
     claims "still going". A 220 ms grace period keeps a fast mock call or a
     cache hit from producing a flicker. */
  var netBarEl = null;
  var netBarTimer = null;

  function ensureNetBar() {
    if (netBarEl && netBarEl.parentNode) return netBarEl;
    if (!document.body) return null;
    netBarEl = el('div', 'net-bar');
    netBarEl.setAttribute('aria-hidden', 'true');
    netBarEl.appendChild(el('span', 'net-bar-fill'));
    document.body.appendChild(netBarEl);
    return netBarEl;
  }

  function setNetBar(on) {
    var bar = ensureNetBar();
    if (!bar) return;
    if (netBarTimer) { window.clearTimeout(netBarTimer); netBarTimer = null; }
    if (on) {
      netBarTimer = window.setTimeout(function () {
        netBarTimer = null;
        if (netBarEl) netBarEl.classList.add('is-active');
      }, 220);
    } else if (netBarEl) {
      netBarEl.classList.remove('is-active');
    }
  }

  var netBarWired = false;
  function mountNetBar() {
    if (netBarWired) return;
    netBarWired = true;
    window.addEventListener('clinic:activity', function (ev) {
      var n = (ev && ev.detail && Number(ev.detail.active)) || 0;
      setNetBar(n > 0);
    });
    /* A call may already be in flight by the time the header renders. */
    try {
      var api = Clinic.api;
      if (api && typeof api.activeCallCount === 'function' && api.activeCallCount() > 0) {
        setNetBar(true);
      }
    } catch (e) { /* api.js not loaded on this page */ }
  }

  function mockSwitchUser(persona) {
    var mock = Clinic.mock;
    var fn = null;
    if (mock) {
      if (typeof mock.switchUser === 'function') fn = mock.switchUser;
      else if (typeof mock.setUser === 'function') fn = mock.setUser;
      else if (typeof mock.switchPersona === 'function') fn = mock.switchPersona;
      else if (typeof mock.become === 'function') fn = mock.become;
    }
    if (!fn) { toast('Mock user switching is not available.', 'error'); return; }
    try {
      fn.call(mock, persona);
    } catch (e) {
      toast('Could not switch mock user.', 'error');
      return;
    }
    location.reload();
  }

  function editDisplayName() {
    var user = currentUser() || {};
    var next = window.prompt(
      'Display name — this is what classmates see.', user.display_name || '');
    if (next === null) return;
    next = next.trim();
    if (!next) { toast('Display name cannot be empty.', 'error'); return; }
    if (next === user.display_name) return;

    apiCall('profile.update', { display_name: next }).then(function (data) {
      var updated = (data && data.user) || Object.assign({}, user, { display_name: next });
      lsSet(LS_USER, JSON.stringify(updated));
      toast('Display name updated.', 'success');
      renderHeader(lastActive);
      try {
        document.dispatchEvent(new CustomEvent('clinic:userchange', { detail: { user: updated } }));
      } catch (e) { /* ignore */ }
    }, function (err) {
      toast(normaliseError(err).message || 'Could not update your display name.', 'error');
    });
  }

  function logout() {
    var api = Clinic.api;
    try {
      if (api && typeof api.logout === 'function') { api.logout(); return; }
    } catch (e) { /* fall through */ }
    try {
      window.localStorage.removeItem(LS_TOKEN);
      window.localStorage.removeItem(LS_USER);
    } catch (e) { /* ignore */ }
    location.href = 'login.html';
  }

  function buildUserMenu() {
    var user = currentUser();
    var wrap = el('div', 'user-menu');

    if (!user) {
      var signIn = el('a', 'btn btn-sm', 'Sign in');
      signIn.href = 'login.html?next=' + encodeURIComponent(pageKey() + location.search);
      wrap.appendChild(signIn);
      return wrap;
    }

    var btn = el('button', 'user-menu-btn');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    /* The button has to carry its OWN accessible name, because at ≤479px it has
       nothing else: the avatar is aria-hidden (see avatar()), .user-menu-name is
       display:none, and the caret is an empty <span>. Without this the only
       route to Sign out announced as "button, collapsed" and nothing more — on
       exactly the screens where it is already hardest to find. */
    btn.setAttribute('aria-label',
      'Account menu' + (user.display_name ? ' — ' + user.display_name : ''));
    btn.appendChild(avatar(user, 20));
    btn.appendChild(el('span', 'user-menu-name', user.display_name || 'Account'));
    btn.appendChild(el('span', 'user-menu-caret'));

    var menu = el('div', 'menu-dropdown');
    menu.hidden = true;

    var head = el('div', 'menu-header');
    head.appendChild(el('strong', null, user.display_name || 'Signed in'));
    head.appendChild(document.createTextNode(
      (user.role === 'instructor' ? 'Instructor' : 'Student') +
      (user.email ? ' · ' + user.email : '')));
    menu.appendChild(head);

    var profileLink = el('a', 'menu-item', 'Profile');
    profileLink.href = 'profile.html';
    profileLink.insertBefore(icon('person'), profileLink.firstChild);
    profileLink.addEventListener('click', function () { closeMenu(); });
    menu.appendChild(profileLink);

    var edit = el('button', 'menu-item', 'Edit display name');
    edit.type = 'button';
    edit.insertBefore(icon('pencil'), edit.firstChild);
    edit.addEventListener('click', function () { closeMenu(); editDisplayName(); });
    menu.appendChild(edit);

    if (isMock()) {
      menu.appendChild(el('div', 'menu-sep'));
      menu.appendChild(el('div', 'menu-note', 'Mock user (demo mode)'));
      [['student', 'Student'], ['instructor', 'Instructor']].forEach(function (p) {
        var item = el('button', 'menu-item' +
          (String(user.role || 'student') === p[0] ? ' is-current' : ''), p[1]);
        item.type = 'button';
        item.insertBefore(icon(p[0] === 'instructor' ? 'shield' : 'person'), item.firstChild);
        item.addEventListener('click', function () { closeMenu(); mockSwitchUser(p[0]); });
        menu.appendChild(item);
      });
    }

    menu.appendChild(el('div', 'menu-sep'));
    var out = el('button', 'menu-item', 'Sign out');
    out.type = 'button';
    out.insertBefore(icon('sign-out'), out.firstChild);
    out.addEventListener('click', function () { closeMenu(); logout(); });
    menu.appendChild(out);

    function openMenu() {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onEsc, true);
    }
    function closeMenu() {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onEsc, true);
    }
    function onDocClick(ev) { if (!wrap.contains(ev.target)) closeMenu(); }
    function onEsc(ev) { if (ev.key === 'Escape') { closeMenu(); btn.focus(); } }

    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (menu.hidden) openMenu(); else closeMenu();
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  /* Writes (or clears) the unread affordance on one nav anchor.
     The counter is aria-hidden and the accessible name lives on the anchor —
     otherwise a screen reader reads "Messages 3", and at ≤479px, where the
     label is clipped away, it would read just "3". */
  function applyTabBadge(anchor, tab) {
    if (!anchor) return;
    var n = Number(tab && tab.count);
    if (!isFinite(n) || n < 0) n = 0;
    n = Math.floor(n);

    var span = anchor.querySelector('.nav-counter');
    if (n > 0) {
      if (!span) {
        span = el('span', 'counter nav-counter');
        span.setAttribute('aria-hidden', 'true');
        anchor.appendChild(span);
      }
      span.textContent = n > 99 ? '99+' : String(n);
      anchor.setAttribute('aria-label', tab.label + ', ' + n + ' unread');
    } else {
      if (span && span.parentNode) span.parentNode.removeChild(span);
      anchor.setAttribute('aria-label', tab.label);
    }
  }

  function navAnchor(tabKey) {
    var host = document.getElementById('app-header');
    if (!host) return null;
    return host.querySelector('.app-nav a[data-tab="' + tabKey + '"]');
  }

  /* Stash first, patch second. See the comment on TABS for why the stash is
     the load-bearing half. */
  function setNavBadge(tabKey, count) {
    var tab = tabByKey(tabKey);
    if (!tab) return;
    tab.count = Number(count) || 0;

    var anchor = navAnchor(tabKey);
    if (anchor) applyTabBadge(anchor, tab);
    else renderHeader(lastActive);
  }

  function setTabVisible(tabKey, visible) {
    var tab = tabByKey(tabKey);
    if (!tab) return;
    var next = !visible;
    if (tab.hidden === next) return;      /* no pointless re-render */
    tab.hidden = next;
    renderHeader(lastActive);
  }

  function renderHeader(active) {
    var host = document.getElementById('app-header');
    if (!host) return null;
    lastActive = active === undefined ? lastActive : active;

    /* Every page with a header gets the activity bar, without asking for it. */
    mountNetBar();

    var activeKey = resolveActive(lastActive);
    host.classList.add('app-header');
    host.innerHTML = '';

    var inner = el('div', 'app-header-inner');

    var brand = el('a', 'brand');
    brand.href = 'index.html';
    brand.appendChild(brandMark());
    brand.appendChild(el('span', 'brand-title', siteTitle()));
    inner.appendChild(brand);

    var nav = el('nav', 'app-nav');
    nav.setAttribute('aria-label', 'Primary');
    TABS.forEach(function (tab) {
      if (tab.instructorOnly && !isInstructor()) return;
      /* A hidden tab is still drawn when it IS the current page: landing on
         messages.html with the feature switched off should give you a nav with
         a highlighted current item and an inert page, not a nav that silently
         disagrees with the address bar. */
      if (tab.hidden && tab.key !== activeKey) return;

      var a = el('a', 'app-nav-item' + (tab.key === activeKey ? ' active' : ''));
      a.href = tab.href;
      a.setAttribute('data-tab', tab.key);
      a.appendChild(icon(tab.icon));
      a.appendChild(el('span', 'app-nav-label', tab.label));
      applyTabBadge(a, tab);
      if (tab.key === activeKey) a.setAttribute('aria-current', 'page');
      nav.appendChild(a);
    });
    inner.appendChild(nav);

    var actions = el('div', 'header-actions');
    if (isMock()) {
      var demo = el('span', 'badge', 'Demo data');
      demo.title = 'MOCK mode: no backend, data is seeded in the browser';
      actions.appendChild(demo);
    }
    var tourBtn = makeTourButton();
    if (tourBtn) actions.appendChild(tourBtn);
    actions.appendChild(makeThemeToggle());
    actions.appendChild(buildUserMenu());
    inner.appendChild(actions);

    host.appendChild(inner);
    return host;
  }

  /* ---------------------------------------------------------------------
     Sidebar shell
     ------------------------------------------------------------------ */

  function renderSidebarShell() {
    var placeholder = document.getElementById('app-sidebar');
    if (placeholder) {
      placeholder.classList.add('sidebar');
      return placeholder;
    }
    var layout = document.querySelector('.layout') || document.body;
    var existing = layout.querySelector('.sidebar') || document.querySelector('.sidebar');
    if (existing) return existing;

    var side = el('aside', 'sidebar');
    var main = layout.querySelector('.main');
    if (main && main.parentNode === layout) layout.insertBefore(side, main);
    else layout.appendChild(side);
    return side;
  }

  /* ---------------------------------------------------------------------
     v3 shared helpers (contract §10.6). NOBODY re-implements any of these —
     seven owners emitting seven slightly different answers to "is this the
     instructor?" or "is this wire boolean true?" is exactly how a badge ends
     up on the wrong post.
     ------------------------------------------------------------------ */

  /* The ONE normaliser for mixed-type wire booleans. Excel hands back TRUE,
     'TRUE', 'true', 1 and '1' for the same column depending on how the cell
     was written, and gotcha 16 says it will keep doing so. */
  function truthy(v) {
    if (v === true || v === 1) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1';
  }

  function instructorIds() {
    var ids = bootstrapConfig().instructor_ids;
    return Object.prototype.toString.call(ids) === '[object Array]' ? ids : [];
  }

  function instructorUserId() {
    return bootstrapConfig().instructor_user_id || '';
  }

  /* An anonymous post is never badged, whoever wrote it — that is the whole
     point of anonymity, and the instructor posting anonymously is a real case
     (§5.6). Absent config means an empty list means no badge ANYWHERE, which
     is the correct degradation: never a wrong badge. */
  function isInstructorAuthor(author) {
    if (!author) return false;
    var id = author.user_id;
    if (!id || id === 'anon') return false;
    return instructorIds().indexOf(id) !== -1;
  }

  /* Feature registry. sessionStorage, not localStorage: "the backend does not
     support this yet" is true for a session, and a stale 'off' surviving a
     re-import for weeks would be worse than one probe per session. */
  var FEATURES_KEY = 'clinic_features';

  function featuresRead() {
    try {
      var raw = window.sessionStorage.getItem(FEATURES_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      return obj && typeof obj === 'object' ? obj : {};
    } catch (e) { return {}; }
  }

  function featuresWrite(name, state) {
    var all = featuresRead();
    all[String(name)] = state;
    try {
      window.sessionStorage.setItem(FEATURES_KEY, JSON.stringify(all));
    } catch (e) { /* private mode: the registry degrades to per-page-load */ }
  }

  function featureOn(name) { featuresWrite(name, 'on'); }
  function featureOff(name) { featuresWrite(name, 'off'); }

  function featureState(name) {
    var v = featuresRead()[String(name)];
    return v === 'on' || v === 'off' ? v : 'unknown';
  }

  /* FEATURE-ABSENT detector. The app flow's Switch default, the mock dispatcher
     and admin.moderate's op Switch default all return code 'bad_request' with
     some form of "unknown ... action" in the sentence; matching on that pair is
     what lets every owner call a new action once and then go quiet instead of
     retrying into a flow that will never know it.

     THIS USED TO BE PINNED TO /unknown action/i AND WAS WRONG. The live admin
     flow says "Unknown moderation action." — a word in the MIDDLE — so this
     returned false for every admin.* op and any owner who followed §10.6 would
     have retried a not-yet-imported flow forever. api.js's detector already
     handled all three wordings, so:
       1. delegate to api.js when it is loaded (single source of truth), and
       2. keep a local regex with the same shape for the case where ui.js is
          used without api.js (it must never widen or narrow relative to it).
     Both detectors must keep agreeing. If you change one, change the other. */
  var RE_UNKNOWN_ACTION = /unknown\s+(?:[a-z]+\s+)?(?:action|op|operation)\b/i;

  function isUnknownAction(err) {
    var api = window.Clinic && window.Clinic.api;
    if (api && typeof api.isUnknownAction === 'function') {
      try { return !!api.isUnknownAction(err); } catch (e) { /* fall through */ }
    }
    return !!(err && err.code === 'bad_request' &&
      RE_UNKNOWN_ACTION.test(err.message || err.error || ''));
  }

  /* ---------------------------------------------------------------------
     Exports
     ------------------------------------------------------------------ */

  ui.esc = esc;
  ui.relTime = relTime;
  ui.fmtDate = fmtDate;
  ui.fmtDayDate = fmtDayDate;
  ui.fmtTime = fmtTime;
  ui.fmtDateTime = fmtDateTime;
  ui.parseIso = parseIso;
  ui.sgParts = sgParts;
  ui.SGT_OFFSET_MS = SGT_OFFSET_MS;

  ui.icon = icon;
  ui.iconEl = icon;
  ui.iconMarkup = iconMarkup;
  ui.iconNames = Object.keys(ICONS);
  ui.avatar = avatar;
  ui.pill = pill;
  ui.pillCategory = pillCategory;
  ui.initials = initials;
  ui.hashHue = hashHue;

  ui.toast = toast;
  ui.confirmModal = confirmModal;

  ui.renderHeader = renderHeader;
  ui.renderSidebarShell = renderSidebarShell;
  ui.mountThemeToggle = mountThemeToggle;

  /* The one waiting vocabulary — see the long note above spinner(). */
  ui.spinner = spinner;
  ui.busy = busy;
  ui.skeleton = skeleton;
  ui.loadingBlock = loadingBlock;
  ui.mountNetBar = mountNetBar;

  ui.getTheme = getTheme;
  ui.setTheme = setTheme;
  ui.toggleTheme = toggleTheme;

  ui.config = config;
  ui.isMock = isMock;
  ui.currentUser = currentUser;
  ui.isInstructor = isInstructor;
  ui.cachedBootstrap = cachedBootstrap;
  ui.bootstrapConfig = bootstrapConfig;
  ui.siteTitle = siteTitle;
  ui.apiCall = apiCall;
  ui.normaliseError = normaliseError;
  ui.editDisplayName = editDisplayName;
  ui.logout = logout;

  /* --- v3 (contract §10.6) --- */
  ui.setNavBadge = setNavBadge;
  ui.setTabVisible = setTabVisible;
  ui.truthy = truthy;
  ui.instructorIds = instructorIds;
  ui.instructorUserId = instructorUserId;
  ui.isInstructorAuthor = isInstructorAuthor;
  ui.featureOn = featureOn;
  ui.featureOff = featureOff;
  ui.featureState = featureState;
  ui.isUnknownAction = isUnknownAction;
  ui.endpointFor = endpointFor;

  /* Safety net: if a page forgets to call renderHeader(), still draw the
     chrome (with the tab auto-detected from the URL). Page scripts load
     after ui.js, so an explicit later call simply re-renders. */
  document.addEventListener('DOMContentLoaded', function () {
    var host = document.getElementById('app-header');
    if (host && !host.firstChild) renderHeader();
  });
})();
