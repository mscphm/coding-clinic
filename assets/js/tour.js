/*!
 * MScPHMxAI Coding Clinic — tour.js
 * First-run coach marks. Three short runs, each tied to the page it teaches:
 *
 *   welcome   index.html    getting around the board
 *   post      new.html      writing a question that can be answered
 *   book      booking.html  taking a clinic slot
 *
 *   Clinic.tour.available()   -> bool   is there anything to offer this user
 *   Clinic.tour.open(key)     start a run here, or go to its page and run it
 *   Clinic.tour.toggleMenu()  the "?" button in the header calls this
 *   Clinic.tour.runs()        -> [{key,label,page,seen}]   (menu + console)
 *
 * =========================================================================
 * THIS FILE ADDS NO NETWORK TRAFFIC. NOT ONE REQUEST.
 * =========================================================================
 * Same arithmetic as chat-fab.js: a poller on every content page is ~28,800
 * flow runs a day, which is the tenant's whole daily allocation, shared with
 * sign-in. Whether a student has seen a walkthrough is worth exactly zero
 * flow runs, so it lives in localStorage. The cost of that choice is that a
 * second device replays the run once — which is 30 seconds and has a Skip
 * button, and is a far better trade than a workbook column, a flow edit and
 * a package re-import for a boolean.
 *
 * WHY COACH MARKS AND NOT A SLIDESHOW
 * Because the marks point at the real control. The only three that carry a
 * clip are the ones showing a before-and-after you cannot point at: markdown
 * rendering, a screenshot landing in the tray, and what the slot colours
 * mean.
 *
 * WHY EVERY RUN WAITS
 * Live reads take 4-40s. At first paint index.html is a spinner, and the
 * whole of booking.html is server data. A mark fired on arrival would ring
 * an empty skeleton, so each run declares its anchors and does not start
 * until they are in the DOM. If they never arrive the run stays silent —
 * a walkthrough that never appears is better than one pointing at nothing.
 *
 * localStorage keys owned by this file — nothing else may write them:
 *   clinic_tour_seen   {"welcome":1,"post":1,"book":1}   version per run
 */
