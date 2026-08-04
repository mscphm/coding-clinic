/* NUS Coding Clinic — admin.html (agent A3)
   Instructor dashboard: Overview, Threads, Bookings, Slots, Export (SPEC §8).

   Single data source: Clinic.api.call('admin.export', {}) on load + Refresh.
   Moderation is optimistic and reverts on failure.
   The instructor reads hostile student input here, so every dynamic string is
   inserted with textContent — there is no innerHTML with data in this file. */
(function () {
  'use strict';

  var C = window.Clinic || {};
  var api = C.api;
  var ui = C.ui || {};

  if (!api || typeof api.call !== 'function') {
    console.error('[admin] Clinic.api is missing');
    return;
  }

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  var NDASH = '–';

  var TABS = [
    { key: 'overview', label: 'Overview' },
    { key: 'threads', label: 'Threads' },
    { key: 'bookings', label: 'Bookings' },
    { key: 'slots', label: 'Slots' },
    { key: 'export', label: 'Export' }
  ];

  var CONFIG_FIELDS = [
    { key: 'site_title', label: 'Site title', kind: 'text' },
    { key: 'notice_text', label: 'Notice text', kind: 'textarea', hint: 'Shown in the sidebar on every page.' },
    { key: 'categories', label: 'Categories', kind: 'text', hint: 'Comma-separated list.' },
    { key: 'labels', label: 'Labels', kind: 'text', hint: 'Comma-separated list.' },
    { key: 'clinic_day', label: 'Clinic day', kind: 'weekday' },
    { key: 'clinic_start', label: 'Clinic start', kind: 'time' },
    { key: 'clinic_end', label: 'Clinic end', kind: 'time' },
    { key: 'slot_minutes', label: 'Slot length (minutes)', kind: 'number' },
    { key: 'booking_cutoff_day', label: 'Booking cutoff day', kind: 'weekday' },
    { key: 'booking_cutoff_time', label: 'Booking cutoff time', kind: 'time' },
    { key: 'max_active_bookings', label: 'Max active bookings per student', kind: 'number' }
  ];

  var state = {
    tab: 'overview',
    raw: null,
    config: {},
    users: [], usersById: {},
    threads: [], threadsById: {},
    posts: [],
    votes: [],
    slots: [], slotsById: {},
    bookings: [],
    repliesByThread: {},
    voteCount: {},
    loadedAt: 0
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

  function pillEl(text) {
    try {
      if (typeof ui.pill === 'function') {
        var out = ui.pill(text);
        if (out && out.nodeType) return out;
      }
    } catch (e) { /* ignore */ }
    return el('span', 'pill', text);
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

  function currentUser() {
    try { if (typeof api.getUser === 'function') { var u = api.getUser(); if (u) return u; } } catch (e) { /* ignore */ }
    try { return JSON.parse(window.localStorage.getItem('clinic_user') || 'null') || {}; }
    catch (e) { return {}; }
  }

  function errMsg(e, fallback) { return (e && (e.message || e.error)) || fallback; }

  function truthy(v) {
    if (v === true) return true;
    if (v === false || v === null || v === undefined) return false;
    return /^(true|yes|1)$/i.test(String(v).trim());
  }

  function listOf(v) {
    if (Array.isArray(v)) return v.slice();
    return String(v || '').split(',').map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length; });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* ------------------------------------------------------- SGT date utils
     SGT is a fixed UTC+8 offset (no DST): shift the epoch by +8h, then read
     the UTC getters. No dependency on Intl timezone data. */

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
    return hh + ':' + pad2(mm);
  }

  function meridiem(mins) { var m = ((mins % 1440) + 1440) % 1440; return m >= 720 ? 'pm' : 'am'; }
  function fmtTime(mins) { return h12(mins) + ' ' + meridiem(mins); }

  function fmtRange(a, b) {
    if (meridiem(a) === meridiem(b)) return h12(a) + NDASH + h12(b) + ' ' + meridiem(b);
    return h12(a) + ' ' + meridiem(a) + NDASH + h12(b) + ' ' + meridiem(b);
  }

  function fmtDateMed(dateStr) {            // "Thu 13 Aug 2026"
    var d = ymd(dateStr);
    if (!d) return String(dateStr || '');
    return DAYS_SHORT[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }

  function fmtStampSgt(iso) {               // "13 Aug 2026, 1:04 pm"
    var d = sgt(iso);
    if (!d) return '';
    return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear()
      + ', ' + fmtTime(d.getUTCHours() * 60 + d.getUTCMinutes());
  }

  function isoSgt(iso) {                    // "2026-08-13 13:04 SGT" for CSVs
    var d = sgt(iso);
    if (!d) return '';
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
      + ' ' + pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes()) + ' SGT';
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

  function mondayOf(d) { return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400000); }
  function dateKey(d) { return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()); }

  function weekKeyFromIso(iso) {
    var d = sgt(iso);
    if (!d) return '';
    return dateKey(mondayOf(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))));
  }

  function weekKeyFromDate(dateStr) {
    var d = ymd(dateStr);
    return d ? dateKey(mondayOf(d)) : '';
  }

  function isoWeekNum(d) {
    var t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7) + 3);       // Thursday of this week
    var firstThu = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
    firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
    return 1 + Math.round((t.getTime() - firstThu.getTime()) / (7 * 86400000));
  }

  function lastWeeks(n) {
    var nowSgt = new Date(Date.now() + 8 * 3600000);
    var monday = mondayOf(new Date(Date.UTC(nowSgt.getUTCFullYear(), nowSgt.getUTCMonth(), nowSgt.getUTCDate())));
    var out = [];
    for (var i = n - 1; i >= 0; i--) {
      var m = new Date(monday.getTime() - i * 7 * 86400000);
      out.push({
        key: dateKey(m),
        short: 'W' + isoWeekNum(m),
        label: 'W' + isoWeekNum(m) + ' — week of ' + m.getUTCDate() + ' ' + MONTHS[m.getUTCMonth()]
      });
    }
    return out;
  }

  /* -------------------------------------------------------- data shaping */

  function configMap(raw) {
    var out = {};
    if (!raw) return out;
    if (Array.isArray(raw)) {                       // [{key, value}, …]
      raw.forEach(function (r) {
        if (!r) return;
        var k = r.key !== undefined ? r.key : r.Key;
        var v = r.value !== undefined ? r.value : r.Value;
        if (k !== undefined) out[String(k)] = (v === undefined || v === null) ? '' : String(v);
      });
      return out;
    }
    Object.keys(raw).forEach(function (k) {         // {key: value, …}
      var v = raw[k];
      out[k] = (v === null || v === undefined) ? ''
        : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    });
    return out;
  }

  function indexBy(rows, key) {
    var m = {};
    (rows || []).forEach(function (r) { if (r && r[key] !== undefined) m[r[key]] = r; });
    return m;
  }

  function ingest(data) {
    state.raw = data || {};
    state.config = configMap(state.raw.config);
    state.users = state.raw.users || [];
    state.usersById = indexBy(state.users, 'user_id');
    state.threads = state.raw.threads || [];
    state.threadsById = indexBy(state.threads, 'thread_id');
    state.posts = state.raw.posts || [];
    state.votes = state.raw.votes || [];
    state.slots = (state.raw.slots || []).slice().sort(function (a, b) { return slotStartMs(a) - slotStartMs(b); });
    state.slotsById = indexBy(state.slots, 'slot_id');
    state.bookings = state.raw.bookings || [];
    state.loadedAt = Date.now();

    state.repliesByThread = {};
    state.posts.forEach(function (p) {
      if (truthy(p.deleted)) return;
      state.repliesByThread[p.thread_id] = (state.repliesByThread[p.thread_id] || 0) + 1;
    });

    state.voteCount = {};
    state.votes.forEach(function (v) {
      var k = v.target_type + ':' + v.target_id;
      state.voteCount[k] = (state.voteCount[k] || 0) + 1;
    });
  }

  function userName(userId) {
    var u = state.usersById[userId];
    return (u && u.display_name) || (userId ? String(userId) : '');
  }

  function displayAuthor(row) { return truthy(row.is_anonymous) ? 'Anonymous' : userName(row.author_id); }
  function realName(row) { return truthy(row.is_anonymous) ? userName(row.author_id) : ''; }
  function votesFor(type, id) { return state.voteCount[type + ':' + id] || 0; }
  function threadTitle(id) { var t = state.threadsById[id]; return t ? (t.title || '') : ''; }

  /* ------------------------------------------------------------ row menu */

  var openMenuEl = null;

  function closeMenu() {
    if (openMenuEl && openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl);
    openMenuEl = null;
    document.removeEventListener('click', closeMenu, true);
    document.removeEventListener('keydown', onEsc, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
  }

  function onEsc(ev) { if (ev.key === 'Escape' || ev.keyCode === 27) closeMenu(); }

  function openMenu(anchor, items) {
    closeMenu();
    var menu = el('div', 'menu-dropdown row-menu');
    menu.setAttribute('role', 'menu');
    // The shared class positions itself against a relative parent; row menus
    // live on <body> so they escape the table's horizontal scroll box.
    menu.style.position = 'fixed';
    menu.style.right = 'auto';

    items.forEach(function (it) {
      if (!it) return;
      if (it.sep) { menu.appendChild(el('div', 'menu-sep')); return; }
      var b = el('button', 'menu-item' + (it.danger ? ' is-danger' : ''), it.label);
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.addEventListener('click', function (ev) {
        ev.stopPropagation();
        closeMenu();
        it.onClick();
      });
      menu.appendChild(b);
    });
    document.body.appendChild(menu);

    var r = anchor.getBoundingClientRect();
    var left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
    var top = r.bottom + 4;
    if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    openMenuEl = menu;

    window.setTimeout(function () {
      document.addEventListener('click', closeMenu, true);
      document.addEventListener('keydown', onEsc, true);
      window.addEventListener('resize', closeMenu);
      window.addEventListener('scroll', closeMenu, true);
    }, 0);
  }

  function kebabButton(itemsFn) {
    var b = el('button', 'btn-invisible btn-sm');
    b.type = 'button';
    b.setAttribute('aria-label', 'Row actions');
    b.setAttribute('aria-haspopup', 'true');
    b.appendChild(iconEl('kebab'));
    if (!b.childNodes.length) b.textContent = '⋯';
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      openMenu(b, itemsFn());
    });
    return b;
  }

  /* --------------------------------------------------------------- shell */

  function renderShell() {
    var main = document.getElementById('admin-main');
    if (!main) return;
    clear(main);
    closeMenu();

    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Instructor dashboard'));
    var right = el('div', 'row');
    var sgtNow = new Date(state.loadedAt + 8 * 3600000);
    right.appendChild(el('span', 'muted fs-small',
      'Loaded ' + fmtTime(sgtNow.getUTCHours() * 60 + sgtNow.getUTCMinutes()) + ' SGT'));
    var refreshBtn = el('button', 'btn btn-sm', 'Refresh');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', function () {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Refreshing…';
      loadData().then(function () { renderShell(); toast('Dashboard refreshed.', 'success'); })
      ['catch'](function (e) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Refresh';
        toast(errMsg(e, 'Refresh failed.'), 'error');
      });
    });
    right.appendChild(refreshBtn);
    head.appendChild(right);
    main.appendChild(head);

    var tabs = el('div', 'tab-bar');
    tabs.setAttribute('role', 'tablist');
    TABS.forEach(function (t) {
      var b = el('button', 'tab' + (state.tab === t.key ? ' active' : ''), t.label);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', state.tab === t.key ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.tab = t.key;
        try { window.history.replaceState(null, '', '#' + t.key); }
        catch (e) { window.location.hash = t.key; }
        renderShell();
      });
      tabs.appendChild(b);
    });
    main.appendChild(tabs);

    var panel = el('div');
    panel.id = 'admin-panel';
    main.appendChild(panel);
    renderPanel();
  }

  function renderPanel() {
    var panel = document.getElementById('admin-panel');
    if (!panel) return;
    clear(panel);
    closeMenu();
    if (state.tab === 'overview') renderOverview(panel);
    else if (state.tab === 'threads') renderThreads(panel);
    else if (state.tab === 'bookings') renderBookings(panel);
    else if (state.tab === 'slots') renderSlots(panel);
    else renderExport(panel);
  }

  /* ------------------------------------------------------------ overview */

  function pct(n, total) { return total ? Math.round((n / total) * 100) + '%' : '—'; }

  function renderOverview(panel) {
    var liveThreads = state.threads.filter(function (t) { return !truthy(t.deleted); });
    var livePosts = state.posts.filter(function (p) { return !truthy(p.deleted); });
    var answered = liveThreads.filter(function (t) { return String(t.status) === 'answered'; }).length;

    var authors = {};
    liveThreads.concat(livePosts).forEach(function (r) {
      if (!r.author_id) return;
      var u = state.usersById[r.author_id];
      if (u && u.role === 'instructor') return;
      authors[r.author_id] = true;
    });

    var confirmed = state.bookings.filter(function (b) { return String(b.status) === 'confirmed'; });
    var marked = confirmed.filter(function (b) { return b.attendance === 'attended' || b.attendance === 'no_show'; });
    var attended = marked.filter(function (b) { return b.attendance === 'attended'; }).length;

    var items = liveThreads.concat(livePosts);
    var anon = items.filter(function (r) { return truthy(r.is_anonymous); }).length;

    var cards = el('div', 'stat-cards');
    [
      [String(liveThreads.length), 'Threads'],
      [pct(answered, liveThreads.length), 'Answered'],
      [String(livePosts.length), 'Replies'],
      [String(Object.keys(authors).length), 'Active students'],
      [String(confirmed.length), 'Bookings this term'],
      [marked.length ? pct(attended, marked.length) : '—', 'Attendance rate'],
      [pct(anon, items.length), 'Posted anonymously']
    ].forEach(function (pair) {
      var c = el('div', 'stat-card');
      c.appendChild(el('strong', '', pair[0]));
      c.appendChild(el('span', '', pair[1]));
      cards.appendChild(c);
    });
    panel.appendChild(cards);

    if (confirmed.length && marked.length < confirmed.length) {
      panel.appendChild(el('p', 'muted fs-small mb-16',
        'Attendance rate covers the ' + marked.length + ' of ' + confirmed.length
        + ' confirmed bookings that have been marked — mark the rest on the Bookings tab.'));
    }

    var grid = el('div', 'chart-grid');

    /* threads per category — horizontal bars */
    var catCounts = {};
    listOf(state.config.categories).forEach(function (c) { catCounts[c] = 0; });
    liveThreads.forEach(function (t) {
      var c = t.category || '(no category)';
      catCounts[c] = (catCounts[c] || 0) + 1;
    });
    var catRows = Object.keys(catCounts).map(function (k) { return { label: k, value: catCounts[k] }; })
      .sort(function (a, b) { return b.value - a.value; });
    var catCard = chartCard('Threads per category');
    if (catRows.length) catCard.appendChild(hBars(catRows));
    else catCard.appendChild(el('p', 'muted fs-small', 'No threads yet.'));
    grid.appendChild(catCard);

    /* threads per ISO week — columns */
    var weeks = lastWeeks(10);
    var weekCounts = {};
    liveThreads.forEach(function (t) {
      var k = weekKeyFromIso(t.created_at);
      if (k) weekCounts[k] = (weekCounts[k] || 0) + 1;
    });
    var wkCard = chartCard('Threads per week (last 10, SGT)');
    wkCard.appendChild(colChart(weeks.map(function (w) {
      var n = weekCounts[w.key] || 0;
      return { short: w.short, label: w.label, title: w.label + ': ' + n + ' thread' + (n === 1 ? '' : 's'), values: [n] };
    }), [{ cls: '', name: 'Threads' }]));
    grid.appendChild(wkCard);

    /* booked vs attended per week — stacked columns (total = booked) */
    var bookedW = {}, attendedW = {};
    confirmed.forEach(function (b) {
      var slot = state.slotsById[b.slot_id];
      var k = slot ? weekKeyFromDate(slot.date) : weekKeyFromIso(b.created_at);
      if (!k) return;
      bookedW[k] = (bookedW[k] || 0) + 1;
      if (b.attendance === 'attended') attendedW[k] = (attendedW[k] || 0) + 1;
    });
    var bkCard = chartCard('Booked vs attended per week');
    bkCard.appendChild(colChart(weeks.map(function (w) {
      var booked = bookedW[w.key] || 0;
      var att = attendedW[w.key] || 0;
      return {
        short: w.short,
        label: w.label,
        title: w.label + ': ' + booked + ' booked, ' + att + ' attended',
        values: [Math.max(0, booked - att), att]           // top segment, then bottom
      };
    }), [{ cls: 'is-muted', name: 'Booked, not attended' }, { cls: 'is-success', name: 'Attended' }]));
    bkCard.appendChild(legend([
      { cls: 'is-success', name: 'Attended' },
      { cls: 'is-muted', name: 'Booked, not attended' }
    ]));
    grid.appendChild(bkCard);

    panel.appendChild(grid);
  }

  function chartCard(title) {
    var card = el('div', 'chart');
    card.appendChild(el('h3', '', title));
    return card;
  }

  function hBars(rows) {
    var frag = document.createDocumentFragment();
    var max = 1;
    rows.forEach(function (r) { if (r.value > max) max = r.value; });
    rows.forEach(function (r) {
      var row = el('div', 'chart-row');
      row.title = r.label + ': ' + r.value;
      row.appendChild(el('span', 'chart-label', r.label));
      var track = el('span', 'chart-track');
      var fill = el('span', 'chart-fill');
      if (r.value > 0) fill.style.width = Math.round((r.value / max) * 100) + '%';
      else { fill.style.width = '0'; fill.style.minWidth = '0'; }
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'chart-value', String(r.value)));
      frag.appendChild(row);
    });
    return frag;
  }

  function colChart(items, series) {
    var frag = document.createDocumentFragment();
    var max = 1;
    items.forEach(function (it) {
      var total = 0;
      it.values.forEach(function (v) { total += v; });
      if (total > max) max = total;
    });

    var cols = el('div', 'chart-cols');
    items.forEach(function (it) {
      var col = el('div', 'chart-col');
      col.title = it.title || it.label;
      it.values.forEach(function (v, j) {
        if (v <= 0) return;
        var cls = series[j] && series[j].cls ? 'bar ' + series[j].cls : 'bar';
        var bar = el('span', cls);
        bar.style.height = Math.round((v / max) * 100) + '%';
        col.appendChild(bar);
      });
      cols.appendChild(col);
    });
    frag.appendChild(cols);

    var axis = el('div', 'chart-xaxis');
    items.forEach(function (it) {
      var s = el('span', '', it.short);
      s.title = it.label;
      axis.appendChild(s);
    });
    frag.appendChild(axis);
    return frag;
  }

  function legend(entries) {
    var l = el('div', 'chart-legend');
    entries.forEach(function (e) {
      var span = el('span');
      span.appendChild(el('span', e.cls ? 'swatch ' + e.cls : 'swatch'));
      span.appendChild(document.createTextNode(e.name));
      l.appendChild(span);
    });
    return l;
  }

  /* ------------------------------------------------------------- threads */

  function headRow(cols) {
    var thead = el('thead');
    var tr = el('tr');
    cols.forEach(function (c) {
      var th = el('th', c.cls || '', c.label !== undefined ? c.label : c);
      tr.appendChild(th);
    });
    thead.appendChild(tr);
    return thead;
  }

  function tableWrap(headers) {
    var wrap = el('div', 'table-wrap');
    var table = el('table', 'admin-table');
    table.appendChild(headRow(headers));
    var tbody = el('tbody');
    table.appendChild(tbody);
    wrap.appendChild(table);
    return { wrap: wrap, body: tbody };
  }

  function renderThreads(panel) {
    panel.appendChild(el('p', 'muted fs-small mb-16',
      'Every thread, including deleted ones (' + state.threads.length + ' total). '
      + 'Anonymous threads show “Anonymous” by design — identities appear only in the Export CSVs.'));

    var t = tableWrap([
      'Title', 'Category', 'Labels', 'Author', 'Status', 'Resolved via',
      { label: 'Replies', cls: 'num' }, { label: 'Upvotes', cls: 'num' },
      { label: 'Created', cls: 'nowrap' }, ''
    ]);

    var sorted = state.threads.slice().sort(function (a, b) {
      var pa = truthy(a.pinned) ? 1 : 0, pb = truthy(b.pinned) ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
    });
    if (!sorted.length) {
      var tr = el('tr');
      var td = el('td', 'muted', 'No threads yet.');
      td.colSpan = 10;
      tr.appendChild(td);
      t.body.appendChild(tr);
    }
    sorted.forEach(function (th) { t.body.appendChild(threadRow(th)); });
    panel.appendChild(t.wrap);
  }

  function threadRow(t) {
    var tr = el('tr', truthy(t.deleted) ? 'is-deleted' : '');

    var titleTd = el('td');
    var a = el('a', '', t.title || '(untitled)');
    a.href = 'thread.html?id=' + encodeURIComponent(t.thread_id);
    titleTd.appendChild(a);
    if (truthy(t.pinned)) titleTd.appendChild(el('span', 'badge-pinned', 'Pinned'));
    if (truthy(t.deleted)) titleTd.appendChild(el('span', 'badge', 'Deleted'));
    tr.appendChild(titleTd);

    tr.appendChild(el('td', '', t.category || ''));

    var labTd = el('td');
    listOf(t.labels).forEach(function (l) { labTd.appendChild(pillEl(l)); });
    tr.appendChild(labTd);

    var authTd = el('td', 'nowrap');
    if (truthy(t.is_anonymous)) {
      authTd.appendChild(iconEl('eye-closed'));
      authTd.appendChild(el('span', '', ' Anonymous'));
      authTd.title = 'Identities appear only in the Export CSVs';
    } else {
      authTd.appendChild(el('span', '', userName(t.author_id)));
    }
    tr.appendChild(authTd);

    var statusTd = el('td');
    if (String(t.status) === 'answered') statusTd.appendChild(el('span', 'badge-answered', 'Answered'));
    else statusTd.appendChild(el('span', 'muted', 'Open'));
    tr.appendChild(statusTd);

    tr.appendChild(el('td', '', t.resolved_via || '—'));
    tr.appendChild(el('td', 'num', String(state.repliesByThread[t.thread_id] || 0)));
    tr.appendChild(el('td', 'num', String(votesFor('thread', t.thread_id))));
    tr.appendChild(el('td', 'nowrap', fmtStampSgt(t.created_at)));

    var actTd = el('td', 'row-actions');
    actTd.appendChild(kebabButton(function () { return threadMenu(t); }));
    tr.appendChild(actTd);
    return tr;
  }

  function threadMenu(t) {
    var items = [];

    items.push({
      label: truthy(t.pinned) ? 'Unpin thread' : 'Pin thread',
      onClick: function () {
        var was = t.pinned;
        moderate(
          { op: truthy(was) ? 'unpin_thread' : 'pin_thread', thread_id: t.thread_id },
          function () { t.pinned = truthy(was) ? 'FALSE' : 'TRUE'; },
          function () { t.pinned = was; },
          truthy(was) ? 'Thread unpinned.' : 'Thread pinned.'
        );
      }
    });

    items.push({
      label: 'Edit labels…',
      onClick: function () {
        var suggested = listOf(state.config.labels).join(', ');
        var next = window.prompt(
          'Labels for “' + (t.title || '') + '”, comma separated.'
          + (suggested ? '\nConfigured labels: ' + suggested : ''),
          listOf(t.labels).join(', '));
        if (next === null) return;
        var arr = listOf(next);
        var was = t.labels;
        moderate(
          { op: 'set_labels', thread_id: t.thread_id, labels: arr },
          function () { t.labels = arr.join(','); },
          function () { t.labels = was; },
          'Labels updated.'
        );
      }
    });

    items.push({
      label: 'Set category…',
      onClick: function () {
        var cats = listOf(state.config.categories);
        var next = window.prompt('Category for “' + (t.title || '') + '”.'
          + (cats.length ? '\nOptions: ' + cats.join(', ') : ''), t.category || '');
        if (next === null) return;
        next = next.trim();
        if (!next) return;
        if (cats.length && cats.indexOf(next) === -1) {
          toast('“' + next + '” is not one of the configured categories.', 'error');
          return;
        }
        var was = t.category;
        moderate(
          { op: 'set_category', thread_id: t.thread_id, category: next },
          function () { t.category = next; },
          function () { t.category = was; },
          'Category updated.'
        );
      }
    });

    items.push({ sep: true });
    [['live', 'Mark resolved live (clinic)'], ['async', 'Mark resolved async (thread)'], ['', 'Clear resolution']]
      .forEach(function (pair) {
        items.push({
          label: pair[1],
          onClick: function () {
            var was = t.resolved_via;
            moderate(
              // `value` is sent alongside for flows that name the field generically.
              { op: 'set_resolved_via', thread_id: t.thread_id, resolved_via: pair[0], value: pair[0] },
              function () { t.resolved_via = pair[0]; },
              function () { t.resolved_via = was; },
              'Resolution updated.'
            );
          }
        });
      });

    items.push({ sep: true });
    if (truthy(t.deleted)) {
      items.push({
        label: 'Restore thread',
        onClick: function () {
          var was = t.deleted;
          moderate(
            { op: 'restore_thread', thread_id: t.thread_id },
            function () { t.deleted = 'FALSE'; },
            function () { t.deleted = was; },
            'Thread restored.'
          );
        }
      });
    } else {
      items.push({
        label: 'Delete thread',
        danger: true,
        onClick: function () {
          confirmModal('Delete “' + (t.title || '') + '”? It disappears for students, and you can restore it from this table.')
            .then(function (yes) {
              if (!yes) return;
              var was = t.deleted;
              moderate(
                { op: 'delete_thread', thread_id: t.thread_id },
                function () { t.deleted = 'TRUE'; },
                function () { t.deleted = was; },
                'Thread deleted.'
              );
            });
        }
      });
    }
    return items;
  }

  function moderate(payload, apply, undo, okMsg) {
    apply();
    renderPanel();
    api.call('admin.moderate', payload).then(function () {
      toast(okMsg, 'success');
    })['catch'](function (e) {
      undo();
      renderPanel();
      toast(errMsg(e, 'That change did not save.'), 'error');
    });
  }

  /* ------------------------------------------------------------ bookings */

  function renderBookings(panel) {
    var now = Date.now();
    var rows = state.bookings.slice();
    rows.forEach(function (b) {
      var slot = state.slotsById[b.slot_id];
      b.__ms = slot ? slotStartMs(slot) : (Date.parse(b.created_at) || 0);
      b.__end = slot ? slotEndMs(slot) : b.__ms;
    });
    var upcoming = rows.filter(function (b) { return b.__end >= now; })
      .sort(function (a, b) { return a.__ms - b.__ms; });
    var past = rows.filter(function (b) { return b.__end < now; })
      .sort(function (a, b) { return b.__ms - a.__ms; });

    panel.appendChild(el('p', 'muted fs-small mb-16',
      'Contact details are visible on this page only. They come straight from the workbook — '
      + 'do not paste them anywhere public.'));

    panel.appendChild(el('h2', 'side-title', 'Upcoming (' + upcoming.length + ')'));
    if (!upcoming.length) {
      var empty = el('div', 'empty-state mb-24');
      empty.appendChild(iconEl('calendar'));
      empty.appendChild(el('h3', '', 'No upcoming bookings'));
      empty.appendChild(el('p', '', 'Students book from the clinic booking page once they have posted a thread.'));
      panel.appendChild(empty);
    } else {
      panel.appendChild(bookingTable(upcoming));
    }

    var det = el('details', 'mt-24');
    det.appendChild(el('summary', 'side-title', 'Past bookings (' + past.length + ')'));
    if (past.length) det.appendChild(bookingTable(past));
    else det.appendChild(el('p', 'muted fs-small mt-8', 'Nothing yet.'));
    panel.appendChild(det);
  }

  function bookingTable(rows) {
    var t = tableWrap([
      { label: 'When', cls: 'nowrap' }, 'Student', { label: 'Phone', cls: 'nowrap' }, 'Email',
      'Thread', 'Note', 'Status', 'Attendance', 'Outcome', 'Actions'
    ]);
    rows.forEach(function (b) { t.body.appendChild(bookingRow(b)); });
    return t.wrap;
  }

  function bookingRow(b) {
    var tr = el('tr', String(b.status) === 'confirmed' ? '' : 'is-deleted');
    var slot = state.slotsById[b.slot_id];

    tr.appendChild(el('td', 'nowrap',
      slot ? fmtDateMed(slot.date) + ', ' + slotTimeText(slot) : '(slot ' + b.slot_id + ')'));
    tr.appendChild(el('td', '', b.full_name || userName(b.user_id)));
    tr.appendChild(el('td', 'nowrap', b.phone || ''));
    tr.appendChild(el('td', '', b.email || ''));

    var thTd = el('td');
    if (b.thread_id) {
      var a = el('a', '', threadTitle(b.thread_id) || b.thread_id);
      a.href = 'thread.html?id=' + encodeURIComponent(b.thread_id);
      thTd.appendChild(a);
    } else {
      thTd.appendChild(el('span', 'muted', '—'));
    }
    tr.appendChild(thTd);

    tr.appendChild(el('td', '', b.note || ''));
    tr.appendChild(el('td', '', b.status || ''));
    tr.appendChild(el('td', '', b.attendance === 'no_show' ? 'no-show' : (b.attendance || '—')));
    tr.appendChild(el('td', '', b.resolved_how || '—'));

    var act = el('td', 'row-actions');
    act.appendChild(smallBtn('Attended', function () { updateBooking(b, { attendance: 'attended' }, 'Marked attended.'); }));
    act.appendChild(smallBtn('No-show', function () { updateBooking(b, { attendance: 'no_show' }, 'Marked no-show.'); }));
    act.appendChild(smallBtn('Live', function () { updateBooking(b, { resolved_how: 'live' }, 'Marked resolved live.'); }));
    act.appendChild(smallBtn('Escalated', function () { updateBooking(b, { resolved_how: 'escalated' }, 'Marked escalated.'); }));
    act.appendChild(kebabButton(function () {
      return [
        { label: 'Clear attendance', onClick: function () { updateBooking(b, { attendance: '' }, 'Attendance cleared.'); } },
        { label: 'Clear outcome', onClick: function () { updateBooking(b, { resolved_how: '' }, 'Outcome cleared.'); } },
        { sep: true },
        {
          label: 'Cancel this booking', danger: true, onClick: function () {
            confirmModal('Cancel ' + (b.full_name || 'this student') + '’s booking? '
              + 'Tell them yourself — cancelling here does not send an email.')
              .then(function (yes) { if (yes) updateBooking(b, { status: 'cancelled' }, 'Booking cancelled.'); });
          }
        }
      ];
    }));
    tr.appendChild(act);
    return tr;
  }

  function smallBtn(label, fn) {
    var b = el('button', 'btn btn-sm', label);
    b.type = 'button';
    b.addEventListener('click', fn);
    return b;
  }

  function updateBooking(b, changes, okMsg) {
    var before = { attendance: b.attendance, resolved_how: b.resolved_how, status: b.status };
    var payload = { booking_id: b.booking_id };
    Object.keys(changes).forEach(function (k) { b[k] = changes[k]; payload[k] = changes[k]; });
    renderPanel();
    api.call('admin.booking.update', payload).then(function () {
      toast(okMsg, 'success');
    })['catch'](function (e) {
      b.attendance = before.attendance;
      b.resolved_how = before.resolved_how;
      b.status = before.status;
      renderPanel();
      toast(errMsg(e, 'That update did not save.'), 'error');
    });
  }

  /* --------------------------------------------------------------- slots */

  function renderSlots(panel) {
    var now = Date.now();
    var coming = state.slots.filter(function (s) { return slotEndMs(s) >= now; });
    var bookedBy = {};
    state.bookings.forEach(function (b) {
      if (String(b.status) === 'confirmed') bookedBy[b.slot_id] = b;
    });

    var bar = el('div', 'toolbar');
    bar.appendChild(el('h2', 'side-title grow', 'Coming slots (' + coming.length + ')'));
    var weeksIn = el('input', 'input input-sm');
    weeksIn.type = 'number';
    weeksIn.min = '1';
    weeksIn.max = '12';
    weeksIn.value = '4';
    weeksIn.style.width = '64px';
    weeksIn.setAttribute('aria-label', 'Number of weeks to generate');
    bar.appendChild(weeksIn);
    var genBtn = el('button', 'btn btn-sm', 'Generate next weeks');
    genBtn.type = 'button';
    genBtn.addEventListener('click', function () {
      var n = parseInt(weeksIn.value, 10);
      if (!n || n < 1) { toast('Enter a number of weeks.', 'error'); return; }
      genBtn.disabled = true;
      api.call('admin.slots.generate', { weeks: n }).then(function (res) {
        toast('Created ' + ((res && res.created) || 0) + ' slot' + ((res && res.created) === 1 ? '' : 's') + '.', 'success');
        return reload();
      })['catch'](function (e) {
        genBtn.disabled = false;
        toast(errMsg(e, 'Could not generate slots.'), 'error');
      });
    });
    bar.appendChild(genBtn);
    panel.appendChild(bar);

    var t = tableWrap([
      { label: 'Date', cls: 'nowrap' }, { label: 'Time', cls: 'nowrap' },
      { label: 'Minutes', cls: 'num' }, 'Status', 'Booked by', ''
    ]);
    coming.forEach(function (s) { t.body.appendChild(slotRow(s, bookedBy[s.slot_id])); });
    if (!coming.length) {
      var tr = el('tr');
      var td = el('td', 'muted', 'No upcoming slots — add one below or generate the next few weeks.');
      td.colSpan = 6;
      tr.appendChild(td);
      t.body.appendChild(tr);
    }
    panel.appendChild(t.wrap);

    panel.appendChild(addSlotBox());
    panel.appendChild(settingsBox());
  }

  function slotRow(s, booking) {
    var tr = el('tr', s.status === 'blocked' ? 'is-deleted' : '');
    tr.appendChild(el('td', 'nowrap', fmtDateMed(s.date)));
    tr.appendChild(el('td', 'nowrap', slotTimeText(s)));
    tr.appendChild(el('td', 'num', String(s.duration_min || '')));
    tr.appendChild(el('td', '', s.status || ''));
    tr.appendChild(el('td', '', booking ? (booking.full_name || userName(booking.user_id)) : '—'));

    var act = el('td', 'row-actions');
    act.appendChild(kebabButton(function () {
      var items = [];
      if (s.status === 'blocked') {
        items.push({ label: 'Unblock — offer again', onClick: function () { upsertSlot(s, { status: 'open' }, 'Slot reopened.'); } });
      } else if (s.status === 'booked') {
        items.push({ label: 'Booked — cancel it on the Bookings tab', onClick: function () { state.tab = 'bookings'; renderShell(); } });
      } else {
        items.push({ label: 'Block this slot', onClick: function () { upsertSlot(s, { status: 'blocked' }, 'Slot blocked.'); } });
      }
      items.push({ sep: true });
      items.push({
        label: 'Change start time…',
        onClick: function () {
          var v = window.prompt('Start time in 24-hour SGT, e.g. 13:20', s.start_time || '');
          if (v === null) return;
          var t = normaliseTime(v);
          if (!t) { toast('Use HH:MM, e.g. 13:20.', 'error'); return; }
          upsertSlot(s, { start_time: t }, 'Start time updated.');
        }
      });
      items.push({
        label: 'Change duration…',
        onClick: function () {
          var v = window.prompt('Slot length in minutes', String(s.duration_min || 20));
          if (v === null) return;
          var n = parseInt(v, 10);
          if (!n || n < 5 || n > 240) { toast('Enter 5–240 minutes.', 'error'); return; }
          upsertSlot(s, { duration_min: n }, 'Duration updated.');
        }
      });
      return items;
    }));
    tr.appendChild(act);
    return tr;
  }

  function normaliseTime(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return '';
    var h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return '';
    return pad2(h) + ':' + pad2(mi);
  }

  function upsertSlot(s, changes, okMsg) {
    var payload = {
      slot_id: s.slot_id,
      date: s.date,
      start_time: s.start_time,
      duration_min: Number(s.duration_min) || 20,
      status: s.status
    };
    Object.keys(changes).forEach(function (k) { payload[k] = changes[k]; });
    api.call('admin.slots.upsert', { slots: [payload] }).then(function () {
      toast(okMsg, 'success');
      return reload();
    })['catch'](function (e) { toast(errMsg(e, 'Could not update that slot.'), 'error'); });
  }

  function addSlotBox() {
    var box = el('div', 'box mt-24');
    box.appendChild(el('div', 'box-header', 'Add a slot'));
    var body = el('div', 'box-body');
    var row = el('div', 'row');

    var date = el('input', 'input input-sm');
    date.type = 'date';
    date.setAttribute('aria-label', 'Slot date');
    var time = el('input', 'input input-sm');
    time.type = 'time';
    time.value = normaliseTime(state.config.clinic_start) || '13:00';
    time.setAttribute('aria-label', 'Start time');
    var mins = el('input', 'input input-sm');
    mins.type = 'number';
    mins.min = '5';
    mins.max = '240';
    mins.value = String(state.config.slot_minutes || 20);
    mins.style.width = '80px';
    mins.setAttribute('aria-label', 'Length in minutes');

    var btn = el('button', 'btn btn-primary btn-sm', '+ Add slot');
    btn.type = 'button';
    btn.addEventListener('click', function () {
      if (!date.value) { toast('Pick a date.', 'error'); return; }
      var t = normaliseTime(time.value);
      if (!t) { toast('Pick a start time.', 'error'); return; }
      btn.disabled = true;
      api.call('admin.slots.upsert', {
        slots: [{ date: date.value, start_time: t, duration_min: parseInt(mins.value, 10) || 20, status: 'open' }]
      }).then(function () {
        toast('Slot added.', 'success');
        return reload();
      })['catch'](function (e) {
        btn.disabled = false;
        toast(errMsg(e, 'Could not add that slot.'), 'error');
      });
    });

    row.appendChild(date);
    row.appendChild(time);
    row.appendChild(mins);
    row.appendChild(btn);
    body.appendChild(row);
    body.appendChild(el('p', 'field-hint mt-8', 'Dates and times are SGT.'));
    box.appendChild(body);
    return box;
  }

  function settingsBox() {
    var box = el('div', 'box mt-24');
    box.appendChild(el('div', 'box-header', 'Clinic settings'));
    var body = el('div', 'box-body');
    body.appendChild(el('p', 'muted fs-small mb-16',
      'These write straight to the Config table. Only the fields you change are sent.'));

    var original = {};
    var inputs = {};

    CONFIG_FIELDS.forEach(function (f) {
      var cur = state.config[f.key] === undefined ? '' : String(state.config[f.key]);
      original[f.key] = cur;

      var wrap = el('div', 'field');
      var lab = el('label', 'field-label', f.label);
      lab.htmlFor = 'cfg-' + f.key;
      wrap.appendChild(lab);

      var input;
      if (f.kind === 'textarea') { input = el('textarea', 'textarea'); input.rows = 3; }
      else if (f.kind === 'weekday') {
        input = el('select', 'select');
        WEEKDAYS.forEach(function (d) {
          var o = el('option', '', d);
          o.value = d;
          input.appendChild(o);
        });
        if (cur && WEEKDAYS.indexOf(cur) === -1) {
          var extra = el('option', '', cur);
          extra.value = cur;
          input.appendChild(extra);
        }
      } else {
        input = el('input', 'input');
        if (f.kind === 'time') input.type = 'time';
        if (f.kind === 'number') { input.type = 'number'; input.min = '1'; }
      }
      input.id = 'cfg-' + f.key;
      input.value = cur;
      wrap.appendChild(input);
      if (f.hint) wrap.appendChild(el('div', 'field-hint', f.hint));
      body.appendChild(wrap);
      inputs[f.key] = input;
    });

    /* passcode mode lives in its own danger zone — it weakens sign-in */
    var zone = el('div', 'danger-zone');
    zone.appendChild(el('h3', '', 'Shared class passcode'));
    zone.appendChild(el('p', '',
      'Shared passcodes are weaker — anyone who learns it can read the forum; identities unverified.'));

    var pmRow = el('div', 'checkbox-row');
    var pm = el('input');
    pm.type = 'checkbox';
    pm.id = 'cfg-passcode_mode';
    pm.checked = truthy(state.config.passcode_mode);
    var pmLab = el('label', '', 'Allow sign-in with a shared class passcode instead of an emailed code');
    pmLab.htmlFor = 'cfg-passcode_mode';
    pmRow.appendChild(pm);
    pmRow.appendChild(pmLab);
    zone.appendChild(pmRow);

    var cpWrap = el('div', 'field mt-16');
    var cpLab = el('label', 'field-label', 'Class passcode');
    cpLab.htmlFor = 'cfg-class_passcode';
    cpWrap.appendChild(cpLab);
    var cp = el('input', 'input');
    cp.id = 'cfg-class_passcode';
    cp.value = state.config.class_passcode || '';
    cp.setAttribute('autocomplete', 'off');
    cpWrap.appendChild(cp);
    zone.appendChild(cpWrap);
    body.appendChild(zone);

    var save = el('button', 'btn btn-primary mt-16', 'Save settings');
    save.type = 'button';
    save.addEventListener('click', function () {
      var entries = {};
      CONFIG_FIELDS.forEach(function (f) {
        var v = String(inputs[f.key].value);
        if (v !== original[f.key]) entries[f.key] = v;
      });
      var pmVal = pm.checked ? 'TRUE' : 'FALSE';
      if (pmVal !== (truthy(state.config.passcode_mode) ? 'TRUE' : 'FALSE')) entries.passcode_mode = pmVal;
      if (String(cp.value) !== String(state.config.class_passcode || '')) entries.class_passcode = String(cp.value);

      var keys = Object.keys(entries);
      if (!keys.length) { toast('Nothing changed.', 'success'); return; }
      save.disabled = true;
      save.textContent = 'Saving…';
      api.call('admin.config.set', { entries: entries }).then(function () {
        keys.forEach(function (k) { state.config[k] = entries[k]; });
        toast('Saved ' + keys.length + ' setting' + (keys.length === 1 ? '' : 's') + '.', 'success');
        renderPanel();
      })['catch'](function (e) {
        save.disabled = false;
        save.textContent = 'Save settings';
        toast(errMsg(e, 'Settings did not save.'), 'error');
      });
    });
    body.appendChild(save);

    box.appendChild(body);
    return box;
  }

  /* -------------------------------------------------------------- export */

  function renderExport(panel) {
    panel.appendChild(el('p', 'muted fs-small mb-16',
      'Files are built in your browser from the data already on this page — nothing extra is sent anywhere. '
      + 'They carry the real names behind anonymous posts and full booking contact details, so keep them on '
      + 'NUS storage and delete them at the end of term (see PRIVACY.md).'));

    var box = el('div', 'box');
    box.appendChild(el('div', 'box-header', 'Downloads'));
    var body = el('div', 'box-body');

    [
      ['threads.csv', 'Every thread with author, category, labels, resolution and counts.', csvThreads],
      ['interactions.csv', 'One row per thread and per reply — the promotion-evidence log.', csvInteractions],
      ['bookings.csv', 'Clinic bookings including name, phone and email.', csvBookings],
      ['contributors.csv', 'Replies, accepted answers, upvotes received and score per person.', csvContributors]
    ].forEach(function (spec) {
      var row = el('div', 'row mb-8');
      var b = el('button', 'btn btn-sm', 'Download ' + spec[0]);
      b.type = 'button';
      b.addEventListener('click', function () {
        try { download(spec[0], spec[2](), 'text/csv;charset=utf-8', true); }
        catch (e) { console.error(e); toast('Could not build ' + spec[0] + '.', 'error'); }
      });
      row.appendChild(b);
      row.appendChild(el('span', 'muted fs-small', spec[1]));
      body.appendChild(row);
    });

    var jrow = el('div', 'row');
    var jb = el('button', 'btn btn-sm', 'Download raw JSON');
    jb.type = 'button';
    jb.addEventListener('click', function () {
      download('clinic_export.json', JSON.stringify(state.raw, null, 2), 'application/json;charset=utf-8', false);
    });
    jrow.appendChild(jb);
    jrow.appendChild(el('span', 'muted fs-small', 'Exactly what the API returned — for archiving or tools/analytics.py.'));
    body.appendChild(jrow);

    box.appendChild(body);
    panel.appendChild(box);
  }

  function csvCell(v) {
    var s = (v === null || v === undefined) ? '' : String(v);
    // Student-supplied text starting with = + - @ runs as a formula when the
    // instructor opens the CSV in Excel. Defuse it with a leading apostrophe,
    // but leave plain numbers and "+65 9123 4567" phone numbers alone.
    if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?[\d\s().\-]+$/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function toCsv(rows) {
    return rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n';
  }

  function download(filename, text, mime, bom) {
    // UTF-8 byte-order mark, so Excel opens the file without mangling names.
    var blob = new Blob([(bom ? '\uFEFF' : '') + text], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast(filename + ' downloaded.', 'success');
  }

  function csvThreads() {
    var rows = [['thread_id', 'title', 'category', 'labels', 'author_display', 'author_real', 'is_anonymous',
      'status', 'resolved_via', 'accepted_post_id', 'pinned', 'deleted', 'replies', 'upvotes', 'created_at_sgt']];
    state.threads.forEach(function (t) {
      rows.push([
        t.thread_id, t.title, t.category, listOf(t.labels).join(' '),
        displayAuthor(t), realName(t), truthy(t.is_anonymous) ? 'TRUE' : 'FALSE',
        t.status, t.resolved_via || '', t.accepted_post_id || '',
        truthy(t.pinned) ? 'TRUE' : 'FALSE', truthy(t.deleted) ? 'TRUE' : 'FALSE',
        state.repliesByThread[t.thread_id] || 0, votesFor('thread', t.thread_id), isoSgt(t.created_at)
      ]);
    });
    return toCsv(rows);
  }

  function csvInteractions() {
    var rows = [['type', 'id', 'thread_id', 'title', 'category', 'labels', 'author_display', 'author_real',
      'is_anonymous', 'status', 'resolved_via', 'created_at_sgt', 'upvotes', 'is_accepted']];
    state.threads.forEach(function (t) {
      rows.push(['thread', t.thread_id, t.thread_id, t.title, t.category, listOf(t.labels).join(' '),
        displayAuthor(t), realName(t), truthy(t.is_anonymous) ? 'TRUE' : 'FALSE',
        t.status, t.resolved_via || '', isoSgt(t.created_at), votesFor('thread', t.thread_id),
        t.accepted_post_id ? 'TRUE' : 'FALSE']);
    });
    state.posts.forEach(function (p) {
      var t = state.threadsById[p.thread_id] || {};
      rows.push(['post', p.post_id, p.thread_id, t.title || '', t.category || '', listOf(t.labels).join(' '),
        displayAuthor(p), realName(p), truthy(p.is_anonymous) ? 'TRUE' : 'FALSE',
        t.status || '', t.resolved_via || '', isoSgt(p.created_at), votesFor('post', p.post_id),
        truthy(p.is_accepted) ? 'TRUE' : 'FALSE']);
    });
    return toCsv(rows);
  }

  function csvBookings() {
    var rows = [['booking_id', 'slot_date', 'slot_start_sgt', 'duration_min', 'full_name', 'phone', 'email',
      'user_id', 'user_display_name', 'thread_id', 'thread_title', 'note', 'status', 'attendance',
      'resolved_how', 'created_at_sgt']];
    state.bookings.forEach(function (b) {
      var s = state.slotsById[b.slot_id] || {};
      rows.push([b.booking_id, s.date || '', s.start_time || '', s.duration_min || '',
        b.full_name, b.phone, b.email, b.user_id, userName(b.user_id),
        b.thread_id || '', threadTitle(b.thread_id), b.note || '', b.status, b.attendance || '',
        b.resolved_how || '', isoSgt(b.created_at)]);
    });
    return toCsv(rows);
  }

  function csvContributors() {
    /* SPEC §8 scoring: reply +2, accepted answer +5 bonus, upvote received +1. */
    var stats = {};
    function bucket(id) {
      if (!stats[id]) stats[id] = { replies: 0, accepted: 0, upvotes: 0 };
      return stats[id];
    }
    state.posts.forEach(function (p) {
      if (truthy(p.deleted) || !p.author_id) return;
      var s = bucket(p.author_id);
      s.replies += 1;
      if (truthy(p.is_accepted)) s.accepted += 1;
    });
    var ownerOf = {};
    state.threads.forEach(function (t) { if (t.author_id) ownerOf['thread:' + t.thread_id] = t.author_id; });
    state.posts.forEach(function (p) { if (p.author_id) ownerOf['post:' + p.post_id] = p.author_id; });
    state.votes.forEach(function (v) {
      var owner = ownerOf[v.target_type + ':' + v.target_id];
      if (!owner || owner === v.user_id) return;
      bucket(owner).upvotes += 1;
    });

    var rows = [['user_id', 'display_name', 'email', 'role', 'replies', 'accepted', 'upvotes_received', 'score']];
    Object.keys(stats).map(function (id) {
      var u = state.usersById[id] || {};
      var s = stats[id];
      var score = s.replies * 2 + s.accepted * 5 + s.upvotes;
      return {
        score: score,
        row: [id, u.display_name || '', u.email || '', u.role || '', s.replies, s.accepted, s.upvotes, score]
      };
    }).sort(function (a, b) { return b.score - a.score; })
      .forEach(function (r) { rows.push(r.row); });
    return toCsv(rows);
  }

  /* ------------------------------------------------------------ lifecycle */

  function loadData() {
    return api.call('admin.export', {}).then(function (data) { ingest(data); });
  }

  function reload() {
    return loadData().then(renderShell)['catch'](function (e) {
      toast(errMsg(e, 'Could not reload the dashboard.'), 'error');
    });
  }

  function denied() {
    clear(document.body);
    var wrap = el('div', 'container mt-24');
    var box = el('div', 'empty-state');
    box.appendChild(iconEl('person'));
    box.appendChild(el('h3', '', 'Instructor access only'));
    box.appendChild(el('p', '',
      'This dashboard is limited to the instructor account, and the server enforces the same rule.'));
    var a = el('a', 'btn btn-primary mt-8', 'Back to discussions');
    a.href = 'index.html';
    box.appendChild(a);
    wrap.appendChild(box);
    document.body.appendChild(wrap);
  }

  function boot() {
    // requireLogin() redirects when signed out; only an explicit false stops us.
    if (typeof api.requireLogin === 'function' && api.requireLogin() === false) return;

    var me = currentUser();
    if (!me || me.role !== 'instructor') { denied(); return; }

    if (typeof ui.renderHeader === 'function') {
      try { ui.renderHeader('admin'); } catch (e) { console.error('[admin] renderHeader', e); }
    }

    var hash = (window.location.hash || '').replace('#', '');
    for (var i = 0; i < TABS.length; i++) if (TABS[i].key === hash) state.tab = hash;

    loadData().then(renderShell)['catch'](function (e) {
      if (e && (e.code === 'forbidden' || e.code === 'unauthorized')) { denied(); return; }
      var main = document.getElementById('admin-main');
      if (!main) return;
      clear(main);
      var box = el('div', 'empty-state');
      box.appendChild(iconEl('gear'));
      box.appendChild(el('h3', '', 'Could not load the dashboard'));
      box.appendChild(el('p', '', errMsg(e, 'The admin export did not come back.')));
      var btn = el('button', 'btn btn-sm mt-8', 'Try again');
      btn.type = 'button';
      btn.addEventListener('click', boot);
      box.appendChild(btn);
      main.appendChild(box);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
