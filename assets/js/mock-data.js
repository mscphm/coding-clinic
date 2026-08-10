/*!
 * MScPHMxAI Coding Clinic - mock-data.js
 * A complete in-browser implementation of the API contract (SPEC.md §5) so the
 * whole site can be demonstrated with MOCK:true and no backend at all.
 *
 *   Clinic.mock.handle(action, data, token) -> Promise   (600-1200 ms fake latency)
 *   Clinic.mock.reset()                                  wipe + reseed + reload
 *   Clinic.mock.switchUser('student'|'instructor')       swap the signed-in persona
 *   Clinic.mock.signOut()                                drop the current session
 *   Clinic.mock.personas()                               [{key, user_id, display_name, email, role}]
 *   Clinic.mock.hint()                                   one-line sign-in hint for login.html
 *   Clinic.mock.state()                                  the raw seeded tables (debugging)
 *
 *   v3 timing controls - see "the two mock-only behaviours" below:
 *   Clinic.mock.setLatency(ms | null)                    null = back to 600-1200 ms
 *   Clinic.mock.setWriteLag(ms)                          0 = a sent DM is readable at once
 *   Clinic.mock.timing()                                 {latency_ms, write_lag_ms}
 *   Clinic.mock.fast()                                   latency 80 ms, no write lag
 *   Clinic.mock.realistic()                              back to the defaults
 *
 * This file must not touch Clinic.api - it loads before it. All state is built
 * lazily on the first handle() call and persisted to localStorage.
 *
 * Everything dated is computed from the real clock at seed time, so the clinic is
 * always "this coming Thursday" and posts are always "2 days ago". When the clinic
 * date rolls past, the seed is rebuilt automatically (see anchorFor / init).
 *
 * ---------------------------------------------------------------------------
 * THE TWO MOCK-ONLY BEHAVIOURS, AND WHY THEY ARE NOT AN ANNOYANCE
 *
 * The real backend is Excel behind Power Automate. Two of its properties shape
 * every screen in this app, and if the mock hides them then the code that copes
 * with them is written blind and ships untested:
 *
 *   1. EVERY CALL IS SLOW. A real action takes 10-21 SECONDS. The mock used to
 *      answer in 80 ms, which is why "just fetch it again" felt free while writing
 *      v2. The mock now takes 600-1200 ms - still 10-20x faster than reality, but
 *      slow enough that a missing spinner, a double-fetch, or a button you can
 *      press twice is visible rather than theoretical.
 *
 *   2. A WRITE IS NOT READABLE FOR ~30 SECONDS. Excel's connector does not make a
 *      row you just added visible to the next GetItems. So a DM you just sent will
 *      NOT come back from messages.get on the next poll - the UI has to carry it
 *      optimistically until the server catches up (contract §10.7). The mock
 *      compresses that to MOCK_WRITE_LAG_MS = 4000: messages.send inserts the row
 *      immediately, and messages.get pretends it is not there for 4 seconds. The
 *      client_msg_id de-duplication index is lagged by exactly the same amount,
 *      because otherwise the mock would be STRICTER than the real flow and the 45 s
 *      retry suppression - the thing that actually stops a double-post - would
 *      never be exercised.
 *
 * Both are switchable, because a demo in front of a room is not a test run:
 *   Clinic.mock.fast()        - 80 ms, no lag. For showing the site to someone.
 *   Clinic.mock.realistic()   - the defaults. For building and testing against.
 * The setting is remembered across reloads (localStorage 'clinic_mock_timing').
 * ---------------------------------------------------------------------------
 */
