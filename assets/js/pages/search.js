/* ============================================================================
 * pages/search.js — the dedicated search page (D2, owner F3)
 *
 * Mounts on #search-main and #search-side (contract §8.5 — search.html ships
 * both EMPTY; every node below them is built here, exactly as thread.js builds
 * #thread-root). This file may not edit any HTML or CSS: it emits the class
 * names registered in §9.7 and nothing else.
 *
 * THE POINT OF THE PAGE: "find before you ask". Everything else follows from
 * that.
 *
 *  - ZERO network calls per keystroke. The whole page runs off Clinic.searchIndex,
 *    which is built from ONE threads.list response — the same payload index.html
 *    already fetches, single-flighted by api.js's DEDUPE and cached in
 *    sessionStorage for 90 s. Filtering, ranking and re-rendering are pure
 *    client-side work. Open the Network tab, type, filter: nothing happens.
 *    That is D2's definition of done, not an optimisation.
 *
 *  - The URL IS the state. Every filter round-trips through the querystring
 *    (§8.5 pins the names: q, category, label, language, status, answered,
 *    from, to, sort), the page restores itself from the URL on load, and the
 *    back button walks back through filter changes. A result you found must be
 *    a link you can paste to a classmate.
 *
 *  - `answered` and `status` are TWO DIFFERENT DIMENSIONS and are never
 *    collapsed. `answered` is the DERIVED view state (status === 'answered' OR
 *    an accepted post exists) — the same isAnswered() index.js uses. `status`
 *    is the RAW tbl_Threads.status column, exact string match, for the
 *    instructor. A thread can be status='open' and answered=true at once.
 *
 *  - The empty state is the most important state on the page. A student who
 *    searched and found nothing has done exactly the right thing, and the
 *    next click must be "ask it", pre-filled with what they typed.
 *
 *  - HONESTY. The index covers titles, labels, category, author names and a
 *    220-character excerpt — not full bodies, not replies, no stemming, no
 *    synonyms. That is stated on the page in a .field-hint, permanently. If the
 *    backend ever stops sending `excerpt` (risk R20 — silent quality loss with
 *    no error) stats().hasExcerpt goes false and an .inert-note says so.
 *
 * House style: ES5 only. var, function declarations, no template literals, no
 * arrow functions, no optional chaining, storage in try/catch.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---------------------------------------------------------------- shims */
  function UI() { return (window.Clinic && window.Clinic.ui) || {}; }
  function API() { return (window.Clinic && window.Clinic.api) || {}; }
  function SI() { return (window.Clinic && window.Clinic.searchIndex) || null; }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
  /* ui.icon()/ui.pill() may return an element or a static SVG string — both are
     author-controlled chrome, never user content. */
  function toNode(x) {
    if (x && x.nodeType) return x;
    var s = document.createElement('span');
    if (typeof x === 'string') s.innerHTML = x;
    return s;
  }
  function icon(name) { try { return toNode(UI().icon(name)); } catch (e) { return el('span'); } }
  function pill(text) { try { return toNode(UI().pill(text)); } catch (e) { return el('span', 'pill', text); } }
  function relTime(iso) { try { return UI().relTime(iso) || ''; } catch (e) { return ''; } }
  function toast(msg, type) { try { UI().toast(msg, type); } catch (e) { /* ignore */ } }
  function truthy(v) {
    try { return !!UI().truthy(v); } catch (e) { return v === true; }
  }
  function errText(e) {
    return (e && (e.message || e.error)) || 'Something went wrong. Please try again.';
  }
  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

  var MIN_QUERY = 2;
  var DEBOUNCE_MS = 180;
  (function () {
    var si = SI();
    if (si) {
      if (si.MIN_QUERY != null) MIN_QUERY = si.MIN_QUERY;
      if (si.DEBOUNCE_MS != null) DEBOUNCE_MS = si.DEBOUNCE_MS;
    }
  })();

  /* ------------------------------------------------------------ page state */
  /* Every key here is a §8.5 URL parameter name, spelled the way §8.5 spells
     it. `language` is canonical; `lang` is accepted on read (index.html's
     legacy name) and NEVER written. */
  var state = {
    q: '',
    category: '',
    label: '',
    language: '',
    status: '',            /* RAW tbl_Threads.status                          */
    answered: '',          /* '' | 'answered' | 'unanswered' — DERIVED         */
    from: '',              /* YYYY-MM-DD, SGT day, inclusive                   */
    to: '',
    sort: ''               /* '' = default (relevance with a query, else latest) */
  };

  var cfg = { categories: [], labels: [], languages: [] };
  var threadsAll = [];        /* everything the index holds, for the facets    */
  var loaded = false;
  var loadError = null;
  var lastPushedUrl = '';
  var els = {};               /* built once, then mutated in place            */
  var qTimer = null;
  var mq = null;

  /* Same derivation as index.js's isAnswered() and searchIndex.isAnswered().
     One definition, three call sites, no drift. */
  function isAnswered(t) {
    var si = SI();
    if (si && si.isAnswered) return si.isAnswered(t);
    return t.status === 'answered' || t.accepted === true;
  }
  function labelsOf(t) {
    if (Array.isArray(t.labels)) return t.labels;
    return t.labels ? String(t.labels).split(',') : [];
  }
  function nameOf(a) { return (a && a.display_name) || 'Unknown'; }

  function defaultSort() { return hasQuery() ? 'relevance' : 'latest'; }
  function effSort() { return state.sort || defaultSort(); }
  function hasQuery() { return trim(state.q).length >= MIN_QUERY; }
  function activeFilterCount() {
    var n = 0;
    if (state.category) n++;
    if (state.label) n++;
    if (state.language) n++;
    if (state.status) n++;
    if (state.answered) n++;
    if (state.from) n++;
    if (state.to) n++;
    return n;
  }
  function anyState() { return !!(trim(state.q) || activeFilterCount()); }

  /* ============================================================ URL STATE == */

  function readUrl() {
    var p = new URLSearchParams(location.search);
    state.q = p.get('q') || '';
    state.category = p.get('category') || '';
    state.label = p.get('label') || '';
    /* Accept BOTH spellings, prefer `language`, always write `language`
       (§8.5). index.html emits `lang`; F6's "See all N results" link emits
       `language`. A link from either era has to keep working. */
    state.language = p.has('language') ? (p.get('language') || '') : (p.get('lang') || '');
    state.status = p.get('status') || '';
    var a = p.get('answered');
    state.answered = (a === 'answered' || a === 'unanswered') ? a : '';
    state.from = normDate(p.get('from'));
    state.to = normDate(p.get('to'));
    var s = p.get('sort');
    state.sort = (s === 'relevance' || s === 'latest' || s === 'top' || s === 'unanswered') ? s : '';
  }

  function normDate(v) {
    v = trim(v);
    return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
  }

  function urlString() {
    var p = new URLSearchParams();
    if (trim(state.q)) p.set('q', state.q);
    if (state.category) p.set('category', state.category);
    if (state.label) p.set('label', state.label);
    if (state.language) p.set('language', state.language);
    if (state.status) p.set('status', state.status);
    if (state.answered) p.set('answered', state.answered);
    if (state.from) p.set('from', state.from);
    if (state.to) p.set('to', state.to);
    if (state.sort && state.sort !== defaultSort()) p.set('sort', state.sort);
    var qs = p.toString();
    return location.pathname + (qs ? '?' + qs : '');
  }

  /* push=true for a DISCRETE change (a control the user clicked): that is a
     step the back button should walk back through. push=false while typing:
     one history entry per keystroke would make Back useless — you would have
     to press it fourteen times to leave the page. The search input's `change`
     event (fires on Enter/blur) commits the typed query as one entry, so Back
     works for queries too, just at a sane granularity. */
  function writeUrl(push) {
    var url = urlString();
    try {
      if (push && url !== lastPushedUrl) {
        history.pushState({ clinic: 'search' }, '', url);
        lastPushedUrl = url;
      } else {
        history.replaceState({ clinic: 'search' }, '', url);
        if (push) lastPushedUrl = url;
      }
    } catch (e) { /* file:// — harmless, the page still works */ }
  }

  function commitQueryToHistory() {
    var url = urlString();
    if (url === lastPushedUrl) return;
    try {
      history.pushState({ clinic: 'search' }, '', url);
      lastPushedUrl = url;
    } catch (e) { /* ignore */ }
  }

  /* ============================================================= FILTERS === */

  function filtersFromState() {
    return {
      category: state.category,
      label: state.label,
      language: state.language,
      status: state.status,
      answered: state.answered,
      from: state.from,
      to: state.to
    };
  }

  /* Facet counts answer "how many would I get if I picked this?", so they are
     computed with every OTHER filter applied but not this dimension. A count
     that disagrees with what clicking it shows is worse than no count. */
  function countIf(overrides) {
    var si = SI();
    if (!si || !si.ready()) return 0;
    var f = filtersFromState();
    for (var k in overrides) {
      if (Object.prototype.hasOwnProperty.call(overrides, k)) f[k] = overrides[k];
    }
    if (hasQuery()) return si.search(state.q, { limit: 0, filters: f }).length;
    return si.filterOnly(f).length;
  }

  /* =============================================================== SHELL === */

  function buildShell() {
    var main = $('search-main');
    if (!main) return false;
    clear(main);

    /* --- page head ---------------------------------------------------- */
    var head = el('div', 'page-head');
    var h1 = el('h1', null, 'Search');
    head.appendChild(h1);
    var ask = el('a', 'btn btn-primary', 'Ask a new question');
    ask.href = 'new.html';
    els.askTop = ask;
    head.appendChild(ask);
    main.appendChild(head);

    /* --- sticky search bar -------------------------------------------- */
    var bar = el('div', 'search-bar');

    var input = el('input', 'input grow');
    input.type = 'search';
    input.id = 'search-q';
    input.placeholder = 'Search questions by title, label, category or author';
    input.setAttribute('aria-label', 'Search questions');
    input.setAttribute('aria-describedby', 'search-coverage');
    input.autocomplete = 'off';
    bar.appendChild(input);
    els.input = input;

    /* Filters live behind a toggle at <=767px (§9.10). The toggle carries the
       active-filter count so nothing is ever hidden invisibly. */
    var toggle = el('button', 'btn btn-sm search-filters-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'search-filters');
    toggle.appendChild(el('span', null, 'Filters'));
    var tCount = el('span', 'counter', '0');
    tCount.setAttribute('aria-hidden', 'true');
    toggle.appendChild(tCount);
    bar.appendChild(toggle);
    els.toggle = toggle;
    els.toggleCount = tCount;

    main.appendChild(bar);

    /* FOUND IN THE BROWSER, and the reason .search-filters is a SIBLING of
       .search-bar rather than a child of it: .search-bar is position:sticky
       (§9.7, non-negotiable — the query box must stay reachable while you
       scroll a long result list). With eight filter controls inside it the bar
       wraps to ~438px tall at 800px wide, and a 438px sticky element does not
       "stick", it OCCLUDES: the first four results scroll underneath it and are
       invisible. Keeping only the input and the mobile toggle in the sticky bar
       leaves it one row high. .search-filters carries width:100% and no
       descendant selector ties it to .search-bar, so every §9.7 rule still
       applies exactly as written. */
    var filters = el('div', 'search-filters');
    filters.id = 'search-filters';
    filters.setAttribute('role', 'group');
    filters.setAttribute('aria-label', 'Filter results');
    els.filters = filters;
    buildFilterControls(filters);
    main.appendChild(filters);

    /* --- honest coverage note (never removed) -------------------------- */
    var cover = el('p', 'field-hint');
    cover.id = 'search-coverage';
    cover.textContent =
      'Searches question titles, labels, categories, language boards and a short ' +
      'body excerpt — not full replies. It finds questions worded like yours; ' +
      'it does not understand meaning, so try the words in the error message.';
    main.appendChild(cover);
    els.coverage = cover;

    /* R20: excerpts are an extension beyond SPEC §5. If the flow stops sending
       them, search quietly gets worse with no error anywhere. Say it out loud. */
    var narrow = el('div', 'inert-note');
    narrow.hidden = true;
    narrow.appendChild(icon('search'));
    var nb = el('div');
    nb.appendChild(el('span', 'inert-note-title', 'Titles and labels only'));
    nb.appendChild(document.createTextNode(
      ' This backend is not sending body excerpts yet, so results come from ' +
      'titles, labels, categories and author names.'));
    narrow.appendChild(nb);
    main.appendChild(narrow);
    els.narrow = narrow;

    /* --- summary (live region) ---------------------------------------- */
    var summary = el('div', 'search-summary');
    summary.id = 'search-summary';
    summary.setAttribute('role', 'status');
    summary.setAttribute('aria-live', 'polite');
    main.appendChild(summary);
    els.summary = summary;

    /* --- results ------------------------------------------------------- */
    var results = el('div', 'search-results');
    results.id = 'search-results';
    main.appendChild(results);
    els.results = results;

    wireEvents();
    return true;
  }

  function group(parent, labelText, controlId) {
    var g = el('div', 'search-filter-group');
    var lab = el('label', 'search-filter-label', labelText);
    if (controlId) lab.setAttribute('for', controlId);
    g.appendChild(lab);
    parent.appendChild(g);
    return g;
  }

  function select(id, ariaLabel) {
    var s = el('select', 'select');
    s.id = id;
    s.style.width = 'auto';
    if (ariaLabel) s.setAttribute('aria-label', ariaLabel);
    return s;
  }

  function buildFilterControls(host) {
    clear(host);

    /* Category */
    var g1 = group(host, 'Category', 'sf-category');
    els.category = select('sf-category');
    g1.appendChild(els.category);

    /* Language board */
    var g2 = group(host, 'Board', 'sf-language');
    els.language = select('sf-language');
    g2.appendChild(els.language);

    /* Label */
    var g3 = group(host, 'Label', 'sf-label');
    els.label = select('sf-label');
    g3.appendChild(els.label);

    /* Answered — the DERIVED state. Buttons, not a select, because this is the
       filter students actually use and it must be one tap. */
    var g4 = el('div', 'search-filter-group');
    var l4 = el('span', 'search-filter-label', 'Answered');
    l4.id = 'sf-answered-label';
    g4.appendChild(l4);
    var grp = el('div', 'btn-group');
    grp.setAttribute('role', 'group');
    grp.setAttribute('aria-labelledby', 'sf-answered-label');
    grp.setAttribute('aria-label', 'Filter by answer status');
    els.answeredBtns = [];
    [['', 'All'], ['answered', 'Answered'], ['unanswered', 'Unanswered']].forEach(function (o) {
      var b = el('button', 'btn btn-sm', o[1]);
      b.type = 'button';
      b.setAttribute('data-value', o[0]);
      b.addEventListener('click', function () {
        state.answered = o[0];
        onFilterChange();
      });
      els.answeredBtns.push(b);
      grp.appendChild(b);
    });
    g4.appendChild(grp);
    host.appendChild(g4);

    /* Dates — SGT days, inclusive at both ends. */
    var g5 = group(host, 'From', 'sf-from');
    els.from = el('input', 'input');
    els.from.type = 'date';
    els.from.id = 'sf-from';
    els.from.style.width = 'auto';
    g5.appendChild(els.from);

    var g6 = group(host, 'To', 'sf-to');
    els.to = el('input', 'input');
    els.to.type = 'date';
    els.to.id = 'sf-to';
    els.to.style.width = 'auto';
    g6.appendChild(els.to);

    /* Raw status. §8.5: "exists for the instructor's benefit and is not
       surfaced in the default filter row." So it is drawn only for an
       instructor — OR whenever a ?status= deep link is in play, because a
       filter you cannot see is a filter you cannot clear. */
    var g7 = group(host, 'Raw status', 'sf-status');
    els.status = select('sf-status');
    els.status.title = 'The raw tbl_Threads.status column. Different from Answered, ' +
                       'which also counts a thread with an accepted reply.';
    g7.appendChild(els.status);
    els.statusGroup = g7;

    /* Sort */
    var g8 = group(host, 'Sort', 'sf-sort');
    els.sort = select('sf-sort');
    g8.appendChild(els.sort);

    /* Clear all — CSS gives .search-chip-clear margin-left:auto, so it parks
       at the end of the row. */
    var clr = el('button', 'btn btn-invisible btn-sm search-chip-clear', 'Clear all');
    clr.type = 'button';
    clr.addEventListener('click', clearAll);
    host.appendChild(clr);
    els.clearAll = clr;

    /* Refresh — the ONLY control on this page that can touch the network. */
    var refresh = el('button', 'btn btn-sm', 'Refresh');
    refresh.type = 'button';
    refresh.title = 'Re-fetch the question list (one backend call, 10-20 seconds)';
    refresh.addEventListener('click', function () { doLoad(true); });
    host.appendChild(refresh);
    els.refresh = refresh;
  }

  function fillSelect(sel, options, value) {
    if (!sel) return;
    clear(sel);
    for (var i = 0; i < options.length; i++) {
      var o = el('option', null, options[i][1]);
      o.value = options[i][0];
      if (options[i][0] === value) o.selected = true;
      sel.appendChild(o);
    }
    /* A deep link can name a value this corpus no longer has. Keep it visible
       and selected rather than silently snapping to "All" — the results say
       zero and the control says why. */
    if (value && sel.value !== value) {
      var extra = el('option', null, value + ' (no matches)');
      extra.value = value;
      extra.selected = true;
      sel.appendChild(extra);
    }
  }

  /* ======================================================= SYNC CONTROLS === */

  /* Controls are built once and updated in place. Rebuilding them on every
     render would throw focus out of the search box mid-keystroke and lose the
     caret position — which is exactly the bug that makes a search page feel
     broken. */
  function syncControls() {
    if (!els.input) return;
    if (document.activeElement !== els.input && els.input.value !== state.q) {
      els.input.value = state.q;
    }

    var cats = [['', 'All categories']];
    (cfg.categories || []).forEach(function (c) {
      if (c) cats.push([c, c + ' (' + countIf({ category: c }) + ')']);
    });
    fillSelect(els.category, cats, state.category);

    var langs = [['', 'All boards']];
    (cfg.languages || []).forEach(function (l) {
      if (l) langs.push([l, l + ' (' + countIf({ language: l }) + ')']);
    });
    fillSelect(els.language, langs, state.language);

    var labs = [['', 'All labels']];
    knownLabels().forEach(function (l) {
      labs.push([l, l + ' (' + countIf({ label: l }) + ')']);
    });
    fillSelect(els.label, labs, state.label);

    var statuses = [['', 'Any raw status']];
    knownStatuses().forEach(function (s) { statuses.push([s, s]); });
    fillSelect(els.status, statuses, state.status);

    var showStatus = isInstructor() || !!state.status;
    if (els.statusGroup) els.statusGroup.hidden = !showStatus;

    var sorts = [];
    if (hasQuery()) sorts.push(['relevance', 'Best match']);
    sorts.push(['latest', 'Latest']);
    sorts.push(['top', 'Most upvoted']);
    sorts.push(['unanswered', 'Unanswered first']);
    fillSelect(els.sort, sorts, effSort());

    if (els.from) els.from.value = state.from;
    if (els.to) els.to.value = state.to;

    for (var i = 0; i < (els.answeredBtns || []).length; i++) {
      var b = els.answeredBtns[i];
      var on = b.getAttribute('data-value') === state.answered;
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) b.classList.add('selected'); else b.classList.remove('selected');
    }

    var n = activeFilterCount();
    if (els.toggleCount) els.toggleCount.textContent = String(n);
    if (els.toggle) {
      els.toggle.setAttribute('aria-label',
        n ? ('Filters, ' + n + ' active') : 'Filters');
    }
    if (els.clearAll) els.clearAll.hidden = !anyState();

    /* The "ask it anyway" route carries everything the student already told
       us. new.js reads `category` and `lang`; `title` is passed for F6 to pick
       up (harmlessly ignored today). */
    if (els.askTop) els.askTop.href = newUrl();
  }

  function knownLabels() {
    var seen = {}, out = [];
    (cfg.labels || []).forEach(function (l) {
      l = trim(l);
      if (l && !seen[l]) { seen[l] = 1; out.push(l); }
    });
    threadsAll.forEach(function (t) {
      labelsOf(t).forEach(function (raw) {
        var l = trim(raw);
        if (l && !seen[l]) { seen[l] = 1; out.push(l); }
      });
    });
    return out;
  }

  function knownStatuses() {
    var seen = {}, out = [];
    threadsAll.forEach(function (t) {
      var s = trim(t.status);
      if (s && !seen[s]) { seen[s] = 1; out.push(s); }
    });
    out.sort();
    return out;
  }

  function isInstructor() {
    try { return !!UI().isInstructor(); } catch (e) { return false; }
  }

  function newUrl() {
    var p = new URLSearchParams();
    if (trim(state.q)) p.set('title', trim(state.q));
    if (state.category) p.set('category', state.category);
    if (state.language) p.set('lang', state.language);   /* new.js reads `lang` */
    var qs = p.toString();
    return 'new.html' + (qs ? '?' + qs : '');
  }

  /* ============================================================== EVENTS === */

  function wireEvents() {
    /* Typing: debounce 180 ms (§10.1), replaceState only. */
    els.input.addEventListener('input', function () {
      if (qTimer) clearTimeout(qTimer);
      qTimer = setTimeout(function () {
        qTimer = null;
        state.q = els.input.value;
        if (state.sort === 'relevance' && !hasQuery()) state.sort = '';
        writeUrl(false);
        syncControls();
        renderSidebar();
        renderResults();
      }, DEBOUNCE_MS);
    });

    /* Enter / blur commits one history entry for the typed query. */
    els.input.addEventListener('change', function () {
      if (qTimer) { clearTimeout(qTimer); qTimer = null; }
      state.q = els.input.value;
      writeUrl(false);
      commitQueryToHistory();
      syncControls();
      renderSidebar();
      renderResults();
    });

    /* Down-arrow out of the box and into the results — the whole list is then
       walkable without touching the mouse. */
    els.input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown' || ev.key === 'Down') {
        var first = firstResultLink();
        if (first) { ev.preventDefault(); first.focus(); }
      } else if (ev.key === 'Escape' || ev.key === 'Esc') {
        if (els.input.value) {
          ev.preventDefault();
          els.input.value = '';
          state.q = '';
          if (state.sort === 'relevance') state.sort = '';
          writeUrl(true);
          syncControls(); renderSidebar(); renderResults();
        }
      }
    });

    els.category.addEventListener('change', function () {
      state.category = els.category.value; onFilterChange();
    });
    els.language.addEventListener('change', function () {
      state.language = els.language.value; onFilterChange();
    });
    els.label.addEventListener('change', function () {
      state.label = els.label.value; onFilterChange();
    });
    els.status.addEventListener('change', function () {
      state.status = els.status.value; onFilterChange();
    });
    els.sort.addEventListener('change', function () {
      state.sort = els.sort.value === defaultSort() ? '' : els.sort.value;
      onFilterChange();
    });
    els.from.addEventListener('change', function () {
      state.from = normDate(els.from.value); onFilterChange();
    });
    els.to.addEventListener('change', function () {
      state.to = normDate(els.to.value); onFilterChange();
    });

    els.toggle.addEventListener('click', function () {
      var collapsed = els.filters.classList.contains('is-collapsed');
      setFiltersCollapsed(!collapsed);
    });

    /* Arrow-key walk over the result list. Real anchors, so Enter and
       middle-click already do the right thing; this only adds movement. */
    els.results.addEventListener('keydown', function (ev) {
      var k = ev.key;
      if (k !== 'ArrowDown' && k !== 'Down' && k !== 'ArrowUp' && k !== 'Up' &&
          k !== 'Home' && k !== 'End') return;
      var links = resultLinks();
      if (!links.length) return;
      var at = -1;
      for (var i = 0; i < links.length; i++) { if (links[i] === document.activeElement) { at = i; break; } }
      var next = at;
      if (k === 'Home') next = 0;
      else if (k === 'End') next = links.length - 1;
      else if (k === 'ArrowDown' || k === 'Down') next = at < 0 ? 0 : at + 1;
      else next = at <= 0 ? -1 : at - 1;

      ev.preventDefault();
      if (next < 0) { els.input.focus(); return; }
      if (next >= links.length) next = links.length - 1;
      links[next].focus();
    });

    window.addEventListener('popstate', function () {
      readUrl();
      syncControls();
      renderSidebar();
      renderResults();
    });

    /* A post in ANOTHER tab rings searchIndex's doorbell, which marks the index
       stale but deliberately does NOT blank what you are reading. Re-render the
       summary so the "someone posted — refresh" affordance appears at once
       instead of waiting for the next keystroke. Costs nothing: no network, no
       re-ranking, one text node. */
    window.addEventListener('storage', function (ev) {
      if (!ev || (ev.key !== null && ev.key !== 'clinic_search_dirty')) return;
      if (!loaded) return;
      renderSummary(els.results ? els.results.querySelectorAll('.search-result').length : 0);
    });

    /* The filter row is a disclosure below 767px and always-open above it.
       Track the breakpoint rather than guessing once at boot: a phone rotates. */
    if (window.matchMedia) {
      mq = window.matchMedia('(max-width: 767px)');
      setFiltersCollapsed(mq.matches);
      var onMq = function (e) { setFiltersCollapsed(e.matches); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }
  }

  function setFiltersCollapsed(collapsed) {
    if (!els.filters || !els.toggle) return;
    if (collapsed) els.filters.classList.add('is-collapsed');
    else els.filters.classList.remove('is-collapsed');
    els.toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }

  function onFilterChange() {
    writeUrl(true);           /* a discrete choice: Back must undo it */
    syncControls();
    renderSidebar();
    renderResults();
  }

  function clearAll() {
    state.q = ''; state.category = ''; state.label = ''; state.language = '';
    state.status = ''; state.answered = ''; state.from = ''; state.to = '';
    state.sort = '';
    if (els.input) els.input.value = '';
    onFilterChange();
    if (els.input) els.input.focus();
  }

  function resultLinks() {
    if (!els.results) return [];
    var nl = els.results.querySelectorAll('.search-result .thread-row-title');
    var out = [];
    for (var i = 0; i < nl.length; i++) out.push(nl[i]);
    return out;
  }
  function firstResultLink() {
    var l = resultLinks();
    return l.length ? l[0] : null;
  }

  /* ============================================================= SIDEBAR === */
  /* §8.5: the sidebar carries the existing .side-section category list and
     label cloud ONLY, and clicking one is a FILTER CHANGE, not a navigation.
     No leaderboard: that is index-page furniture and would need a second
     payload on a page whose entire promise is zero extra calls. */

  function renderSidebar() {
    var side = $('search-side');
    if (!side) return;
    clear(side);
    if (!loaded) return;

    var sec1 = el('section', 'side-section');
    sec1.appendChild(el('h2', 'side-title', 'Categories'));
    var ul = el('ul', 'cat-list');
    ul.id = 'cat-list';

    var rows = [{ key: '', name: 'All categories', n: countIf({ category: '' }) }];
    var seen = {};
    (cfg.categories || []).forEach(function (c) {
      if (!c || seen[c]) return;
      seen[c] = 1;
      rows.push({ key: c, name: c, n: countIf({ category: c }) });
    });
    threadsAll.forEach(function (t) {
      var c = trim(t.category);
      if (c && !seen[c]) { seen[c] = 1; rows.push({ key: c, name: c, n: countIf({ category: c }) }); }
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
        onFilterChange();
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
    sec1.appendChild(ul);
    side.appendChild(sec1);

    var sec2 = el('section', 'side-section');
    sec2.appendChild(el('h2', 'side-title', 'Labels'));
    var cloud = el('div', 'label-cloud');
    var labs = knownLabels();
    if (!labs.length) {
      cloud.appendChild(el('span', 'field-hint mt-0', 'No labels yet.'));
    } else {
      labs.forEach(function (l) {
        var p = pill(l);
        var on = state.label === l;
        if (on) p.classList.add('is-active');
        p.setAttribute('role', 'button');
        p.setAttribute('tabindex', '0');
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
        p.title = on ? 'Remove this label filter' : 'Show only questions labelled ' + l;
        p.style.cursor = 'pointer';
        function toggle() {
          state.label = on ? '' : l;
          onFilterChange();
        }
        p.addEventListener('click', toggle);
        p.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggle(); }
        });
        cloud.appendChild(p);
      });
    }
    sec2.appendChild(cloud);
    side.appendChild(sec2);
  }

  /* ============================================================= RESULTS === */

  function computeResults() {
    var si = SI();
    if (!si || !si.ready()) return [];
    var f = filtersFromState();
    var rows;
    if (hasQuery()) {
      rows = si.search(state.q, { limit: 0, filters: f });
    } else {
      rows = si.filterOnly(f).map(function (t) {
        return { thread: t, score: 0, hits: { title: [], excerpt: [] } };
      });
    }
    return sortRows(rows);
  }

  function sortRows(rows) {
    var by = effSort();
    if (by === 'relevance') return rows;      /* already ranked by the index */
    return rows.slice().sort(function (ra, rb) {
      var a = ra.thread, b = rb.thread;
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

  /* A result row REUSES .thread-row geometry entirely (§9.7), so it is
     class="thread-row search-result" and nothing else. */
  function resultRow(res, archived) {
    var t = res.thread;
    var si = SI();
    var answered = isAnswered(t);
    var dup = trim(t.duplicate_of);

    var cls = 'thread-row search-result';
    if (t.pinned) cls += ' is-pinned';
    if (archived) cls += ' is-archived';
    var row = el('div', cls);

    var ico = el('span', 'thread-row-icon' + (answered ? ' answered' : ''));
    ico.title = answered ? 'Answered' : 'Open question';
    ico.appendChild(icon(answered ? 'check-circle' : 'comment-discussion'));
    row.appendChild(ico);

    var main = el('div', 'thread-row-main');

    var title = el('a', 'thread-row-title');
    title.href = 'thread.html?id=' + encodeURIComponent(t.thread_id);
    /* Highlighting goes through searchIndex.highlight(), which returns a
       DocumentFragment of text nodes and <span class="search-hit">. It never
       returns an HTML string: the corpus is student-authored text and building
       markup out of it is how a search page becomes an XSS hole. */
    if (si && hasQuery()) title.appendChild(si.highlight(t.title || '(untitled)', state.q));
    else title.appendChild(document.createTextNode(t.title || '(untitled)'));
    main.appendChild(title);

    var badges = el('span', 'thread-row-badges');
    if (t.pinned) badges.appendChild(el('span', 'badge-pinned', 'Pinned'));
    if (answered) badges.appendChild(el('span', 'badge-answered', 'Answered'));
    /* v3 card flags. Every one is absent-tolerant: ui.truthy(undefined) is
       false and a missing duplicate_of is falsy, so a backend that has not
       been re-imported simply shows none of them. Never a wrong badge. */
    if (truthy(t.instructor_replied)) {
      badges.appendChild(el('span', 'badge-instructor-replied', 'Instructor replied'));
    }
    if (truthy(t.locked)) {
      var bl = el('span', 'badge-locked');
      bl.appendChild(icon('lock'));
      bl.appendChild(el('span', null, 'Locked'));
      badges.appendChild(bl);
    }
    if (dup) {
      var bd = el('a', 'badge-duplicate');
      bd.href = 'thread.html?id=' + encodeURIComponent(dup);
      /* Same D12 change as index.js's card: the destination has to be in the
         visible text and in an aria-label, not only in a title tooltip that a
         touch user never sees and a screen reader does not read by default.
         "…" would be the earlier thread's title, which §5.3 deliberately keeps
         off the wire, so "earlier question" is the honest wording. */
      bd.title = 'Marked as a duplicate — open the earlier question';
      bd.setAttribute('aria-label', 'Duplicate of an earlier question — open it');
      bd.textContent = 'Duplicate of earlier question';
      badges.appendChild(bd);
    }
    if (badges.firstChild) main.appendChild(badges);

    var meta = el('div', 'thread-row-meta');
    if (t.category) {
      var cp = el('button', 'pill pill-category', t.category);
      cp.type = 'button';
      cp.title = 'Filter by ' + t.category;
      cp.addEventListener('click', function () {
        state.category = t.category;
        onFilterChange();
        window.scrollTo(0, 0);
      });
      meta.appendChild(cp);
    }
    labelsOf(t).forEach(function (raw) {
      var l = trim(raw);
      if (!l) return;
      var p = pill(l);
      p.setAttribute('role', 'button');
      p.setAttribute('tabindex', '0');
      p.title = 'Filter by label ' + l;
      p.style.cursor = 'pointer';
      function go() { state.label = l; onFilterChange(); window.scrollTo(0, 0); }
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
    main.appendChild(meta);

    /* Snippet: the excerpt, highlighted. Only when there is something to show
       and something to highlight — an unhighlighted 220-character excerpt on
       every row is noise, not information. */
    var ex = trim(t.excerpt);
    if (ex && hasQuery() && res.hits && res.hits.excerpt && res.hits.excerpt.length) {
      var snip = el('div', 'search-result-snippet');
      snip.appendChild(si.highlight(ex, state.q));
      main.appendChild(snip);
    }

    row.appendChild(main);

    var stats = el('div', 'thread-row-stats');
    stats.appendChild(statChip('arrow-up', Number(t.upvotes) || 0, 'upvotes'));
    stats.appendChild(statChip('comment-discussion', Number(t.reply_count) || 0, 'replies'));
    row.appendChild(stats);

    return row;
  }

  function describeFilters() {
    var bits = [];
    if (state.category) bits.push('category ' + state.category);
    if (state.language) bits.push('board ' + state.language);
    if (state.label) bits.push('label ' + state.label);
    if (state.answered) bits.push(state.answered);
    if (state.status) bits.push('raw status ' + state.status);
    if (state.from && state.to) bits.push('from ' + state.from + ' to ' + state.to);
    else if (state.from) bits.push('from ' + state.from);
    else if (state.to) bits.push('up to ' + state.to);
    return bits;
  }

  function renderSummary(n) {
    var s = els.summary;
    if (!s) return;
    clear(s);
    if (!loaded) { s.textContent = 'Loading questions…'; return; }
    if (loadError) { s.textContent = ''; return; }

    var parts = [];
    parts.push(n + (n === 1 ? ' result' : ' results'));
    if (hasQuery()) parts.push('for “' + trim(state.q) + '”');
    var f = describeFilters();
    if (f.length) parts.push('· ' + f.join(', '));
    var text = parts.join(' ');

    var typed = trim(state.q);
    if (typed && typed.length < MIN_QUERY) {
      text = n + (n === 1 ? ' result' : ' results') +
             (f.length ? ' · ' + f.join(', ') : '') +
             ' · type at least ' + MIN_QUERY + ' characters to search';
    }
    s.appendChild(document.createTextNode(text));

    var si = SI();
    var st = si ? si.stats() : null;
    if (st && st.stale) {
      s.appendChild(document.createTextNode(' · '));
      var r = el('button', 'btn btn-invisible btn-sm', 'Someone posted — refresh');
      r.type = 'button';
      r.addEventListener('click', function () { doLoad(true); });
      s.appendChild(r);
    }
  }

  function emptyState(title, msg, actions) {
    var box = el('div', 'empty-state');
    box.appendChild(icon('search'));
    box.appendChild(el('h3', null, title));
    box.appendChild(el('p', null, msg));
    (actions || []).forEach(function (a) {
      var b;
      if (a.href) { b = el('a', a.cls || 'btn btn-primary', a.text); b.href = a.href; }
      else {
        b = el('button', a.cls || 'btn', a.text);
        b.type = 'button';
        b.addEventListener('click', a.onClick);
      }
      box.appendChild(b);
    });
    return box;
  }

  function renderResults() {
    var host = els.results;
    if (!host) return;
    clear(host);

    if (!loaded) {
      var wait = el('div', 'empty-state');
      wait.appendChild(el('span', 'spinner'));
      host.appendChild(wait);
      renderSummary(0);
      return;
    }

    if (loadError) {
      host.appendChild(emptyState(
        'Could not load questions',
        errText(loadError),
        [{ text: 'Try again', onClick: function () { doLoad(true); } }]
      ));
      renderSummary(0);
      return;
    }

    var si = SI();
    var st = si ? si.stats() : { hasExcerpt: true, docs: 0 };
    if (els.narrow) els.narrow.hidden = !!st.hasExcerpt;

    var rows = computeResults();
    renderSummary(rows.length);

    if (!rows.length) {
      /* THE MOST IMPORTANT STATE ON THE PAGE. A student searched, found
         nothing, and is now one click from asking it properly — with what they
         typed carried across as the title. "Find before you ask" only works if
         "ask" is right here when the find fails. */
      var typed = trim(state.q);
      var actions = [];
      if (typed) {
        actions.push({
          text: 'Ask this as a new question',
          href: newUrl(),
          cls: 'btn btn-primary'
        });
      } else {
        actions.push({ text: 'Ask a new question', href: 'new.html', cls: 'btn btn-primary' });
      }
      if (anyState()) {
        actions.push({ text: 'Clear all filters', cls: 'btn', onClick: clearAll });
      }
      var msg = typed
        ? 'Nobody has asked this yet — at least not in these words. Search covers ' +
          'titles, labels and a short excerpt, so try the exact error text, or ask it ' +
          'or ask it as a new question.'
        : 'Nothing matches these filters.';
      host.appendChild(emptyState(
        typed ? 'No questions match “' + typed + '”' : 'No questions match',
        msg, actions));
      return;
    }

    var archived = false;
    try { archived = truthy(UI().bootstrapConfig().archive_mode); } catch (e) { archived = false; }

    for (var i = 0; i < rows.length; i++) {
      host.appendChild(resultRow(rows[i], archived));
    }
  }

  /* ================================================================ BOOT === */

  function applyBootstrap(b) {
    if (!b || !b.config) return;
    var c = b.config;
    cfg.categories = c.categories || [];
    cfg.labels = c.labels || [];
    cfg.languages = c.languages || [];
  }

  function doLoad(force) {
    var si = SI();
    if (!si) {
      loaded = true;
      loadError = { message: 'Search is unavailable: the index module did not load.' };
      renderResults();
      return;
    }
    if (els.refresh) els.refresh.disabled = true;
    loadError = null;
    if (force) { loaded = false; renderResults(); }

    si.load({ force: !!force }).then(function () {
      threadsAll = si.filterOnly(null);
      loaded = true;
      loadError = null;
      if (els.refresh) els.refresh.disabled = false;
      syncControls();
      renderSidebar();
      renderResults();
    }, function (err) {
      if (els.refresh) els.refresh.disabled = false;
      /* api.js has already bounced an expired session to login.html; rendering
         an error under a redirect would just flash. */
      if (err && err.code === 'unauthorized') return;
      loaded = true;
      loadError = err;
      renderResults();
      toast(errText(err), 'error');
    });
  }

  function boot() {
    var api = API();
    if (!api || typeof api.call !== 'function') return;
    try {
      if (api.requireLogin && api.requireLogin() === false) return;
    } catch (e) { return; }

    try { if (UI().renderHeader) UI().renderHeader('search'); } catch (e) { /* ignore */ }

    if (!buildShell()) return;

    readUrl();
    /* Echo the resolved state straight back into the address bar (normalising
       a legacy ?lang= into ?language=) and seed the history baseline so the
       first pushState is a real step forward, not a duplicate. */
    writeUrl(false);
    lastPushedUrl = urlString();
    if (els.input) els.input.value = state.q;

    /* Bootstrap answers instantly from the localStorage cache and refreshes in
       the background; the event fires when newer config lands. Categories and
       labels are chrome — they must never gate the results. */
    try { applyBootstrap({ config: UI().bootstrapConfig() }); } catch (e) { /* ignore */ }
    window.addEventListener('clinic:bootstrap', function (ev) {
      if (ev && ev.detail) { applyBootstrap(ev.detail); syncControls(); renderSidebar(); }
    });
    if (typeof api.bootstrap === 'function') {
      api.bootstrap().then(function (b) {
        applyBootstrap(b);
        syncControls();
        renderSidebar();
      }, function () { /* chrome only — a failure here must not break search */ });
    }

    syncControls();
    renderResults();
    doLoad(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
