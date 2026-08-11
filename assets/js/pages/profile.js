/* MScPHMxAI Coding Clinic — profile.html
   Student profile: display name, contact details, proficiency self-rating.
   SPEC §4 ("v2 addition — student profiles"), §5 (profile.update / the
   user object "v2 addition"), §7 (design system), §8 (page conventions).

   No fetch() here: every call goes through Clinic.api.call(action, data).
   All dynamic text is inserted with textContent — never innerHTML. */
(function () {
  'use strict';

  var C = window.Clinic || {};
  var api = C.api;
  var ui = C.ui || {};

  if (!api || typeof api.call !== 'function') {
    console.error('[profile] Clinic.api is missing');
    return;
  }

  /* 1–5 anchors, verbatim from SPEC §4 so a rating means the same thing for
     every student — every level is always shown in full, never a bare
     number scale. */
  var LEVELS = [
    { v: 1, text: 'never really used it' },
    { v: 2, text: 'can run code someone else wrote' },
    { v: 3, text: 'can modify an example to fit my data' },
    { v: 4, text: 'write my own scripts from scratch' },
    { v: 5, text: 'help other people debug theirs' }
  ];

  /* Display label for the third skill is "Bash/Linux" (naming unified
     2026-08-07 to match the language-board name, so nobody rates "Linux"
     and then posts to a "Bash" board). The wire field stays "linux"
     everywhere — tbl_Proficiency column, the profile.update payload, and
     bootstrap user.proficiency.linux — only SKILLS[].label is user-facing. */
  var SKILLS = [
    { key: 'r', label: 'R' },
    { key: 'python', label: 'Python' },
    { key: 'linux', label: 'Bash/Linux' }
  ];

  /* v3 — email opt-outs (contract §5.1, §5.5).

     These are OPT-OUTS: a blank column means "yes, send it", so every switch
     starts ON. They save through the existing profile.update path, merged PER
     KEY, which is why a student's save never mentions `escalation` and
     therefore never touches it.

     Every entry says what the email IS and roughly how often it arrives,
     because "notify_replies" tells a student nothing and an unlabelled switch
     just gets turned off out of caution. `instructorOnly` keeps the escalation
     alert — which only ever goes to the instructor — off everybody else's page
     rather than showing them a switch that controls nothing. */
  var NOTIFY = [
    {
      key: 'replies',
      label: 'Someone replies to your question',
      hint: 'One email when a classmate or the instructor answers a discussion you started. ' +
        'At most one per discussion per day, and never for your own replies.'
    },
    {
      key: 'reminders',
      label: 'Clinic booking reminders',
      hint: 'Two per booking: the evening before, and around midday on clinic day. Each one carries ' +
        'a calendar invite you can open in Outlook.'
    },
    {
      key: 'digest',
      label: 'Nightly round-up',
      hint: 'One email at about 8 pm listing what was asked and what is still unanswered. ' +
        'Nothing is sent on a quiet day — never an empty email.'
    },
    {
      key: 'escalation',
      label: 'Unanswered-question alerts',
      instructorOnly: true,
      hint: 'One email when a question has gone unanswered for a day, sent with the nightly run. ' +
        'Each question is only ever escalated once.'
    }
  ];

  var state = {
    me: {},
    ratings: { r: 0, python: 0, linux: 0 },  // last-saved baseline, for diffing
    notify: null,                            // last-saved baseline, or null when unsupported
    saving: false,
    nudgeDismissed: false
  };

  /* ---------------------------------------------------------------- utils */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  /* ui.icon() returns a real <svg> element (see ui.js). Anything else is
     dropped rather than parsed — this file never sets innerHTML. */
  function iconEl(name) {
    try {
      if (typeof ui.icon === 'function') {
        var out = ui.icon(name);
        if (out && out.nodeType) return out;
      }
    } catch (e) { /* ignore */ }
    return document.createDocumentFragment();
  }

  function toast(msg, type) {
    if (typeof ui.toast === 'function') { try { ui.toast(msg, type); return; } catch (e) { /* ignore */ } }
    if (type === 'error') console.error(msg); else console.log(msg);
  }

  function errMsg(e, fallback) { return (e && (e.message || e.error)) || fallback; }

  /* Spinner-in-the-button. Falls back to the old label swap against a ui.js
     that predates ui.busy(), so this page never depends on the newer file. */
  function busyBtn(btn, label) {
    if (!btn) return function () {};
    if (typeof ui.busy === 'function') { try { return ui.busy(btn, label); } catch (e) {} }
    var was = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    return function () { btn.disabled = false; btn.textContent = was; };
  }

  function currentUser() {
    try {
      if (typeof api.getUser === 'function') { var u = api.getUser(); if (u) return u; }
    } catch (e) { /* ignore */ }
    try { return JSON.parse(window.localStorage.getItem('clinic_user') || 'null'); }
    catch (e) { return null; }
  }

  function flagGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function flagSet(key, val) {
    try { window.localStorage.setItem(key, val); } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ proficiency */

  function ratingsFromProficiency(prof) {
    function n(v) { var i = parseInt(v, 10); return (i >= 1 && i <= 5) ? i : 0; }
    return { r: n(prof && prof.r), python: n(prof && prof.python), linux: n(prof && prof.linux) };
  }

  function readRadioGroup(name) {
    var nodes = document.getElementsByName(name);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].checked) return parseInt(nodes[i].value, 10) || 0;
    }
    return 0;
  }

  /* --------------------------------------------------------- notifications */

  /* ui.truthy is the ONE mixed-type wire-boolean normaliser (§10.6). The flow
     converts these server-side, but a hand-edited workbook cell can still send
     back the string 'TRUE', and `!!'FALSE'` is true — which would silently show
     an opted-out student as opted in and then save that back. */
  function truthy(v) {
    try { if (typeof ui.truthy === 'function') return !!ui.truthy(v); } catch (e) { /* ignore */ }
    if (v === true || v === 1) return true;
    if (v === false || v === null || v === undefined) return false;
    var s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1';
  }

  /* `user.notify` absent means the app flow has not been re-imported yet. That
     is NOT the same as "all four are off" — it means we cannot honour a change,
     so the whole section becomes one .inert-note rather than four switches that
     look like they save (§10.10). Strict object test, never a truthiness one. */
  function notifySupported() {
    var n = state.me && state.me.notify;
    return !!(n && typeof n === 'object');
  }

  function notifyBaseline() {
    var n = (state.me && state.me.notify) || {};
    var out = {};
    for (var i = 0; i < NOTIFY.length; i++) out[NOTIFY[i].key] = truthy(n[NOTIFY[i].key]);
    return out;
  }

  function isInstructor() { return String((state.me && state.me.role) || '') === 'instructor'; }
  function showsNotify(item) { return !item.instructorOnly || isInstructor(); }

  /* ------------------------------------------------------------ first-run nudge
     Dismissal is remembered per user_id (localStorage) so it does not nag
     again once seen — but it never blocks reading or posting anywhere else;
     this banner is the only place it appears at all. */

  function nudgeKey() {
    return 'clinic_profile_nudge_dismissed_' + ((state.me && state.me.user_id) || 'anon');
  }

  function shouldShowNudge() {
    if (state.nudgeDismissed) return false;
    var me = state.me || {};
    var hasFullName = !!String(me.full_name || '').trim();
    var hasProficiency = !!me.proficiency;
    return !hasFullName && !hasProficiency;
  }

  function dismissNudge() {
    state.nudgeDismissed = true;
    flagSet(nudgeKey(), '1');
    /* remove the node directly rather than re-rendering the whole form, so
       an in-progress edit elsewhere on the page is never discarded */
    var box = document.getElementById('profile-nudge');
    if (box && box.parentNode) box.parentNode.removeChild(box);
  }

  /* ------------------------------------------------------------ data load */

  function applyBaseline() {
    state.ratings = ratingsFromProficiency(state.me.proficiency);
    state.notify = notifySupported() ? notifyBaseline() : null;
    state.nudgeDismissed = flagGet(nudgeKey()) === '1';
  }

  function load() {
    var p = null;
    /* refreshBootstrap() (when available) also updates the clinic_bootstrap
       cache and clinic_user, and fires clinic:bootstrap — keeping every
       other page's header/cache in step with whatever this page loads. */
    if (typeof api.refreshBootstrap === 'function') {
      try { p = api.refreshBootstrap(); } catch (e) { p = null; }
    }
    if (!p) p = api.call('meta.bootstrap', {});
    return p.then(function (boot) {
      state.me = (boot && boot.user) || currentUser() || {};
      applyBaseline();
    })['catch'](function (e) {
      var cached = currentUser();
      if (cached && cached.user_id) {
        state.me = cached;
        applyBaseline();
        toast(errMsg(e, 'Could not refresh your profile — showing the last saved details.'), 'error');
        return;   // we still have something to show — do not fail the page
      }
      throw e;
    });
  }

  /* ---------------------------------------------------------------- render */

  function renderMain() {
    var main = document.getElementById('profile-main');
    if (!main) return;
    clear(main);

    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Your profile'));
    main.appendChild(head);
    main.appendChild(el('p', 'muted mb-16',
      'Manage how classmates see you, the contact details behind clinic bookings, and your skill self-rating.'));

    if (shouldShowNudge()) main.appendChild(nudgeBanner());

    var form = el('form');
    form.id = 'profile-form';
    form.setAttribute('novalidate', 'novalidate');

    form.appendChild(displayNameSection());
    form.appendChild(contactSection());
    form.appendChild(proficiencySection());
    form.appendChild(notificationsSection());

    var errBox = el('div', 'form-error');
    errBox.id = 'profile-error';
    errBox.setAttribute('role', 'alert');
    errBox.hidden = true;
    form.appendChild(errBox);

    var actions = el('div', 'row mt-16');
    var save = el('button', 'btn btn-primary', 'Save changes');
    save.type = 'submit';
    save.id = 'profile-save';
    actions.appendChild(save);
    form.appendChild(actions);

    form.addEventListener('submit', onSave);
    main.appendChild(form);
  }

  function nudgeBanner() {
    var box = el('div', 'notice-box mb-16');
    box.id = 'profile-nudge';
    box.appendChild(el('p', '',
      'Add your contact details and a quick skill self-rating below — about a minute, and it means ' +
      'your clinic booking form is already filled in next time.'));
    var dismiss = el('button', 'btn btn-sm', 'Dismiss');
    dismiss.type = 'button';
    dismiss.addEventListener('click', dismissNudge);
    box.appendChild(dismiss);
    return box;
  }

  function displayNameSection() {
    var sec = el('section', 'side-section');
    sec.appendChild(el('h2', 'side-title', 'Your display name'));
    sec.appendChild(el('p', 'field-hint mt-0',
      'What classmates see next to your posts, replies, and on the leaderboard.'));

    var f = el('div', 'field');
    var lab = el('label', 'field-label', 'Display name');
    lab.htmlFor = 'pf-display-name';
    f.appendChild(lab);
    var input = el('input', 'input');
    input.type = 'text';
    input.id = 'pf-display-name';
    input.maxLength = 40;
    input.setAttribute('autocomplete', 'nickname');
    input.value = state.me.display_name || '';
    f.appendChild(input);
    sec.appendChild(f);
    return sec;
  }

  function contactSection() {
    var sec = el('section', 'side-section');
    sec.appendChild(el('h2', 'side-title', 'Contact details'));
    sec.appendChild(el('p', 'field-hint mt-0',
      'Both optional. They prefill the clinic booking form so you are not retyping them each time, ' +
      'and let the instructor reach you directly if a slot changes.'));

    var row = el('div', 'form-row');

    var fullF = el('div', 'field');
    var fullLab = el('label', 'field-label', 'Full name');
    fullLab.htmlFor = 'pf-full-name';
    fullF.appendChild(fullLab);
    var fullIn = el('input', 'input');
    fullIn.type = 'text';
    fullIn.id = 'pf-full-name';
    fullIn.maxLength = 80;
    fullIn.setAttribute('autocomplete', 'name');
    fullIn.value = state.me.full_name || '';
    fullF.appendChild(fullIn);
    fullF.appendChild(el('div', 'field-hint', 'As it appears on your student record.'));
    row.appendChild(fullF);

    var phoneF = el('div', 'field');
    var phoneLab = el('label', 'field-label', 'Mobile number');
    phoneLab.htmlFor = 'pf-phone';
    phoneF.appendChild(phoneLab);
    var phoneIn = el('input', 'input');
    phoneIn.type = 'tel';
    phoneIn.id = 'pf-phone';
    phoneIn.maxLength = 20;
    phoneIn.setAttribute('autocomplete', 'tel');
    phoneIn.value = state.me.phone || '';
    phoneF.appendChild(phoneIn);
    phoneF.appendChild(el('div', 'field-hint', 'Singapore mobile, e.g. 9123 4567 (+65 optional).'));
    row.appendChild(phoneF);

    sec.appendChild(row);

    var emailF = el('div', 'field');
    var emailLab = el('label', 'field-label', 'Email');
    emailLab.htmlFor = 'pf-email';
    emailF.appendChild(emailLab);
    var emailIn = el('input', 'input');
    emailIn.type = 'email';
    emailIn.id = 'pf-email';
    emailIn.disabled = true;
    emailIn.value = state.me.email || '';
    emailF.appendChild(emailIn);
    emailF.appendChild(el('div', 'field-hint',
      'Your verified NUS sign-in address. It cannot be changed here.'));
    sec.appendChild(emailF);

    return sec;
  }

  function proficiencySection() {
    var sec = el('section', 'side-section');
    sec.appendChild(el('h2', 'side-title', 'Proficiency self-rating'));
    sec.appendChild(el('p', 'field-hint mt-0',
      'Helps the instructor pitch clinic sessions at the right level. You will be asked again later in ' +
      'the term to see how the cohort has moved. No wrong answers — under-rating is common and fine.'));

    SKILLS.forEach(function (skill) {
      var f = el('div', 'field');
      var labelId = 'pf-' + skill.key + '-label';
      var lab = el('span', 'field-label', skill.label);
      lab.id = labelId;
      f.appendChild(lab);

      var group = el('div', 'col gap-8');
      group.setAttribute('role', 'radiogroup');
      group.setAttribute('aria-labelledby', labelId);

      var name = 'pf-prof-' + skill.key;
      var currentVal = state.ratings[skill.key] || 0;
      LEVELS.forEach(function (level) {
        var rowId = 'pf-' + skill.key + '-' + level.v;
        var rowEl = el('div', 'checkbox-row');
        var radio = el('input');
        radio.type = 'radio';
        radio.name = name;
        radio.id = rowId;
        radio.value = String(level.v);
        if (currentVal === level.v) radio.checked = true;
        var radioLab = el('label', '', level.v + ' = ' + level.text);
        radioLab.htmlFor = rowId;
        rowEl.appendChild(radio);
        rowEl.appendChild(radioLab);
        group.appendChild(rowEl);
      });

      f.appendChild(group);
      sec.appendChild(f);
    });

    return sec;
  }

  /* ------------------------------------------------------- notifications UI

     The emails link students here as __SITE_URL__/profile.html#notifications —
     there is deliberately no one-click unsubscribe link in the mail itself,
     because that would need a token-free endpoint (contract §5.5). So this
     section carries that id and boot() scrolls to it. */

  function notificationsSection() {
    var sec = el('section', 'side-section');
    sec.id = 'notifications';
    sec.appendChild(el('h2', 'side-title', 'Email notifications'));

    if (!notifySupported()) {
      sec.appendChild(el('p', 'field-hint mt-0',
        'Which emails the clinic sends you.'));
      var note = el('div', 'inert-note');
      note.appendChild(iconEl('info'));
      var body = el('div');
      body.appendChild(el('span', 'inert-note-title', 'Not switched on yet'));
      body.appendChild(document.createTextNode(
        'Email preferences arrive with the next update to the clinic. Until then nothing here ' +
        'would save, so there is nothing to switch — if the clinic is emailing you more than you ' +
        'want in the meantime, tell the instructor and they will turn it down for everyone.'));
      note.appendChild(body);
      sec.appendChild(note);
      return sec;
    }

    sec.appendChild(el('p', 'field-hint mt-0',
      'Everything is on to start with. Turn off whatever you do not want — it changes only your own ' +
      'email, never anyone else’s, and never what you can see on the site.'));

    NOTIFY.forEach(function (item) {
      if (!showsNotify(item)) return;
      var f = el('div', 'field');
      var row = el('div', 'checkbox-row');
      var cb = el('input');
      cb.type = 'checkbox';
      cb.id = 'pf-notify-' + item.key;
      cb.checked = !!(state.notify && state.notify[item.key]);
      cb.setAttribute('aria-describedby', 'pf-notify-' + item.key + '-hint');
      var lab = el('label', '', item.label);
      lab.htmlFor = cb.id;
      row.appendChild(cb);
      row.appendChild(lab);
      f.appendChild(row);
      var hint = el('div', 'field-hint', item.hint);
      hint.id = 'pf-notify-' + item.key + '-hint';
      f.appendChild(hint);
      sec.appendChild(f);
    });

    sec.appendChild(el('p', 'field-hint',
      'Password and sign-in codes are not notifications — those always arrive.'));
    return sec;
  }

  /* ------------------------------------------------------------------ save */

  function showError(box, msg) {
    if (!box) return;
    box.hidden = false;
    box.textContent = msg;
  }

  function hideError(box) {
    if (!box) return;
    box.hidden = true;
    box.textContent = '';
  }

  function setFormDisabled(disabled) {
    var form = document.getElementById('profile-form');
    if (!form) return;
    var fields = form.querySelectorAll('input, button');
    for (var i = 0; i < fields.length; i++) {
      if (fields[i].id === 'pf-email') continue;      // permanently read-only
      if (fields[i].id === 'profile-save') continue;  // label/state handled separately
      fields[i].disabled = disabled;
    }
  }

  function mergeUser(base, entries, serverUser) {
    var merged = Object.assign({}, base || {}, entries || {});
    /* entries.notify is a PARTIAL — only the keys that changed, because
       profile.update merges per key and an absent key must preserve its stored
       value. A flat Object.assign would drop the untouched ones on the floor
       and the page would redraw them as off. Fold it onto the baseline instead;
       serverUser, when present, then overwrites with the authoritative four. */
    if (entries && entries.notify) {
      merged.notify = Object.assign({}, (base && base.notify) || {}, entries.notify);
    }
    if (serverUser && typeof serverUser === 'object') merged = Object.assign(merged, serverUser);
    return merged;
  }

  function onSave(ev) {
    if (ev) ev.preventDefault();
    if (state.saving) return;

    var errBox = document.getElementById('profile-error');
    hideError(errBox);

    var nameIn = document.getElementById('pf-display-name');
    var fullIn = document.getElementById('pf-full-name');
    var phoneIn = document.getElementById('pf-phone');
    if (!nameIn || !fullIn || !phoneIn) return;

    var displayName = nameIn.value.trim();
    var fullName = fullIn.value.trim();
    var phone = phoneIn.value.trim();

    if (!displayName) { showError(errBox, 'Display name cannot be empty.'); return; }
    if (displayName.length < 2) { showError(errBox, 'Display name is too short.'); return; }

    if (phone) {
      var digits = phone.replace(/[\s()\-]/g, '');
      if (!/^(\+?65)?[89]\d{7}$/.test(digits)) {
        showError(errBox, 'Enter a Singapore mobile number — 8 digits starting with 8 or 9 ' +
          '(+65 optional) — or leave it blank.');
        return;
      }
    }

    var r = readRadioGroup('pf-prof-r');
    var py = readRadioGroup('pf-prof-python');
    var lin = readRadioGroup('pf-prof-linux');
    var anySet = !!(r || py || lin);
    var allSet = !!(r && py && lin);
    if (anySet && !allSet) {
      showError(errBox, 'Rate all three — R, Python and Bash/Linux — to save your proficiency, ' +
        'or leave all three blank for now.');
      return;
    }

    var base = state.me || {};
    var entries = {};
    if (displayName !== String(base.display_name || '').trim()) entries.display_name = displayName;
    if (fullName !== String(base.full_name || '').trim()) entries.full_name = fullName;
    if (phone !== String(base.phone || '').trim()) entries.phone = phone;

    var baseline = state.ratings || { r: 0, python: 0, linux: 0 };
    var profChanged = allSet && (r !== baseline.r || py !== baseline.python || lin !== baseline.linux);
    if (profChanged) entries.proficiency = { r: r, python: py, linux: lin };

    /* Same present-vs-absent idiom as the fields above: send ONLY the switches
       that actually moved. profile.update merges notify per key, so a student's
       payload never mentions `escalation` and therefore can never clear it. */
    if (notifySupported()) {
      var notify = {};
      var notifyChanged = false;
      NOTIFY.forEach(function (item) {
        if (!showsNotify(item)) return;
        var node = document.getElementById('pf-notify-' + item.key);
        if (!node) return;
        var was = !!(state.notify && state.notify[item.key]);
        if (node.checked !== was) { notify[item.key] = node.checked; notifyChanged = true; }
      });
      if (notifyChanged) entries.notify = notify;
    }

    if (!Object.keys(entries).length) {
      toast('Nothing to save — no changes yet.', 'success');
      return;
    }

    doSave(entries);
  }

  function doSave(entries) {
    var btn = document.getElementById('profile-save');
    state.saving = true;
    var restore = busyBtn(btn, 'Saving…');
    setFormDisabled(true);

    /* The live backend takes 10-20s per call — the spinner and the verb in the
       button are the "this is working" signal while we wait. */
    api.call('profile.update', entries).then(function (data) {
      state.me = mergeUser(state.me, entries, data && data.user);
      applyBaseline();
      state.saving = false;
      toast('Profile saved.', 'success');
      renderMain();
      if (typeof ui.renderHeader === 'function') {
        try { ui.renderHeader(); } catch (e) { /* ignore */ }
      }
      try {
        document.dispatchEvent(new CustomEvent('clinic:userchange', { detail: { user: state.me } }));
      } catch (e) { /* ignore */ }
    })['catch'](function (e) {
      /* Degrade gracefully: MOCK's profile.update may not yet accept a
         partial payload (see build report) — surface the error, do not
         throw, and leave the form exactly as the student left it. */
      state.saving = false;
      restore();
      setFormDisabled(false);
      var msg = errMsg(e, 'Could not save your profile. Try again in a moment.');
      showError(document.getElementById('profile-error'), msg);
      toast(msg, 'error');
    });
  }

  /* ------------------------------------------------------------ lifecycle */

  function showFatal(msg) {
    var main = document.getElementById('profile-main');
    if (!main) return;
    clear(main);
    var box = el('div', 'empty-state mt-16');
    box.appendChild(iconEl('person'));
    box.appendChild(el('h3', '', 'Your profile is unavailable'));
    box.appendChild(el('p', '', msg));
    var btn = el('button', 'btn btn-sm mt-8', 'Try again');
    btn.type = 'button';
    btn.addEventListener('click', boot);
    box.appendChild(btn);
    main.appendChild(box);
  }

  /* Emails link to profile.html#notifications. The section is built by JS, so
     the browser's own fragment scroll has already fired and found nothing by
     the time it exists — do it ourselves, once, after the first render. */
  function jumpToHash() {
    if (String(window.location.hash || '') !== '#notifications') return;
    var sec = document.getElementById('notifications');
    if (!sec) return;
    try { sec.scrollIntoView({ block: 'start' }); } catch (e) { sec.scrollIntoView(); }
  }

  function refresh() {
    return load().then(function () {
      renderMain();
      jumpToHash();
    })['catch'](function (e) {
      showFatal(errMsg(e, 'Could not load your profile.'));
    });
  }

  function boot() {
    // requireLogin() redirects when signed out; only an explicit false stops us.
    if (typeof api.requireLogin === 'function' && api.requireLogin() === false) return;
    if (typeof ui.renderHeader === 'function') {
      try { ui.renderHeader(); } catch (e) { console.error('[profile] renderHeader', e); }
    }
    var main = document.getElementById('profile-main');
    if (main) { clear(main); main.appendChild(el('div', 'spinner spinner-block')); }
    refresh();
  }

  /* Keep in step with the header's own "Edit display name" fast path (it
     stays working by design) in case both are used in the same tab. */
  document.addEventListener('clinic:userchange', function (ev) {
    if (state.saving) return;
    var u = ev && ev.detail && ev.detail.user;
    if (!u || !u.user_id) return;
    if (u === state.me) return;   // our own doSave() already rendered this
    if (state.me && state.me.user_id && state.me.user_id !== u.user_id) return;
    state.me = Object.assign({}, state.me, u);
    applyBaseline();
    renderMain();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
