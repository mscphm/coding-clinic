/* ============================================================================
 * index.js — Discussions home (agent A2)
 *
 * Sidebar : categories with live counts, label cloud, clinic notice,
 *           top-5 leaderboard with All-time / This month tabs.
 * Main    : search + quick filters + sort + thread rows + empty states.
 *
 * Data    : Clinic.api only (no fetch here). Markup follows the class
 *           inventory in assets/css/main.css.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---------------------------------------------------------------- shims */
  function UI() { return (window.Clinic && window.Clinic.ui) || {}; }
  function API() { return (window.Clinic && window.Clinic.api) || {}; }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  function show(n, on) { if (n) n.style.display = on ? '' : 'none'; }
  /* ui.icon()/ui.pill() may return an element or a static SVG string — both
     are author-controlled chrome, never user content. */
  function toNode(x) {
    if (x && x.nodeType) return x;
    var s = document.createElement('span');
    if (typeof x === 'string') s.innerHTML = x;
    return s;
  }
  function icon(name) { try { return toNode(UI().icon(name)); } catch (e) { return el('span'); } }
  function pill(text) { try { return toNode(UI().pill(text)); } catch (e) { return el('span', 'pill', text); } }
  function avatar(a) {
    try { return toNode(UI().avatar(a)); }
    catch (e) { return el('span', 'avatar', ((a && a.display_name) || '?').charAt(0)); }
  }
  function relTime(iso) { try { return UI().relTime(iso) || ''; } catch (e) { return ''; } }
  function toast(msg, type) { try { UI().toast(msg, type); } catch (e) {} }
  function errText(e) {
    return (e && (e.message || e.error)) || 'Something went wrong. Please try again.';
  }

  /* ------------------------------------------------------------ page state */
  var data = { threads: [], users: [], contrib: [], contribMonth: null };
  var cfg = { categories: [], labels: [], notice_text: '' };
  var topContrib = {};                /* user_id -> true, all-time top 3      */
  var loaded = false;

  var state = {
    q: '',
    category: '',                     /* '' = all                             */
    label: '',
    answered: 'all',                  /* all | answered | unanswered          */
    sort: 'latest',                   /* latest | top | unanswered            */
    lbTab: 'all'                      /* all | month                          */
  };

  /* -------------------------------------------------------------- helpers */
  function isAnswered(t) { return t.status === 'answered' || t.accepted === true; }
  function nameOf(author) { return (author && author.display_name) || 'Unknown'; }
  function labelsOf(t) {
    return Array.isArray(t.labels) ? t.labels : (t.labels ? String(t.labels).split(',') : []);
  }
  function scoreOf(c) {
    return (Number(c.replies) || 0) * 2 +
           (Number(c.accepted) || 0) * 5 +
           (Number(c.upvotes_received) || 0) * 1;
  }
  function filtering() {
    return !!(state.q || state.category || state.label || state.answered !== 'all');
  }

  /* Filters live in the URL so a filtered view can be shared or bookmarked. */
  function readUrl() {
    var p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.category = p.get('category') || '';
    state.label = p.get('label') || '';
    var a = p.get('answered');
    if (a === 'answered' || a === 'unanswered') state.answered = a;
    var s = p.get('sort');
    if (s === 'top' || s === 'unanswered' || s === 'latest') state.sort = s;
  }
  function writeUrl() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category) p.set('category', state.category);
    if (state.label) p.set('label', state.label);
    if (state.answered !== 'all') p.set('answered', state.answered);
    if (state.sort !== 'latest') p.set('sort', state.sort);
    var qs = p.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); }
    catch (e) { /* file:// — harmless */ }
  }

  function clearFilters() {
    state.q = ''; state.category = ''; state.label = ''; state.answered = 'all';
    writeUrl();
    renderToolbar(); renderCategories(); renderLabels(); renderList();
  }

  /* ============================================================= SIDEBAR === */

  function renderCategories() {
    var list = $('cat-list');
    if (!list) return;
    clear(list);

    var counts = {};
    data.threads.forEach(function (t) {
      var c = t.category || 'General';
      counts[c] = (counts[c] || 0) + 1;
    });

    var rows = [{ key: '', name: 'All discussions', n: data.threads.length }];
    var seen = {};
    (cfg.categories || []).forEach(function (c) {
      seen[c] = true;
      rows.push({ key: c, name: c, n: counts[c] || 0 });
    });
    /* categories present on threads but no longer in config */
    Object.keys(counts).forEach(function (c) {
      if (!seen[c]) rows.push({ key: c, name: c, n: counts[c] });
    });

    rows.forEach(function (r) {
      var li = el('li');
      var b = el('button', 'cat-item' + (state.category === r.key ? ' active' : ''));
      b.type = 'button';
      if (state.category === r.key) b.setAttribute('aria-current', 'true');
      b.appendChild(el('span', 'cat-name', r.name));
      b.appendChild(el('span', 'counter', String(r.n)));
      b.addEventListener('click', function () {
        state.category = (state.category === r.key) ? '' : r.key;
        writeUrl(); renderCategories(); renderList();
      });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function renderLabels() {
    var cloud = $('label-cloud');
    if (!cloud) return;
    clear(cloud);

    var seen = {}, all = [];
    (cfg.labels || []).forEach(function (l) { if (l && !seen[l]) { seen[l] = 1; all.push(l); } });
    data.threads.forEach(function (t) {
      labelsOf(t).forEach(function (l) {
        l = String(l).trim();
        if (l && !seen[l]) { seen[l] = 1; all.push(l); }
      });
    });

    if (!all.length) {
      cloud.appendChild(el('span', 'field-hint mt-0', 'No labels yet.'));
      return;
    }

    all.forEach(function (l) {
      var p = pill(l);
      var on = state.label === l;
      if (on) p.classList.add('is-active');
      p.setAttribute('role', 'button');
      p.setAttribute('tabindex', '0');
      p.setAttribute('aria-pressed', on ? 'true' : 'false');
      p.title = on ? 'Remove this label filter' : 'Show discussions labelled ' + l;
      p.style.cursor = 'pointer';
      function toggle() {
        state.label = on ? '' : l;
        writeUrl(); renderLabels(); renderList();
      }
      p.addEventListener('click', toggle);
      p.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
      });
      cloud.appendChild(p);
    });
  }

  function renderNotice() {
    var box = $('notice-box');
    if (!box) return;
    clear(box);
    box.appendChild(el('p', 'mb-0', cfg.notice_text ||
      'Ask freely — questions are answered within 1 working day.'));
  }

  /* ------------------------------------------------------------ leaderboard */
  /* threads.list returns aggregate, all-time `contrib` only. If the backend
     ever adds month-scoped figures (a contrib_month[] array, or *_month fields
     on each contrib row) they are used automatically; until then the
     "This month" tab shows the all-time table and says so. */
  function monthRows() {
    if (Array.isArray(data.contribMonth) && data.contribMonth.length) {
      return { rows: data.contribMonth, exact: true };
    }
    var hasMonthFields = (data.contrib || []).some(function (c) {
      return typeof c.replies_month === 'number' ||
             typeof c.upvotes_received_month === 'number' ||
             typeof c.accepted_month === 'number';
    });
    if (hasMonthFields) {
      return {
        rows: data.contrib.map(function (c) {
          return {
            user_id: c.user_id,
            display_name: c.display_name,
            replies: c.replies_month || 0,
            accepted: c.accepted_month || 0,
            upvotes_received: c.upvotes_received_month || 0
          };
        }),
        exact: true
      };
    }
    return { rows: data.contrib || [], exact: false };
  }

  function ranked(rows) {
    var names = {};
    (data.users || []).forEach(function (u) { names[u.user_id] = u.display_name; });
    return (rows || []).map(function (c) {
      return {
        user_id: c.user_id,
        display_name: c.display_name || names[c.user_id] || 'Unknown',
        score: scoreOf(c),
        replies: Number(c.replies) || 0,
        accepted: Number(c.accepted) || 0,
        upvotes: Number(c.upvotes_received) || 0
      };
    }).filter(function (c) {
      return c.score > 0 && c.user_id && c.user_id !== 'anon';
    }).sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.display_name).localeCompare(String(b.display_name));
    });
  }

  function renderLeaderboardTabs() {
    var bar = $('lb-tabs');
    if (!bar) return;
    clear(bar);
    [{ k: 'all', t: 'All-time' }, { k: 'month', t: 'This month' }].forEach(function (o) {
      var b = el('button', 'tab' + (state.lbTab === o.k ? ' active' : ''), o.t);
      b.type = 'button';
      b.setAttribute('aria-selected', state.lbTab === o.k ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.lbTab = o.k;
        renderLeaderboardTabs();
        renderLeaderboard();
      });
      bar.appendChild(b);
    });
  }

  function renderLeaderboard() {
    var box = $('leaderboard'), note = $('lb-note');
    if (!box) return;
    clear(box);
    if (note) { note.textContent = ''; show(note, false); }

    var src = state.lbTab === 'month' ? monthRows() : { rows: data.contrib || [], exact: true };
    var rows = ranked(src.rows);

    if (state.lbTab === 'month' && !src.exact && note) {
      note.textContent = 'Showing all-time: threads.list returns aggregate contributions ' +
                         'only, with no per-month breakdown.';
      show(note, true);
    }

    if (!rows.length) {
      box.appendChild(el('div', 'field-hint mt-0',
        'No contributions yet — answer a question to get on the board.'));
      return;
    }

    rows.slice(0, 5).forEach(function (c, i) {
      var row = el('div', 'lb-row');
      row.appendChild(el('span', 'lb-rank', String(i + 1)));
      if (i < 3) {
        var medal = el('span', 'lb-medal rank-' + (i + 1));
        medal.title = ['Gold', 'Silver', 'Bronze'][i];
        medal.appendChild(icon('trophy'));
        row.appendChild(medal);
      }
      row.appendChild(avatar({ user_id: c.user_id, display_name: c.display_name }));
      row.appendChild(el('span', 'lb-name', c.display_name));
      var sc = el('span', 'lb-score', String(c.score));
      sc.title = c.replies + ' replies (x2) · ' + c.accepted + ' accepted (x5) · ' +
                 c.upvotes + ' upvotes received (x1)';
      row.appendChild(sc);
      box.appendChild(row);
    });
  }

  /* ============================================================= TOOLBAR === */

  function renderToolbar() {
    var bar = $('toolbar');
    if (!bar) return;
    clear(bar);

    /* search */
    var search = el('input', 'input grow');
    search.type = 'search';
    search.placeholder = 'Search discussions';
    search.setAttribute('aria-label', 'Search discussions by title, label or category');
    search.autocomplete = 'off';
    search.value = state.q;
    var timer = null;
    search.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.q = search.value;
        writeUrl();
        renderList();
      }, 120);
    });
    bar.appendChild(search);

    /* All / Answered / Unanswered */
    var group = el('div', 'btn-group');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Filter by answer status');
    [['all', 'All'], ['answered', 'Answered'], ['unanswered', 'Unanswered']].forEach(function (o) {
      var on = state.answered === o[0];
      var b = el('button', 'btn btn-sm' + (on ? ' selected' : ''), o[1]);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () {
        state.answered = o[0];
        writeUrl(); renderToolbar(); renderList();
      });
      group.appendChild(b);
    });
    bar.appendChild(group);

    /* sort */
    var sort = el('select', 'select');
    sort.setAttribute('aria-label', 'Sort discussions');
    sort.style.width = 'auto';
    [['latest', 'Latest'], ['top', 'Top'], ['unanswered', 'Unanswered first']].forEach(function (o) {
      var op = el('option', null, o[1]);
      op.value = o[0];
      if (state.sort === o[0]) op.selected = true;
      sort.appendChild(op);
    });
    sort.addEventListener('change', function () {
      state.sort = sort.value;
      writeUrl(); renderList();
    });
    bar.appendChild(sort);
  }

  /* ========================================================= THREAD LIST === */

  function matches(t) {
    if (state.category && (t.category || '') !== state.category) return false;
    if (state.label && labelsOf(t).indexOf(state.label) === -1) return false;
    if (state.answered === 'answered' && !isAnswered(t)) return false;
    if (state.answered === 'unanswered' && isAnswered(t)) return false;
    if (state.q) {
      /* `excerpt` is an optional plain-text body summary (mock-data.js provides
         it); when present it lets the search cover bodies as well, per SPEC §8. */
      var hay = [t.title || '', t.category || '', labelsOf(t).join(' '),
                 nameOf(t.author), t.excerpt || ''].join(' ').toLowerCase();
      var terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
      for (var i = 0; i < terms.length; i++) {
        if (hay.indexOf(terms[i]) === -1) return false;
      }
    }
    return true;
  }

  function sortRows(rows) {
    var by = state.sort;
    return rows.slice().sort(function (a, b) {
      var pa = a.pinned ? 1 : 0, pb = b.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;                       /* pinned first */
      if (by === 'top') {
        var ua = Number(a.upvotes) || 0, ub = Number(b.upvotes) || 0;
        if (ua !== ub) return ub - ua;
      } else if (by === 'unanswered') {
        var oa = isAnswered(a) ? 1 : 0, ob = isAnswered(b) ? 1 : 0;
        if (oa !== ob) return oa - ob;
      }
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });
  }

  function statChip(iconName, n, label) {
    var s = el('span', 'stat-chip');
    s.title = n + ' ' + label;
    s.appendChild(icon(iconName));
    s.appendChild(el('span', null, String(n)));
    return s;
  }

  function threadRow(t) {
    var answered = isAnswered(t);
    var row = el('div', 'thread-row' + (t.pinned ? ' is-pinned' : ''));

    var ico = el('span', 'thread-row-icon' + (answered ? ' answered' : ''));
    ico.title = answered ? 'Answered' : 'Open discussion';
    ico.appendChild(icon(answered ? 'check-circle' : 'comment-discussion'));
    row.appendChild(ico);

    var main = el('div', 'thread-row-main');

    var title = el('a', 'thread-row-title', t.title || '(untitled)');
    title.href = 'thread.html?id=' + encodeURIComponent(t.thread_id);
    main.appendChild(title);

    var badges = el('span', 'thread-row-badges');
    if (t.pinned) badges.appendChild(el('span', 'badge-pinned', 'Pinned'));
    if (answered) badges.appendChild(el('span', 'badge-answered', 'Answered'));
    if (badges.firstChild) main.appendChild(badges);

    var meta = el('div', 'thread-row-meta');
    if (t.category) {
      var cp = el('button', 'pill pill-category', t.category);
      cp.type = 'button';
      cp.title = 'Show only ' + t.category;
      cp.addEventListener('click', function () {
        state.category = t.category;
        writeUrl(); renderCategories(); renderList();
        window.scrollTo(0, 0);
      });
      meta.appendChild(cp);
    }
    labelsOf(t).forEach(function (raw) {
      var l = String(raw).trim();
      if (!l) return;
      var p = pill(l);
      p.setAttribute('role', 'button');
      p.setAttribute('tabindex', '0');
      p.title = 'Show only discussions labelled ' + l;
      p.style.cursor = 'pointer';
      function go() {
        state.label = l;
        writeUrl(); renderLabels(); renderList();
        window.scrollTo(0, 0);
      }
      p.addEventListener('click', go);
      p.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
      });
      meta.appendChild(p);
    });

    var by = el('span');
    by.appendChild(document.createTextNode(
      'opened ' + relTime(t.created_at) + ' by ' + nameOf(t.author)));
    meta.appendChild(by);
    if (t.author && topContrib[t.author.user_id]) {
      var badge = el('span', 'badge-top-contrib');
      badge.title = 'Top 3 all-time contributor';
      badge.appendChild(icon('trophy'));
      badge.appendChild(el('span', null, 'Top contributor'));
      meta.appendChild(badge);
    }
    main.appendChild(meta);
    row.appendChild(main);

    var stats = el('div', 'thread-row-stats');
    stats.appendChild(statChip('arrow-up', Number(t.upvotes) || 0, 'upvotes'));
    stats.appendChild(statChip('comment-discussion', Number(t.reply_count) || 0, 'replies'));
    row.appendChild(stats);

    return row;
  }

  function emptyState(title, msg, actionText, onAction) {
    var box = el('div', 'empty-state');
    box.appendChild(icon('comment-discussion'));
    box.appendChild(el('h3', null, title));
    box.appendChild(el('p', null, msg));
    if (actionText) {
      var b = el('button', 'btn btn-primary', actionText);
      b.type = 'button';
      b.addEventListener('click', onAction);
      box.appendChild(b);
    }
    return box;
  }

  function renderList() {
    var list = $('thread-list');
    if (!list) return;
    clear(list);

    if (!loaded) {
      var wait = el('div', 'empty-state');
      wait.appendChild(el('span', 'spinner'));
      list.appendChild(wait);
      return;
    }

    if (!data.threads.length) {
      list.appendChild(emptyState(
        'No discussions yet',
        'Be the first to ask. Say what you tried, paste the exact error, and keep the code minimal.',
        'Start the first discussion',
        function () { location.href = 'new.html'; }
      ));
      return;
    }

    var rows = sortRows(data.threads.filter(matches));

    /* header strip: count + clear-filters */
    var head = el('div', 'thread-list-header');
    head.appendChild(el('span', null,
      rows.length + (rows.length === 1 ? ' discussion' : ' discussions') +
      (filtering() ? ' of ' + data.threads.length : '')));
    if (filtering()) {
      var spacer = el('span', 'grow');
      head.appendChild(spacer);
      var cl = el('button', 'btn btn-sm btn-invisible', 'Clear filters');
      cl.type = 'button';
      cl.addEventListener('click', clearFilters);
      head.appendChild(cl);
    }
    list.appendChild(head);

    if (!rows.length) {
      list.appendChild(emptyState(
        'No matching discussions',
        'Nothing matches the current search and filters.',
        'Clear filters',
        clearFilters
      ));
      return;
    }

    rows.forEach(function (t) { list.appendChild(threadRow(t)); });
  }

  /* ================================================================ BOOT === */

  function applyBootstrap(b) {
    if (!b || !b.config) return;
    cfg = b.config;
    renderCategories();
    renderLabels();
    renderNotice();
  }

  function renderAll() {
    renderCategories();
    renderLabels();
    renderNotice();
    renderLeaderboardTabs();
    renderLeaderboard();
    renderToolbar();
    renderList();
  }

  function boot() {
    var api = API();
    if (!api || typeof api.call !== 'function') return;
    try {
      if (api.requireLogin && api.requireLogin() === false) return;
    } catch (e) { return; }

    try { if (UI().renderHeader) UI().renderHeader('discussions'); } catch (e) {}

    readUrl();
    renderToolbar();

    /* api.bootstrap() answers instantly from the localStorage cache and
       refreshes in the background; the event fires when newer config lands. */
    window.addEventListener('clinic:bootstrap', function (ev) {
      if (loaded && ev && ev.detail) applyBootstrap(ev.detail);
    });

    var bootP = (typeof api.bootstrap === 'function')
      ? api.bootstrap()
      : api.call('meta.bootstrap', {});

    Promise.all([bootP, api.call('threads.list', {})]).then(function (res) {
      var b = res[0] || {};
      var list = res[1] || {};

      cfg = b.config || cfg;
      data.threads = (list.threads || []).filter(function (t) { return t && !t.deleted; });
      data.users = list.users || [];
      data.contrib = list.contrib || [];
      data.contribMonth = list.contrib_month || null;

      topContrib = {};
      ranked(data.contrib).slice(0, 3).forEach(function (c) { topContrib[c.user_id] = true; });

      loaded = true;
      renderAll();
    }).catch(function (e) {
      loaded = true;
      if (e && e.code === 'unauthorized') return;   /* api.js already bounced */
      var list = $('thread-list');
      if (list) {
        clear(list);
        list.appendChild(emptyState(
          'Could not load discussions',
          errText(e),
          'Try again',
          function () { location.reload(); }
        ));
      }
      toast(errText(e), 'error');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