(function () {
  'use strict';

  var Clinic = (window.Clinic = window.Clinic || {});
  var tour = (Clinic.tour = Clinic.tour || {});

  /* Bump this to replay every run once for everybody. It is the whole
     re-broadcast mechanism: no backend, no import, one integer. */
  var VERSION = 1;
  var LS_SEEN = 'clinic_tour_seen';
  var WAIT_MS = 45000;            /* give up quietly after the slowest read */

  /* =====================================================================
     THE RUNS

     `sel` is a real selector on that page — verified against the markup and
     against what index.js / new.js / booking.js build at runtime.
     `soft: true` means skip this mark if the element is absent rather than
     hold the whole run up: the FAB is feature-gated, and the slot grid is
     missing entirely in a week with nothing published.
     ===================================================================== */
  var RUNS = [
    {
      key: 'welcome', label: 'Getting around', page: 'index',
      steps: [
        { sel: '.page-head h1', title: 'This is the board',
          text: 'Every question in the cohort lives here. One question per thread — ' +
                'three problems means three threads.' },
        { sel: '.page-head .btn-primary', title: 'Start a question here',
          text: 'This button is on every page of the board.' },
        { sel: '.chat-fab', round: true, soft: true, title: 'Messages',
          text: 'Your direct line. It follows you across pages and shows a badge ' +
                'when something is waiting.' },
        { sel: '#tour-help', round: true, soft: true, title: 'Lost? Come back here',
          text: 'Any of these walkthroughs can be replayed from this button, any time.' }
      ]
    },
    {
      key: 'post', label: 'How to post', page: 'new',
      steps: [
        { sel: '#title', title: 'Say what is actually wrong',
          text: '"Pandas merge drops rows" gets read. "Help please" does not.' },
        { sel: '#category', title: 'Pick a category',
          text: 'It decides who sees your question first.' },
        { sel: '.md-toolbar', title: 'Headings and code fences',
          text: 'Type ### for a heading and wrap code in ```python. Your indentation ' +
                'survives and the syntax gets coloured. These buttons do both for you.',
          clip: 'md', loop: 8 },
        { sel: '.md-tool-image', soft: true, title: 'Add a screenshot',
          text: 'Paste an image straight into the box, drag one on top of it, or use ' +
                'this button. A picture of the actual error beats describing it.',
          clip: 'img', loop: 7.5 },
        { sel: '#submit', title: 'Post it',
          text: 'It goes on the board straight away, and anyone in the cohort can answer.' }
      ]
    },
    {
      /* Everything here is present the moment booking.js has rendered. The
         thread picker deliberately is NOT in this list: booking.js only
         builds #bk-thread once a slot is selected, so a mark aimed at it
         would point at nothing. Its rule is folded into the first step. */
      key: 'book', label: 'How to book', page: 'booking',
      steps: [
        { sel: '.page-head h1', title: 'Bookings hang off a thread',
          text: 'Every slot is attached to one of your own questions, so it gets read ' +
                'before you arrive. No thread yet? Post one first.' },
        { sel: '.slot-grid', soft: true, title: 'Pick an open slot',
          text: 'Twenty minutes, one to one. Struck-through slots are taken and dashed ' +
                'ones are closed. Choosing one opens a short form where you say which ' +
                'thread it is about.',
          clip: 'slots', loop: 6.5 },
        { sel: '.cutoff-note', soft: true, title: 'One booking at a time',
          text: 'Cancel yours if plans change — it frees the slot for someone else.' }
      ]
    }
  ];

  function byKey(k) {
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].key === k) return RUNS[i];
    return null;
  }

  /* =====================================================================
     Which page is this
     ===================================================================== */
  function pageName() {
    var p = String(location.pathname || '');
    var f = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
    if (!f || f === 'index.html') return 'index';
    return f.replace(/\.html$/, '');
  }

  /* =====================================================================
     HAS THIS STUDENT SEEN IT?

     One key, a version per run, so finishing one does not silence the
     others and a student who never books never meets the booking marks.

     Two rules, both easy to get wrong:

       1. Skip counts as seen. Somebody who skips has decided. If only the
          final "Done" wrote the flag the marks would return on every visit,
          which is the single fastest way to make people hate a site. Skip,
          Esc and Done all leave through the same function.

       2. The fallback order is about REACHABILITY, not emptiness. If
          localStorage answers at all — even with null — that answer is the
          truth. Letting the in-memory copy speak for an empty-but-readable
          store would resurrect cleared flags and silence the runs for good.
          `mem` is consulted only when both stores actually throw, which is
          a private window refusing writes. Worst case a run repeats once
          per session; never once per page load.
     ===================================================================== */
  var mem = {};

  function parse(raw) {
    if (raw === null) return {};
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }
  function readSeen() {
    try { return parse(localStorage.getItem(LS_SEEN)); } catch (e) { /* blocked */ }
    try { return parse(sessionStorage.getItem(LS_SEEN)); } catch (e) { /* blocked */ }
    return mem;
  }
  function markSeen(key) {
    if (!key) return;
    var all = readSeen();
    all[key] = VERSION;
    mem = all;
    var s = JSON.stringify(all);
    try { localStorage.setItem(LS_SEEN, s); return; } catch (e) { /* blocked */ }
    try { sessionStorage.setItem(LS_SEEN, s); } catch (e) { /* blocked */ }
  }
  function isSeen(key) { return (readSeen()[key] || 0) >= VERSION; }

  /* =====================================================================
     Who gets this

     Signed in, and not the instructor — every line of copy is written to a
     student and talks about "the instructor" in the third person. The
     instructor can still replay any run from the "?" button.
     ===================================================================== */
  function signedIn() {
    try { return !!localStorage.getItem('clinic_token'); } catch (e) { return false; }
  }
  function isStudent() {
    var ui = Clinic.ui;
    if (ui && typeof ui.isInstructor === 'function') { try { return !ui.isInstructor(); } catch (e) { /* fall through */ } }
    return true;
  }

  /* =====================================================================
     Small DOM helpers (this file does not depend on ui.js being loaded)
     ===================================================================== */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* ``` and ### are the two things this tour keeps saying. Escape first,
     then dress them, so nothing in the copy can inject markup. */
  function fmt(s) {
    return esc(s)
      .replace(/```python/g, '<code>```python</code>')
      .replace(/###/g, '<code>###</code>');
  }

  /* Wait until the run's hard anchors exist. A MutationObserver catches the
     render the instant it lands; the interval is the belt-and-braces for a
     node that appears without mutating body's subtree in an observed way.

     GRACE. Hard anchors going up does NOT mean the page has finished. The
     header is drawn when a page script calls ui.renderHeader(), and the FAB
     is mounted by chat-fab.js, which is the last script on the page — both
     land after DOMContentLoaded, i.e. after this file has already decided
     the run can begin. Filtering the optional steps at that moment silently
     dropped two of the four Welcome marks. So once the hard anchors are up,
     hold briefly for the optional ones and only then settle. They may of
     course never come — the FAB is feature-gated — hence a short cap rather
     than another wait. */
  var SOFT_GRACE_MS = 1500;

  function waitFor(run, done) {
    function have(soft) {
      for (var i = 0; i < run.steps.length; i++) {
        var s = run.steps[i];
        if (!!s.soft === !!soft && !document.querySelector(s.sel)) return false;
      }
      return true;
    }
    var obs = null, poll = null, timer = null, grace = null, settled = false;

    function stop(ok) {
      if (settled) return;
      settled = true;
      if (obs) obs.disconnect();
      if (poll) clearInterval(poll);
      if (timer) clearTimeout(timer);
      if (grace) clearTimeout(grace);
      done(ok);
    }
    function softSettle() {
      if (grace) return;                       /* already counting down */
      if (have(true)) { stop(true); return; }  /* everything is up */
      grace = setTimeout(function () { stop(true); }, SOFT_GRACE_MS);
    }
    function check() {
      if (!have(false)) return;
      if (have(true)) { stop(true); return; }
      softSettle();
    }

    check();
    if (settled) return;

    if (window.MutationObserver) {
      obs = new MutationObserver(check);
      obs.observe(document.body, { childList: true, subtree: true });
    }
    poll = setInterval(check, 400);
    timer = setTimeout(function () { stop(false); }, WAIT_MS);
  }

  /* =====================================================================
     The clips. Three, only where pointing at the real thing cannot show a
     before-and-after. Markup is built once, on first use.
     ===================================================================== */
  var CLIPS = {
    md:
      '<div class="tour-clip-md">' +
        '<div class="tour-clip-raw">' +
          '<span class="tk-h">###</span> What I tried<br>' +
          '<span class="tk-h">```python</span><br>' +
          'out = df.merge(ref, on="id")<br>' +
          '<span class="tk-h">```</span>' +
        '</div>' +
        '<div class="tour-clip-out">' +
          '<p class="tour-clip-h">What I tried</p>' +
          '<pre class="tour-clip-pre"><span class="tk-f">out</span> = df.' +
            '<span class="tk-f">merge</span>(ref, <span class="tk-k">on</span>=' +
            '<span class="tk-s">"id"</span>)</pre>' +
        '</div>' +
      '</div>',
    img:
      '<div class="tour-clip-img">' +
        '<div class="tour-clip-zone">paste or drop</div>' +
        '<div class="tour-clip-shot">error.png</div>' +
        '<div class="tour-clip-tray"></div>' +
      '</div>',
    slots:
      '<div class="tour-clip-slots">' +
        '<div class="tour-clip-row"><span class="tcs">10:00</span>' +
          '<span class="tcs t">10:30</span><span class="tcs c">11:00</span></div>' +
        '<div class="tour-clip-row"><span class="tcs t">14:00</span>' +
          '<span class="tcs p">14:30</span><span class="tcs">15:00</span></div>' +
        '<div class="tour-clip-key">' +
          '<span><i class="k-open"></i>open</span>' +
          '<span><i class="k-taken"></i>taken</span>' +
          '<span><i class="k-closed"></i>closed</span>' +
        '</div>' +
      '</div>'
  };

  /* =====================================================================
     The overlay
     ===================================================================== */
  var root = null, hole = null, pop = null, arrow = null, media = null;
  var titleEl = null, textEl = null, dotsEl = null, nextEl = null, skipEl = null;
  var barEl = null, secsEl = null;
  var run = null, at = 0, steps = [];

  function build() {
    if (root) return;
    root = el('div', 'tour-root');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-labelledby', 'tour-step-title');

    hole = el('div', 'tour-hole');
    pop = el('div', 'tour-pop');
    arrow = el('span', 'tour-arrow');

    media = el('div', 'tour-media');
    var loop = el('div', 'tour-loop');
    loop.setAttribute('aria-hidden', 'true');
    loop.innerHTML =
      '<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M8 2.5a5.5 5.5 0 1 0 5.24 3.83.75.75 0 0 1 1.43-.46A7 7 0 1 1 8 1a.75.75 0 0 1 0 1.5Z"/>' +
      '<path d="M8.72.22a.75.75 0 0 0-1.06 1.06l1.22 1.22-1.22 1.22a.75.75 0 1 0 1.06 1.06l1.75-1.75a.75.75 0 0 0 0-1.06Z"/>' +
      '</svg><span class="tour-loop-on">loops <b></b></span>' +
      '<span class="tour-loop-off">still</span>';
    secsEl = loop.querySelector('b');
    var prog = el('div', 'tour-prog');
    prog.setAttribute('aria-hidden', 'true');
    barEl = el('i');
    prog.appendChild(barEl);
    media.appendChild(loop);
    media.appendChild(prog);

    var inner = el('div', 'tour-pop-in');
    titleEl = el('h3', 'tour-pop-title');
    titleEl.id = 'tour-step-title';
    textEl = el('p', 'tour-pop-text');
    inner.appendChild(titleEl);
    inner.appendChild(textEl);

    var foot = el('div', 'tour-pop-foot');
    dotsEl = el('div', 'tour-dots');
    var nav = el('div', 'tour-nav');
    skipEl = el('button', 'tour-skip', 'Skip');
    skipEl.type = 'button';
    nextEl = el('button', 'btn btn-sm btn-primary', 'Next');
    nextEl.type = 'button';
    nav.appendChild(skipEl);
    nav.appendChild(nextEl);
    foot.appendChild(dotsEl);
    foot.appendChild(nav);

    pop.appendChild(arrow);
    pop.appendChild(media);
    pop.appendChild(inner);
    pop.appendChild(foot);
    root.appendChild(hole);
    root.appendChild(pop);
    document.body.appendChild(root);

    /* Both guard on `run`. Without it a second click landing after the last
       one — a double tap, or Enter still held on the focused button —
       throws and leaves the dimmer stuck over the page. */
    nextEl.addEventListener('click', function () {
      if (!run) return;
      if (at === steps.length - 1) finish(); else { at++; place(); }
    });
    skipEl.addEventListener('click', function () { if (run) finish(); });
    window.addEventListener('resize', function () { if (run) place(); });
    window.addEventListener('scroll', function () { if (run) place(); }, true);
  }

  function place() {
    var step = steps[at];
    var t = document.querySelector(step.sel);
    if (!t) { if (at === steps.length - 1) { finish(); } else { at++; place(); } return; }

    try { t.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { /* old browser */ }
    var r = t.getBoundingClientRect(), pad = 6;

    hole.className = 'tour-hole' + (step.round ? ' is-round' : '');
    hole.style.left = (r.left - pad) + 'px';
    hole.style.top = (r.top - pad) + 'px';
    hole.style.width = (r.width + pad * 2) + 'px';
    hole.style.height = (r.height + pad * 2) + 'px';

    /* content first, so the popover is measured at its real height */
    pop.classList.toggle('has-media', !!step.clip);
    if (step.clip) {
      if (media.getAttribute('data-clip') !== step.clip) {
        var keep = media.querySelector('.tour-loop').outerHTML +
                   media.querySelector('.tour-prog').outerHTML;
        media.innerHTML = CLIPS[step.clip] + keep;
        media.setAttribute('data-clip', step.clip);
        secsEl = media.querySelector('.tour-loop b');
        barEl = media.querySelector('.tour-prog i');
      }
      media.style.setProperty('--tour-loop', step.loop + 's');
      if (secsEl) secsEl.textContent = step.loop + 's';
      if (barEl) {                    /* restart the sweep with the clip */
        barEl.style.animation = 'none';
        void barEl.offsetWidth;
        barEl.style.animation = '';
      }
    }

    titleEl.textContent = step.title;
    textEl.innerHTML = fmt(step.text);

    dotsEl.innerHTML = '';
    for (var i = 0; i < steps.length; i++) {
      dotsEl.appendChild(el('span', 'tour-dot' + (i === at ? ' is-on' : '')));
    }
    nextEl.textContent = at === steps.length - 1 ? 'Done' : 'Next';

    var pw = pop.offsetWidth, ph = pop.offsetHeight, gap = 14;
    var below = r.bottom + gap + ph <= window.innerHeight - 8;
    pop.classList.toggle('is-below', below);
    pop.classList.toggle('is-above', !below);
    var top = below ? r.bottom + gap : r.top - ph - gap;
    var left = r.left + r.width / 2 - pw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    pop.style.top = Math.max(8, Math.min(top, window.innerHeight - ph - 8)) + 'px';
    pop.style.left = left + 'px';

    /* the arrow tracks the target, not the popover's centre */
    arrow.style.left = Math.max(12, Math.min(r.left + r.width / 2 - left - 5.5, pw - 23)) + 'px';
  }

  function start(r) {
    build();
    run = r;
    steps = r.steps.filter(function (s) { return !s.soft || document.querySelector(s.sel); });
    if (!steps.length) { run = null; return; }
    at = 0;
    root.classList.add('is-open');
    place();
    trap();
  }

  /* Every way out lands here: one exit, one write, no way to leave a run
     without it being recorded. */
  function finish() {
    if (run) markSeen(run.key);
    run = null;
    steps = [];
    if (root) root.classList.remove('is-open');
    untrap();
    paintMenu();
  }

  /* ui.js's confirmModal has Esc, backdrop dismiss and focus restore, but
     Tab still walks out into the page behind it. Written here rather than
     inherited, because this dialog sits over a page the student can see. */
  var trapped = false, restore = null;
  function onKey(ev) {
    if (!trapped || !run) return;
    if (ev.key === 'Escape') { ev.preventDefault(); finish(); return; }
    if (ev.key === 'ArrowRight' && at < steps.length - 1) { ev.preventDefault(); at++; place(); return; }
    if (ev.key === 'ArrowLeft' && at > 0) { ev.preventDefault(); at--; place(); return; }
    if (ev.key !== 'Tab') return;
    if (ev.shiftKey && document.activeElement === skipEl) { ev.preventDefault(); nextEl.focus(); }
    else if (!ev.shiftKey && document.activeElement === nextEl) { ev.preventDefault(); skipEl.focus(); }
  }
  function trap() {
    if (!trapped) restore = document.activeElement;
    trapped = true;
    document.addEventListener('keydown', onKey, true);
    try { nextEl.focus(); } catch (e) { /* ignore */ }
  }
  function untrap() {
    trapped = false;
    document.removeEventListener('keydown', onKey, true);
    if (restore && restore.focus) { try { restore.focus(); } catch (e) { /* ignore */ } }
  }

  /* =====================================================================
     The "?" menu. ui.js puts the button in the header; the list is built
     here, on first click, so header rendering never depends on this file
     having finished.
     ===================================================================== */
  var menu = null;

  function menuHost() {
    var btn = document.getElementById('tour-help');
    return btn ? btn.parentNode : null;
  }
  function buildMenu() {
    var host = menuHost();
    if (!host || menu && menu.parentNode === host) return;
    menu = el('div', 'tour-menu');
    menu.setAttribute('role', 'menu');
    menu.appendChild(el('div', 'tour-menu-head', 'Replay a walkthrough'));
    RUNS.forEach(function (r, n) {
      var b = el('button', 'tour-menu-item');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.appendChild(el('b', null, String(n + 1)));
      b.appendChild(el('span', null, r.label));
      b.appendChild(el('i', 'tour-menu-tick'));
      b.addEventListener('click', function () { setMenu(false); tour.open(r.key); });
      menu.appendChild(b);
    });
    host.appendChild(menu);
    paintMenu();
  }
  function paintMenu() {
    if (!menu) return;
    var items = menu.querySelectorAll('.tour-menu-item');
    for (var i = 0; i < items.length && i < RUNS.length; i++) {
      items[i].querySelector('.tour-menu-tick').textContent = isSeen(RUNS[i].key) ? 'done' : '';
    }
  }
  function setMenu(open) {
    var btn = document.getElementById('tour-help');
    if (menu) menu.classList.toggle('is-open', !!open);
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }
  document.addEventListener('click', function (ev) {
    if (menu && menu.classList.contains('is-open') && !menu.contains(ev.target)) setMenu(false);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && menu && menu.classList.contains('is-open') && !run) {
      setMenu(false);
      var btn = document.getElementById('tour-help');
      if (btn && btn.focus) { try { btn.focus(); } catch (e) { /* ignore */ } }
    }
  });

  /* =====================================================================
     Public API
     ===================================================================== */
  tour.available = function () { return signedIn(); };

  tour.runs = function () {
    return RUNS.map(function (r) {
      return { key: r.key, label: r.label, page: r.page, seen: isSeen(r.key) };
    });
  };

  tour.toggleMenu = function () {
    buildMenu();
    setMenu(!(menu && menu.classList.contains('is-open')));
  };

  /* Open a run. On its own page, wait for the anchors and go. Anywhere
     else, navigate there with ?tour=<key> — a coach mark is worthless on
     a page that does not contain the thing it points at. */
  tour.open = function (key) {
    var r = byKey(key);
    if (!r) return;
    if (run) finish();
    if (r.page !== pageName()) {
      location.href = r.page + '.html?tour=' + encodeURIComponent(r.key);
      return;
    }
    waitFor(r, function (ok) { if (ok) start(r); });
  };

  /* =====================================================================
     Auto-start

     Only the run that belongs to this page, only for a signed-in student,
     only while unseen — and only once its anchors are on screen. ?tour=
     overrides the seen check so the menu can send you here to replay.
     ===================================================================== */
  function boot() {
    var here = pageName();
    var forced = '';
    try { forced = new URLSearchParams(location.search).get('tour') || ''; } catch (e) { forced = ''; }

    if (forced) {
      var f = byKey(forced);
      if (f && f.page === here) { waitFor(f, function (ok) { if (ok) start(f); }); return; }
    }
    if (!signedIn() || !isStudent()) return;

    for (var i = 0; i < RUNS.length; i++) {
      if (RUNS[i].page === here && !isSeen(RUNS[i].key)) {
        (function (r) { waitFor(r, function (ok) { if (ok) start(r); }); })(RUNS[i]);
        return;
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