(function (window) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var STATE_KEY = 'clinic_mock_state';
  /* Bumping this forces every demo browser to throw its saved state away and reseed
     on the next call - which is the only way the new tables and columns below can
     appear in a browser that already has v2 data sitting in localStorage. */
  var STATE_VERSION = 4;  /* v4: clinic_mode + clinic_join_url config rows.
                             Bumped rather than back-filled: without it, every
                             browser that has already run the v3 demo keeps a
                             saved config with no clinic_mode key, so
                             hasLocationConfig() reads false and the admin page
                             shows the "not migrated yet" note forever — the
                             feature would be invisible to exactly the people
                             who have been using the demo longest.
                             v3 was: messages, attachments, endorsement, lock,
                             duplicate. */
  var TIMING_KEY = 'clinic_mock_timing';
  var LATENCY_MIN_MS = 600;                  /* see the header block: the real */
  var LATENCY_MAX_MS = 1200;                 /* backend takes 10-21 SECONDS */
  var MOCK_WRITE_LAG_MS = 4000;              /* miniature of the real ~30 s lag */
  var SGT_MS = 8 * 3600 * 1000;              /* Asia/Singapore, UTC+8, no DST */
  var DAY_MS = 86400000;

  /* Chat message body cap, enforced client-side AND flow-side in the real system
     (contract §3.2 tbl_Messages.body_md). Mirrored here so a builder finds the
     limit in MOCK rather than in the tenant. */
  var MSG_MAX_CHARS = 4000;

  var DOW = {
    Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3,
    Thursday: 4, Friday: 5, Saturday: 6
  };

  /* ================================================================ storage */

  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  function lsDel(k) { try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ } }
  function readJSON(k) {
    var raw = lsGet(k);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  }

  /* ================================================================= timing */
  /* Kept OUTSIDE the seeded state on purpose: it is a property of this browser
     session's demo, not of the data, so Clinic.mock.reset() must not silently put
     the lag back while somebody is mid-demo. */

  var timing = null;

  function timingRead() {
    if (timing) return timing;
    var saved = readJSON(TIMING_KEY);
    timing = {
      latency_ms: (saved && typeof saved.latency_ms === 'number') ? saved.latency_ms : null,
      write_lag_ms: (saved && typeof saved.write_lag_ms === 'number')
        ? saved.write_lag_ms : MOCK_WRITE_LAG_MS
    };
    return timing;
  }
  function timingWrite() {
    try { lsSet(TIMING_KEY, JSON.stringify(timingRead())); } catch (e) { /* ignore */ }
  }
  /* null latency means "vary it", which is what the real thing does - a fixed
     number lets a builder accidentally depend on calls returning in call order. */
  function latencyMs() {
    var t = timingRead();
    if (t.latency_ms !== null) return t.latency_ms;
    return LATENCY_MIN_MS + Math.floor(Math.random() * (LATENCY_MAX_MS - LATENCY_MIN_MS + 1));
  }
  function writeLagMs() { return timingRead().write_lag_ms; }

  /* ================================================================== utils */

  function L() { return Array.prototype.join.call(arguments, '\n'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function find(list, key, value) {
    for (var i = 0; i < list.length; i++) if (list[i][key] === value) return list[i];
    return null;
  }
  function where(list, fn) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (fn(list[i], i)) out.push(list[i]);
    return out;
  }
  function countWhere(list, fn) {
    var n = 0;
    for (var i = 0; i < list.length; i++) if (fn(list[i])) n++;
    return n;
  }
  function removeWhere(list, fn) {
    for (var i = list.length - 1; i >= 0; i--) if (fn(list[i])) list.splice(i, 1);
  }

  var idSeq = 0;
  function nid(prefix) {
    idSeq += 1;
    return prefix + '_' + Date.now().toString(36) + idSeq.toString(36);
  }

  function str(v) { return (v === null || v === undefined) ? '' : String(v); }
  function trimmed(v) { return str(v).replace(/^\s+|\s+$/g, ''); }

  function fail(code, message) {
    throw { code: code, message: message };
  }

  /* ============================================================ time (SGT) */

  function sgt(d) { return new Date(d.getTime() + SGT_MS); }
  function nowMs() { return Date.now(); }
  function isoAt(ms) { return new Date(ms).toISOString(); }
  function isoAgo(ms) { return isoAt(nowMs() - ms); }
  function hoursAgo(h) { return isoAgo(h * 3600000); }
  function daysAgo(d) { return isoAgo(d * DAY_MS); }

  function sgtDateStr(d) {
    var s = sgt(d);
    return s.getUTCFullYear() + '-' + pad2(s.getUTCMonth() + 1) + '-' + pad2(s.getUTCDate());
  }
  function dateStrDow(dateStr) {
    var p = dateStr.split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay();
  }
  function addDaysStr(dateStr, n) {
    var p = dateStr.split('-');
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]) + n * DAY_MS);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  /* SGT wall-clock (date + HH:MM) -> ISO 8601 UTC, the format every table uses. */
  function isoFromSgt(dateStr, timeStr) {
    var dp = dateStr.split('-');
    var tp = str(timeStr || '00:00').split(':');
    return isoAt(Date.UTC(+dp[0], +dp[1] - 1, +dp[2], +tp[0] || 0, +tp[1] || 0, 0) - SGT_MS);
  }
  function toMin(hhmm) {
    var p = str(hhmm).split(':');
    return (+p[0] || 0) * 60 + (+p[1] || 0);
  }
  function fromMin(m) { return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60); }

  function monthStartMs() {
    var s = sgt(new Date());
    return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1, 0, 0, 0) - SGT_MS;
  }
  function todayStartMs() {
    return Date.parse(isoFromSgt(sgtDateStr(new Date()), '00:00'));
  }

  /* The next cutoff instant strictly in the future. */
  function nextCutoffIso(cfgObj) {
    var dayName = cfgObj.booking_cutoff_day || 'Wednesday';
    var timeStr = cfgObj.booking_cutoff_time || '23:59';
    var target = DOW[dayName];
    if (target === undefined) target = 3;
    var today = sgtDateStr(new Date());
    var delta = (target - dateStrDow(today) + 7) % 7;
    var iso = isoFromSgt(addDaysStr(today, delta), timeStr);
    if (Date.parse(iso) <= nowMs()) iso = isoFromSgt(addDaysStr(today, delta + 7), timeStr);
    return iso;
  }

  /* The clinic date that the next cutoff governs (Wed cutoff -> Thu clinic). */
  function nextClinicDate(cfgObj) {
    var cutoffIso = nextCutoffIso(cfgObj);
    var cutoffDate = sgtDateStr(new Date(Date.parse(cutoffIso)));
    var clinicDow = DOW[cfgObj.clinic_day];
    if (clinicDow === undefined) clinicDow = 4;
    var delta = (clinicDow - dateStrDow(cutoffDate) + 7) % 7;
    if (delta === 0) delta = 7;
    return addDaysStr(cutoffDate, delta);
  }

  /* The cutoff that applies to a particular clinic date: the most recent
     cutoff-day at cutoff-time strictly before it. */
  function cutoffForDate(cfgObj, dateStr) {
    var target = DOW[cfgObj.booking_cutoff_day];
    if (target === undefined) target = 3;
    for (var i = 1; i <= 7; i++) {
      var candidate = addDaysStr(dateStr, -i);
      if (dateStrDow(candidate) === target) {
        return isoFromSgt(candidate, cfgObj.booking_cutoff_time || '23:59');
      }
    }
    return isoFromSgt(addDaysStr(dateStr, -1), cfgObj.booking_cutoff_time || '23:59');
  }

  function slotStartTimes(cfgObj) {
    var step = parseInt(cfgObj.slot_minutes, 10) || 20;
    var start = toMin(cfgObj.clinic_start || '13:00');
    var end = toMin(cfgObj.clinic_end || '16:00');
    var out = [];
    for (var t = start; t + step <= end; t += step) out.push(fromMin(t));
    return out;
  }

  /* ============================================================ seed images */
  /* Two real PNGs, base64, small enough to sit in a source file: a fake VS Code
     error pane and a fake terminal traceback. They exist so the image pipeline -
     paste -> attach.create -> markdown -> attach.get -> data: URI -> <img> - is
     end-to-end demonstrable with no backend and no OneDrive. They are drawn shapes,
     not photographs, and they carry no EXIF. */

  var SHOT_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAUAAAACgCAIAAADywSLLAAACU0lEQVR42u3cQY2EQBRFUSSggB2oYI8DFohA' +
    'EYJQgAMcIAAFEFIhoT51Tp6ASU/fza+kq7btzCzoKh+BmYDNTMBmJmAzAZtZ2IDnjPm3mQnYTMACNhOwgM0E' +
    'bCZgAZt5RjIzAZuZgM0EbGYCNjMBmwk4hz+iAZIIGAQsYBAwIGAQsIBBwAIGAQMCBgELGCIFPD32bsBrQL5S' +
    'CFjAIGABI2ABCxgBCxhcoQEBg4AFDAIWMAgYBCxgELCAIZ+AvQN7dkbAAhYwAkbACFjACFjAAsYVGhAwCFjA' +
    'IGABg4ABAYOABQwRA/7qHXhcNruZZ2cELGABC1jAAkbAAhYwAhawgAXsCg0CFjAIGBAwCFjAIGABg4BBwH4T' +
    'C7/4JWABI2ABCxgBCxgBC1jACNgV2hUaBAwIGAQsYBCwgEHAIGABw/8C9g6MZ2cBCxgBCxgELGAQsIARsCs0' +
    'IGAQsIBBwAIGAQMCBgELGCIG7B3YoyUCFrCAETACRsACRsACFjCu0ICAQcACBgELGAQMCBgELGAQsIBBwICA' +
    'QcAChnID7oEkAgYBCxgEDMQL2CkCXKFBwAIGAQsYBAwIGAQsYBCwgKGMgI9hMHtxAhawCVjAAjYBC9hMwAI2' +
    'AQvYFRoEDAgYBCxgELCAQcCAgEHA3oGthFdWAQtYwAjYBIyATcACFrAJWMCu0CBgELCAQcACBgEDAgYBCxgE' +
    'nBbwvte/ma8aAhYwCFjACFjAAkbAAgZXaBCwgEHAAgYBAwIGAQsYBCxgEDAgYBCwgEHAgIBBwAIGAQsYBAxc' +
    'OgFDAV0TkwyykgAAAABJRU5ErkJggg==';

  var TRACE_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAASwAAAB4CAIAAADHd1h3AAABbklEQVR42u3ZIRJAUBiFUcswkgUIsqW8lciy' +
    'rCiKvSiyYhGWICpG9Xhn5jQNX7l/VtUN8KLMKwARgggBEYIIL10/fZqPighFCCIEEYoQRAgiFCE4UYAIARGC' +
    'CAERQsQR5kUJvEiEIEIQISBCECEgQhAhIEIQIRBXhMu6wS3xiBARihARIkJEKEJEiHUURAiIEEQIiBBECIgQ' +
    '0oxwGGeIhAhBhCJEhCIEEYoQEVpHARGCCAERgggBEYIIAXdCXPNECCIUISIUIYhQhIjQOgqIEEQIiBBECIgQ' +
    'RAiIEEQIiBBECCJ8enyEAIkQIYhQhIhQhCBCESJC6yhYRwERgggBEYIIARGCCN2OXMYQISIUISJEhIhQhIgQ' +
    '6yiIEBAhiBAQIYgQECGIEBAhiBAQIYgQECH8O8J27xPnF0GEIkSEIgQRihARihCsoyBCQIQgQkCEIEJAhCBC' +
    'QIQgQkCEIEJAhCBCQIQgQkCEIEJAhPBBJ8spRnVupWliAAAAAElFTkSuQmCC';

  /* The flow computes the decoded size as div(mul(length(b64), 3), 4) - integer
     division, padding not subtracted. Copied exactly, wrong-by-two bytes and all,
     so a file that is accepted here is accepted there and vice versa. */
  function b64Bytes(b64) {
    return Math.floor(str(b64).length * 3 / 4);
  }

  /* ================================================================= config */

  function seedConfig() {
    return {
      site_title: 'MScPHMxAI Coding Clinic',
      allowed_domains: 'u.nus.edu,nus.edu.sg',
      /* Whole-address allowlist. allowed_domains can only admit a whole
         domain, so one gmail account needs its own key. MOCK accepts any
         address regardless — this is here for parity with the workbook. */
      allowed_emails: 'xavierchee@gmail.com',
      admin_emails: 'xavierchee@gmail.com',
      passcode_mode: 'FALSE',
      class_passcode: '',
      categories: 'Environment & setup,Syntax & errors,Concepts,Debugging,' +
        'Data wrangling,Stats & interpretation,Assignments,General',
      labels: 'python-basics,pandas,plotting,statistics,environment,assignment',
      languages: 'R,Python,Bash/Linux',
      clinic_day: 'Thursday',
      clinic_start: '13:00',
      clinic_end: '16:00',
      slot_minutes: '20',
      booking_cutoff_day: 'Wednesday',
      booking_cutoff_time: '23:59',
      max_active_bookings: '1',
      notice_text: 'Welcome! Post concepts, errors and debugging questions freely ' +
        '\u2014 do not post assignment solution code. Questions are answered within ' +
        '1 working day. Book a clinic slot only after posting a thread about your issue.',
      code_ttl_minutes: '10',
      session_days: '30',
      proficiency_wave: 'baseline',

      /* ---- v3, tbl_Config rows 21-37 (contract §3.3) ----------------------
         Every value is a STRING, because tbl_Config is a two-column text sheet and
         outputs('cfg') arrives flow-side as a flat string->string dictionary. The
         booleans are the literal words TRUE/FALSE and the numbers are decimal
         strings. Reading them as anything else here would let a builder write
         `if (cfg.chat_enabled)` and have it pass in MOCK and then be true for the
         string 'FALSE' in the tenant. */
      chat_enabled: 'TRUE',
      messages_poll_seconds: '90',
      attachments_enabled: 'TRUE',
      attachment_max_kb: '1536',
      attachment_folder: '/CodingClinic/attachments',
      attachment_types: 'image/png,image/jpeg,image/gif,image/webp',
      notify_enabled: 'TRUE',
      notify_daily_cap: '6',
      digest_hour: '20',
      escalation_hours: '24',
      reminder_day_before_hour: '18',
      reminder_day_of_hour: '12',
      archive_mode: 'FALSE',
      /* Blank in the real workbook until the instructor fills it in by hand. The
         demo sets it, because with it blank there is nobody to address a DM to and
         the whole chat feature would demo as "Direct messages are not set up yet."
         To see THAT path (it is a real one, and F4 has to render it), run:
             Clinic.mock.state().config.instructor_user_id = ''    */
      instructor_user_id: 'u_ins',
      messages_min_interval_seconds: '3',
      attachments_daily_cap: '40',

      /* ---- clinic location, tbl_Config rows 35 and 38-39 -------------------
         clinic_mode holds one of exactly two lowercase words. Not TRUE/FALSE:
         a boolean here would drag every reader through the mixed-type
         toUpper(string(...)) dance, and it would not extend if a hybrid mode
         is ever wanted. Every reader — here and flow-side — treats anything
         that is not the exact word 'online' as 'physical', which is both the
         status quo and the safer guess (a student walking to a room that is
         empty beats a student sitting at home while the instructor waits).

         clinic_join_url is blank in the shipped workbook. The demo seeds it
         blank too, so the default demo shows the physical path exactly as a
         fresh tenant does. To exercise the online path:
             var c = Clinic.mock.state().config;
             c.clinic_mode = 'online';
             c.clinic_join_url = 'https://nus-sg.zoom.us/j/98765432101?pwd=abc';
         Kept in its own cell rather than overloaded into clinic_location so
         that flipping physical → online → physical does not destroy the room. */
      clinic_mode: 'physical',
      clinic_location: 'MD1 Level 3, Room 03-12',
      clinic_join_url: ''
    };
  }

  function csvList(value) {
    return str(value).split(',').map(trimmed).filter(function (s) { return !!s; });
  }
  function isTrue(value) { return str(value).toUpperCase() === 'TRUE'; }
  /* The notify_* columns are opt-OUT: blank means "yes, send it". Only the literal
     word FALSE switches one off, matching the flow's
     @not(equals(toUpper(...),'FALSE')) idiom (contract §5.1). */
  function notFalse(value) { return str(value).toUpperCase() !== 'FALSE'; }

  function adminEmails(cfgObj) {
    return csvList(cfgObj.admin_emails).map(function (e) { return e.toLowerCase(); });
  }
  function roleForEmail(cfgObj, email) {
    return adminEmails(cfgObj).indexOf(str(email).toLowerCase()) !== -1 ? 'instructor' : 'student';
  }

  /* The msg flow's role_eff_m twin (contract §4.3). It is NOT the same test as
     roleForEmail above and it deliberately does NOT look at tbl_Users.role: the msg
     flow's prologue never reads tbl_Users, so all it can see is admin_emails and
     instructor_user_id. A row with role='instructor' that appears in neither reads
     as a STUDENT here. That is R17's fail-closed limitation, and it is reproduced
     rather than smoothed over precisely so it is discovered on the demo path instead
     of in the tenant. */
  function msgRole(u) {
    if (!u) return 'student';
    if (adminEmails(S.config).indexOf(str(u.email).toLowerCase()) !== -1) return 'instructor';
    var pinned = trimmed(S.config.instructor_user_id);
    if (pinned && pinned === u.user_id) return 'instructor';
    return 'student';
  }
  function isMsgInstructor(u) { return msgRole(u) === 'instructor'; }

  /* ============================================================ seed content */

  /* v3 adds five columns to tbl_Users. All blank on a fresh seed, which for the four
     notify_* columns means "on" (they are opt-OUT - see notFalse above), and that is
     what the profile page's four switches must show for a brand new student. */
  function withNotifyCols(u) {
    u.notify_replies = '';
    u.notify_reminders = '';
    u.notify_escalation = '';
    u.notify_digest = '';
    u.last_notify_at = '';
    return u;
  }

  function seedUsers() {
    return [
      { user_id: 'u_you', email: 'you@u.nus.edu', display_name: 'you', role: 'student', created_at: daysAgo(40), last_login: hoursAgo(2) },
      { user_id: 'u_ins', email: 'xavierchee@gmail.com', display_name: 'Dr Chee', role: 'instructor', created_at: daysAgo(60), last_login: hoursAgo(4) },
      { user_id: 'u_ana', email: 'ana@u.nus.edu', display_name: 'sgcoder', role: 'student', created_at: daysAgo(39), last_login: hoursAgo(9) },
      { user_id: 'u_ben', email: 'ben@u.nus.edu', display_name: 'pandas_fan', role: 'student', created_at: daysAgo(39), last_login: hoursAgo(30) },
      /* Three quieter classmates. They read and vote but rarely post - they exist
         so upvote counts and the leaderboard look like a real cohort. */
      { user_id: 'u_kai', email: 'kai@u.nus.edu', display_name: 'kaitlyn_t', role: 'student', created_at: daysAgo(38), last_login: daysAgo(1) },
      { user_id: 'u_raj', email: 'raj@u.nus.edu', display_name: 'raj_m', role: 'student', created_at: daysAgo(38), last_login: daysAgo(2) },
      { user_id: 'u_min', email: 'minhui@u.nus.edu', display_name: 'minhui', role: 'student', created_at: daysAgo(35), last_login: daysAgo(3) }
    ].map(withNotifyCols);
  }

  function seedThreads() {
    return [
      {
        thread_id: 't_welcome',
        title: 'Read first: how this clinic works',
        category: 'General',
        language: 'Python',
        labels: [],
        author_id: 'u_ins',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: true,
        deleted: false,
        created_at: daysAgo(38),
        body_md: L(
          'Welcome to the coding clinic. There are two ways to get help, and you are',
          'meant to use both.',
          '',
          '**1. Post here.** Anything about Python, pandas, plotting or stats. I read the',
          'board every working day and answer within one working day.',
          '',
          '**2. Book a 20-minute slot.** Thursdays, 13:00-16:00. Post a thread about your',
          'problem *first*, then book from **Clinic booking** and link the thread. That is',
          'not bureaucracy - half the time writing the thread solves it, and when it does',
          'not, I arrive already knowing what broke.',
          '',
          '### How to ask so you get a useful answer',
          '',
          '- One line on what you were trying to do.',
          '- The **exact** error, all of it, in a fenced code block:',
          '',
          '```python',
          'Traceback (most recent call last):',
          '  File "analysis.py", line 12, in <module>',
          '    df["Age"].mean()',
          'KeyError: "Age"',
          '```',
          '',
          '- The smallest piece of code that reproduces it.',
          '- What you already tried.',
          '',
          'Screenshots of code are hard to read and impossible to copy. Paste text.',
          '',
          '### Ground rules',
          '',
          '| Fine | Not fine |',
          '| --- | --- |',
          '| Concepts, errors, debugging, "why does this work" | Posting your assignment solution |',
          '| Sharing a 5-line snippet that reproduces a bug | Asking someone to write Q3 for you |',
          '| Answering a classmate | Answering with a full solution before the deadline |',
          '',
          'Tick **Post anonymously** if you would rather not attach your name to a question.',
          'Classmates only see "Anonymous". Nobody has ever been judged for asking here, but',
          'if it lowers the barrier, use it.'
        )
      },
      {
        thread_id: 't_conda',
        title: 'conda activate: command not found in a WSL Ubuntu terminal',
        category: 'Environment & setup',
        language: 'Bash/Linux',
        labels: ['environment'],
        author_id: 'u_ana',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_conda_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(31),
        body_md: L(
          'Installed Miniconda inside WSL (Ubuntu 22.04), following the installer\'s prompts:',
          '',
          '```bash',
          'bash Miniconda3-latest-Linux-x86_64.sh',
          '```',
          '',
          'It finished, said it added conda to my PATH, and I closed the terminal like it',
          'suggested. New WSL window, and:',
          '',
          '```bash',
          'conda activate phm5003',
          '# conda: command not found',
          '```',
          '',
          '`~/miniconda3/bin` is not on `PATH` either - `echo $PATH` does not show it, and',
          '`which conda` finds nothing. The installer definitely ran without errors. Do I have',
          'to add something by hand, or did the install just silently fail?'
        )
      },
      {
        thread_id: 't_keyerror',
        title: 'KeyError: "Age" when the column is clearly in the CSV',
        category: 'Debugging',
        language: 'Python',
        labels: ['pandas'],
        author_id: 'u_you',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_key_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(17),
        body_md: L(
          'Loading the class survey export and immediately hitting a KeyError, even though',
          '`Age` is right there in the header row when I open the file in Excel.',
          '',
          '```python',
          'import pandas as pd',
          '',
          'df = pd.read_csv("survey_export.csv")',
          'print(df["Age"].mean())',
          '```',
          '',
          '```python',
          'Traceback (most recent call last):',
          '  File "C:\\Users\\me\\phm5003\\clean.py", line 4, in <module>',
          '    print(df["Age"].mean())',
          '  File "...\\pandas\\core\\frame.py", line 4102, in __getitem__',
          '    indexer = self.columns.get_loc(key)',
          '  File "...\\pandas\\core\\indexes\\base.py", line 3812, in get_loc',
          '    raise KeyError(key) from err',
          'KeyError: \'Age\'',
          '```',
          '',
          '`df.shape` is `(214, 11)` so the file loads. `df.head()` looks completely normal.',
          'I have retyped the column name three times.'
        )
      },
      {
        thread_id: 't_plt',
        title: 'plt.show() opens a blank window and savefig writes a blank PNG',
        category: 'Debugging',
        language: 'Python',
        labels: ['plotting'],
        author_id: 'u_you',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: hoursAgo(5),
        body_md: L(
          'The figure window opens but it is completely white. No error, no warning. The same',
          'code in Jupyter draws the plot fine.',
          '',
          '```python',
          'import matplotlib.pyplot as plt',
          '',
          'plt.plot([1, 2, 3], [2, 4, 8])',
          'plt.show()',
          'plt.title("Growth")',
          'plt.savefig("growth.png")',
          '```',
          '',
          '`growth.png` is blank too. matplotlib 3.8.2, Python 3.11, running the file with the',
          'VS Code Run button.'
        )
      },
      {
        thread_id: 't_listcomp',
        title: 'Why does my list comprehension give me a list of Nones?',
        category: 'Concepts',
        language: 'Python',
        labels: ['python-basics'],
        author_id: 'u_ben',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(10),
        body_md: L(
          'I wanted a list of cleaned names. This works:',
          '',
          '```python',
          'names = ["  ana ", "BEN", " chee"]',
          'cleaned = [n.strip().title() for n in names]',
          'print(cleaned)      # [\'Ana\', \'Ben\', \'Chee\']',
          '```',
          '',
          'But when I build it up the other way I get three Nones:',
          '',
          '```python',
          'out = []',
          'result = [out.append(n.strip().title()) for n in names]',
          'print(result)       # [None, None, None]',
          'print(out)          # [\'Ana\', \'Ben\', \'Chee\']   <- this one is right',
          '```',
          '',
          'Why is `result` full of `None`? I feel like this is going to be obvious.'
        )
      },
      {
        thread_id: 't_merge',
        title: 'merge() vs dplyr\'s left_join() in R - which one am I supposed to reach for?',
        category: 'Data wrangling',
        language: 'R',
        labels: [],
        author_id: 'u_ana',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(6),
        body_md: L(
          'Both seem to glue two data frames together and I cannot work out when to use which.',
          'The docs show base `merge(a, b)` and dplyr\'s `left_join(a, b)`, and I end up copying',
          'whichever example is closest to my situation, which is not a strategy.',
          '',
          'Is there a simple rule?'
        )
      },
      {
        thread_id: 't_ttest',
        title: 'Two-sample t-test gives p = 0.06 - do I say there is no difference?',
        category: 'Stats & interpretation',
        language: 'R',
        labels: ['statistics'],
        author_id: 'u_ben',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(2),
        body_md: L(
          'Comparing reaction times for two groups, n = 18 and n = 21.',
          '',
          '```r',
          't.test(group_a, group_b)',
          '#  Welch Two Sample t-test',
          '#',
          '#  t = -1.94, df = 33.5, p-value = 0.0603',
          '```',
          '',
          'Group means are 412 ms and 448 ms.',
          '',
          'Do I write "there was no difference between the groups"? My current draft says',
          '"approaching significance" and something tells me that is also wrong.'
        )
      },
      {
        thread_id: 't_anon',
        title: 'Assignment 1 Q3: are we allowed to use pandas, or must it be plain Python?',
        category: 'Assignments',
        language: 'Python',
        labels: ['assignment'],
        author_id: 'u_ben',
        is_anonymous: true,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: hoursAgo(26),
        body_md: L(
          'Q3 says "read the file and report the mean score per group". The lecture that week',
          'only covered lists and dictionaries, but we have already used pandas in the clinic',
          'examples and it is three lines instead of twenty.',
          '',
          'Will we lose marks for using pandas instead of a dictionary and a loop?',
          '',
          'Asking anonymously because I suspect this is written somewhere obvious and I have',
          'missed it.'
        )
      },

      /* ================================================================= v3 ==
         Everything below exists to make a feature VISIBLE on a fresh seed. In
         order: an endorsed student answer, a locked thread, a thread marked as a
         duplicate, a thread with a pasted screenshot, an anonymous instructor
         reply (the one case instructor_replied must NOT light up for), and four
         ordinary threads whose only job is to give the search page something to
         filter - so that every category, all three language boards, every label
         and a spread of dates from five weeks ago to this morning are represented.
         ====================================================================== */
      {
        thread_id: 't_venv',
        title: 'venv or conda for this course - does it matter which one I pick?',
        category: 'Environment & setup',
        language: 'Python',
        labels: ['environment'],
        author_id: 'u_kai',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_venv_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(26),
        body_md: L(
          'The course notes say conda, half the tutorials online say `python -m venv`, and I',
          'have now got both on my laptop, which feels like the actual problem.',
          '',
          'Is there a reason to prefer one, or should I just pick whichever and move on?'
        )
      },
      {
        thread_id: 't_shell',
        title: 'chmod +x worked but the script still says Permission denied',
        category: 'Environment & setup',
        language: 'Bash/Linux',
        labels: ['environment'],
        author_id: 'u_raj',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_shell_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(33),
        body_md: L(
          '```bash',
          'chmod +x clean_data.sh',
          'ls -l clean_data.sh',
          '# -rwxr-xr-x 1 raj raj 412 Mar 3 09:14 clean_data.sh',
          '',
          'clean_data.sh',
          '# clean_data.sh: command not found',
          '',
          './clean_data.sh',
          '# bash: ./clean_data.sh: Permission denied',
          '```',
          '',
          'The x bits are clearly there. The file is on a USB drive I am working from, if',
          'that matters.'
        )
      },
      {
        thread_id: 't_indent',
        title: 'IndentationError: unexpected indent, but the line looks identical to the one above',
        category: 'Syntax & errors',
        language: 'Python',
        labels: ['python-basics'],
        author_id: 'u_min',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_ind_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(19),
        body_md: L(
          'I copied two lines out of the lecture slides into my own script and now:',
          '',
          '```python',
          '  File "wrangle.py", line 9',
          '    total = total + row["score"]',
          'IndentationError: unexpected indent',
          '```',
          '',
          'Line 8 and line 9 look exactly the same amount of indented to me. I have tried',
          'deleting the spaces and putting them back.'
        )
      },
      {
        thread_id: 't_ggplot',
        title: 'ggplot legend shows the wrong labels after I recode a factor',
        category: 'Debugging',
        language: 'R',
        labels: ['plotting'],
        author_id: 'u_ana',
        is_anonymous: false,
        status: 'answered',
        accepted_post_id: 'p_gg_1',
        resolved_via: 'async',
        pinned: false,
        deleted: false,
        created_at: daysAgo(24),
        body_md: L(
          'I recode a group column and the plot still shows the old labels in the legend,',
          'in the old order:',
          '',
          '```r',
          'df$grp <- factor(df$grp, labels = c("Control", "Treatment"))',
          'ggplot(df, aes(x = time, y = score, colour = grp)) + geom_line()',
          '```',
          '',
          'The legend says "Treatment" for what I am fairly sure is the control group. Is',
          '`labels =` not doing what I think it does?'
        )
      },
      {
        thread_id: 't_regex',
        title: 'gsub() in R keeps eating my backslashes',
        category: 'Data wrangling',
        language: 'R',
        labels: [],
        author_id: 'u_min',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(4),
        body_md: L(
          'Trying to strip Windows path separators out of a column of file names:',
          '',
          '```r',
          'gsub("\\", "/", paths)',
          '# Error: \'\\"\' is an unrecognized escape in character string',
          '```',
          '',
          'Doubling it up gets me further but the result is not what I expect either. How',
          'many backslashes am I actually supposed to write?'
        )
      },
      {
        thread_id: 't_ide',
        title: 'Jupyter or VS Code for the assignments?',
        category: 'General',
        language: 'Python',
        labels: [],
        author_id: 'u_kai',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(14),
        body_md: L(
          'Notebooks are easier to poke at, but every error message I get in class seems to',
          'come from running a `.py` file. Which one should I be living in?'
        )
      },
      {
        thread_id: 't_img',
        title: 'VS Code just says "exited with code 1" and nothing else',
        category: 'Debugging',
        language: 'Python',
        labels: [],
        author_id: 'u_you',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(3),
        attachment_ids: 'a_shot',
        body_md: L(
          'Running the file with the Run button gives me this and then the terminal closes',
          'the panel. Screenshot because I cannot select the text in that pane:',
          '',
          '![vscode-error.png](clinic-img/a_shot)',
          '',
          'The same file runs fine if I type `python clean.py` in a terminal myself.'
        )
      },
      {
        thread_id: 't_dupe',
        title: 'pandas cannot find a column that is definitely in my CSV',
        category: 'Debugging',
        language: 'Python',
        labels: ['pandas'],
        author_id: 'u_min',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(12),
        /* Marked as a duplicate AND locked - two independent flags, set by two
           separate admin.moderate calls (set_duplicate, then lock_thread from the
           "also lock this discussion" checkbox). Note what is NOT touched: status is
           still 'open' and accepted_post_id is still ''. Contract §4.4 is explicit
           that the duplicate ops write duplicate_of and nothing else, so that
           clearing the mark restores the thread exactly. */
        duplicate_of: 't_keyerror',
        locked: 'TRUE',
        body_md: L(
          'Same as the KeyError thread I think, but for a different file - `df["Score"]`',
          'blows up even though Score is in the header when I open the CSV.'
        )
      },
      {
        thread_id: 't_locked',
        title: 'Can someone post the Assignment 1 solutions?',
        category: 'Assignments',
        language: 'Python',
        labels: ['assignment'],
        author_id: 'u_raj',
        is_anonymous: false,
        status: 'open',
        accepted_post_id: '',
        resolved_via: '',
        pinned: false,
        deleted: false,
        created_at: daysAgo(8),
        /* Locked WITHOUT being a duplicate: the other half of the pair above, so a
           builder can see that the two states render independently. */
        locked: 'TRUE',
        body_md: L(
          'Assignment 1 closed last night. Can whoever got Q3 out paste their version so we',
          'can check ours against it?'
        )
      }
    ].map(withThreadCols);
  }

  /* v3 adds four columns to tbl_Threads. Applied as a pass rather than typed into
     every literal above, so that "blank" is impossible to forget on a new row.
     locked is the Excel-style string 'TRUE'/'FALSE'/'' rather than a JS boolean -
     the real column is text, and threadCard() is where it becomes a real boolean.
     Get that wrong and `if (t.locked)` is true for the string 'FALSE'. */
  function withThreadCols(t) {
    t.locked = t.locked || '';
    t.duplicate_of = t.duplicate_of || '';
    t.escalated_at = t.escalated_at || '';
    t.attachment_ids = t.attachment_ids || '';
    return t;
  }

  function seedPosts() {
    return [
      {
        post_id: 'p_pin_1', thread_id: 't_welcome', parent_post_id: '',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(37),
        body_md: 'Do we have to book a slot to ask a question, or is posting here enough?'
      },
      {
        post_id: 'p_pin_2', thread_id: 't_welcome', parent_post_id: 'p_pin_1',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(37),
        body_md: L(
          'Posting is enough, and it is the faster route for most things - you get an answer',
          'in a day and everyone else can read it.',
          '',
          'Book a slot when the problem is one of these:',
          '',
          '- something on *your* machine that I need to see (environment, paths, install)',
          '- a concept that has not landed after reading the thread',
          '- your data, which you cannot paste into a public board'
        )
      },

      {
        post_id: 'p_conda_1', thread_id: 't_conda', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(31),
        body_md: L(
          'The installer only edits `~/.bashrc` if you say yes to its last prompt ("Do you',
          'wish the installer to initialize Miniconda3?") - easy to arrow past without reading.',
          'Check:',
          '',
          '```bash',
          'tail -n 5 ~/.bashrc',
          '```',
          '',
          'No block between `# >>> conda initialize >>>` and `# <<< conda initialize <<<`?',
          'Then it was skipped. Fix it by pointing `conda init` at the install directly:',
          '',
          '```bash',
          '~/miniconda3/bin/conda init bash',
          'source ~/.bashrc',
          'conda activate phm5003',
          'python -c "import pandas; print(pandas.__version__)"',
          '```',
          '',
          'You should now see `(phm5003)` at the start of the prompt.',
          '',
          'Two things that cause exactly this symptom, for anyone finding this later:',
          '',
          '| Do not | Why |',
          '| --- | --- |',
          '| Answer "no" to the initialize prompt to "keep things clean" | Nothing then sources conda\'s shell function, so `conda`/`activate` are simply not commands the shell knows |',
          '| Open a fresh terminal tab instead of a genuinely new session | Some WSL setups only re-source `.bashrc` on a new login shell |'
        )
      },
      {
        post_id: 'p_conda_2', thread_id: 't_conda', parent_post_id: 'p_conda_1',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(30),
        body_md: '`~/miniconda3/bin/conda init bash` plus `source ~/.bashrc` did it. I had ' +
          'answered "no" to that prompt, trying to be careful. Thank you!'
      },

      {
        post_id: 'p_key_1', thread_id: 't_keyerror', parent_post_id: '',
        author_id: 'u_ben', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(17),
        body_md: L(
          'Print the columns as a list rather than looking at `df.head()` - `head()` renders',
          'whitespace invisibly, which is the whole problem:',
          '',
          '```python',
          'print(list(df.columns))',
          '```',
          '',
          'I would bet money you get something like:',
          '',
          '```python',
          '[\'Timestamp\', \' Age\', \'Gender \', \'Programme\', ...]',
          '```',
          '',
          'Survey exports love a leading space. Two fixes:',
          '',
          '```python',
          'df.columns = df.columns.str.strip()                        # trim every header',
          'df = pd.read_csv("survey_export.csv", skipinitialspace=True)   # or at read time',
          '```',
          '',
          'The same trick applies to the values, not just the headers - `" Male"` and',
          '`"Male"` are two different groups as far as `groupby` is concerned:',
          '',
          '```python',
          'df["Gender"] = df["Gender"].str.strip()',
          '```'
        )
      },
      {
        post_id: 'p_key_2', thread_id: 't_keyerror', parent_post_id: 'p_key_1',
        author_id: 'u_you', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(17),
        body_md: 'That was exactly it - `\' Age\'` with a leading space. `df.columns.str.strip()` ' +
          'fixed the whole script, and two `groupby` results that had been quietly splitting in ' +
          'two. Thank you!'
      },

      {
        post_id: 'p_plt_1', thread_id: 't_plt', parent_post_id: '',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(4),
        body_md: L(
          '`plt.show()` consumes the current figure. Everything after it is drawing onto a',
          'brand new, empty one - which is why both the window and `growth.png` are blank.',
          '',
          'Move `show()` to the end, or drop it when you are saving to a file:',
          '',
          '```python',
          'import matplotlib.pyplot as plt',
          '',
          'plt.plot([1, 2, 3], [2, 4, 8])',
          'plt.title("Growth")',
          'plt.savefig("growth.png", dpi=150, bbox_inches="tight")',
          'plt.show()      # last line, or leave it out entirely',
          '```'
        )
      },
      {
        post_id: 'p_plt_2', thread_id: 't_plt', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(3),
        body_md: L(
          'Adding to that: get into the habit of the explicit object style. It makes this',
          'entire class of bug impossible, because the figure is a variable you are holding',
          'rather than a hidden global "current figure":',
          '',
          '```python',
          'fig, ax = plt.subplots(figsize=(5, 3))',
          'ax.plot([1, 2, 3], [2, 4, 8])',
          'ax.set_title("Growth")',
          'fig.savefig("growth.png", dpi=150, bbox_inches="tight")',
          '```',
          '',
          'We move to that style in week 4 anyway, so you may as well start now.'
        )
      },
      {
        post_id: 'p_plt_3', thread_id: 't_plt', parent_post_id: '',
        author_id: 'u_kai', is_anonymous: false, is_accepted: false, deleted: true,
        created_at: hoursAgo(3),
        body_md: '[this post pasted a full worked solution to Assignment 1 Q3 and was ' +
          'removed by the instructor]'
      },

      {
        post_id: 'p_lc_1', thread_id: 't_listcomp', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(10),
        body_md: L(
          'Not obvious at all - it catches everyone exactly once.',
          '',
          '`list.append()` changes the list **in place** and returns `None`. A comprehension',
          'faithfully collects whatever the expression evaluates to, so it collects three',
          '`None`s. Nothing is broken; you asked for the return value of `append`.',
          '',
          'The rule of thumb:',
          '',
          '- **Expression** - produces a value - belongs in a comprehension.',
          '- **Mutation** (`append`, `sort`, `update`) - returns `None` - belongs in a loop.',
          '',
          'So pick one style and commit to it:',
          '',
          '```python',
          'cleaned = [n.strip().title() for n in names]   # comprehension: keep the value',
          '',
          'out = []                                       # loop: mutate',
          'for n in names:',
          '    out.append(n.strip().title())',
          '```',
          '',
          'The same distinction is `sorted(xs)` versus `xs.sort()`, and in pandas it is',
          '`df.dropna()` versus `df.dropna(inplace=True)`. Once you see it you see it',
          'everywhere.'
        )
      },
      {
        post_id: 'p_lc_2', thread_id: 't_listcomp', parent_post_id: 'p_lc_1',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(9),
        body_md: 'The `sorted(xs)` vs `xs.sort()` pairing is what made it click for me. If a ' +
          'method changes the thing you called it on, assume it hands back `None`.'
      },

      {
        post_id: 'p_mrg_1', thread_id: 't_merge', parent_post_id: '',
        author_id: 'u_ben', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(6),
        body_md: L(
          'Short version: **use dplyr\'s `*_join()` family and stop thinking about it.**',
          '',
          'Base `merge()` joins on every column the two frames have in common unless you say',
          'otherwise, which is an easy way to join on more than you meant to. dplyr makes you',
          'name the key, which is what you actually want 95% of the time.',
          '',
          '```r',
          '# a key column on both sides -> left_join',
          'out <- left_join(students, marks, by = "student_id")',
          '',
          '# differently named key columns',
          'out <- left_join(students, marks, by = c("id" = "student_id"))',
          '',
          '# only when you deliberately want base R\'s behaviour',
          'out <- merge(students, marks, by = "student_id", all.x = TRUE)',
          '```',
          '',
          'Two habits worth stealing:',
          '',
          '1. Always pass `by =` explicitly. Letting dplyr guess (with a message you probably',
          '   will not read) is how the wrong column ends up as the join key.',
          '2. Check the row count immediately after:',
          '',
          '```r',
          'cat(nrow(students), "->", nrow(out))',
          '```',
          '',
          'If it *grew*, your right-hand key is not unique and you have made a many-to-many',
          'join by accident. Adding `relationship = "many-to-one"` turns that into a loud error',
          'instead of a quiet mess three cells later.'
        )
      },

      {
        post_id: 'p_tt_1', thread_id: 't_ttest', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(2),
        body_md: L(
          'Neither - and well spotted, because both of those are the classic write-up traps.',
          '',
          '`p = 0.06` means: *if* the two groups really came from the same distribution, you',
          'would see a difference at least this big about 6% of the time. It is not evidence',
          'that the groups are the same, and there is no such thing as "approaching"',
          'significance - a threshold is a threshold.',
          '',
          '| Report this | Instead of |',
          '| --- | --- |',
          '| The effect size with its confidence interval | "significant" / "not significant" on its own |',
          '| "36 ms slower, 95% CI -2 to 74 ms" | "approaching significance" |',
          '| "consistent with anything from no effect to a 74 ms effect" | "there was no difference" |',
          '',
          '```r',
          'res <- t.test(group_a, group_b)',
          'diff <- mean(group_a) - mean(group_b)',
          'sprintf("diff = %.1f ms, 95%% CI %.1f to %.1f ms", diff, res$conf.int[1], res$conf.int[2])',
          '```',
          '',
          'With n = 18 and 21 you simply do not have the power to resolve a 36 ms effect.',
          'Saying so plainly is a much stronger sentence than any hedge.'
        )
      },
      {
        post_id: 'p_tt_2', thread_id: 't_ttest', parent_post_id: 'p_tt_1',
        author_id: 'u_you', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(2),
        body_md: 'Is Welch\'s test always the safe default? We were taught to test for equal ' +
          'variances first and then choose - is that why `t.test()` even has a `var.equal` argument?'
      },
      {
        post_id: 'p_tt_3', thread_id: 't_ttest', parent_post_id: 'p_tt_1',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(20),
        body_md: L(
          'Yes - `t.test()`\'s default is already Welch (`var.equal = FALSE`), and that default',
          'is deliberate, not an oversight. Skip the variance test.',
          '',
          'The two-step "test then choose" procedure sounds careful but it makes your final',
          'p-value depend on the outcome of a first test, which distorts it. Welch costs you',
          'almost nothing when the variances *are* equal and saves you when they are not.',
          '',
          '`var.equal` mainly exists so you can opt into the classic Student\'s t-test on',
          'purpose. Python\'s `scipy.stats.ttest_ind` makes you opt into Welch instead with',
          '`equal_var=False` - so you are getting the safer behaviour here by default.'
        )
      },

      {
        post_id: 'p_anon_1', thread_id: 't_anon', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: hoursAgo(22),
        body_md: L(
          'Not obvious at all - the brief should have said, and that is on me.',
          '',
          'Use whatever you like, pandas included. The marks are for getting the right',
          'numbers and for code somebody else could read, not for which library you reached',
          'for. If the dictionary-and-loop version is clearer to you, that is a fine answer',
          'too.',
          '',
          'One condition: it has to run in the course environment (`phm5003.yml`), so no',
          'extra pip installs.',
          '',
          'I have added a line to the brief to say this.'
        )
      },
      {
        post_id: 'p_anon_2', thread_id: 't_anon', parent_post_id: 'p_anon_1',
        author_id: 'u_you', is_anonymous: true, is_accepted: false, deleted: false,
        created_at: hoursAgo(18),
        body_md: 'Same question here, so thank you for asking it. The three-line version felt ' +
          'like cheating.'
      },

      /* ================================================================= v3 == */
      {
        /* ENDORSEMENT #1, and the important one: a STUDENT's answer, accepted by the
           asker AND separately endorsed by the instructor. Accepted and endorsed are
           two different things wearing two different badges - "the asker says this
           solved it" versus "the instructor vouches for this being correct" - and
           this row is what proves the UI keeps them apart. */
        post_id: 'p_venv_1', thread_id: 't_venv', parent_post_id: '',
        author_id: 'u_ben', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(26),
        endorsed: 'TRUE', endorsed_by: 'u_ins', endorsed_at: daysAgo(25),
        body_md: L(
          'Either works, but pick ONE and delete the other, because having both is how you',
          'end up installing pandas into an environment you are not actually running.',
          '',
          'For this course conda is the lower-friction answer: the class file installs the R',
          'and Python sides together, and it handles the compiled bits (numpy, scipy) without',
          'needing a compiler on Windows.',
          '',
          '```bash',
          'conda env create -f phm5003.yml',
          'conda activate phm5003',
          'python -c "import sys; print(sys.executable)"',
          '```',
          '',
          'That last line is the one to memorise. If the path it prints is not inside your',
          'environment folder, you are running the wrong Python and every "but I installed',
          'it!" problem for the rest of the semester is that.'
        )
      },
      {
        post_id: 'p_venv_2', thread_id: 't_venv', parent_post_id: 'p_venv_1',
        author_id: 'u_kai', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(25),
        body_md: '`sys.executable` was pointing at the system Python the whole time. Removed ' +
          'the venv, kept conda. Thank you!'
      },

      {
        post_id: 'p_shell_1', thread_id: 't_shell', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(33),
        body_md: L(
          'Two separate things there, and the second one is the answer.',
          '',
          '`clean_data.sh: command not found` is normal: the current directory is not on',
          '`PATH`, which is deliberate, hence `./clean_data.sh`.',
          '',
          'The `Permission denied` on `./clean_data.sh` with the x bit visibly set is almost',
          'always the USB drive. Removable media is usually mounted `noexec`, and no `chmod`',
          'can override a mount option:',
          '',
          '```bash',
          'findmnt -no OPTIONS -T clean_data.sh',
          '# rw,nosuid,nodev,noexec,relatime,...    <- there it is',
          '```',
          '',
          'Copy the project onto the home directory and work there. Working directly off a',
          'USB stick will also lose you an afternoon to file locking eventually.'
        )
      },

      {
        post_id: 'p_ind_1', thread_id: 't_indent', parent_post_id: '',
        author_id: 'u_ana', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(19),
        body_md: L(
          'Slides are typeset with tabs, your file is spaces (or the other way round). They',
          'look identical and Python treats them as different.',
          '',
          'In VS Code: `Ctrl+Shift+P` -> "Convert Indentation to Spaces", then turn on',
          '`"editor.renderWhitespace": "all"` for a week and you will start seeing it.'
        )
      },

      {
        post_id: 'p_gg_1', thread_id: 't_ggplot', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: true, deleted: false,
        created_at: daysAgo(24),
        body_md: L(
          '`labels =` does not RENAME your groups - it renames whatever is in position 1,',
          'position 2, and so on, in the level order R chose. That order is alphabetical by',
          'default, so if your codes are `"t"` and `"c"`, level 1 is `"c"`... unless it is',
          'not, and then you have silently swapped your two groups in every figure.',
          '',
          'Always name the levels explicitly:',
          '',
          '```r',
          'df$grp <- factor(df$grp, levels = c("c", "t"), labels = c("Control", "Treatment"))',
          'table(df$grp)   # check it before you plot it',
          '```',
          '',
          'This one is worth being paranoid about: nothing errors, the figure looks fine, and',
          'the conclusion is backwards.'
        )
      },

      {
        /* ENDORSEMENT #2: endorsed but NOT accepted, on a thread that is still open.
           The pair (this and p_venv_1) is what stops anyone implementing the
           endorsement badge as a synonym for the accepted-answer ribbon. */
        post_id: 'p_regex_1', thread_id: 't_regex', parent_post_id: '',
        author_id: 'u_ana', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(4),
        endorsed: 'TRUE', endorsed_by: 'u_ins', endorsed_at: hoursAgo(30),
        body_md: L(
          'Four. It is always four, and it is not R being difficult.',
          '',
          'The string parser eats one pair, then the regex engine eats another, so `"\\\\\\\\"`',
          'in your source is one literal backslash by the time the matcher sees it.',
          '',
          '```r',
          'gsub("\\\\\\\\", "/", paths)          # works, unreadable',
          'gsub("\\\\", "/", paths, fixed = TRUE) # works, says what it means',
          '```',
          '',
          'Use `fixed = TRUE` whenever you are replacing a literal rather than a pattern.',
          'You get to stop counting, and it is faster.'
        )
      },

      {
        post_id: 'p_dupe_1', thread_id: 't_dupe', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(11),
        body_md: 'Marked this as a duplicate and pointed it at the earlier KeyError thread, ' +
          'which has the full answer - it is a leading space in the header. Locking this one ' +
          'so the answers stay in one place; keep replying over there.'
      },

      {
        post_id: 'p_lock_1', thread_id: 't_locked', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(8),
        body_md: L(
          'No - see the ground rules in the pinned thread. Locking this one.',
          '',
          'Marks are released with per-question feedback on Friday. If you want to know',
          'whether your Q3 approach was sound, post the approach (not the code) as its own',
          'thread and I will tell you.'
        )
      },

      {
        post_id: 'p_img_1', thread_id: 't_img', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: false, is_accepted: false, deleted: false,
        created_at: daysAgo(2),
        body_md: L(
          'That panel is the Debug Console, and it only ever shows the exit code. The real',
          'traceback went to the Terminal tab next to it.',
          '',
          'Bottom panel -> "TERMINAL" tab -> scroll up. Paste what is there and we will have',
          'it in one reply.'
        )
      },

      {
        /* The anonymity trap, seeded deliberately. This is an INSTRUCTOR post, but it
           is anonymous, so it must NOT set instructor_replied on t_ide's card and must
           NOT get an instructor badge. The flow computes instructor_replied from
           f_posts_named, which already excludes anonymous posts, for exactly this
           reason; threadCard() below mirrors that. If this thread ever shows the
           "instructor replied" marker, the mirror is broken - and in the tenant that
           bug de-anonymises the instructor. */
        post_id: 'p_ide_1', thread_id: 't_ide', parent_post_id: '',
        author_id: 'u_ins', is_anonymous: true, is_accepted: false, deleted: false,
        created_at: daysAgo(13),
        body_md: L(
          'Notebooks for exploring, `.py` files for anything you have to hand in or run',
          'twice. The assignments are marked as scripts, so get comfortable there.'
        )
      }
    ].map(withPostCols);
  }

  /* v3 adds four columns to tbl_Posts, same reasoning as withThreadCols above.
     endorsed_by and endorsed_at are stored here but are NEVER returned to any
     client (contract §5.3) - "the instructor endorsed this" is public, "which
     instructor, and when" is not. postShape() is where that is enforced. */
  function withPostCols(p) {
    p.endorsed = p.endorsed || '';
    p.endorsed_by = p.endorsed_by || '';
    p.endorsed_at = p.endorsed_at || '';
    p.attachment_ids = p.attachment_ids || '';
    return p;
  }

  /* [target_type, target_id, [voter user ids]] */
  function seedVoteSpec() {
    return [
      ['thread', 't_welcome', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['thread', 't_conda', ['u_you', 'u_ben', 'u_kai', 'u_min']],
      ['thread', 't_keyerror', ['u_ana', 'u_ben', 'u_ins', 'u_kai', 'u_raj']],
      ['thread', 't_plt', ['u_ana', 'u_kai']],
      ['thread', 't_listcomp', ['u_you', 'u_ana', 'u_ins', 'u_raj']],
      ['thread', 't_merge', ['u_you', 'u_ben', 'u_min']],
      ['thread', 't_ttest', ['u_you', 'u_ins', 'u_kai']],
      ['thread', 't_anon', ['u_you', 'u_ana', 'u_kai', 'u_raj', 'u_min']],

      ['post', 'p_pin_1', ['u_you']],
      ['post', 'p_pin_2', ['u_ana', 'u_ben']],
      ['post', 'p_conda_1', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['post', 'p_key_1', ['u_you', 'u_ana', 'u_ins', 'u_kai', 'u_min']],
      ['post', 'p_key_2', ['u_ben']],
      ['post', 'p_plt_1', ['u_you', 'u_ben', 'u_kai']],
      ['post', 'p_plt_2', ['u_you', 'u_ana', 'u_ben', 'u_raj']],
      ['post', 'p_lc_1', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['post', 'p_lc_2', ['u_ben', 'u_kai']],
      ['post', 'p_mrg_1', ['u_you', 'u_ana', 'u_ins', 'u_kai']],
      ['post', 'p_tt_1', ['u_you', 'u_ana', 'u_ben', 'u_kai', 'u_raj', 'u_min']],
      ['post', 'p_tt_2', ['u_ana']],
      ['post', 'p_tt_3', ['u_you', 'u_ben']],
      ['post', 'p_anon_1', ['u_you', 'u_ana', 'u_kai', 'u_min']],
      ['post', 'p_anon_2', ['u_ana']],

      /* v3 threads, so the new cards do not all read "0" next to the older ones. */
      ['thread', 't_venv', ['u_you', 'u_ana', 'u_min']],
      ['thread', 't_shell', ['u_you', 'u_kai']],
      ['thread', 't_indent', ['u_ana', 'u_ben']],
      ['thread', 't_ggplot', ['u_you', 'u_ben', 'u_min']],
      ['thread', 't_regex', ['u_you', 'u_kai']],
      ['thread', 't_ide', ['u_ana', 'u_raj']],
      ['thread', 't_img', ['u_ana']],
      ['post', 'p_venv_1', ['u_you', 'u_ana', 'u_ins', 'u_kai', 'u_min', 'u_raj']],
      ['post', 'p_shell_1', ['u_you', 'u_ana', 'u_raj']],
      ['post', 'p_ind_1', ['u_min', 'u_ben']],
      ['post', 'p_gg_1', ['u_you', 'u_ana', 'u_ben', 'u_kai']],
      ['post', 'p_regex_1', ['u_you', 'u_min', 'u_ben']],
      ['post', 'p_ide_1', ['u_kai']]
    ];
  }

  /* Votes are dated after whatever they voted on, and mostly in the last few
     days, so the leaderboard's "This month" tab always has something in it. */
  function seedVotes(threads, posts) {
    var out = [];
    var spec = seedVoteSpec();
    var n = 0;
    for (var i = 0; i < spec.length; i++) {
      var row = spec[i];
      var target = row[0] === 'thread'
        ? find(threads, 'thread_id', row[1])
        : find(posts, 'post_id', row[1]);
      var earliest = target ? Date.parse(target.created_at) + 900000 : 0;
      for (var j = 0; j < row[2].length; j++) {
        n += 1;
        var at = nowMs() - ((n % 6) * DAY_MS + (n % 17) * 3600000);
        out.push({
          vote_id: 'v_seed_' + n,
          target_type: row[0],
          target_id: row[1],
          user_id: row[2][j],
          created_at: isoAt(Math.min(nowMs() - 60000, Math.max(at, earliest)))
        });
      }
    }
    return out;
  }

  /* Nine slots on the coming clinic day, plus last week's for admin charts. */
  function seedSlots(cfgObj, upcomingDate, pastDate) {
    var times = slotStartTimes(cfgObj);
    var duration = parseInt(cfgObj.slot_minutes, 10) || 20;
    var out = [];

    var upcomingStatus = ['open', 'open', 'booked', 'open', 'blocked', 'booked', 'open', 'open', 'open'];
    var pastStatus = ['booked', 'open', 'booked', 'open', 'open', 'booked', 'open', 'open', 'open'];

    for (var i = 0; i < times.length; i++) {
      out.push({
        slot_id: 's_past_' + (i + 1), date: pastDate, start_time: times[i],
        duration_min: duration, status: pastStatus[i] || 'open', created_at: daysAgo(14)
      });
    }
    for (var k = 0; k < times.length; k++) {
      out.push({
        slot_id: 's_next_' + (k + 1), date: upcomingDate, start_time: times[k],
        duration_min: duration, status: upcomingStatus[k] || 'open', created_at: daysAgo(7)
      });
    }
    return out;
  }

  function seedBookings(pastDate) {
    return [
      /* Upcoming clinic - two classmates have taken slots. "you" deliberately has
         none, so the booking flow is demonstrable end to end. */
      {
        booking_id: 'b_next_1', slot_id: 's_next_3', user_id: 'u_ana',
        full_name: 'Ana Rahman', phone: '+65 9123 4567', email: 'ana@u.nus.edu',
        thread_id: 't_merge', note: 'Keep ending up with more rows after a merge than I started with.',
        status: 'confirmed', attendance: '', resolved_how: '', created_at: daysAgo(2)
      },
      {
        booking_id: 'b_next_2', slot_id: 's_next_6', user_id: 'u_ben',
        full_name: 'Ben Tan', phone: '+65 8234 5678', email: 'ben@u.nus.edu',
        thread_id: 't_ttest', note: 'Want to check the wording of my results paragraph before I submit.',
        status: 'confirmed', attendance: '', resolved_how: '', created_at: daysAgo(1)
      },
      /* Last week - already marked up, so the admin dashboard has real numbers. */
      {
        booking_id: 'b_past_1', slot_id: 's_past_1', user_id: 'u_ben',
        full_name: 'Ben Tan', phone: '+65 8234 5678', email: 'ben@u.nus.edu',
        thread_id: 't_listcomp', note: '',
        status: 'confirmed', attendance: 'attended', resolved_how: 'live',
        created_at: isoFromSgt(addDaysStr(pastDate, -4), '09:00')
      },
      {
        booking_id: 'b_past_2', slot_id: 's_past_3', user_id: 'u_ana',
        full_name: 'Ana Rahman', phone: '+65 9123 4567', email: 'ana@u.nus.edu',
        thread_id: 't_conda', note: 'Environment still not right on the laptop.',
        status: 'confirmed', attendance: 'attended', resolved_how: 'live',
        created_at: isoFromSgt(addDaysStr(pastDate, -3), '20:05')
      },
      {
        booking_id: 'b_past_3', slot_id: 's_past_6', user_id: 'u_you',
        full_name: 'Demo Student', phone: '+65 8000 1234', email: 'you@u.nus.edu',
        thread_id: 't_keyerror', note: '',
        status: 'confirmed', attendance: 'no_show', resolved_how: '',
        created_at: isoFromSgt(addDaysStr(pastDate, -2), '10:15')
      },
      {
        booking_id: 'b_past_4', slot_id: 's_past_7', user_id: 'u_ben',
        full_name: 'Ben Tan', phone: '+65 8234 5678', email: 'ben@u.nus.edu',
        thread_id: 't_listcomp', note: 'Sorted it myself, sorry!',
        status: 'cancelled', attendance: '', resolved_how: '',
        created_at: isoFromSgt(addDaysStr(pastDate, -5), '08:00')
      }
    ];
  }

  /* A self-rating or two for classmates other than the demo user, so the
     instructor's export/admin view is not empty on a fresh seed. "you" (u_you)
     deliberately has none - see selfUserFull() / profile.html - so the profile
     page's first-run nudge is demonstrable. Ana has two waves on purpose:
     append-only storage (SPEC §4) is what makes a baseline-vs-endterm trend
     possible at all, and a single wave is otherwise nothing to look at. */
  function seedProficiency() {
    return [
      {
        prof_id: 'pf_ana_1', user_id: 'u_ana', r: 2, python: 4, linux: 2,
        wave: 'baseline', recorded_at: daysAgo(35)
      },
      {
        prof_id: 'pf_ben_1', user_id: 'u_ben', r: 1, python: 3, linux: 1,
        wave: 'baseline', recorded_at: daysAgo(33)
      },
      {
        prof_id: 'pf_ana_2', user_id: 'u_ana', r: 3, python: 5, linux: 3,
        wave: 'endterm', recorded_at: daysAgo(2)
      }
    ];
  }

  /* ====================================================== v3: chat seed data ==
     conversation_id is DETERMINISTIC: 'c_' + the STUDENT's user_id. Chat is always
     student <-> instructor, so keying off the student side avoids pair-sorting and
     survives the two-instructor-identities problem (contract §3.2). It also means
     any student can compute any other student's conversation id, which is why the
     participation guard in the handlers below is a security control and not a
     convenience - see convIdFor().

     `visible_at` is a MOCK-ONLY column with no counterpart in tbl_Messages. It is
     the write-visibility lag made concrete: messages.get ignores any row whose
     visible_at is still in the future. Seeded rows use 0, i.e. always visible.

     The seeded state, deliberately:
       c_u_you  4 msgs, one carrying an image, 1 unread FOR THE STUDENT
       c_u_ana  3 msgs, last from the student   -> 2 unread for the instructor
       c_u_ben  2 msgs, last from the student   -> 1 unread for the instructor
       c_u_min  1 msg,  never answered          -> 1 unread for the instructor
     So the student persona opens Messages to a badge of 1 and one conversation;
     the instructor opens it to a badge of 4 across three conversations that need
     a reply and one that does not. Both views are worth showing to somebody.
     ========================================================================== */

  function msg(id, cid, from, to, minsAgo, body, extra) {
    var row = {
      message_id: id,
      conversation_id: cid,
      sender_id: from,
      recipient_id: to,
      body_md: body,
      attachment_ids: '',
      ref_thread_id: '',
      client_msg_id: 'seed_' + id,
      deleted: 'FALSE',
      created_at: isoAgo(minsAgo * 60000),
      visible_at: 0
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) row[k] = extra[k];
      }
    }
    return row;
  }

  function seedMessages() {
    /* NOTE THE ORDER. These are NOT in chronological order, and that is on purpose:
       tbl_Messages is an Excel sheet read with GetItems, which gives NO ordering
       guarantee at all, and after the end-of-semester archive tool has run the row
       order is genuinely arbitrary. messages.get returns them in stored order, so a
       client that forgets to sort on created_at will visibly render this
       conversation out of sequence in MOCK rather than in front of the cohort. */
    return [
      msg('m_you_2', 'c_u_you', 'u_ins', 'u_you', 60 * 30,
        L('That is the leading-space thing again - see the thread you posted, the',
          'accepted answer covers it. Try `df.columns = df.columns.str.strip()` before',
          'anything else touches the frame.'),
        { ref_thread_id: 't_keyerror' }),
      msg('m_you_1', 'c_u_you', 'u_you', 'u_ins', 60 * 33,
        L('Hi Dr Chee - a bit embarrassed to ask this on the board. My script worked on',
          'Tuesday and today the same file will not load at all. Here is what I get:',
          '',
          '![traceback.png](clinic-img/a_dm_trace)'),
        { attachment_ids: 'a_dm_trace' }),
      msg('m_you_3', 'c_u_you', 'u_you', 'u_ins', 60 * 26,
        'That was it. Thank you - and sorry, that was in the thread the whole time.'),
      /* The one unread FOR THE STUDENT: last word from the instructor, not yet read
         by u_you, which is what puts a 1 on the student persona's nav badge. */
      msg('m_you_4', 'c_u_you', 'u_ins', 'u_you', 55,
        L('No need to apologise - asking twice is cheaper than losing an evening.',
          '',
          'One thing while I have you: you are down for a slot on Thursday but there is no',
          'thread linked to it yet. Add the link when you get a moment so I can read it',
          'beforehand.')),

      msg('m_ana_1', 'c_u_ana', 'u_ana', 'u_ins', 60 * 50,
        'Could I bring my own dataset to the clinic on Thursday? It has patient identifiers ' +
        'in it so I would rather not paste any of it on the board.'),
      msg('m_ana_2', 'c_u_ana', 'u_ins', 'u_ana', 60 * 49,
        L('Yes - that is exactly what the slot is for. Bring it on the laptop, do not email',
          'it to me, and we will work on it there.')),
      msg('m_ana_3', 'c_u_ana', 'u_ana', 'u_ins', 95,
        'Thank you. One more - is 20 minutes enough to go through a merge that is producing ' +
        'duplicate rows, or should I book two?'),

      msg('m_ben_1', 'c_u_ben', 'u_ins', 'u_ben', 60 * 20,
        'Saw your t-test question on the board - the write-up wording is worth ten minutes ' +
        'in person if you want to bring the draft on Thursday.'),
      msg('m_ben_2', 'c_u_ben', 'u_ben', 'u_ins', 60 * 6,
        'Yes please. Should I send the paragraph over first so you have seen it?'),

      msg('m_min_1', 'c_u_min', 'u_min', 'u_ins', 40,
        L('Sorry to message directly. I am quite far behind after being ill for two weeks',
          'and I do not really know where to restart. Is there a sensible order to catch up',
          'in, or should I just book a slot?'))
    ];
  }

  /* One row per conversation, and the ONLY table the unread badge and the inbox
     ever read. tbl_Messages grows to ~15,000 rows over a semester and is past the
     connector's 5,000-row pagination cliff; tbl_MsgState stays at one row per
     student forever. Counters are decimal STRINGS because the column is text - if
     Excel is allowed to make them numbers, the flow's add() idiom breaks. */
  function seedMsgState() {
    return [
      { conversation_id: 'c_u_you', student_id: 'u_you',
        last_msg_at: isoAgo(55 * 60000), last_sender_id: 'u_ins',
        last_excerpt: 'No need to apologise - asking twice is cheaper than losing an evening. ' +
          'One thing while I have you: you are down f',
        unread_student: '1', unread_instructor: '0' },
      { conversation_id: 'c_u_ana', student_id: 'u_ana',
        last_msg_at: isoAgo(95 * 60000), last_sender_id: 'u_ana',
        last_excerpt: 'Thank you. One more - is 20 minutes enough to go through a merge that ' +
          'is producing duplicate rows, or should I b',
        unread_student: '0', unread_instructor: '2' },
      { conversation_id: 'c_u_ben', student_id: 'u_ben',
        last_msg_at: isoAgo(6 * 3600000), last_sender_id: 'u_ben',
        last_excerpt: 'Yes please. Should I send the paragraph over first so you have seen it?',
        unread_student: '0', unread_instructor: '1' },
      { conversation_id: 'c_u_min', student_id: 'u_min',
        last_msg_at: isoAgo(40 * 60000), last_sender_id: 'u_min',
        last_excerpt: 'Sorry to message directly. I am quite far behind after being ill for ' +
          'two weeks and I do not really know where t',
        unread_student: '0', unread_instructor: '1' }
    ];
  }

  /* Two seeded images, one per scope, so the whole picture round trip works with no
     network and no OneDrive: a screenshot pasted into a public thread, and one
     pasted into a private DM. The DM one is the interesting case - attach.get's
     rule for scope 'dm' is PARTICIPATION, not ownership, so the instructor can see
     an image a student pasted and the student can see one the instructor pasted,
     while a third student can see neither. data_b64 is a real (tiny) PNG, so an
     <img> built from it actually renders. */
  function seedAttachments() {
    return [
      {
        attachment_id: 'a_shot', owner_id: 'u_you', scope: 'thread', scope_id: 't_img',
        file_name: 'vscode-error.png', content_type: 'image/png',
        size_bytes: String(b64Bytes(SHOT_B64)),
        onedrive_item_id: 'mock-item-shot', onedrive_path: '/CodingClinic/attachments/a_shot.png',
        deleted: 'FALSE', created_at: daysAgo(3), data_b64: SHOT_B64
      },
      {
        attachment_id: 'a_dm_trace', owner_id: 'u_you', scope: 'dm', scope_id: 'c_u_you',
        file_name: 'traceback.png', content_type: 'image/png',
        size_bytes: String(b64Bytes(TRACE_B64)),
        onedrive_item_id: 'mock-item-trace', onedrive_path: '/CodingClinic/attachments/a_dm_trace.png',
        deleted: 'FALSE', created_at: isoAgo(60 * 33 * 60000), data_b64: TRACE_B64
      }
    ];
  }

  /* Nothing in the frontend reads tbl_MailLog - it is the reminders flow's
     idempotency ledger (a deterministic mail_id per recipient per day is the entire
     mechanism that stops E1-E4 double-sending). It is seeded only so the table
     exists with the right shape and admin tooling has something to look at. */
  function seedMailLog() {
    var today = sgtDateStr(new Date());
    return [
      { mail_id: 'e1_t_plt_u_you_' + today, user_id: 'u_you', email: 'you@u.nus.edu',
        kind: 'e1', ref_id: 't_plt', day_sgt: today, sent_at: hoursAgo(4),
        detail: 'reply by sgcoder' },
      { mail_id: 'e2_d1_b_next_1', user_id: 'u_ana', email: 'ana@u.nus.edu',
        kind: 'e2_d1', ref_id: 'b_next_1', day_sgt: today, sent_at: hoursAgo(9), detail: '' }
    ];
  }

  function seed() {
    var cfgObj = seedConfig();
    var upcoming = nextClinicDate(cfgObj);
    var past = addDaysStr(upcoming, -7);
    var threads = seedThreads();
    var posts = seedPosts();
    return {
      v: STATE_VERSION,
      anchor: upcoming,
      seeded_at: isoAt(nowMs()),
      config: cfgObj,
      users: seedUsers(),
      threads: threads,
      posts: posts,
      votes: seedVotes(threads, posts),
      slots: seedSlots(cfgObj, upcoming, past),
      bookings: seedBookings(past),
      proficiency: seedProficiency(),
      messages: seedMessages(),
      msgstate: seedMsgState(),
      attachments: seedAttachments(),
      maillog: seedMailLog(),
      codes: [],
      sessions: []
    };
  }

  /* ========================================================== state lifecycle */

  var S = null;
  var dirty = false;

  function touch() { dirty = true; }

  function save() {
    try { window.localStorage.setItem(STATE_KEY, JSON.stringify(S)); }
    catch (e) { /* quota or private mode: the demo just becomes session-only */ }
  }

  /* If the signed-in browser belongs to a seeded persona, keep them signed in
     across a reseed rather than bouncing them to the login page mid-demo. */
  function rehomeSession() {
    var token = lsGet('clinic_token');
    var cached = readJSON('clinic_user');
    if (!token || !cached || !cached.email) return;
    var u = userByEmail(cached.email);
    if (!u) return;
    S.sessions.push({
      token: token, user_id: u.user_id, email: u.email,
      expires_at: isoAt(nowMs() + sessionDays() * DAY_MS), created_at: isoAt(nowMs())
    });
  }

  function init() {
    if (S) return S;
    var saved = readJSON(STATE_KEY);
    if (saved && saved.v === STATE_VERSION && saved.config &&
        saved.anchor === nextClinicDate(saved.config)) {
      S = saved;
      return S;
    }
    /* No state, wrong version, or the clinic date has rolled past - start fresh
       so the booking page always shows a bookable Thursday. */
    S = seed();
    rehomeSession();
    touch();
    return S;
  }

  function sessionDays() { return parseInt(S.config.session_days, 10) || 30; }

  /* ================================================================ lookups */

  function userById(id) { return find(S.users, 'user_id', id); }
  function userByEmail(email) {
    var e = str(email).toLowerCase();
    for (var i = 0; i < S.users.length; i++) {
      if (str(S.users[i].email).toLowerCase() === e) return S.users[i];
    }
    return null;
  }
  function threadById(id) { return find(S.threads, 'thread_id', id); }
  function postById(id) { return find(S.posts, 'post_id', id); }
  function slotById(id) { return find(S.slots, 'slot_id', id); }
  function bookingById(id) { return find(S.bookings, 'booking_id', id); }
  function msgStateByConv(cid) { return find(S.msgstate, 'conversation_id', cid); }
  function attachmentById(id) { return find(S.attachments, 'attachment_id', id); }

  /* ------------------------------------------------------- v3 chat helpers */

  /* THE PARTICIPATION INVARIANT (contract §4.3), and the single most important
     line in the chat implementation.

     conversation_id is 'c_' + <student user_id>, and every student's user_id is
     shipped to every signed-in client on every non-anonymous post. So any student
     can compute any other student's conversation id. The defence is not to validate
     the id the caller sent - it is to never look at it:

       student    -> the conversation id is ALWAYS 'c_' + their own user_id. Whatever
                     conversation_id or to_user_id arrived in the payload is IGNORED,
                     not rejected. A student cannot construct a reference to anyone
                     else's conversation, so there is nothing to attack.
       instructor -> the supplied id is used, and must already exist in msgstate.

     Ignoring rather than validating matters: a student who hand-crafts a payload
     naming a classmate's conversation gets their OWN conversation back, silently.
     Used identically by messages.get, messages.send and messages.read - if any one
     of the three trusted the payload, that one would be the hole. */
  function convIdFor(me, data) {
    if (isMsgInstructor(me)) return trimmed(data && data.conversation_id);
    return 'c_' + me.user_id;
  }

  function chatEnabled() { return isTrue(S.config.chat_enabled); }
  function archiveMode() { return isTrue(S.config.archive_mode); }

  function requireChat() {
    if (!chatEnabled()) {
      fail('forbidden', 'Direct messages are switched off for this course.');
    }
  }
  /* The board is read-only at the end of semester. Every write action checks this
     FIRST, before it validates anything else, exactly like the flow's guard order. */
  function requireWritable() {
    if (archiveMode()) {
      fail('forbidden', 'The board is archived for the semester — it is read-only now.');
    }
  }

  /* tbl_MsgState.last_excerpt is the first 120 characters of the last message with
     newlines stripped. It is the ONLY message content the inbox ever sees, which is
     what keeps messages.list off tbl_Messages entirely. */
  function dmExcerpt(bodyMd) {
    return str(bodyMd).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').slice(0, 120);
  }

  /* A row is readable only once its lag has expired - see the header block. Seeded
     rows carry visible_at 0 and are therefore always visible. */
  function msgVisible(m) {
    return !isTrue(m.deleted) && (!m.visible_at || m.visible_at <= nowMs());
  }

  function instructorIds() {
    var admins = adminEmails(S.config);
    var out = [];
    for (var i = 0; i < S.users.length; i++) {
      var u = S.users[i];
      if (str(u.role).toLowerCase() === 'instructor' ||
          admins.indexOf(str(u.email).toLowerCase()) !== -1) {
        out.push(u.user_id);
      }
    }
    return out;
  }
  /* config.instructor_user_id wins when it is set; otherwise fall back to the first
     row that looks like an instructor. Blank only when there is nobody at all, and
     that blank is what hides the "message the instructor" button. */
  function primaryInstructorId() {
    var pinned = trimmed(S.config.instructor_user_id);
    if (pinned) return pinned;
    var ids = instructorIds();
    return ids.length ? ids[0] : '';
  }

  /* The `other` block in messages.list / messages.get. is_instructor is computed the
     same way role_eff_m is, not from tbl_Users.role. */
  function otherParty(userId) {
    if (!userId) return null;
    var u = userById(userId);
    if (!u) return { user_id: userId, display_name: 'Former student', is_instructor: false };
    return {
      user_id: u.user_id,
      display_name: u.display_name,
      is_instructor: isMsgInstructor(u)
    };
  }

  function actorFor(token) {
    var t = token || lsGet('clinic_token');
    if (!t) return null;
    var s = find(S.sessions, 'token', t);
    if (!s) return null;
    if (Date.parse(s.expires_at) <= nowMs()) {
      removeWhere(S.sessions, function (row) { return row.token === t; });
      touch();
      return null;
    }
    return userById(s.user_id);
  }

  function requireUser(token) {
    var u = actorFor(token);
    if (!u) fail('unauthorized', 'Your session has expired. Please sign in again.');
    return u;
  }

  function requireInstructor(token) {
    var u = requireUser(token);
    if (u.role !== 'instructor') {
      fail('forbidden', 'That area is for the instructor only.');
    }
    return u;
  }

  function mintSession(user) {
    var s = {
      token: nid('tok'), user_id: user.user_id, email: user.email,
      expires_at: isoAt(nowMs() + sessionDays() * DAY_MS), created_at: isoAt(nowMs())
    };
    S.sessions.push(s);
    user.last_login = isoAt(nowMs());
    touch();
    return s;
  }

  /* ================================================================ shaping */

  function selfUser(u) {
    return { user_id: u.user_id, display_name: u.display_name, role: u.role, email: u.email };
  }
  /* Latest self-rating for a user, or null - tbl_Proficiency is append-only, so
     "current" means the row with the newest recorded_at, never an update in place. */
  function latestProficiencyRow(userId) {
    var rows = where(S.proficiency, function (p) { return p.user_id === userId; });
    if (!rows.length) return null;
    var latest = rows[0];
    for (var i = 1; i < rows.length; i++) {
      if (Date.parse(rows[i].recorded_at) > Date.parse(latest.recorded_at)) latest = rows[i];
    }
    return latest;
  }
  function proficiencyShape(row) {
    if (!row) return null;
    return { r: row.r, python: row.python, linux: row.linux, wave: row.wave, recorded_at: row.recorded_at };
  }
  /* SPEC §5 v2 addition: full_name/phone/proficiency are only ever added to the
     CALLER's own user object, and only from meta.bootstrap and profile.update -
     auth.* and every PublicAuthor/PublicUser keep using plain selfUser/publicUser. */
  function selfUserFull(u) {
    var out = selfUser(u);
    out.full_name = u.full_name || '';
    out.phone = u.phone || '';
    out.proficiency = proficiencyShape(latestProficiencyRow(u.user_id));
    /* v3: the four email opt-outs, as REAL booleans. They are opt-out columns, so a
       blank cell means "yes, send it" - see notFalse(). When this key is absent
       altogether (an app flow that has not been re-imported), profile.html must show
       one .inert-note instead of four switches that appear to save and do not. */
    out.notify = {
      replies: notFalse(u.notify_replies),
      reminders: notFalse(u.notify_reminders),
      escalation: notFalse(u.notify_escalation),
      digest: notFalse(u.notify_digest)
    };
    return out;
  }
  function publicUser(u) {
    return { user_id: u.user_id, display_name: u.display_name };
  }
  /* SPEC §5: anonymous content must never carry the real id in the payload. */
  function publicAuthor(authorId, isAnonymous) {
    if (isAnonymous) return { user_id: 'anon', display_name: 'Anonymous' };
    var u = userById(authorId);
    return u ? publicUser(u) : { user_id: authorId, display_name: 'Former student' };
  }

  function voteCount(type, id) {
    return countWhere(S.votes, function (v) {
      return v.target_type === type && v.target_id === id;
    });
  }
  function replyCount(threadId) {
    return countWhere(S.posts, function (p) {
      return p.thread_id === threadId && !p.deleted;
    });
  }

  function excerptOf(bodyMd) {
    if (Clinic.md && Clinic.md.strip) return Clinic.md.strip(bodyMd, 220);
    return str(bodyMd).replace(/\s+/g, ' ').slice(0, 220);
  }

  /* v3 card flags. Both mirror a flow-side Query, and the SOURCE SET of each one is
     the whole point:

       instructorReplied  is computed from NON-ANONYMOUS posts only, because the flow
                          computes it from f_posts_named, which already drops
                          is_anonymous='TRUE'. An anonymous instructor reply that lit
                          this flag would de-anonymise the instructor on that card -
                          and a badge is a stronger identifier than a display name.
                          t_ide in the seed above exists to catch exactly that.
       hasEndorsed        is computed from ALL posts including anonymous ones, because
                          endorsing an anonymous answer says nothing about who wrote
                          it. Different set, deliberately, not an oversight. */
  function instructorReplied(threadId) {
    var ids = instructorIds();
    return countWhere(S.posts, function (p) {
      return p.thread_id === threadId && !p.deleted && !p.is_anonymous &&
        ids.indexOf(p.author_id) !== -1;
    }) > 0;
  }
  function hasEndorsed(threadId) {
    return countWhere(S.posts, function (p) {
      return p.thread_id === threadId && !p.deleted && isTrue(p.endorsed);
    }) > 0;
  }

  function threadCard(t, me) {
    return {
      thread_id: t.thread_id,
      title: t.title,
      category: t.category,
      language: t.language || '',
      labels: (t.labels || []).slice(),
      author: publicAuthor(t.author_id, t.is_anonymous),
      status: t.status,
      pinned: !!t.pinned,
      created_at: t.created_at,
      reply_count: replyCount(t.thread_id),
      upvotes: voteCount('thread', t.thread_id),
      accepted: !!t.accepted_post_id,
      /* SPEC §5 (patched): "did the caller write this?" without unmasking who.
         True for the caller's own ANONYMOUS threads too, while `author` stays
         {user_id:"anon"} - which is what lets booking.html list your anonymous
         threads and thread.html show you the accept button on them. It only ever
         describes the requesting user, so it reveals nothing about anyone else. */
      mine: !!(me && t.author_id === me.user_id),
      /* EXTENSION beyond SPEC §5 - a plain-text excerpt so index.html can search
         bodies as well as titles (SPEC §8). Safe to ignore; treat as optional. */
      excerpt: excerptOf(t.body_md),

      /* --- v3 (contract §5.2). Four keys, all absent-tolerant on the client. --- */
      locked: isTrue(t.locked),
      /* A thread id, or ''. NON-EMPTY IS WHAT EXCLUDES A THREAD FROM THE UNANSWERED
         COUNT AND THE UNANSWERED FILTER - never t.status. The duplicate ops
         deliberately do not rewrite status (contract §4.4), so a duplicate can be
         open, answered, or anything else; duplicate_of is the only reliable test,
         and it is the same test E3/E4 make flow-side. */
      duplicate_of: trimmed(t.duplicate_of),
      instructor_replied: instructorReplied(t.thread_id),
      has_endorsed: hasEndorsed(t.thread_id)
    };
  }

  function threadFull(t, me) {
    var card = threadCard(t, me);
    card.body_md = t.body_md;
    card.accepted_post_id = t.accepted_post_id || '';
    card.resolved_via = t.resolved_via || '';
    /* locked and duplicate_of come along from threadCard. duplicate_of_title is
       deliberately NOT here: resolving it flow-side would cost a second unfiltered
       read of tbl_Threads (+1 call, ~15 s). The client links to
       thread.html?id=<duplicate_of> and that page supplies its own title. */
    return card;
  }

  function postShape(p) {
    return {
      post_id: p.post_id,
      thread_id: p.thread_id,
      parent_post_id: p.parent_post_id || '',
      body_md: p.deleted ? '' : p.body_md,
      author: publicAuthor(p.author_id, p.is_anonymous),
      is_accepted: !!p.is_accepted,
      created_at: p.created_at,
      upvotes: voteCount('post', p.post_id),
      deleted: !!p.deleted,
      /* v3. Note what is NOT here: endorsed_by and endorsed_at are stored but never
         returned to any client. "The instructor vouches for this" is public; which
         of the two instructor identities did it, and when, is not. */
      endorsed: isTrue(p.endorsed)
    };
  }

  function slotShape(s) {
    return {
      slot_id: s.slot_id, date: s.date, start_time: s.start_time,
      duration_min: s.duration_min, status: s.status
    };
  }

  function bookingShape(b) {
    return {
      booking_id: b.booking_id, slot_id: b.slot_id, thread_id: b.thread_id,
      full_name: b.full_name, phone: b.phone, email: b.email,
      note: b.note, status: b.status
    };
  }

  function bootConfig() {
    return {
      site_title: S.config.site_title,
      categories: csvList(S.config.categories),
      labels: csvList(S.config.labels),
      languages: csvList(S.config.languages),
      notice_text: S.config.notice_text,
      clinic: {
        day: S.config.clinic_day,
        start: S.config.clinic_start,
        end: S.config.clinic_end,
        slot_minutes: parseInt(S.config.slot_minutes, 10) || 20,
        cutoff_day: S.config.booking_cutoff_day,
        cutoff_time: S.config.booking_cutoff_time
      },
      passcode_mode: isTrue(S.config.passcode_mode),

      /* ---- v3 (contract §5.1). Seven keys, every one of them already converted
         from the flat string->string config dictionary: real booleans, real
         integers. Doing that server-side is not tidiness - `if (cfg.chat_enabled)`
         on the raw string 'FALSE' is true, and that mistake switches chat ON for a
         course that switched it off. ---- */

      /* Who wears the instructor badge. PublicAuthor does NOT carry a role (contract
         §5.6) - the client compares author.user_id against this list instead. That
         is what makes anonymity safe by construction: publicAuthor() replaces an
         anonymous author's id with the literal 'anon', which can never appear here.
         Absent -> [] -> no badge anywhere, never a WRONG badge. */
      instructor_ids: instructorIds(),
      /* Who a student's DM is addressed to. Blank -> the "message the instructor"
         button hides itself and messages.send returns bad_request. */
      instructor_user_id: primaryInstructorId(),
      chat_enabled: chatEnabled(),
      attachments_enabled: isTrue(S.config.attachments_enabled),
      attachment_max_kb: parseInt(S.config.attachment_max_kb, 10) || 1536,
      /* 90, not 45. At a 60-student cohort a 45 s poll was 180 Excel calls a minute
         against a documented ceiling of 100 - it would have taken sign-in down (R1). */
      messages_poll_seconds: parseInt(S.config.messages_poll_seconds, 10) || 90,
      archive_mode: archiveMode()
    };
  }

  /* Leaderboard aggregation (SPEC §8). Anonymous threads and posts are excluded
     on purpose: contrib carries real user_ids, so counting anonymous activity
     would let somebody diff the numbers before and after a post appears and work
     out who wrote it. Anonymity beats leaderboard points. */
  function contribFrom(sinceMs) {
    var rows = {};
    function row(uid) {
      if (!rows[uid]) rows[uid] = { user_id: uid, replies: 0, accepted: 0, upvotes_received: 0 };
      return rows[uid];
    }
    var i;
    for (i = 0; i < S.users.length; i++) row(S.users[i].user_id);

    function inWindow(iso) {
      return !sinceMs || Date.parse(iso) >= sinceMs;
    }

    for (i = 0; i < S.posts.length; i++) {
      var p = S.posts[i];
      if (p.deleted || p.is_anonymous || !inWindow(p.created_at)) continue;
      var r = row(p.author_id);
      r.replies += 1;
      if (p.is_accepted) r.accepted += 1;
    }

    for (i = 0; i < S.votes.length; i++) {
      var v = S.votes[i];
      if (!inWindow(v.created_at)) continue;
      var target = v.target_type === 'thread' ? threadById(v.target_id) : postById(v.target_id);
      if (!target || target.deleted || target.is_anonymous) continue;
      row(target.author_id).upvotes_received += 1;
    }

    var out = [];
    for (var key in rows) if (Object.prototype.hasOwnProperty.call(rows, key)) out.push(rows[key]);
    return out;
  }

  /* ============================================================== validation */

  function needText(value, field, min, max) {
    var v = trimmed(value);
    if (v.length < min) fail('bad_request', field + ' is too short.');
    if (v.length > max) fail('bad_request', field + ' is too long (max ' + max + ' characters).');
    return v;
  }

  /* Proficiency anchors (SPEC §4) only mean the same thing for everyone if the
     scale is enforced: integer 1-5. */
  function needRating(value, field) {
    var n = parseInt(value, 10);
    if (!(n >= 1 && n <= 5)) fail('bad_request', field + ' rating must be between 1 and 5.');
    return n;
  }

  function validPhone(raw) {
    var digits = str(raw).replace(/[\s()\-]/g, '');
    if (digits.indexOf('+65') === 0) digits = digits.slice(3);
    else if (digits.indexOf('65') === 0 && digits.length === 10) digits = digits.slice(2);
    return /^[89]\d{7}$/.test(digits);
  }

  function looksLikeEmail(raw) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed(raw));
  }

  /* ================================================================ handlers */

  var H = {};

  /* ------------------------------------------------------------------ auth */

  H['auth.request_code'] = function (data) {
    var email = trimmed(data.email).toLowerCase();
    if (!looksLikeEmail(email)) fail('bad_request', 'That does not look like an email address.');
    /* Demo mode accepts any domain and the code is always 000000. The live flow
       checks allowed_domains and emails a random code. */
    S.codes.push({
      code_id: nid('c'), email: email, code: '000000',
      expires_at: isoAt(nowMs() + (parseInt(S.config.code_ttl_minutes, 10) || 10) * 60000),
      used: false
    });
    touch();
    return { sent: true };
  };

  function grantSession(email, displayName) {
    var user = userByEmail(email);
    if (!user) {
      var name = trimmed(displayName);
      /* login.html relies on this exact message to know it should show the
         "pick a display name" step (SPEC §8). */
      if (!name) fail('bad_request', 'display_name_required');
      if (name.length < 2 || name.length > 40) {
        fail('bad_request', 'Pick a display name between 2 and 40 characters.');
      }
      user = {
        user_id: nid('u'), email: email, display_name: name,
        role: roleForEmail(S.config, email),
        created_at: isoAt(nowMs()), last_login: isoAt(nowMs())
      };
      S.users.push(user);
      touch();
    }
    var s = mintSession(user);
    return { token: s.token, user: selfUser(user), expires_at: s.expires_at };
  }

  H['auth.verify'] = function (data) {
    var email = trimmed(data.email).toLowerCase();
    if (!looksLikeEmail(email)) fail('bad_request', 'That does not look like an email address.');
    if (trimmed(data.code) !== '000000') {
      fail('bad_request', 'That code is not right. This is the demo site \u2014 the code is always 000000.');
    }
    return grantSession(email, data.display_name);
  };

  H['auth.passcode'] = function (data) {
    if (!isTrue(S.config.passcode_mode)) {
      fail('forbidden', 'Class passcode sign-in is switched off. Use the emailed code instead.');
    }
    var email = trimmed(data.email).toLowerCase();
    if (!looksLikeEmail(email)) fail('bad_request', 'That does not look like an email address.');
    if (trimmed(data.passcode) !== str(S.config.class_passcode)) {
      fail('forbidden', 'That class passcode is not right.');
    }
    return grantSession(email, data.display_name);
  };

  /* ------------------------------------------------------------------- app */

  H['meta.bootstrap'] = function (data, token) {
    var me = requireUser(token);
    return { config: bootConfig(), user: selfUserFull(me) };
  };

  H['threads.list'] = function (data, token) {
    var me = requireUser(token);
    var live = where(S.threads, function (t) { return !t.deleted; });
    return {
      threads: live.map(function (t) { return threadCard(t, me); }),
      users: S.users.map(publicUser),
      contrib: contribFrom(0),
      /* EXTENSION beyond SPEC §5: same shape, this calendar month only, so the
         leaderboard's "This month" tab (SPEC §8) is computable client-side. */
      contrib_month: contribFrom(monthStartMs())
    };
  };

  H['threads.get'] = function (data, token) {
    var me = requireUser(token);
    var t = threadById(trimmed(data.thread_id));
    if (!t || (t.deleted && me.role !== 'instructor')) {
      fail('not_found', 'That discussion no longer exists.');
    }
    var posts = where(S.posts, function (p) { return p.thread_id === t.thread_id; })
      .sort(function (a, b) { return Date.parse(a.created_at) - Date.parse(b.created_at); });
    var mine = where(S.votes, function (v) { return v.user_id === me.user_id; })
      .map(function (v) { return v.target_id; });
    return { thread: threadFull(t, me), posts: posts.map(postShape), my_votes: mine };
  };

  /* v3: attachment_ids arrives as an array of ids and is stored comma-joined,
     because tbl_Threads / tbl_Posts have one text column for it. Unknown ids are
     dropped rather than rejected - an upload that failed halfway should not cost the
     student the post they spent ten minutes writing. */
  function joinAttachments(ids) {
    var list = ids || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var id = trimmed(list[i]);
      if (id && attachmentById(id)) out.push(id);
    }
    return out.join(',');
  }

  H['threads.create'] = function (data, token) {
    var me = requireUser(token);
    requireWritable();                       /* v3: first guard, before validation */
    var title = needText(data.title, 'Title', 4, 200);
    var body = needText(data.body_md, 'Body', 2, 20000);
    var category = trimmed(data.category);
    if (csvList(S.config.categories).indexOf(category) === -1) {
      fail('bad_request', 'Choose a category from the list.');
    }
    /* SPEC §4 v2 "language boards": required, same error shape as category
       above - but (matching the live flow) only checked for non-empty, not
       re-validated against Config languages. */
    var language = trimmed(data.language);
    if (!language) {
      fail('bad_request', 'Choose a language board for this question.');
    }
    var known = csvList(S.config.labels);
    var labels = (data.labels || []).map(trimmed).filter(function (l) {
      return known.indexOf(l) !== -1;
    }).slice(0, 5);

    var t = withThreadCols({
      thread_id: nid('t'), title: title, body_md: body, category: category,
      language: language, labels: labels, author_id: me.user_id,
      is_anonymous: !!data.is_anonymous,
      status: 'open', accepted_post_id: '', resolved_via: '',
      pinned: false, deleted: false, created_at: isoAt(nowMs()),
      attachment_ids: joinAttachments(data.attachment_ids)
    });
    S.threads.push(t);
    touch();
    return { thread_id: t.thread_id };
  };

  /* v3. A locked thread refuses new replies and new votes, but stays fully readable.
     The message names the escape hatch on purpose: locking a thread must not leave a
     student with nowhere to go, and chat is that somewhere. */
  function requireUnlocked(t) {
    if (t && isTrue(t.locked)) {
      fail('forbidden',
        'This discussion is locked. Message the instructor if you need to add something.');
    }
  }

  H['posts.create'] = function (data, token) {
    var me = requireUser(token);
    requireWritable();
    var t = threadById(trimmed(data.thread_id));
    if (!t || t.deleted) fail('not_found', 'That discussion no longer exists.');
    requireUnlocked(t);
    var body = needText(data.body_md, 'Reply', 2, 20000);

    var parentId = trimmed(data.parent_post_id);
    if (parentId) {
      var parent = postById(parentId);
      if (!parent || parent.thread_id !== t.thread_id || parent.deleted) {
        fail('not_found', 'The reply you are responding to has gone.');
      }
      /* One level of nesting only (SPEC §4): a reply to a reply lands flat
         underneath the same top-level post. */
      parentId = parent.parent_post_id || parent.post_id;
    }

    var p = withPostCols({
      post_id: nid('p'), thread_id: t.thread_id, parent_post_id: parentId,
      body_md: body, author_id: me.user_id, is_anonymous: !!data.is_anonymous,
      is_accepted: false, deleted: false, created_at: isoAt(nowMs()),
      attachment_ids: joinAttachments(data.attachment_ids)
    });
    S.posts.push(p);
    touch();
    return { post_id: p.post_id };
  };

  H['votes.toggle'] = function (data, token) {
    var me = requireUser(token);
    requireWritable();
    var type = trimmed(data.target_type);
    var id = trimmed(data.target_id);
    if (type !== 'thread' && type !== 'post') fail('bad_request', 'Unknown vote target.');

    var target = type === 'thread' ? threadById(id) : postById(id);
    if (!target || target.deleted) fail('not_found', 'That post no longer exists.');
    /* The lock applies to the whole discussion, so a vote on a POST inside a locked
       thread is refused too - the flow reaches the thread row the same way, via the
       post's thread_id. */
    requireUnlocked(type === 'thread' ? target : threadById(target.thread_id));
    if (target.author_id === me.user_id) {
      fail('forbidden', 'You cannot upvote your own post.');
    }

    var existing = null;
    for (var i = 0; i < S.votes.length; i++) {
      var v = S.votes[i];
      if (v.target_type === type && v.target_id === id && v.user_id === me.user_id) {
        existing = v; break;
      }
    }
    if (existing) {
      removeWhere(S.votes, function (row) { return row === existing; });
      touch();
      return { voted: false, count: voteCount(type, id) };
    }
    S.votes.push({
      vote_id: nid('v'), target_type: type, target_id: id,
      user_id: me.user_id, created_at: isoAt(nowMs())
    });
    touch();
    return { voted: true, count: voteCount(type, id) };
  };

  H['threads.accept'] = function (data, token) {
    var me = requireUser(token);
    requireWritable();
    /* Deliberately NOT lock-guarded. Locking stops the conversation growing; the
       asker marking which existing reply solved it is exactly the tidy-up a locked
       thread wants, and the flow does not guard it either (contract §5.4 lists the
       lock guard for posts.create and votes.toggle only). */
    var t = threadById(trimmed(data.thread_id));
    if (!t || t.deleted) fail('not_found', 'That discussion no longer exists.');
    if (t.author_id !== me.user_id && me.role !== 'instructor') {
      fail('forbidden', 'Only the person who asked (or the instructor) can mark an answer.');
    }
    var p = postById(trimmed(data.post_id));
    if (!p || p.thread_id !== t.thread_id || p.deleted) {
      fail('not_found', 'That reply no longer exists.');
    }
    if (p.parent_post_id) {
      fail('bad_request', 'Only a top-level reply can be marked as the answer.');
    }
    for (var i = 0; i < S.posts.length; i++) {
      if (S.posts[i].thread_id === t.thread_id) S.posts[i].is_accepted = false;
    }
    p.is_accepted = true;
    t.accepted_post_id = p.post_id;
    t.status = 'answered';
    if (t.resolved_via !== 'live') t.resolved_via = 'async';
    touch();
    return { ok: true };
  };

  H['profile.update'] = function (data, token) {
    var me = requireUser(token);

    /* SPEC §5 v2: display_name/full_name/phone are each independently optional.
       A field that is absent (undefined) is left exactly as it was - never
       blanked - mirroring admin.booking.update's optional-field pattern below.
       Only display_name is validated, and only when it is actually present;
       full_name/phone accept an explicit "" as a deliberate clear. */
    if (data.display_name !== undefined) {
      me.display_name = needText(data.display_name, 'Display name', 2, 40);
    }
    if (data.full_name !== undefined) {
      me.full_name = trimmed(data.full_name);
    }
    if (data.phone !== undefined) {
      me.phone = trimmed(data.phone);
    }
    /* Proficiency is never edited in place - a fresh row is appended, stamped
       with the wave in force right now, so baseline and endterm ratings both
       survive side by side (SPEC §4). */
    if (data.proficiency) {
      var prof = data.proficiency;
      S.proficiency.push({
        prof_id: nid('pf'), user_id: me.user_id,
        r: needRating(prof.r, 'R'), python: needRating(prof.python, 'Python'),
        linux: needRating(prof.linux, 'Bash/Linux'),
        wave: S.config.proficiency_wave || 'baseline', recorded_at: isoAt(nowMs())
      });
    }
    /* v3: the four email opt-outs. There is no separate preferences action - this
       reuses the present-vs-absent idiom above verbatim, PER KEY. An absent key
       keeps the stored value; a present key overwrites it. That matters because
       profile.html can send `notify: {digest: false}` on its own, and a merge that
       treated the object as a whole would silently re-enable the other three.
       The columns are stored as the strings 'TRUE'/'FALSE', not booleans - the
       workbook has no boolean type and a mixed-type column is a known corruption
       trap in the Excel connector. */
    if (data.notify) {
      var NOTIFY_KEYS = ['replies', 'reminders', 'escalation', 'digest'];
      for (var n = 0; n < NOTIFY_KEYS.length; n++) {
        var k = NOTIFY_KEYS[n];
        if (data.notify[k] === undefined) continue;
        me['notify_' + k] = (data.notify[k] === true || str(data.notify[k]).toLowerCase() === 'true')
          ? 'TRUE' : 'FALSE';
      }
    }
    touch();
    return { user: selfUserFull(me) };
  };

  /* ---------------------------------------------------------------- slots */

  function activeBookingsFor(userId) {
    return where(S.bookings, function (b) {
      if (b.user_id !== userId || b.status !== 'confirmed') return false;
      var s = slotById(b.slot_id);
      return !!s && Date.parse(isoFromSgt(s.date, s.start_time)) >= nowMs();
    });
  }

  H['slots.list'] = function (data, token) {
    var me = requireUser(token);
    var horizon = nowMs() + 21 * DAY_MS;
    var floor = todayStartMs();
    var upcoming = where(S.slots, function (s) {
      var at = Date.parse(isoFromSgt(s.date, s.start_time));
      return at >= floor && at <= horizon;
    }).sort(function (a, b) {
      return Date.parse(isoFromSgt(a.date, a.start_time)) -
        Date.parse(isoFromSgt(b.date, b.start_time));
    });

    var cutoffIso = upcoming.length
      ? cutoffForDate(S.config, upcoming[0].date)
      : nextCutoffIso(S.config);

    var mine = activeBookingsFor(me.user_id);
    return {
      slots: upcoming.map(slotShape),
      my_booking: mine.length ? bookingShape(mine[0]) : null,
      cutoff_iso: cutoffIso
    };
  };

  H['slots.book'] = function (data, token) {
    var me = requireUser(token);
    var slot = slotById(trimmed(data.slot_id));
    if (!slot) fail('not_found', 'That slot no longer exists.');

    var cutoffIso = cutoffForDate(S.config, slot.date);
    if (nowMs() > Date.parse(cutoffIso)) {
      fail('cutoff_passed', 'Bookings for that clinic closed at the cutoff. Email the instructor if it is urgent.');
    }
    if (slot.status !== 'open') fail('conflict', 'Somebody just took that slot. Pick another one.');

    var max = parseInt(S.config.max_active_bookings, 10) || 1;
    if (activeBookingsFor(me.user_id).length >= max) {
      fail('conflict', 'You already have a clinic booking. Cancel it first if you want to move.');
    }

    var t = threadById(trimmed(data.thread_id));
    if (!t || t.deleted) fail('not_found', 'Pick one of your own discussion threads.');
    if (t.author_id !== me.user_id) {
      fail('forbidden', 'You can only book a slot about a thread you posted yourself.');
    }

    var fullName = needText(data.full_name, 'Full name', 2, 80);
    var email = trimmed(data.email);
    if (!looksLikeEmail(email)) fail('bad_request', 'Enter the email address you want the confirmation sent to.');
    if (!validPhone(data.phone)) {
      fail('bad_request', 'Enter a Singapore mobile number, e.g. 9123 4567.');
    }
    var note = str(data.note).slice(0, 300);

    var b = {
      booking_id: nid('b'), slot_id: slot.slot_id, user_id: me.user_id,
      full_name: fullName, phone: trimmed(data.phone), email: email,
      thread_id: t.thread_id, note: note, status: 'confirmed',
      attendance: '', resolved_how: '', created_at: isoAt(nowMs())
    };
    S.bookings.push(b);
    slot.status = 'booked';
    touch();
    return { booking_id: b.booking_id };
  };

  H['slots.cancel'] = function (data, token) {
    var me = requireUser(token);
    var b = bookingById(trimmed(data.booking_id));
    if (!b || b.user_id !== me.user_id) fail('not_found', 'We could not find that booking.');
    if (b.status !== 'confirmed') fail('conflict', 'That booking has already been cancelled.');

    var slot = slotById(b.slot_id);
    if (slot && nowMs() > Date.parse(cutoffForDate(S.config, slot.date))) {
      fail('cutoff_passed', 'It is past the cutoff \u2014 email the instructor to cancel.');
    }
    b.status = 'cancelled';
    if (slot && slot.status === 'booked') slot.status = 'open';
    touch();
    return { ok: true };
  };

  /* ---------------------------------------------------------------- admin */

  H['admin.export'] = function (data, token) {
    requireInstructor(token);
    /* The one place anonymity is pierced: raw rows, real author ids, booking PII.
       Booleans are real booleans and labels are arrays - the live ADMIN flow must
       coerce Excel's "TRUE"/"FALSE" strings and comma lists to match.

       v3 DELIBERATELY DOES NOT ADD messages / msgstate / attachments HERE, even
       though the tables now exist. The export ends up in a spreadsheet that gets
       shared; private one-to-one conversations and pasted screenshots are not
       course analytics, and PRIVACY.md tells students chat is private. Widening
       this is a policy decision for the instructor and a PRIVACY.md edit, not a
       side effect of adding the tables. The archive tool (tools/archive_messages.py)
       is the sanctioned route to that data. */
    return {
      threads: clone(S.threads),
      posts: clone(S.posts),
      votes: clone(S.votes),
      users: clone(S.users),
      slots: clone(S.slots),
      bookings: clone(S.bookings),
      proficiency: clone(S.proficiency),
      config: clone(S.config)
    };
  };

  H['admin.moderate'] = function (data, token) {
    var actor = requireInstructor(token);
    var op = trimmed(data.op);
    var t, p;

    function needThread() {
      var th = threadById(trimmed(data.thread_id));
      if (!th) fail('not_found', 'That discussion no longer exists.');
      return th;
    }
    function needPost() {
      var po = postById(trimmed(data.post_id));
      if (!po) fail('not_found', 'That reply no longer exists.');
      return po;
    }

    switch (op) {
      case 'delete_thread':
        t = needThread(); t.deleted = true; break;
      case 'restore_thread':                       /* not in SPEC §5's op list, but
                                                      SPEC §8 tab 2 offers restore */
        t = needThread(); t.deleted = false; break;
      case 'delete_post':
        p = needPost(); p.deleted = true;
        if (p.is_accepted) {
          p.is_accepted = false;
          t = threadById(p.thread_id);
          if (t && t.accepted_post_id === p.post_id) {
            t.accepted_post_id = ''; t.status = 'open'; t.resolved_via = '';
          }
        }
        break;
      case 'restore_post':
        p = needPost(); p.deleted = false; break;
      case 'pin_thread':
        t = needThread(); t.pinned = true; break;
      case 'unpin_thread':
        t = needThread(); t.pinned = false; break;
      case 'set_labels':
        t = needThread();
        var known = csvList(S.config.labels);
        t.labels = (data.labels || []).map(trimmed).filter(function (l) {
          return known.indexOf(l) !== -1;
        });
        break;
      case 'set_category':
        t = needThread();
        var cat = trimmed(data.category);
        if (csvList(S.config.categories).indexOf(cat) === -1) {
          fail('bad_request', 'Unknown category.');
        }
        t.category = cat;
        break;
      case 'set_resolved_via':
        t = needThread();
        var via = trimmed(data.resolved_via);
        if (['', 'live', 'async'].indexOf(via) === -1) fail('bad_request', 'Unknown resolution.');
        t.resolved_via = via;
        break;

      /* ---------------------------------------------------------------- v3 --
         Six new ops (contract §4.4). Every one of them writes the SMALLEST
         possible set of columns. */

      case 'lock_thread':
        t = needThread(); t.locked = 'TRUE'; break;
      case 'unlock_thread':
        t = needThread(); t.locked = 'FALSE'; break;

      /* THE DUPLICATE OPS WRITE duplicate_of AND NOTHING ELSE. It is tempting to
         also set locked:'TRUE' and status:'answered' here, and it is wrong: the
         prior status is nowhere recorded, so clear_duplicate could never restore
         it. A thread that already had an accepted answer would come back as 'open'
         while accepted_post_id still pointed at a post - thread.html would then
         render an accepted-answer ribbon on a thread the board counts as
         unanswered, and the escalation email would chase the instructor about a
         question that was answered a week ago. Locking a duplicate is a SEPARATE,
         explicit lock_thread call (the dialog's "also lock this discussion"
         checkbox, ticked by default). Keeping the two states independent is the
         only way both can be restored correctly. */
      case 'set_duplicate':
        t = needThread();
        var dupId = trimmed(data.duplicate_of);
        if (!dupId) fail('bad_request', 'Pick the thread this duplicates.');
        if (dupId === t.thread_id) fail('bad_request', 'A thread cannot duplicate itself.');
        if (!threadById(dupId)) fail('not_found', 'That original discussion no longer exists.');
        t.duplicate_of = dupId;
        break;
      case 'clear_duplicate':
        t = needThread(); t.duplicate_of = ''; break;

      /* Endorsement is NOT the accepted answer. The asker accepts; the instructor
         endorses; a post can be either, both or neither. endorsed_by/endorsed_at are
         recorded but never leave the server (postShape). */
      case 'endorse_post':
        p = needPost();
        p.endorsed = 'TRUE';
        p.endorsed_by = actor.user_id;
        p.endorsed_at = isoAt(nowMs());
        break;
      case 'unendorse_post':
        p = needPost();
        p.endorsed = 'FALSE'; p.endorsed_by = ''; p.endorsed_at = '';
        break;

      default:
        fail('bad_request', 'Unknown moderation action: ' + op);
    }
    touch();
    return { ok: true };
  };

  H['admin.slots.upsert'] = function (data, token) {
    requireInstructor(token);
    var rows = data.slots || [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var existing = row.slot_id ? slotById(trimmed(row.slot_id)) : null;
      if (existing) {
        if (row.date) existing.date = trimmed(row.date);
        if (row.start_time) existing.start_time = trimmed(row.start_time);
        if (row.duration_min) existing.duration_min = parseInt(row.duration_min, 10) || existing.duration_min;
        if (row.status) existing.status = trimmed(row.status);
      } else {
        if (!row.date || !row.start_time) fail('bad_request', 'A slot needs a date and a start time.');
        S.slots.push({
          slot_id: nid('s'), date: trimmed(row.date), start_time: trimmed(row.start_time),
          duration_min: parseInt(row.duration_min, 10) || (parseInt(S.config.slot_minutes, 10) || 20),
          status: trimmed(row.status) || 'open', created_at: isoAt(nowMs())
        });
      }
    }
    touch();
    return { ok: true };
  };

  H['admin.slots.generate'] = function (data, token) {
    requireInstructor(token);
    var weeks = parseInt(data.weeks, 10) || 1;
    if (weeks < 1) weeks = 1;
    if (weeks > 12) weeks = 12;
    var times = slotStartTimes(S.config);
    var duration = parseInt(S.config.slot_minutes, 10) || 20;
    var date = nextClinicDate(S.config);
    var created = 0;
    for (var w = 0; w < weeks; w++) {
      for (var i = 0; i < times.length; i++) {
        var clash = false;
        for (var k = 0; k < S.slots.length; k++) {
          if (S.slots[k].date === date && S.slots[k].start_time === times[i]) { clash = true; break; }
        }
        if (clash) continue;
        S.slots.push({
          slot_id: nid('s'), date: date, start_time: times[i],
          duration_min: duration, status: 'open', created_at: isoAt(nowMs())
        });
        created += 1;
      }
      date = addDaysStr(date, 7);
    }
    touch();
    return { created: created };
  };

  H['admin.booking.update'] = function (data, token) {
    requireInstructor(token);
    var b = bookingById(trimmed(data.booking_id));
    if (!b) fail('not_found', 'We could not find that booking.');

    if (data.attendance !== undefined) {
      var att = trimmed(data.attendance);
      if (['', 'attended', 'no_show'].indexOf(att) === -1) fail('bad_request', 'Unknown attendance value.');
      b.attendance = att;
    }
    if (data.resolved_how !== undefined) {
      var how = trimmed(data.resolved_how);
      if (['', 'live', 'escalated'].indexOf(how) === -1) fail('bad_request', 'Unknown resolution value.');
      b.resolved_how = how;
      if (how === 'live') {
        var t = threadById(b.thread_id);
        if (t) { t.resolved_via = 'live'; t.status = 'answered'; }
      }
    }
    if (data.status !== undefined) {
      var st = trimmed(data.status);
      if (['confirmed', 'cancelled', 'rejected'].indexOf(st) === -1) fail('bad_request', 'Unknown booking status.');
      b.status = st;
      var slot = slotById(b.slot_id);
      if (slot) slot.status = (st === 'confirmed') ? 'booked' : 'open';
    }
    touch();
    return { ok: true };
  };

  var CONFIG_WHITELIST = [
    'site_title', 'notice_text', 'categories', 'labels', 'languages',
    'clinic_day', 'clinic_start', 'clinic_end', 'slot_minutes',
    'booking_cutoff_day', 'booking_cutoff_time', 'max_active_bookings',
    'passcode_mode', 'class_passcode',
    /* v3, thirteen more (contract §3.3). Deliberately NOT here:
       attachment_folder and attachment_types (changing the folder orphans every
       image already uploaded; the type list is a security control), and
       instructor_user_id (set once, by hand). */
    'chat_enabled', 'messages_poll_seconds', 'attachments_enabled', 'attachment_max_kb',
    'notify_enabled', 'notify_daily_cap', 'digest_hour', 'escalation_hours',
    'reminder_day_before_hour', 'reminder_day_of_hour', 'archive_mode',
    'messages_min_interval_seconds', 'attachments_daily_cap',
    /* Clinic location. clinic_location was on the "by hand" list above until the
       instructor asked to set it from the admin page; it now joins its two new
       siblings. This list is the twin of the admin flow's `wl` createArray, and
       a key missing from THAT array is not refused flow-side — it is silently
       skipped while the flow still answers ok:true. Keeping the two lists in
       step is what stops MOCK reporting a save the tenant would drop. */
    'clinic_mode', 'clinic_location', 'clinic_join_url'
  ];

  /* Nine of the new keys are read with int(...) flow-side. A blank cell there does
     not default - it throws, and it throws inside meta.bootstrap, which would take
     the whole site down for the entire cohort the moment an instructor cleared one
     of these boxes and pressed Save. So blank is refused at the point of entry. */
  var CONFIG_NUMERIC = [
    'messages_poll_seconds', 'attachment_max_kb', 'notify_daily_cap', 'digest_hour',
    'escalation_hours', 'reminder_day_before_hour', 'reminder_day_of_hour',
    'messages_min_interval_seconds', 'attachments_daily_cap'
  ];

  /* The clinic-location gate, and the twin of the three chk_* blocks the admin
     flow runs between chk_num_blank and for_each_key.

     It validates EFFECTIVE values, not submitted ones. The admin page sends only
     the keys whose value changed, so "switch to online" arrives as a lone
     clinic_mode entry with no clinic_join_url beside it; the pair rule has to
     read through to the stored config for the half that did not move. Flow-side
     that is outputs('cfg'); here it is S.config.

     It runs BEFORE anything is written, for the same reason the flow puts these
     blocks before for_each_key: a refusal must leave the config exactly as it
     was, not half-applied. */
  function effective(entries, key) {
    if (Object.prototype.hasOwnProperty.call(entries, key)) return trimmed(entries[key]);
    return trimmed(S.config[key]);
  }

  function checkClinicLocation(entries) {
    var sentMode = Object.prototype.hasOwnProperty.call(entries, 'clinic_mode');
    var sentUrl = Object.prototype.hasOwnProperty.call(entries, 'clinic_join_url');

    /* The twin of touch_loc_cs, and it must stay EXACTLY this:
         @if(or(contains(entries,'clinic_mode'), contains(entries,'clinic_join_url')), 'yes','no')

       clinic_location is deliberately NOT in the gate, in the flow and therefore
       not here either. Changing the room alone cannot create the bad pair, and
       including it would refuse a harmless room edit on a workbook whose
       clinic_mode row is blank or holds a typo — accepted live, refused in MOCK,
       which is precisely the divergence that stops MOCK being a trustworthy
       rehearsal.

       The gate is also what stops these rules becoming an outage: without it, an
       instructor editing site_title alone on a workbook with no clinic_mode row
       would have EVERY setting on the page refused with a message about the
       clinic mode. */
    var touched = sentMode || sentUrl;
    if (!touched) return;

    var mode = effective(entries, 'clinic_mode').toLowerCase();
    var url = effective(entries, 'clinic_join_url');

    /* Rule 1, and the twin of bad_mode_cs — which opens with
       `if(not(contains(entries,'clinic_mode')), 'no', ...)`. It fires ONLY when
       the mode was actually submitted. A blank or typo'd mode already sitting in
       the workbook is not this save's fault, and refusing a Zoom-link edit
       because of it would leave the instructor no way to fix anything from the
       page. When the mode IS submitted, blank counts as invalid: the admin page
       always sends one of the two words, so a blank arriving means something is
       wrong upstream rather than something left at its default. */
    if (sentMode && mode !== 'physical' && mode !== 'online') {
      fail('bad_request', 'Clinic mode must be either physical or online.');
    }

    if (url) {
      /* http:// is refused outright rather than upgraded: Zoom is https-only and
         a plain-http link in a calendar invite is a downgrade nobody should be
         able to configure. The CR/LF test is not paranoia — a newline inside this
         value would inject a fabricated property line into every .ics the
         reminders flow builds. */
      var ok = url.slice(0, 8).toLowerCase() === 'https://' &&
        url.length >= 12 && url.length <= 200 &&
        url.indexOf(' ') === -1 &&
        url.indexOf('\r') === -1 && url.indexOf('\n') === -1 && url.indexOf('\t') === -1;
      if (!ok) {
        fail('bad_request',
          'The Zoom link must be a single https:// address with no spaces, under 200 characters.');
      }
    }

    /* The rule that actually matters, and last so the two specific messages
       above win. Deliberately NOT symmetric: a blank room in physical mode is
       allowed, because that is the state every workbook ships in and it degrades
       to "see the booking page" rather than breaking. */
    if (mode === 'online' && !url) {
      fail('bad_request',
        'An online clinic needs a Zoom link. Add the link, or switch the clinic back to a physical room.');
    }
  }

  H['admin.config.set'] = function (data, token) {
    requireInstructor(token);
    var entries = data.entries || {};
    checkClinicLocation(entries);
    for (var key in entries) {
      if (!Object.prototype.hasOwnProperty.call(entries, key)) continue;
      if (CONFIG_WHITELIST.indexOf(key) === -1) continue;
      var value = entries[key];
      if (Object.prototype.toString.call(value) === '[object Array]') value = value.join(',');
      if (value === true || value === false) value = value ? 'TRUE' : 'FALSE';
      value = str(value);
      if (CONFIG_NUMERIC.indexOf(key) !== -1) {
        var num = trimmed(value);
        if (!num || !/^\d+$/.test(num)) {
          fail('bad_request', key + ' needs a whole number — it cannot be left blank.');
        }
        value = num;
      }
      S.config[key] = value;
    }
    touch();
    return { ok: true };
  };

  /* ============================================== v3: messages.* (chat) ==== */
  /* Served in production by a SEPARATE flow, [clinic]_msg_api, on its own URL.
     Everything below is a twin of that flow, including its refusals - a builder
     who only ever runs MOCK should still meet every error the tenant can produce.

     PRIVACY, stated once and then relied on: chat is PRIVATE but NOT ANONYMOUS.
     There is no anonymous DM. The sender's real display name is on every message,
     the instructor can always see who they are talking to, and the "Post
     anonymously" checkbox on the board has no counterpart here. A student who
     wants to ask without their name attached posts an anonymous thread instead.
     Do not add an anonymity affordance to this surface without changing PRIVACY.md
     first - a half-anonymous channel is worse than an honest named one. */

  function messageShape(m, me) {
    var sender = userById(m.sender_id);
    return {
      message_id: m.message_id,
      conversation_id: m.conversation_id,
      from_me: m.sender_id === me.user_id,
      sender: {
        user_id: m.sender_id,
        display_name: sender ? sender.display_name : 'Former student'
      },
      body_md: m.body_md,
      attachment_ids: m.attachment_ids ? str(m.attachment_ids).split(',') : [],
      ref_thread_id: m.ref_thread_id || '',
      /* Echoed back so the client can reconcile an optimistic bubble against the
         server row. This is the entire reason the column exists - never match on
         body text, two identical "thanks!" messages are both legitimate. */
      client_msg_id: m.client_msg_id || '',
      created_at: m.created_at
    };
  }

  function unreadFor(row, instructor) {
    var raw = instructor ? row.unread_instructor : row.unread_student;
    return parseInt(raw, 10) || 0;
  }

  /* The rows this caller is allowed to see, by construction. Two layers, both of
     which exist flow-side too: the connector-level filter on conversation_id, and a
     Query on student_id. tbl_MsgState holds a 120-character preview of EVERY
     student's private conversation with the instructor, so an unfiltered read
     shipped to a client would hand every signed-in student a peek at every peer's
     DMs. There is deliberately NO client-side conversation filter anywhere - a
     reviewer must be able to confirm the privacy property by the ABSENCE of one in
     messages.js and the presence of these two here. */
  function myMsgStateRows(me, instructor) {
    var myCid = 'c_' + me.user_id;
    return where(S.msgstate, function (r) {
      if (instructor) return true;
      return r.conversation_id === myCid && r.student_id === me.user_id;
    });
  }

  H['messages.list'] = function (data, token) {
    var me = requireUser(token);
    requireChat();
    var instructor = isMsgInstructor(me);
    var rows = myMsgStateRows(me, instructor);
    var total = 0;
    var convs = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var n = unreadFor(r, instructor);
      total += n;
      convs.push({
        conversation_id: r.conversation_id,
        /* For a student the counterparty is always the instructor; for the
           instructor it is that row's student. */
        other: instructor ? otherParty(r.student_id) : otherParty(primaryInstructorId()),
        last_excerpt: str(r.last_excerpt),
        last_at: str(r.last_msg_at),
        unread: n
      });
    }
    /* Returned in TABLE ORDER, not newest-first. GetItems gives no ordering
       guarantee, so the instructor's inbox has to sort on last_at client-side; a
       mock that pre-sorted would let that sort be forgotten and ship. */
    return { conversations: convs, unread_total: total, chat_enabled: chatEnabled() };
  };

  H['messages.get'] = function (data, token) {
    var me = requireUser(token);
    requireChat();
    var instructor = isMsgInstructor(me);
    var cid = convIdFor(me, data);      /* a student's payload is IGNORED here */
    var row = msgStateByConv(cid);

    /* An instructor naming a conversation that does not exist is a genuine error.
       A STUDENT can never reach this branch: their id is derived, and a student who
       has simply never messaged has no row yet - which is not an error, it is the
       empty state with a "Message the instructor" button. */
    if (instructor && !row) fail('not_found', 'That conversation does not exist.');

    var since = trimmed(data.since);
    var sinceMs = since ? Date.parse(since) : 0;
    if (isNaN(sinceMs)) sinceMs = 0;

    var list = where(S.messages, function (m) {
      if (m.conversation_id !== cid) return false;
      /* The write-visibility lag, and the deleted flag. */
      if (!msgVisible(m)) return false;
      /* Participation, enforced per row: a non-participant row never enters the
         payload, so there is nothing for the client to filter out. */
      if (m.sender_id !== me.user_id && m.recipient_id !== me.user_id) return false;
      if (sinceMs && !(Date.parse(m.created_at) > sinceMs)) return false;
      return true;
    });

    var out = {
      conversation_id: cid,
      messages: list.map(function (m) { return messageShape(m, me); })
    };
    /* `other` is sent on the FIRST load only. A `since` poll omits it and the client
       keeps the copy it already holds - that is one whole Excel read saved on the
       polled path, every 90 seconds, per open conversation. */
    if (!since) {
      out.other = instructor ? otherParty(row.student_id) : otherParty(primaryInstructorId());
    }
    /* `unread` is deliberately NOT in this response: the counter lives in msgstate,
       which this action does not read, and emitting it would put a second read on
       the polled path. The client already has the number from messages.list /
       messages.unread. */
    return out;
  };

  H['messages.send'] = function (data, token) {
    var me = requireUser(token);
    /* Guard order matters and is copied from the flow: cheapest and most global
       refusals first, the write last. */
    requireChat();
    requireWritable();

    var cmid = trimmed(data.client_msg_id);
    if (!cmid) {
      /* Not optional, ever. slots.book has returned HTTP 502 while actually
         succeeding; without an idempotency key one retry double-posts. */
      fail('bad_request', 'That message could not be sent — please try again.');
    }

    var instructor = isMsgInstructor(me);
    var cid, recipientId, row;

    if (instructor) {
      cid = convIdFor(me, data);
      row = cid ? msgStateByConv(cid) : null;
      if (!row) fail('bad_request', 'Pick a conversation to reply to.');
      recipientId = row.student_id;
    } else {
      /* to_user_id and conversation_id from a student are DISCARDED, not validated.
         Without this, student B could post conversation_id 'c_<A>' and their text
         would land in A's private channel and surface in the instructor's inbox
         under A's name - content injection into the one channel this design sells
         as the face-saving private route. */
      cid = 'c_' + me.user_id;
      row = msgStateByConv(cid);
      recipientId = primaryInstructorId();
      if (!recipientId) fail('bad_request', 'Direct messages are not set up yet.');
    }

    var body = trimmed(data.body_md);
    if (!body) fail('bad_request', 'Type a message first.');
    if (body.length > MSG_MAX_CHARS) {
      fail('bad_request', 'That message is too long (max ' + MSG_MAX_CHARS + ' characters).');
    }

    /* Send throttle. A coarse brake on a runaway client or a retry loop, not on a
       determined human - it is deliberately looser than the client's own 45 s retry
       suppression so a legitimate second message is never refused. Costs nothing:
       the row it reads is the one the upsert below needs anyway. */
    var minGap = parseInt(S.config.messages_min_interval_seconds, 10);
    if (isNaN(minGap)) minGap = 3;
    if (row && str(row.last_sender_id) === me.user_id && row.last_msg_at &&
        Date.parse(row.last_msg_at) > nowMs() - minGap * 1000) {
      fail('conflict', 'You are sending too quickly — wait a moment.');
    }

    /* Idempotency, LAGGED ON PURPOSE. msgVisible() means a row written three
       seconds ago is not findable yet - exactly like the real flow, where the
       client_msg_id filter reads an Excel table that has not caught up. So an
       IMMEDIATE retry writes a second row here too. That is not a mock bug: it is
       the reason §10.7 suppresses the Retry button until the pending entry is 45 s
       old. A mock without this lag would be stricter than the tenant, the retry
       suppression would never be exercised, and the double-post would be discovered
       in production. */
    var dupe = null;
    for (var i = 0; i < S.messages.length; i++) {
      if (msgVisible(S.messages[i]) && S.messages[i].client_msg_id === cmid) {
        dupe = S.messages[i];
        break;
      }
    }
    if (dupe) {
      return {
        message_id: dupe.message_id,
        conversation_id: dupe.conversation_id,
        created_at: dupe.created_at,
        duplicate: true
      };
    }

    var createdAt = isoAt(nowMs());
    var m = {
      message_id: nid('m'),
      conversation_id: cid,
      sender_id: me.user_id,
      recipient_id: recipientId,
      body_md: body,
      attachment_ids: joinAttachments(data.attachment_ids),
      ref_thread_id: trimmed(data.ref_thread_id),
      client_msg_id: cmid,
      deleted: 'FALSE',
      created_at: createdAt,
      /* THE WRITE-VISIBILITY LAG. The row exists from this instant, but no
         messages.get will return it until the lag expires. Clinic.mock.fast()
         sets this to zero for a demo. */
      visible_at: nowMs() + writeLagMs()
    };
    S.messages.push(m);

    /* Create-or-update the one msgstate row. The counter that goes up belongs to
       the RECIPIENT and is chosen by the sender's role, never by anything in the
       payload. */
    if (!row) {
      row = {
        conversation_id: cid, student_id: me.user_id,
        last_msg_at: '', last_sender_id: '', last_excerpt: '',
        unread_student: '0', unread_instructor: '0'
      };
      S.msgstate.push(row);
    }
    row.last_msg_at = createdAt;
    row.last_sender_id = me.user_id;
    row.last_excerpt = dmExcerpt(body);
    if (instructor) {
      row.unread_student = String((parseInt(row.unread_student, 10) || 0) + 1);
    } else {
      row.unread_instructor = String((parseInt(row.unread_instructor, 10) || 0) + 1);
    }

    touch();
    return {
      message_id: m.message_id,
      conversation_id: cid,
      created_at: createdAt,
      duplicate: false
    };
  };

  H['messages.read'] = function (data, token) {
    var me = requireUser(token);
    requireChat();
    /* NOT archive-guarded. Marking your own conversation read is not authoring
       content, and a read-only end-of-semester board that leaves a badge stuck at 3
       forever is just a bug. */
    var instructor = isMsgInstructor(me);
    var cid = convIdFor(me, data);
    var row = msgStateByConv(cid);

    /* Without the derived conversation id above, any student could call
       messages.read for a classmate's conversation on a loop and hold that
       classmate's unread counter at zero: their badge never lights, they silently
       miss instructor replies, and nothing anywhere records it. With it, the attack
       is unconstructible - which is why this reads conv_id and not the payload. */
    if (!row) {
      if (instructor) fail('not_found', 'That conversation does not exist.');
      return { unread: 0 };          /* a student who has never messaged: not an error */
    }
    if (instructor) row.unread_instructor = '0'; else row.unread_student = '0';
    touch();
    return { unread: 0 };
  };

  H['messages.unread'] = function (data, token) {
    var me = requireUser(token);
    /* The cheapest action in the system and the only one that is ever called
       speculatively, so it refuses nothing except a bad session: with chat off it
       answers zero rather than erroring, and the caller simply never shows a badge. */
    if (!chatEnabled()) return { unread_total: 0, by_conversation: [] };
    var instructor = isMsgInstructor(me);
    var rows = myMsgStateRows(me, instructor);
    var total = 0;
    var by = [];
    for (var i = 0; i < rows.length; i++) {
      var n = unreadFor(rows[i], instructor);
      total += n;
      by.push({ conversation_id: rows[i].conversation_id, unread: n });
    }
    return { unread_total: total, by_conversation: by };
  };

  /* ============================================ v3: attach.* (screenshots) == */

  H['attach.create'] = function (data, token) {
    var me = requireUser(token);
    if (!isTrue(S.config.attachments_enabled)) {
      fail('forbidden', 'Image upload is switched off for this course.');
    }
    requireWritable();

    var scope = trimmed(data.scope);
    if (scope !== 'thread' && scope !== 'dm') fail('bad_request', 'Unknown upload scope.');

    var contentType = trimmed(data.content_type).toLowerCase();
    var allowed = csvList(S.config.attachment_types).map(function (x) { return x.toLowerCase(); });
    if (allowed.indexOf(contentType) === -1) {
      fail('bad_request', 'That file type is not allowed. Paste a PNG, JPEG, GIF or WebP image.');
    }

    var b64 = str(data.data_b64);
    if (!b64) fail('bad_request', 'That upload arrived empty — try pasting it again.');
    var sizeBytes = b64Bytes(b64);
    var maxKb = parseInt(S.config.attachment_max_kb, 10) || 1536;
    if (sizeBytes > maxKb * 1024) {
      fail('bad_request', 'That image is too large (limit ' + maxKb + ' KB). ' +
        'Crop it to the part that matters and try again.');
    }

    /* scope_id for a DM is MANDATORY and, for a student, OVERWRITTEN rather than
       validated - the same derive-never-trust rule as convIdFor. It is always known
       at paste time for a DM. (The "blank until the row exists" case is real only
       for scope 'thread', where the thread genuinely does not exist yet.) */
    var scopeId = trimmed(data.scope_id);
    if (scope === 'dm') {
      if (isMsgInstructor(me)) {
        if (!scopeId) fail('bad_request', 'Open a conversation before pasting an image.');
        if (!msgStateByConv(scopeId)) fail('bad_request', 'That conversation does not exist.');
      } else {
        scopeId = 'c_' + me.user_id;
      }
    }

    /* Per-uploader daily cap. Mirrors the flow's startsWith(created_at, today_sgt)
       test EXACTLY, including its known imprecision: created_at is UTC and
       today_sgt is a Singapore date, so between 00:00 and 08:00 SGT the comparison
       is against the previous UTC day and the cap effectively resets early. That is
       a rate limit, not an accounting record, so it is left alone rather than
       "fixed" here and left wrong in the flow. */
    var todaySgt = sgtDateStr(new Date());
    var usedToday = countWhere(S.attachments, function (a) {
      return a.owner_id === me.user_id && str(a.created_at).indexOf(todaySgt) === 0;
    });
    var cap = parseInt(S.config.attachments_daily_cap, 10) || 40;
    if (usedToday >= cap) {
      fail('conflict', 'That is today’s upload limit reached. Try again tomorrow, ' +
        'or bring the file to the clinic.');
    }

    var fileName = trimmed(data.file_name) || 'image.png';
    var row = {
      attachment_id: nid('a'),
      owner_id: me.user_id,
      scope: scope,
      scope_id: scopeId,
      file_name: fileName,
      content_type: contentType,
      size_bytes: String(sizeBytes),
      onedrive_item_id: 'mock-item-' + idSeq,
      onedrive_path: str(S.config.attachment_folder) + '/' + fileName,
      deleted: 'FALSE',
      created_at: isoAt(nowMs()),
      data_b64: b64
    };
    S.attachments.push(row);
    touch();

    /* The SERVER returns the markdown to insert, so no client ever constructs the
       clinic-img/ URL form itself. One place to change it if it ever changes. */
    return {
      attachment_id: row.attachment_id,
      markdown: '![' + fileName + '](clinic-img/' + row.attachment_id + ')',
      file_name: fileName,
      size_bytes: sizeBytes
    };
  };

  H['attach.get'] = function (data, token) {
    var me = requireUser(token);
    /* Deliberately NOT gated on attachments_enabled: switching uploads off must stop
       NEW images, not blank out every screenshot already posted this semester. */
    var a = attachmentById(trimmed(data.attachment_id));
    if (!a || isTrue(a.deleted)) fail('not_found', 'That image is no longer available.');

    if (a.scope === 'dm') {
      /* PARTICIPATION, not ownership. Ownership alone is wrong in both directions:
         an image the INSTRUCTOR pastes into a DM is owned by the instructor, so the
         student it was sent to would never see it; and "any instructor" is unbounded
         across the two instructor identities. */
      var ok = (str(a.owner_id) === me.user_id) ||
        (str(a.scope_id) === 'c_' + me.user_id) ||
        (isMsgInstructor(me) && !!msgStateByConv(a.scope_id));
      if (!ok) fail('forbidden', 'That image belongs to a private conversation.');
    }
    /* Thread-scope images are readable by any signed-in caller, unchanged.
       NOTE WHAT IS NOT RETURNED: owner_id, scope_id and onedrive_path never leave
       the server. owner_id on a thread image would de-anonymise the author of an
       anonymous post that contains a screenshot. */
    return {
      attachment_id: a.attachment_id,
      content_type: a.content_type,
      file_name: a.file_name,
      data_b64: a.data_b64
    };
  };

  /* ================================================================ dispatch */

  function handle(action, data, token) {
    return new Promise(function (resolve, reject) {
      window.setTimeout(function () {
        try {
          init();
          var fn = H[action];
          if (!fn) {
            reject({ code: 'bad_request', message: 'Unknown action in demo mode: ' + action });
            return;
          }
          var out = fn(data || {}, token || lsGet('clinic_token') || '');
          if (dirty) { save(); dirty = false; }
          resolve(out === undefined ? {} : out);
        } catch (e) {
          if (dirty) { save(); dirty = false; }
          if (e && e.code) reject(e);
          else reject({ code: 'bad_request', message: (e && e.message) || 'Demo data error.' });
        }
      }, latencyMs());
    });
  }

  /* ============================================================ demo controls */

  function personaUser(which) {
    init();
    if (which === 'instructor') {
      return find(S.users, 'role', 'instructor') || userById('u_ins');
    }
    return userById('u_you');
  }

  /* Used by the mock-only user switcher in the header (SPEC §13.2). */
  function switchUser(which, opts) {
    init();
    var user = personaUser(which);
    if (!user) fail('not_found', 'No demo persona for "' + which + '".');
    var s = mintSession(user);
    lsSet('clinic_token', s.token);
    lsSet('clinic_user', JSON.stringify(selfUser(user)));
    lsSet('clinic_token_expires', s.expires_at);
    lsDel('clinic_bootstrap');
    save();
    dirty = false;
    if (!opts || opts.reload !== false) window.location.reload();
    return selfUser(user);
  }

  function signOut() {
    init();
    var token = lsGet('clinic_token');
    if (token) {
      removeWhere(S.sessions, function (row) { return row.token === token; });
      save();
      dirty = false;
    }
  }

  function reset(opts) {
    lsDel(STATE_KEY);
    lsDel('clinic_token');
    lsDel('clinic_user');
    lsDel('clinic_token_expires');
    lsDel('clinic_bootstrap');
    S = null;
    init();
    save();
    dirty = false;
    if (!opts || opts.reload !== false) window.location.reload();
    return 'Demo data reset.';
  }

  function personas() {
    init();
    var you = userById('u_you');
    var ins = find(S.users, 'role', 'instructor');
    var out = [];
    if (you) out.push({ key: 'student', user_id: you.user_id, display_name: you.display_name, email: you.email, role: you.role });
    if (ins) out.push({ key: 'instructor', user_id: ins.user_id, display_name: ins.display_name, email: ins.email, role: ins.role });
    return out;
  }

  function hint() {
    init();
    var ins = find(S.users, 'role', 'instructor');
    return 'Demo mode: any email address works and the code is always 000000. ' +
      'Sign in as you@u.nus.edu for a student with existing threads, or ' +
      (ins ? ins.email : 'the instructor address') + ' for the instructor view.';
  }

  /* --------------------------------------------------------- timing controls */
  /* These exist so that the same seed can be either a TEST RIG (slow calls, a
     visible write lag - the two properties that break naive UI code) or a DEMO
     (instant, smooth). Neither setting touches the data, and both survive a reload. */

  function setLatency(ms) {
    var t = timingRead();
    t.latency_ms = (ms === null || ms === undefined) ? null : Math.max(0, parseInt(ms, 10) || 0);
    timingWrite();
    return timingInfo();
  }
  function setWriteLag(ms) {
    var t = timingRead();
    t.write_lag_ms = Math.max(0, parseInt(ms, 10) || 0);
    timingWrite();
    /* Anything already queued behind the old lag becomes visible immediately when
       the lag is switched off, so a demo never gets stuck waiting for a message
       that was sent under the previous setting. */
    if (t.write_lag_ms === 0 && S) {
      for (var i = 0; i < S.messages.length; i++) S.messages[i].visible_at = 0;
      save();
    }
    return timingInfo();
  }
  function timingInfo() {
    var t = timingRead();
    return {
      latency_ms: t.latency_ms === null
        ? (LATENCY_MIN_MS + '-' + LATENCY_MAX_MS + ' (varying)')
        : t.latency_ms,
      write_lag_ms: t.write_lag_ms
    };
  }
  function fast() { init(); setLatency(80); return setWriteLag(0); }
  function realistic() { setLatency(null); return setWriteLag(MOCK_WRITE_LAG_MS); }

  Clinic.mock = {
    handle: handle,
    reset: reset,
    switchUser: switchUser,
    signOut: signOut,
    personas: personas,
    hint: hint,
    state: function () { init(); return S; },
    setLatency: setLatency,
    setWriteLag: setWriteLag,
    timing: timingInfo,
    fast: fast,
    realistic: realistic,
    STATE_KEY: STATE_KEY,
    STATE_VERSION: STATE_VERSION,
    MOCK_WRITE_LAG_MS: MOCK_WRITE_LAG_MS
  };

})(window);
