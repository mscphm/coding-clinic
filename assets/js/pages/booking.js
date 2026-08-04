/* NUS Coding Clinic — booking.html (agent A3)
   Slot grid, booking form, my-booking card.  SPEC §8 (booking.html) and §9.

   No fetch() here: every call goes through Clinic.api.call(action, data).
   All dynamic text is inserted with textContent — never innerHTML. */
(function () {
  'use strict';

  var C = window.Clinic || {};
  var api = C.api;
  var ui = C.ui || {};

  if (!api || typeof api.call !== 'function') {
    console.error('[booking] Clinic.api is missing');
    return;
  }

  var PREFILL_KEY = 'clinic_booking_prefill';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var NDASH = '–';

  var state = {
    slots: [],
    dates: [],        // [{date, slots:[…]}] ascending
    myBooking: null,
    cutoffIso: '',
    cutoffPassed: false,
    threads: [],      // every thread (for titles)
    myThreads: [],    // threads authored by me
    me: null,
    config: null,
    selected: null,   // slot object
    wantThread: ''    // ?thread=t_xxx
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

  function confirmModal(msg) {
    if (typeof ui.confirmModal === 'function') {
      try { return Promise.resolve(ui.confirmModal(msg)); } catch (e) { /* fall through */ }
    }
    return Promise.resolve(window.confirm(msg));
  }

  function readJson(key) {
    try { return JSON.parse(window.localStorage.getItem(key) || 'null'); } catch (e) { return null; }
  }

  function writeJson(key, val) {
    try { window.localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* ignore */ }
  }

  function currentUser() {
    try {
      if (typeof api.getUser === 'function') { var u = api.getUser(); if (u) return u; }
    } catch (e) { /* ignore */ }
    return readJson('clinic_user') || {};
  }

  function errMsg(e, fallback) { return (e && (e.message || e.error)) || fallback; }

  /* ------------------------------------------------------- SGT date utils
     SGT is a fixed UTC+8 offset (no DST), so we shift the epoch by +8h and
     read the UTC getters. No dependency on Intl timezone data. */

  function sgt(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return null;
    return new Date(t + 8 * 3600000);
  }

  function ymd(dateStr) {
    var p = String(dateStr || '').split('-');
    if (p.length !== 3) return null;
    var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return isNaN(d.getTime()) ? null : d;
  }

  function minutesOf(hhmm) {
    var p = String(hhmm || '').split(':');
    if (p.length < 2) return 0;
    return (+p[0]) * 60 + (+p[1]);
  }

  function h12(mins) {
    var m = ((mins % 1440) + 1440) % 1440;
    var h = Math.floor(m / 60), mm = m % 60, hh = h % 12;
    if (hh === 0) hh = 12;
    return hh + ':' + (mm < 10 ? '0' : '') + mm;
  }

  function meridiem(mins) { var m = ((mins % 1440) + 1440) % 1440; return m >= 720 ? 'pm' : 'am'; }
  function fmtTime(mins) { return h12(mins) + ' ' + meridiem(mins); }

  function fmtRange(a, b) {
    if (meridiem(a) === meridiem(b)) return h12(a) + NDASH + h12(b) + ' ' + meridiem(b);
    return h12(a) + ' ' + meridiem(a) + NDASH + h12(b) + ' ' + meridiem(b);
  }

  function fmtDateLong(dateStr) {           // "Thursday 13 Aug 2026"
    var d = ymd(dateStr);
    if (!d) return String(dateStr || '');
    return DAYS[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function fmtStampShort(iso) {             // "Wed 12 Aug, 11:59 pm"
    var d = sgt(iso);
    if (!d) return '';
    return DAYS_SHORT[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()]
      + ', ' + fmtTime(d.getUTCHours() * 60 + d.getUTCMinutes());
  }

  function slotStartMs(slot) {
    var p = String(slot.date || '').split('-');
    if (p.length !== 3) return NaN;
    return Date.UTC(+p[0], +p[1] - 1, +p[2]) + minutesOf(slot.start_time) * 60000 - 8 * 3600000;
  }

  function slotEndMs(slot) { return slotStartMs(slot) + (Number(slot.duration_min) || 20) * 60000; }

  function slotTimeText(slot) {
    var s = minutesOf(slot.start_time);
    return fmtRange(s, s + (Number(slot.duration_min) || 20));
  }

  function slotFullText(slot) {             // "Thursday 13 Aug 2026, 1:00–1:20 pm"
    return fmtDateLong(slot.date) + ', ' + slotTimeText(slot);
  }

  /* ------------------------------------------------------------ data load */

  function load() {
    return Promise.all([
      api.call('slots.list', {}),
      api.call('threads.list', {})['catch'](function (e) { return { __error: e }; }),
      loadConfig()
    ]).then(function (res) {
      var slotsRes = res[0] || {};
      var threadsRes = res[1] || {};
      state.config = res[2] || state.config;
      state.me = currentUser();

      var now = Date.now();
      state.slots = (slotsRes.slots || []).filter(function (s) {
        var end = slotEndMs(s);
        return isNaN(end) ? true : end > now;
      }).sort(function (a, b) { return slotStartMs(a) - slotStartMs(b); });

      var booking = slotsRes.my_booking || null;
      if (booking && booking.status && booking.status !== 'confirmed') booking = null;
      state.myBooking = booking;

      state.cutoffIso = slotsRes.cutoff_iso || '';
      var cut = Date.parse(state.cutoffIso);
      state.cutoffPassed = !isNaN(cut) && Date.now() > cut;

      state.dates = groupByDate(state.slots);

      state.threads = threadsRes.__error ? [] : (threadsRes.threads || []);
      var myId = state.me && state.me.user_id;
      state.myThreads = state.threads.filter(function (t) {
        if (!t) return false;
        if (t.mine === true) return true;
        return t.author && myId && t.author.user_id === myId;
      }).sort(function (a, b) {
        return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
      });

      if (threadsRes.__error) {
        toast('Could not load your threads — ' + errMsg(threadsRes.__error, 'try refreshing.'), 'error');
      }
    });
  }

  function loadConfig() {
    var p;
    if (typeof api.bootstrap === 'function') {
      try { p = Promise.resolve(api.bootstrap()); } catch (e) { p = null; }
    }
    if (!p) p = api.call('meta.bootstrap', {});
    return p.then(function (b) { return (b && b.config) || cachedConfig(); })['catch'](cachedConfig);
  }

  function cachedConfig() {
    var boot = null;
    try { if (typeof api.cachedBootstrap === 'function') boot = api.cachedBootstrap(); } catch (e) { /* ignore */ }
    if (!boot) boot = readJson('clinic_bootstrap');
    return (boot && boot.config) || null;
  }

  function groupByDate(slots) {
    var map = {}, order = [];
    slots.forEach(function (s) {
      if (!map[s.date]) { map[s.date] = { date: s.date, slots: [] }; order.push(s.date); }
      map[s.date].slots.push(s);
    });
    order.sort();
    return order.map(function (d) { return map[d]; });
  }

  function dayRangeText(group) {
    var starts = [], ends = [];
    group.slots.forEach(function (s) {
      var st = minutesOf(s.start_time);
      starts.push(st);
      ends.push(st + (Number(s.duration_min) || 20));
    });
    return fmtRange(Math.min.apply(null, starts), Math.max.apply(null, ends));
  }

  /* ---------------------------------------------------------------- render */

  function render() { renderSidebar(); renderMain(); }

  function renderSidebar() {
    var side = document.getElementById('booking-sidebar');
    if (!side) return;
    clear(side);

    var cfg = state.config || {};
    var clinic = cfg.clinic || {};
    var mins = clinic.slot_minutes || (state.slots[0] && state.slots[0].duration_min) || 20;
    var clinicDay = clinic.day || 'Thursday';
    var cutoffDay = clinic.cutoff_day || 'Wednesday';
    var cutoffTime = clinic.cutoff_time ? fmtTime(minutesOf(clinic.cutoff_time)) : '11:59 pm';
    var hours = (clinic.start && clinic.end)
      ? fmtRange(minutesOf(clinic.start), minutesOf(clinic.end)) : '';

    var how = el('section', 'side-section');
    how.appendChild(el('h2', 'side-title', 'How clinic works'));
    var ul = el('ul', 'fs-small muted');
    [
      mins + '-minute slots, one student per slot' + (hours ? ' — ' + clinicDay + ', ' + hours : ''),
      'Come with your thread. Book only after posting your question, so we spend the time on the problem.',
      'Bookings close ' + cutoffDay + ' ' + cutoffTime + ' for that week’s clinic.',
      'One active booking at a time — cancel yours to free the slot for someone else.'
    ].forEach(function (line) { ul.appendChild(el('li', 'mb-8', line)); });
    how.appendChild(ul);
    side.appendChild(how);

    if (cfg.notice_text) {
      var nsec = el('section', 'side-section');
      var box = el('div', 'notice-box');
      box.appendChild(el('strong', '', 'Notice'));
      box.appendChild(el('p', '', cfg.notice_text));
      nsec.appendChild(box);
      side.appendChild(nsec);
    }
  }

  function renderMain() {
    var main = document.getElementById('booking-main');
    if (!main) return;
    clear(main);

    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Clinic booking'));
    main.appendChild(head);
    main.appendChild(el('p', 'muted mb-16',
      'One-to-one time with the instructor. Every booking is tied to one of your threads.'));

    main.appendChild(cutoffBanner());

    if (state.myBooking) main.appendChild(myBookingCard());
    else if (!state.myThreads.length) main.appendChild(threadBlocker(true));

    if (!state.dates.length) {
      main.appendChild(emptyState('calendar', 'No clinic slots on offer yet',
        'Slots for the coming weeks have not been published. Check back after Monday, or ask in a thread.'));
      return;
    }

    main.appendChild(dateSection(state.dates[0]));

    if (state.dates.length > 1) {
      var det = el('details', 'mt-24');
      det.appendChild(el('summary', 'side-title', 'Later clinic dates (' + (state.dates.length - 1) + ')'));
      state.dates.slice(1).forEach(function (g) { det.appendChild(dateSection(g)); });
      main.appendChild(det);
    }

    var host = el('div');
    host.id = 'booking-panel-host';
    main.appendChild(host);
    renderPanel();
  }

  function cutoffBanner() {
    var note = el('div', 'cutoff-note' + (state.cutoffPassed ? ' is-passed' : ''));
    note.appendChild(iconEl('calendar'));
    var txt;
    if (!state.cutoffIso) txt = 'Bookings close the day before the clinic.';
    else if (state.cutoffPassed) txt = 'Bookings for this week have closed';
    else txt = 'Bookings close ' + fmtStampShort(state.cutoffIso);
    note.appendChild(el('span', '', txt));
    return note;
  }

  function dateSection(group) {
    var wrap = el('section');
    var day = el('div', 'slot-day');
    day.appendChild(el('span', '', fmtDateLong(group.date)));
    day.appendChild(el('small', '', dayRangeText(group)));
    wrap.appendChild(day);

    var grid = el('div', 'slot-grid');
    group.slots.forEach(function (s) { grid.appendChild(slotCard(s)); });
    wrap.appendChild(grid);

    var openCount = group.slots.filter(function (s) { return slotState(s) === 'open'; }).length;
    if (!openCount && !state.myBooking) {
      wrap.appendChild(emptyState('calendar', 'Every slot on this date is taken',
        state.cutoffPassed
          ? 'Bookings for this week have closed. Post your question as a thread — questions are answered within one working day.'
          : 'Try a later date, or post your question as a thread — most issues are solved there without a slot.'));
    }
    return wrap;
  }

  function slotState(slot) {
    if (state.myBooking && state.myBooking.slot_id === slot.slot_id) return 'mine';
    if (slot.status === 'blocked') return 'blocked';
    if (slot.status === 'booked') return 'taken';
    return 'open';
  }

  function slotCard(slot) {
    var st = slotState(slot);
    var selected = state.selected && state.selected.slot_id === slot.slot_id;
    var card = el('button', 'slot-card ' + st + (selected ? ' selected' : ''));
    card.type = 'button';
    card.appendChild(el('span', 'slot-time', slotTimeText(slot)));
    card.appendChild(el('span', 'slot-status',
      { open: 'Available', taken: 'Taken', blocked: 'Unavailable', mine: 'Your slot' }[st]));

    var selectable = st === 'open' && !state.cutoffPassed && !state.myBooking;
    if (!selectable) {
      card.disabled = true;
      if (st === 'open' && state.myBooking) card.title = 'You already have a booking';
      else if (st === 'open' && state.cutoffPassed) card.title = 'Bookings for this week have closed';
    } else {
      card.setAttribute('aria-pressed', selected ? 'true' : 'false');
      card.addEventListener('click', function () {
        state.selected = slot;
        renderMain();
        var host = document.getElementById('booking-panel-host');
        if (host && host.scrollIntoView) host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }
    return card;
  }

  function emptyState(iconName, title, body) {
    var box = el('div', 'empty-state mt-16');
    box.appendChild(iconEl(iconName));
    box.appendChild(el('h3', '', title));
    if (body) box.appendChild(el('p', '', body));
    return box;
  }

  /* ----------------------------------------------------------- my booking */

  function myBookingCard() {
    var b = state.myBooking;
    var card = el('div', 'my-booking-card mb-24');
    var h = el('h3');
    h.appendChild(iconEl('check-circle'));
    h.appendChild(el('span', '', 'Your clinic slot is booked'));
    card.appendChild(h);

    var slot = findSlot(b.slot_id);
    var thread = findThread(b.thread_id);

    var dl = el('dl');
    dl.appendChild(el('dt', '', 'When'));
    dl.appendChild(el('dd', '', slot ? slotFullText(slot) : 'Slot ' + b.slot_id));

    dl.appendChild(el('dt', '', 'About'));
    var dd = el('dd');
    if (b.thread_id) {
      var a = el('a', '', (thread && thread.title) || 'your thread');
      a.href = 'thread.html?id=' + encodeURIComponent(b.thread_id);
      dd.appendChild(a);
    } else {
      dd.appendChild(el('span', 'muted', 'no thread linked'));
    }
    dl.appendChild(dd);

    if (b.note) {
      dl.appendChild(el('dt', '', 'Your note'));
      dl.appendChild(el('dd', '', b.note));
    }
    card.appendChild(dl);

    card.appendChild(el('strong', '', 'Before you come'));
    var ul = el('ul');
    ['re-read your thread', 'have your environment open', 'be ready to share the exact error']
      .forEach(function (t) { ul.appendChild(el('li', '', t)); });
    card.appendChild(ul);

    if (state.cutoffPassed) {
      card.appendChild(el('p', 'muted fs-small',
        'Cancellations have closed — past cutoff, email the instructor.'));
    } else {
      var btn = el('button', 'btn btn-danger btn-sm', 'Cancel booking');
      btn.type = 'button';
      btn.addEventListener('click', function () { cancelBooking(btn); });
      card.appendChild(btn);
    }
    return card;
  }

  function findSlot(slotId) {
    for (var i = 0; i < state.slots.length; i++) if (state.slots[i].slot_id === slotId) return state.slots[i];
    return null;
  }

  function findThread(threadId) {
    for (var i = 0; i < state.threads.length; i++) if (state.threads[i].thread_id === threadId) return state.threads[i];
    return null;
  }

  function cancelBooking(btn) {
    var b = state.myBooking;
    if (!b) return;
    confirmModal('Cancel your clinic slot? The time goes back on offer for the rest of the class.')
      .then(function (yes) {
        if (!yes) return;
        btn.disabled = true;
        btn.textContent = 'Cancelling…';
        return api.call('slots.cancel', { booking_id: b.booking_id }).then(function () {
          toast('Booking cancelled.', 'success');
          state.selected = null;
          return refresh();
        })['catch'](function (e) {
          btn.disabled = false;
          btn.textContent = 'Cancel booking';
          if (e && e.code === 'cutoff_passed') {
            toast('Past cutoff — email the instructor.', 'error');
            return refresh();
          }
          toast(errMsg(e, 'Could not cancel that booking.'), 'error');
        });
      });
  }

  /* -------------------------------------------------------- booking panel */

  function renderPanel() {
    var host = document.getElementById('booking-panel-host');
    if (!host) return;
    clear(host);
    if (!state.selected || state.myBooking || state.cutoffPassed) return;

    var panel = el('div', 'booking-panel');
    panel.appendChild(el('h3', '', 'Book ' + slotFullText(state.selected)));

    if (!state.myThreads.length) {
      panel.appendChild(threadBlocker(false));
      host.appendChild(panel);
      return;
    }

    var prefill = readJson(PREFILL_KEY) || {};
    var me = state.me || {};

    var pair = el('div', 'form-row');
    panel.appendChild(pair);
    var nameIn = field(pair, 'Full name', 'input', {
      id: 'bk-name', value: prefill.full_name || me.display_name || '',
      hint: 'As it appears on your student record.',
      attrs: { autocomplete: 'name', maxlength: '80' }
    });
    var phoneIn = field(pair, 'Mobile number', 'input', {
      id: 'bk-phone', value: prefill.phone || '',
      hint: 'Singapore mobile, e.g. 9123 4567 (+65 optional).',
      attrs: { type: 'tel', autocomplete: 'tel', maxlength: '20' }
    });

    var emailIn = field(panel, 'Email', 'input', {
      id: 'bk-email', value: me.email || '',
      hint: 'Your confirmation is sent here.',
      attrs: { type: 'email', autocomplete: 'email', maxlength: '120' }
    });

    var threadSel = field(panel, 'Which of your threads is this about?', 'select', {
      id: 'bk-thread',
      hint: 'All your threads appear here, including ones you posted anonymously — this list is visible only to you.'
    });
    var ph = el('option', '', 'Choose a thread…');
    ph.value = '';
    threadSel.appendChild(ph);
    state.myThreads.forEach(function (t) {
      var title = String(t.title || '(untitled)');
      if (title.length > 80) title = title.slice(0, 77) + '…';
      if (t.author && t.author.user_id === 'anon') title += ' (posted anonymously)';
      var o = el('option', '', title);
      o.value = t.thread_id;
      threadSel.appendChild(o);
    });
    if (state.wantThread) {
      for (var i = 0; i < state.myThreads.length; i++) {
        if (state.myThreads[i].thread_id === state.wantThread) { threadSel.value = state.wantThread; break; }
      }
    }

    var noteIn = field(panel, 'Anything else? (optional)', 'textarea', {
      id: 'bk-note',
      attrs: { maxlength: '300', rows: '3' }
    });
    var counter = el('div', 'field-hint', 'Up to 300 characters — e.g. what you have already tried. 0 / 300');
    noteIn.parentNode.appendChild(counter);
    noteIn.addEventListener('input', function () {
      counter.textContent = 'Up to 300 characters — e.g. what you have already tried. '
        + noteIn.value.length + ' / 300';
    });

    var errBox = el('div', 'form-error');
    errBox.hidden = true;
    panel.appendChild(errBox);

    var actions = el('div', 'row mt-16');
    var submit = el('button', 'btn btn-primary', 'Confirm booking');
    submit.type = 'button';
    var back = el('button', 'btn', 'Choose another slot');
    back.type = 'button';
    back.addEventListener('click', function () { state.selected = null; renderMain(); });
    actions.appendChild(submit);
    actions.appendChild(back);
    panel.appendChild(actions);

    submit.addEventListener('click', function () {
      var vals = {
        full_name: nameIn.value.trim(),
        phone: phoneIn.value.trim(),
        email: emailIn.value.trim(),
        thread_id: threadSel.value,
        note: noteIn.value.trim()
      };
      var problem = validate(vals);
      if (problem) { showError(errBox, problem); return; }
      errBox.hidden = true;
      submitBooking(vals, submit, errBox);
    });

    host.appendChild(panel);
  }

  function showError(box, msg) {
    box.hidden = false;
    box.textContent = msg;
  }

  function field(parent, labelText, kind, opts) {
    opts = opts || {};
    var wrap = el('div', 'field');
    var lab = el('label', 'field-label', labelText);
    if (opts.id) lab.htmlFor = opts.id;
    wrap.appendChild(lab);

    var input;
    if (kind === 'select') input = el('select', 'select');
    else if (kind === 'textarea') input = el('textarea', 'textarea');
    else input = el('input', 'input');

    if (opts.id) input.id = opts.id;
    if (opts.value) input.value = opts.value;
    if (opts.attrs) Object.keys(opts.attrs).forEach(function (k) { input.setAttribute(k, opts.attrs[k]); });
    wrap.appendChild(input);
    if (opts.hint) wrap.appendChild(el('div', 'field-hint', opts.hint));
    parent.appendChild(wrap);
    return input;
  }

  function validate(v) {
    if (v.full_name.length < 2) return 'Enter your full name.';
    var phone = v.phone.replace(/[\s()\-]/g, '');
    if (!/^(\+?65)?[89]\d{7}$/.test(phone)) {
      return 'Enter a Singapore mobile number — 8 digits starting with 8 or 9 (+65 optional).';
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email)) return 'Enter a valid email address.';
    if (!v.thread_id) return 'Choose the thread this session is about.';
    if (v.note.length > 300) return 'Keep the note under 300 characters.';
    return '';
  }

  function submitBooking(vals, btn, errBox) {
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = 'Booking…';
    writeJson(PREFILL_KEY, { full_name: vals.full_name, phone: vals.phone });

    api.call('slots.book', {
      slot_id: state.selected.slot_id,
      full_name: vals.full_name,
      phone: vals.phone,
      email: vals.email,
      thread_id: vals.thread_id,
      note: vals.note
    }).then(function () {
      toast('Slot booked — a confirmation is on its way to your email.', 'success');
      state.selected = null;
      return refresh();
    })['catch'](function (e) {
      btn.disabled = false;
      btn.textContent = original;
      var code = e && e.code;
      if (code === 'conflict') {
        showError(errBox, 'That slot was just taken — pick another one.');
        toast('That slot was just taken.', 'error');
        state.selected = null;
        return refresh();
      }
      if (code === 'cutoff_passed') {
        showError(errBox, 'Bookings for this week have closed.');
        toast('Bookings for this week have closed.', 'error');
        state.selected = null;
        return refresh();
      }
      showError(errBox, errMsg(e, 'Could not book that slot. Try again in a moment.'));
      if (code !== 'bad_request') toast(errMsg(e, 'Could not book that slot.'), 'error');
    });
  }

  function threadBlocker(compact) {
    var box = el('div', compact ? 'notice-box mb-24' : 'empty-state');
    if (!compact) box.appendChild(iconEl('comment-discussion'));
    box.appendChild(el(compact ? 'strong' : 'h3', '',
      'No thread, no slot — post your question first so the session starts productive'));
    box.appendChild(el('p', '',
      'Write up what you are stuck on: what you tried, the exact error, and a minimal example. '
      + 'Many questions are answered in the thread within a day; if not, book a slot from there.'));
    var a = el('a', 'btn btn-primary btn-sm', 'Post a question');
    a.href = 'new.html';
    box.appendChild(a);
    return box;
  }

  /* ------------------------------------------------------------ lifecycle */

  function refresh() {
    return load().then(render)['catch'](function (e) {
      showFatal(errMsg(e, 'Could not load clinic slots.'));
    });
  }

  function showFatal(msg) {
    var main = document.getElementById('booking-main');
    if (!main) return;
    clear(main);
    var box = emptyState('calendar', 'Clinic slots are unavailable', msg);
    var btn = el('button', 'btn btn-sm mt-8', 'Try again');
    btn.type = 'button';
    btn.addEventListener('click', boot);
    box.appendChild(btn);
    main.appendChild(box);
  }

  function queryParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function boot() {
    // requireLogin() redirects when signed out; only an explicit false stops us.
    if (typeof api.requireLogin === 'function' && api.requireLogin() === false) return;
    if (typeof ui.renderHeader === 'function') {
      try { ui.renderHeader('booking'); } catch (e) { console.error('[booking] renderHeader', e); }
    }
    state.wantThread = queryParam('thread');
    var main = document.getElementById('booking-main');
    if (main) { clear(main); main.appendChild(el('div', 'spinner spinner-block')); }
    refresh();
  }

  // api.js refreshes the bootstrap in the background; pick up newer notice text.
  window.addEventListener('clinic:bootstrap', function (ev) {
    if (ev && ev.detail && ev.detail.config) {
      state.config = ev.detail.config;
      renderSidebar();
    }
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
