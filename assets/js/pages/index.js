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
  /* §9 gives .badge-locked/.badge-duplicate/.badge-instructor-replied their own
     12px svg rule; the generic .badge has none, so the one badge that has to
     borrow it (Endorsed — see the note in threadRow) shrinks its icon here
     rather than in a page-local <style> block. */
  function icon12(name) {
    var n = icon(name);
    var svg = (n && n.tagName && String(n.tagName).toLowerCase() === 'svg')
      ? n : (n && n.querySelector ? n.querySelector('svg') : null);
    if (svg) { svg.setAttribute('width', '12'); svg.setAttribute('height', '12'); }
    return n;
  }
  function pill(text) { try { return toNode(UI().pill(text)); } catch (e) { return el('span', 'pill', text); } }
  function avatar(a) {
    try { return toNode(UI().avatar(a)); }
    catch (e) { return el('span', 'avatar', ((a && a.display_name) || '?').charAt(0)); }
  }
  function relTime(iso) { try { return UI().relTime(iso) || ''; } catch (e) { return ''; } }
  function toast(msg, type) { try { UI().toast(msg, type); } catch (e) {} }
  function spinner() {
    try { return UI().spinner(); } catch (e) { return el('span', 'spinner'); }
  }
  /* Grey rows shaped like the cards that are coming. Falls back to the plain
     spinner against a ui.js that predates ui.skeleton(). */
  function skeleton(kind, n) {
    try {
      if (typeof UI().skeleton === 'function') return UI().skeleton(kind, n);
    } catch (e) { /* fall through */ }
    var box = el('div', 'empty-state');
    box.appendChild(spinner());
    return box;
  }
  function errText(e) {
    return (e && (e.message || e.error)) || 'Something went wrong. Please try again.';
  }

  /* ------------------------------------------------------------ page state */
  var data = { threads: [], users: [], contrib: [], contribMonth: null };
  var cfg = { categories: [], labels: [], languages: [], notice_text: '' };
  var topContrib = {};                /* user_id -> true, all-time top 3      */
  var loaded = false;

  var state = {
    q: '',
    category: '',                     /* '' = all                             */
    label: '',
    answered: 'all',                  /* all | answered | unanswered          */
    sort: 'latest',                   /* latest | top | unanswered            */
    lbTab: 'all',                     /* all | month                          */
    language: ''                      /* '' = All boards; else one of cfg.languages */
  };

  /* Language board choice (SPEC §4 v2 "language boards") is a primary nav
     dimension, not a filter: it is remembered client-side and always echoed
     into the URL so a board is linkable, independent of q/category/label/
     answered/sort which only ever come from the URL itself. */
  var LANG_KEY = 'clinic_language';
  function saveLangPref(v) {
    try { window.localStorage.setItem(LANG_KEY, v || ''); } catch (e) { /* ignore */ }
  }
  /* Has this browser ever picked a board? Set by readUrl(); see the note there
     for why an absent key and an empty string mean different things. */
  var boardChosen = false;

  /* -------------------------------------------------------------- helpers */
  function isAnswered(t) { return t.status === 'answered' || t.accepted === true; }

  /* --- v3 (contract §5.2). All four new ThreadCard keys may be ABSENT: the
     app flow has to be re-imported before any of them arrives, and the site
     ships before that happens (wave 0). Every read below therefore goes
     through ui.truthy(), which answers false for undefined — so a card on an
     un-migrated backend renders exactly as it did in v2, with no gap and
     nothing in the console. --- */
  function truthy(v) {
    try { return !!UI().truthy(v); }
    catch (e) {
      /* ui.js missing entirely (it never is) — same five accepted spellings. */
      if (v === true || v === 1) return true;
      var s = String(v == null ? '' : v).trim().toLowerCase();
      return s === 'true' || s === '1';
    }
  }

  /* §5.2, binding: a thread leaves the unanswered count and the Unanswered
     filter IFF duplicate_of is non-empty — NEVER by inspecting status. The
     duplicate ops deliberately do not rewrite status (§4.4), so a thread
     marked duplicate can still be `open`, and E3/E4 make this exact test
     flow-side. Inspecting status here would silently disagree with the
     escalation emails. */
  function duplicateOf(t) {
    return String((t && t.duplicate_of) || '').trim();
  }
  function isDuplicate(t) { return duplicateOf(t) !== ''; }

  /* D14. Absent -> false -> no banner, writes behave exactly as before. */
  function archived() { return truthy(cfg && cfg.archive_mode); }

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

    /* An explicit ?lang= (even empty, i.e. "all boards") always wins over the
       stored preference; otherwise fall back to localStorage. Either way the
       resolved value is written straight back to storage so "return to your
       board" always means the board you are looking at right now, however you
       got here.

       THE TEST IS `stored !== null`, NOT `stored || ''`, and that distinction is
       the whole of the first-visit chooser. Picking "All" stores the empty
       string, so truthiness cannot tell "I chose to see everything" apart from
       "I have never been asked" — and the old code then wrote '' back on the
       very first paint, which marked every new student as having already
       chosen. Absent key means never asked; empty string means asked and
       answered All. */
    if (p.has('lang')) {
      state.language = p.get('lang') || '';
      boardChosen = true;
    } else {
      var stored = null;
      try { stored = window.localStorage.getItem(LANG_KEY); } catch (e) { stored = null; }
      boardChosen = (stored !== null);
      state.language = stored || '';
    }
    if (boardChosen) saveLangPref(state.language);
  }
  function writeUrl() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category) p.set('category', state.category);
    if (state.label) p.set('label', state.label);
    if (state.answered !== 'all') p.set('answered', state.answered);
    if (state.sort !== 'latest') p.set('sort', state.sort);
    if (state.language) p.set('lang', state.language);
    var qs = p.toString();
    try { history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '')); }
    catch (e) { /* file:// — harmless */ }
  }

  function clearFilters() {
    state.q = ''; state.category = ''; state.label = ''; state.answered = 'all';
    writeUrl();
    renderToolbar(); renderCategories(); renderLabels(); renderLanguageSwitcher(); renderList();
  }

  /* ============================================================= SIDEBAR === */

  function renderCategories() {
    var list = $('cat-list');
    if (!list) return;
    clear(list);

    /* Category filtering works *within* the chosen language board (SPEC §4),
       so counts here are scoped to the current board — a student on the R
       board should never see a category count that includes Python threads. */
    var scoped = data.threads.filter(function (t) { return matchesLanguage(t, state.language); });

    var counts = {};
    scoped.forEach(function (t) {
      var c = t.category || 'General';
      counts[c] = (counts[c] || 0) + 1;
    });

    var rows = [{ key: '', name: 'All discussions', n: scoped.length }];
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
        writeUrl(); renderCategories(); renderLanguageSwitcher(); renderList();
      });
      li.appendChild(b);
      list.appendChild(li);
    });
  }

  function renderLabels() {
    var cloud = $('label-cloud');
    if (!cloud) return;
    clear(cloud);

    /* Same board-scoping as renderCategories() — see comment there. */
    var scoped = data.threads.filter(function (t) { return matchesLanguage(t, state.language); });

    var seen = {}, all = [];
    (cfg.labels || []).forEach(function (l) { if (l && !seen[l]) { seen[l] = 1; all.push(l); } });
    scoped.forEach(function (t) {
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
        writeUrl(); renderLabels(); renderLanguageSwitcher(); renderList();
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
  /* The backend returns aggregate, all-time `contrib` (from threads.list today,
     from meta.leaderboard once the flow split lands — see ensureLeaderboard).
     If it ever adds month-scoped figures (a contrib_month[] array, or *_month
     fields on each contrib row) they are used automatically; until then the
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
      note.textContent = 'Showing all-time: the backend returns aggregate contributions ' +
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

  /* ===================================================== LANGUAGE BOARDS === */
  /* SPEC §4 v2 "language boards": a primary navigation dimension (All / R /
     Python / Bash/Linux, driven entirely by config.languages — never
     hardcoded) rendered as its own row above the toolbar, reusing the exact
     chip-group look of the Answered/Unanswered row below. Filtering is
     client-side only; threads.list already returns everything. */

  function matchesLanguage(t, lang) {
    if (!lang) return true;                            /* All boards */
    /* Threads created before the `language` column existed carry '' and show
       under All only — never guessed into a specific board. */
    return (t.language || '') === lang;
  }

  /* Every filter except language — used both for the visible list (scoped to
     the current board first) and to count each switcher option "as if" that
     option were chosen, so the numbers on the switcher can never disagree
     with what clicking them would show. */
  function matchesSecondary(t) {
    if (state.category && (t.category || '') !== state.category) return false;
    if (state.label && labelsOf(t).indexOf(state.label) === -1) return false;
    if (state.answered === 'answered' && !isAnswered(t)) return false;
    /* A duplicate is still listed and still searchable — it just stops being
       counted as an open question, because someone has already decided the
       answer lives on another thread. See the §5.2 note on duplicateOf(). */
    if (state.answered === 'unanswered' && (isAnswered(t) || isDuplicate(t))) return false;
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

  function countForOption(key) {
    return data.threads.filter(function (t) {
      return matchesLanguage(t, key) && matchesSecondary(t);
    }).length;
  }

  /* The switcher lives in its own row, created once and inserted just above
     #toolbar — index.html (owned by A1) has no markup for it, so it is built
     entirely here, the same way every other region on this page is. */
  function ensureLangBar() {
    var bar = $('lang-switcher');
    if (bar) return bar;
    var toolbar = $('toolbar');
    if (!toolbar || !toolbar.parentNode) return null;
    bar = el('div', 'toolbar');
    bar.id = 'lang-switcher';
    toolbar.parentNode.insertBefore(bar, toolbar);
    return bar;
  }

  /* New-discussion button always carries the active board along, so composing
     from inside e.g. the R board pre-selects R without an extra click. */
  function updateNewDiscussionLink() {
    var a = document.querySelector('.page-head a.btn-primary');
    if (!a) return;
    a.href = state.language ? ('new.html?lang=' + encodeURIComponent(state.language)) : 'new.html';
  }

  function selectLanguage(key) {
    if (state.language === key) return;
    state.language = key;
    saveLangPref(key);
    writeUrl();
    renderLanguageSwitcher();
    renderCategories();
    renderLabels();
    renderList();
    window.scrollTo(0, 0);
  }

  /* The first-visit chooser's click handler, and NOT selectLanguage(): that one
     starts `if (state.language === key) return;`, so picking "All" — which
     resolves to the '' this page already holds — would early-return and leave
     the chooser on screen forever. Recording the CHOICE is the point here; the
     board may legitimately be unchanged. */
  function chooseBoard(key) {
    boardChosen = true;
    saveLangPref(key);
    if (state.language !== key) {
      state.language = key;
      writeUrl();
      renderLanguageSwitcher();
      renderCategories();
      renderLabels();
    } else {
      writeUrl();
      renderLanguageSwitcher();
    }
    renderList();
    window.scrollTo(0, 0);
  }

  /* Ask once, and only when there is something to ask: no stored answer, no
     explicit ?lang= in the address, and a languages list to offer. cfg.languages
     arrives with meta.bootstrap, so on a genuinely first visit this becomes true
     when bootstrap lands rather than at first paint — applyBootstrap() re-renders
     the list, which is what puts the question on screen.

     Deliberately NOT a modal and NOT a route: it renders in place of the thread
     rows, so it reads as "choose a board" without ever becoming a wall. "All
     boards" is always one of the answers, because threads written before the
     `language` column existed carry '' and appear under All ONLY (see
     matchesLanguage) — an R/Python/Bash-only gate would make every one of them
     unreachable from this page. */
  function needsBoardChoice() {
    return !boardChosen && !state.language &&
      !!(cfg.languages && cfg.languages.length);
  }

  function renderBoardChooser(host) {
    var box = el('div', 'empty-state');
    box.appendChild(icon('comment-discussion'));
    box.appendChild(el('h3', null, 'Which board do you want?'));
    box.appendChild(el('p', null,
      'Pick the language you are working in. Everything stays one clinic — you ' +
      'can switch board at any time from the row above, and asking in one board ' +
      'does not stop you asking in another.'));

    var group = el('div', 'btn-group');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Choose a language board');
    (cfg.languages || []).forEach(function (l) {
      if (!l) return;
      var b = el('button', 'btn btn-primary');
      b.type = 'button';
      b.appendChild(el('span', null, l));
      b.appendChild(el('span', 'counter', String(countForOption(l))));
      b.addEventListener('click', function () { chooseBoard(l); });
      group.appendChild(b);
    });
    box.appendChild(group);

    /* The escape hatch, and the reason this is not a gate. Quieter than the
       three, because a board is the better default — but never hidden. */
    var all = el('button', 'btn btn-invisible btn-sm',
      'Show me everything (' + countForOption('') + ')');
    all.type = 'button';
    all.addEventListener('click', function () { chooseBoard(''); });
    box.appendChild(all);

    host.appendChild(box);
  }

  function renderLanguageSwitcher() {
    var bar = ensureLangBar();
    if (!bar) return;
    clear(bar);

    var group = el('div', 'btn-group');
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', 'Filter by language board');
    /* Keep the pill-group look intact (rather than letting individual chips
       wrap and lose their joined border-radius) and let it scroll sideways
       instead — config.languages can grow, and this must stay usable at
       375px either way. */
    group.style.maxWidth = '100%';
    group.style.overflowX = 'auto';

    var opts = [['', 'All']];
    (cfg.languages || []).forEach(function (l) { if (l) opts.push([l, l]); });

    opts.forEach(function (o) {
      var key = o[0], label = o[1];
      var on = state.language === key;
      var b = el('button', 'btn btn-sm' + (on ? ' selected' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = key ? ('Show only the ' + key + ' board') : 'Show every board';
      b.appendChild(el('span', null, label));
      b.appendChild(el('span', 'counter', String(countForOption(key))));
      b.addEventListener('click', function () { selectLanguage(key); });
      group.appendChild(b);
    });

    bar.appendChild(group);
    updateNewDiscussionLink();
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
        renderLanguageSwitcher();
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
        writeUrl(); renderToolbar(); renderLanguageSwitcher(); renderList();
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
  /* Full match = current board (matchesLanguage) AND every other active
     filter (matchesSecondary) — both defined in the LANGUAGE BOARDS section
     above, where they are also reused to compute the switcher's counts. */

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

  /* Anything inside a card that already does something on click. The whole-card
     click target below must not steal from any of them, or filtering by a
     category pill would navigate into the thread instead. */
  function isInteractive(node, stopAt) {
    var n = node;
    while (n && n !== stopAt) {
      if (n.nodeType === 1) {
        var tag = String(n.tagName || '').toLowerCase();
        if (tag === 'a' || tag === 'button' || tag === 'input' ||
            tag === 'select' || tag === 'textarea' || tag === 'label') return true;
        if (n.getAttribute && n.getAttribute('role') === 'button') return true;
      }
      n = n.parentNode;
    }
    return false;
  }

  function threadRow(t) {
    var answered = isAnswered(t);
    var pending = !!t._pending;
    var href = 'thread.html?id=' + encodeURIComponent(t.thread_id) +
      (pending ? '&new=1' : '');
    /* .is-archived is a whole-board state, not a per-thread one: when
       archive_mode is on nothing here can be replied to, so every row is
       quietened at once (§9.3). */
    var row = el('div', 'thread-row is-clickable' + (t.pinned ? ' is-pinned' : '') +
      (archived() ? ' is-archived' : '') + (pending ? ' is-pending' : ''));

    /* THE WHOLE CARD IS THE TARGET, not just the twelve words of the title.
       Reported as "I clicked the discussion and nothing happened" — which is
       what a 340px-wide card with a 190px hit area feels like, especially on a
       phone. The <a> stays exactly where it was and does all the real work:
       it is what gives keyboard focus, middle-click, ctrl-click, "open in new
       tab", the status-bar URL preview and the screen-reader link. This handler
       only forwards a click that landed on the padding.

       Three things it must not break, hence the three guards:
         * a click on any control INSIDE the card (category pill, label pill,
           the duplicate link) belongs to that control;
         * a real click on the title anchor must not be handled twice;
         * selecting the title text with the mouse must not navigate on
           mouse-up. */
    row.addEventListener('click', function (ev) {
      if (ev.defaultPrevented) return;
      if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      if (isInteractive(ev.target, row)) return;
      var sel = null;
      try { sel = window.getSelection(); } catch (e) { sel = null; }
      if (sel && String(sel).length > 0) return;
      location.href = href;
    });

    var ico = el('span', 'thread-row-icon' + (answered ? ' answered' : ''));
    ico.title = answered ? 'Answered' : 'Open discussion';
    ico.appendChild(icon(answered ? 'check-circle' : 'comment-discussion'));
    row.appendChild(ico);

    var main = el('div', 'thread-row-main');

    var title = el('a', 'thread-row-title', t.title || '(untitled)');
    title.href = href;
    main.appendChild(title);

    var badges = el('span', 'thread-row-badges');

    /* The just-posted row (api.js's pending store). It is FIRST because it is
       the only badge that answers a question the reader is actively asking —
       "did that go through?" — and because the honest answer has two halves
       that have to arrive together: yes it posted, and no the board has not
       caught up yet. A spinner says the second half without a sentence. */
    if (pending) {
      var pb = el('span', 'badge-pending');
      pb.title = 'Posted. The board is a shared spreadsheet and takes up to a ' +
        'minute to catch up — the discussion itself is open now.';
      pb.appendChild(spinner());
      pb.appendChild(el('span', null, 'Posting'));
      badges.appendChild(pb);
    }

    if (t.pinned) badges.appendChild(el('span', 'badge-pinned', 'Pinned'));
    if (answered) badges.appendChild(el('span', 'badge-answered', 'Answered'));

    /* ---- v3 card markers (D9, D12, D13). Order is deliberate: the two that
       tell you "this has been dealt with" come first, then the two that tell
       you "you cannot act on this". All four read through truthy()/
       duplicateOf(), so an un-migrated backend simply appends nothing. ---- */

    /* D9. instructor_replied is computed flow-side from f_posts_named, which
       already excludes anonymous posts — an anonymous instructor reply must
       NOT light this up, or the badge de-anonymises them on their own card.
       Nothing here can restore that if the flow gets it wrong; this end just
       has to not invent it (there is no client-side derivation from author
       ids, precisely because the anonymous author is masked to 'anon'). */
    if (truthy(t.instructor_replied)) {
      var ir = el('span', 'badge-instructor-replied');
      ir.title = 'The instructor has replied on this discussion';
      ir.appendChild(icon('shield'));
      ir.appendChild(el('span', null, 'Instructor replied'));
      badges.appendChild(ir);
    }

    /* D10 on the card. §9 registers .comment-endorsed / .endorse-strip /
       .endorse-btn for the thread page but NO card-level endorsed class, so
       this uses the plain registered .badge rather than inventing a name.
       That makes it neutral rather than §9.2's outlined navy — the meaning is
       still unambiguous next to the FILLED green "Answered" badge, but if F1
       adds a .badge-endorsed this should become a co-class. */
    if (truthy(t.has_endorsed)) {
      var en = el('span', 'badge');
      en.title = 'An answer on this discussion is endorsed by the instructor';
      en.appendChild(icon12('star'));
      en.appendChild(el('span', null, 'Endorsed'));
      badges.appendChild(en);
    }

    /* D13. */
    if (truthy(t.locked)) {
      var lk = el('span', 'badge-locked');
      lk.title = 'Locked — no new replies';
      lk.appendChild(icon('lock'));
      lk.appendChild(el('span', null, 'Locked'));
      badges.appendChild(lk);
    }

    /* D12. The badge itself is the link to the earlier question: §5.3 does not
       return duplicate_of_title (resolving it would cost a second unfiltered
       GetItems, ~15 s), so the target page supplies the title and this just
       gets you there in one click. A second link inside the row is fine —
       .thread-row is a div, not an anchor. */
    var dup = duplicateOf(t);
    if (dup) {
      var du = el('a', 'badge-duplicate');
      du.href = 'thread.html?id=' + encodeURIComponent(dup);
      /* D12 asks for a "Duplicate of …" LINK. The visible word used to be just
         "Duplicate" with the destination hidden in the title tooltip — which a
         touch user never sees and a screen-reader user is not read by default.
         The destination is now in the visible text and in an aria-label; title
         stays for the mouse. The "…" of D12 would be the earlier thread's
         TITLE, and §5.3 deliberately does not put duplicate_of_title on the
         wire (resolving it costs a second unfiltered GetItems, ~15 s), so
         "earlier question" is as specific as this card can honestly be. */
      du.title = 'Marked as a duplicate — opens the earlier question';
      du.setAttribute('aria-label', 'Duplicate of an earlier question — open it');
      du.appendChild(icon('copy'));
      du.appendChild(el('span', null, 'Duplicate of earlier question'));
      badges.appendChild(du);
    }

    if (badges.firstChild) main.appendChild(badges);

    var meta = el('div', 'thread-row-meta');
    if (t.category) {
      var cp = el('button', 'pill pill-category', t.category);
      cp.type = 'button';
      cp.title = 'Show only ' + t.category;
      cp.addEventListener('click', function () {
        state.category = t.category;
        writeUrl(); renderCategories(); renderLanguageSwitcher(); renderList();
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
        writeUrl(); renderLabels(); renderLanguageSwitcher(); renderList();
        window.scrollTo(0, 0);
      }
      p.addEventListener('click', go);
      p.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); go(); }
      });
      meta.appendChild(p);
    });

    var by = el('span');
    by.appendChild(document.createTextNode(pending
      ? 'just now by ' + nameOf(t.author)
      : 'opened ' + relTime(t.created_at) + ' by ' + nameOf(t.author)));
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

  /* D14 — the site-wide read-only strip, above #toolbar (§9.3). Created and
     removed rather than hidden, so that flipping archive_mode back to FALSE in
     Admin restores the page on the next bootstrap refresh with no redeploy and
     no leftover empty box. Deliberately --attention tinted, never --danger:
     an archived board is a normal end-of-semester state, not a fault. */
  function renderArchiveBanner() {
    var toolbar = $('toolbar');
    if (!toolbar || !toolbar.parentNode) return;

    var box = $('archive-banner');
    if (!archived()) {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      return;
    }
    if (!box) {
      box = el('div', 'archive-banner');
      box.id = 'archive-banner';
      box.setAttribute('role', 'status');
      /* Above the language switcher too, when that row already exists. */
      var anchor = $('lang-switcher') || toolbar;
      anchor.parentNode.insertBefore(box, anchor);
    }
    clear(box);
    box.appendChild(icon('lock'));
    var text = el('div');
    text.appendChild(el('strong', null, 'This board is archived'));
    text.appendChild(document.createTextNode(
      'Everything stays readable, searchable and exportable. Starting discussions, ' +
      'replying, voting and accepting answers are switched off.'));
    box.appendChild(text);
  }

  /* §8.5 pins search.html's parameter names. index.html carries the language
     board as the legacy `lang`; search.html accepts both but canonicalises on
     `language`, so this link emits `language` and never `lang`. */
  function searchUrl() {
    var p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.category) p.set('category', state.category);
    if (state.label) p.set('label', state.label);
    if (state.language) p.set('language', state.language);
    if (state.answered !== 'all') p.set('answered', state.answered);
    if (state.sort !== 'latest') p.set('sort', state.sort);
    var qs = p.toString();
    return 'search.html' + (qs ? '?' + qs : '');
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
      /* threads.list is three unfiltered Excel GetItems plus a ~44-action
         derive chain — 10-21 s on a cold cache, every time, and none of that is
         fixable from here. A lone spinner in the middle of an empty page for
         twenty seconds reads as a page that has failed. Rows shaped like the
         cards that are coming read as a page that is working. */
      var wait = el('div', 'thread-list-loading');
      var say = el('p', 'loading-block-msg');
      say.setAttribute('role', 'status');
      say.appendChild(spinner());
      say.appendChild(el('span', null, 'Loading discussions…'));
      wait.appendChild(say);
      wait.appendChild(skeleton('thread', 4));
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

    /* After the empty-board case, so a brand-new clinic with nothing in it says
       "no discussions yet" rather than asking which flavour of nothing you would
       like. See needsBoardChoice(). */
    if (needsBoardChoice()) {
      renderBoardChooser(list);
      return;
    }

    /* Scope to the current board first, then apply every other filter within
       it — mirrors the switcher's own counts (countForOption) so the two can
       never disagree. */
    var boardThreads = data.threads.filter(function (t) { return matchesLanguage(t, state.language); });
    var rows = sortRows(boardThreads.filter(matchesSecondary));

    /* header strip: count + clear-filters. The denominator is the current
       board's total, not the whole site's, so "3 of 8" always means "3 of
       the 8 threads in this board" rather than mixing in other boards. */
    var head = el('div', 'thread-list-header');
    head.appendChild(el('span', null,
      rows.length + (rows.length === 1 ? ' discussion' : ' discussions') +
      (filtering() ? ' of ' + boardThreads.length : '')));
    if (filtering()) {
      var spacer = el('span', 'grow');
      head.appendChild(spacer);
      /* D2 hand-off. This list does a raw substring AND over a concatenated
         haystack; search.html tokenises, stopwords and prefix-matches, so it
         is a documented SUBSET — it can legitimately return fewer than N.
         The count is this page's own, because this page's filters are what
         the link carries; the title says so rather than pretending. */
      if (rows.length) {
        var more = el('a', 'btn btn-sm btn-invisible',
          'See all ' + rows.length + (rows.length === 1 ? ' result' : ' results'));
        more.href = searchUrl();
        more.title = 'Open these filters on the full search page. Search matches ' +
          'whole words, so it can return fewer than ' + rows.length + '.';
        head.appendChild(more);
      }
      var cl = el('button', 'btn btn-sm btn-invisible', 'Clear filters');
      cl.type = 'button';
      cl.addEventListener('click', clearFilters);
      head.appendChild(cl);
    }
    list.appendChild(head);

    if (!rows.length) {
      if (state.language && !boardThreads.length) {
        /* The board itself has nothing yet, regardless of q/category/label/
           answered — inviting a clear-filters click would be useless here. */
        list.appendChild(emptyState(
          'No ' + state.language + ' questions yet — ask the first one',
          'Be the first to ask in the ' + state.language + ' board. Say what you tried, ' +
          'paste the exact error, and keep the code minimal.',
          'Ask a ' + state.language + ' question',
          function () { location.href = 'new.html?lang=' + encodeURIComponent(state.language); }
        ));
      } else if (state.language) {
        list.appendChild(emptyState(
          'No matching discussions in ' + state.language,
          'Nothing in the ' + state.language + ' board matches the current search and filters.',
          'Clear filters',
          clearFilters
        ));
      } else {
        list.appendChild(emptyState(
          'No matching discussions',
          'Nothing matches the current search and filters.',
          'Clear filters',
          clearFilters
        ));
      }
      return;
    }

    rows.forEach(function (t) { list.appendChild(threadRow(t)); });
  }

  /* ================================================================ BOOT === */

  /* ------------------------------------------------- the twice-delivered board
     api.threadsList() (v3.1) paints the cached board immediately and refreshes
     behind it, so this page now receives threads.list TWICE on a warm cache:
     once from localStorage, once from the flow ~10-20 s later.

     Redrawing on the second delivery unconditionally would rebuild the list
     under the reader's cursor on every single visit, and the common case is that
     NOTHING has changed since they last looked. So the payload is fingerprinted
     and an identical one is dropped without touching the DOM.

     The fingerprint is deliberately order-INSENSITIVE (the parts are sorted):
     row order is decided here by sortRows(), not by the flow, so two payloads
     that differ only in the order they arrived in are the same board. Every
     field the cards actually render is in it, including the four v3 keys, so a
     lock, an endorsement or an accepted answer counts as a change even when no
     thread was added. */
  /* Field / row delimiters. Written as escapes, not as literal control
     characters: a raw 0x01 in a source file is invisible to whoever reads
     it next and one stray editor save or copy-paste silently turns the
     fingerprint into a plain concatenation, where 't_1'+'2' and 't_12'+''
     collide and the board then never notices a change at all. */
  var FS = '\u0001';
  var RS = '\u0002';

  function signatureOf(list) {
    var rows = (list && list.threads) || [];
    var parts = [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i] || {};
      /* `_pending` is in the fingerprint and MUST stay in it. A pending row
         and the real row that replaces it are identical in every other field
         listed here — same id, same title, same zero reply count — so without
         it the payload that finally carries the thread hashes the same as the
         one before it, the guard below decides "nothing has changed", and the
         card keeps its dashed border and its "Posting" spinner for the rest of
         the visit, on a thread that has been on the board for a minute.
         Caught in the browser against a simulated 60 s threads.list lag. */
      parts.push([t.thread_id, t.title, t.language, t.category, t.status,
                  t.accepted, t.pinned, t.locked, t.duplicate_of,
                  t.instructor_replied, t.has_endorsed,
                  t.reply_count, t.upvotes, t.deleted,
                  t._pending ? 'p' : '',
                  labelsOf(t).join(',')].join(FS));
    }
    parts.sort();
    /* The leaderboard can move without any thread changing. */
    var contrib = (list && list.contrib) || [];
    for (var j = 0; j < contrib.length; j++) {
      var c = contrib[j] || {};
      parts.push('c' + FS + [c.user_id, c.replies, c.accepted,
                              c.upvotes_received].join(FS));
    }
    return parts.join(RS);
  }

  var lastSig = null;

  /* ---------------------------------------------- waiting out the write lag
     A row that api.js is still holding for us (see addPendingThread) is one the
     server has not admitted to yet. threads.list is fetched ONCE per visit, so
     without this the "Posting" badge would sit there until the next navigation
     even though the row landed twenty seconds ago.

     STRICTLY BOUNDED, because R22's daily flow allocation is real: at most
     PENDING_RECHECKS extra threads.list runs, only while a pending row is
     actually on this board, only while the tab is visible, and it stops the
     moment there is nothing left to wait for. It cannot run at all for someone
     who has not just posted something. */
  var PENDING_RECHECK_MS = [30000, 45000, 60000];
  var pendingChecks = 0;
  var pendingTimer = null;
  var hadPending = false;

  function pendingCount() {
    var api = API();
    if (typeof api.pendingThreads !== 'function') return 0;
    try { return api.pendingThreads().length; } catch (e) { return 0; }
  }

  function schedulePendingRecheck() {
    if (pendingTimer) return;
    if (pendingChecks >= PENDING_RECHECK_MS.length) return;
    if (!pendingCount()) { pendingChecks = 0; return; }
    var wait = PENDING_RECHECK_MS[pendingChecks];
    pendingTimer = window.setTimeout(function () {
      pendingTimer = null;
      if (!pendingCount()) { pendingChecks = 0; return; }
      /* A backgrounded tab is not looking at the board. Spending a 10-21 s flow
         run on it buys nothing, so wait for it to come back rather than
         re-arming a timer that would fire into a hidden tab forever. */
      if (document.hidden) { whenVisible(schedulePendingRecheck); return; }
      pendingChecks++;
      var api = API();
      if (typeof api.refreshThreads !== 'function') return;
      /* Success repaints through the 'clinic:threads' listener below, which
         re-arms this itself; the catch is only so a failed refresh still gets
         the remaining attempts. */
      api.refreshThreads()['catch'](function () {
        schedulePendingRecheck();
      });
    }, wait);
  }

  var visibleWaiters = null;
  function whenVisible(fn) {
    if (!document.hidden) { fn(); return; }
    if (visibleWaiters) { visibleWaiters.push(fn); return; }
    visibleWaiters = [fn];
    var onVis = function () {
      if (document.hidden) return;
      document.removeEventListener('visibilitychange', onVis, false);
      var queue = visibleWaiters || [];
      visibleWaiters = null;
      for (var i = 0; i < queue.length; i++) queue[i]();
    };
    document.addEventListener('visibilitychange', onVis, false);
  }

  /* ------------------------------------------------- where contrib comes from
     threads.list carries `contrib` today. A flow change in flight moves it to
     its own action, meta.leaderboard, and this page has to draw correctly
     against both for as long as the two coexist — see the long note above
     api.leaderboard(). All this page has to know is: hand the payload over, get
     rows back, and do not assume a network call happened (in the common case
     none does).

     Absent is Array.isArray-absent, not falsy-absent: `contrib: []` is a real
     "nobody has scored yet" from today's backend. */
  function applyContrib(lb) {
    data.contrib = (lb && lb.contrib) || [];
    data.contribMonth = (lb && lb.contrib_month) || null;
    topContrib = {};
    ranked(data.contrib).slice(0, 3).forEach(function (c) { topContrib[c.user_id] = true; });
  }

  /* The "Top contributor" pill is drawn on the CARDS as well as in the sidebar
     (see threadRow), so a late leaderboard has to be able to move both — but
     only when it actually changed something. */
  function topContribSig() {
    return Object.keys(topContrib).sort().join(',');
  }

  var lbAsked = false;

  function ensureLeaderboard(list) {
    if (Array.isArray(list && list.contrib)) { applyContrib(list); return; }
    /* Once per page: api.leaderboard() has its own per-session cache and
       single-flight, but a board refresh landing every minute must not queue a
       fresh render callback each time. */
    if (lbAsked) return;
    var api = API();
    if (typeof api.leaderboard !== 'function') { applyContrib(null); return; }
    lbAsked = true;
    /* Never rejects, by contract. Worst case it resolves with empty rows and
       renderLeaderboard() draws its own "no contributions yet" line. */
    api.leaderboard(list).then(function (lb) {
      var before = topContribSig();
      applyContrib(lb);
      if (!loaded) return;                  /* first paint will draw it anyway */
      renderLeaderboard();
      if (topContribSig() !== before) renderList();
    });
  }

  function applyThreadsPayload(list) {
    list = list || {};
    data.threads = (list.threads || []).filter(function (t) { return t && !t.deleted; });
    data.users = list.users || [];
    ensureLeaderboard(list);
  }

  function applyBootstrap(b) {
    if (!b || !b.config) return;
    var wasArchived = archived();
    var wasAsking = needsBoardChoice();
    cfg = b.config;
    renderCategories();
    renderLabels();
    renderNotice();
    renderLanguageSwitcher();
    renderArchiveBanner();
    /* D14: "within one bootstrap refresh". archive_mode flipping is the one
       config change that alters every row (.is-archived), so the list is
       redrawn — but only when it actually changed, so a routine background
       refresh does not rebuild the list under someone's cursor.

       The board question is the second such config-driven whole-list change: it
       can only be asked once cfg.languages exists, and a bootstrap cached before
       that row was added supplies it here rather than at first paint. Same
       discipline — redraw only on an actual change. */
    if (wasArchived !== archived() || wasAsking !== needsBoardChoice()) renderList();
  }

  function renderAll() {
    renderLanguageSwitcher();
    renderArchiveBanner();
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
    /* Echo the resolved board straight back into the address bar — readUrl()
       may have just pulled it from localStorage rather than the URL itself,
       and a restored board should be just as linkable as a chosen one. */
    writeUrl();
    renderToolbar();

    /* api.bootstrap() answers instantly from the localStorage cache and
       refreshes in the background; the event fires when newer config lands. */
    window.addEventListener('clinic:bootstrap', function (ev) {
      if (loaded && ev && ev.detail) applyBootstrap(ev.detail);
    });

    var bootP = (typeof api.bootstrap === 'function')
      ? api.bootstrap()
      : api.call('meta.bootstrap', {});

    /* api.threadsList() answers instantly from the localStorage cache when there
       is one and refreshes in the background, exactly as api.bootstrap() does.
       The fallback keeps this page working against an api.js that predates the
       cache. */
    var threadsP = (typeof api.threadsList === 'function')
      ? api.threadsList()
      : api.call('threads.list', {});

    /* The background refresh landing. Registered BEFORE the first paint on
       purpose: on a cache MISS, storeThreads fires this event while `loaded` is
       still false, the guard below drops it, and the Promise.all path a tick
       later is what sets the baseline fingerprint. On a cache HIT it is the
       only thing that ever swaps fresh data in. */
    window.addEventListener('clinic:threads', function (ev) {
      if (!loaded || !ev || !ev.detail) return;
      /* Read BEFORE applying: api.js has already dropped any pending row this
         payload contains, so the count afterwards cannot tell us whether one of
         them is what changed. */
      var wasWaiting = hadPending;
      var sig = signatureOf(ev.detail);
      if (sig === lastSig) { hadPending = pendingCount() > 0; return; }
      lastSig = sig;
      applyThreadsPayload(ev.detail);
      hadPending = pendingCount() > 0;
      renderLanguageSwitcher();
      renderCategories();
      renderLabels();
      renderLeaderboard();
      renderList();
      /* Say so. The list has just moved under someone who did not ask it to,
         and an unexplained shift reads as a glitch. Only ever on a real change,
         so this is not per-visit noise.
         When what changed is THEIR post finally landing, say that instead: it
         is the one board update the reader was actually waiting for, and
         "Discussions updated." would bury the answer to their question. */
      if (wasWaiting && !hadPending) toast('Your discussion is on the board.', 'success');
      else toast('Discussions updated.');
      schedulePendingRecheck();
    });

    Promise.all([bootP, threadsP]).then(function (res) {
      var b = res[0] || {};
      var list = res[1] || {};

      cfg = b.config || cfg;
      applyThreadsPayload(list);
      lastSig = signatureOf(list);
      hadPending = pendingCount() > 0;

      loaded = true;
      renderAll();
      schedulePendingRecheck();
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
