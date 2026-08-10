/*!
 * MScPHMxAI Coding Clinic — chat-fab.js   (owner: F9)
 * The floating "open Messages" button, bottom-right, on every content page.
 *
 *   Clinic.fab.mount()      idempotent; re-runs the gate and builds the button
 *   Clinic.fab.unmount()    removes it and every listener MOUNT added — but NOT
 *                           the 'clinic:bootstrap' gate watcher, which is owned
 *                           by the module and outlives both. See wireGate().
 *   Clinic.fab.isMounted()  -> bool
 *   Clinic.fab.reset()      forget the saved position, snap back to the default
 *   Clinic.fab.el()         -> the <button>, or null    (console + tests only)
 *
 * localStorage keys owned by this file — nothing else may write them:
 *   clinic_fab_pos    {"side":"left"|"right","top":<px from the top of the viewport>}
 *
 * =========================================================================
 * THIS FILE ADDS NO NETWORK TRAFFIC. NOT ONE REQUEST. NOT EVER.
 * =========================================================================
 * The unread count is read from Clinic.unread — get() for the value we already
 * have at mount time, and the window CustomEvent 'clinic:unread' for every
 * change after that. There is no api.call() in here and there must never be
 * one, for the arithmetic spelled out at the top of unread.js: a badge poller
 * on every content page is ~28,800 flow runs a day, which is the tenant's whole
 * daily allocation, which is SHARED WITH SIGN-IN. A decorative button is not
 * allowed to take authentication down. Read the number somebody else already
 * paid for, or show no number.
 *
 * Note that unread.js's publish() only fires 'clinic:unread' when the total
 * CHANGES, so a page that opens with 2 unread may never fire the event at all —
 * which is exactly why paint() is also called once at mount from
 * Clinic.unread.get(). Subscribing without seeding gives you a button that is
 * permanently silent until the count happens to move.
 *
 * =========================================================================
 * WHEN THE BUTTON DOES NOT EXIST — TREAT THIS AS THE NORMAL CASE
 * =========================================================================
 * HISTORY, because the comment that used to sit here is now wrong and someone
 * will read it: this file was written while config.js still said
 * MSG_URL: "PASTE_MSG_URL_HERE", so it mounted NOTHING on the live site and the
 * whole design was built around staying invisible. The URL has since been
 * pasted in (config.js is MOCK:false with a real msg flow URL), so hasMsgUrl()
 * now returns TRUE and the button DOES render for every signed-in user with
 * chat enabled. Do not read the gate below as dead code — it is live.
 *
 * The no-button paths still have to be exactly as careful, because each of them
 * is one config edit or one sign-out away, and because a tenant that has not
 * re-imported the wave-3 flows sits in precisely that state: never a greyed-out
 * button, never a dead link, never a console error — just no button.
 * The gate is shouldMount():
 *
 *   1. not on messages.html          you are already there
 *   2. api/ui/unread all loaded      a half-loaded page degrades to no button
 *   3. api.hasMsgUrl()               THE gate. false for the PASTE_ placeholder,
 *                                    true in MOCK. Raw truthiness of MSG_URL is
 *                                    not the same test — a placeholder is truthy.
 *   4. signed in                     api.getToken() is '' when signed out
 *   5. chat not switched off         see chatOff() for the exact shape of the test
 *   6. ui.featureState('messages')   'off' means messages.unread already came back
 *      is not 'off'                  "Unknown action" this session — the backend
 *                                    has never heard of chat, so neither have we
 *
 * The gate is re-run on 'clinic:bootstrap' (config can land after first paint,
 * and it can say chat_enabled=FALSE), so a button that should not be there is
 * removed rather than left behind.
 *
 * THE GATE IS TWO-WAY, and that is a bug fix rather than a nicety. It used to
 * call unmount() when the gate closed and apply() when it opened — but apply()
 * starts `if (!fab) return;`, so once the button was gone nothing could ever
 * bring it back. The real-world shape of that: the instructor switches
 * chat_enabled on in Admin, the next bootstrap lands with the new value, and
 * every open tab still shows no button until its user happens to reload. Now
 * onBootstrap() re-mounts, and mount() restores the persisted position and
 * re-seeds the badge from Clinic.unread.get(), so the button comes back exactly
 * where the user left it with the right number on it.
 * This is why the 'clinic:bootstrap' listener is NOT part of the mount/unmount
 * pair: a listener that unmount() removed could not be the thing that notices
 * the gate reopening. It is registered once, from boot() and from mount(), and
 * it is the only listener in this file that survives unmount().
 *
 * =========================================================================
 * DRAGGING
 * =========================================================================
 * Pointer Events where available, with a mouse + touch fallback for anything
 * that lacks them. On release the button snaps to the nearer vertical edge and
 * keeps its height — the iOS AssistiveTouch pattern. Two rules make it feel
 * like a button rather than a loose object:
 *
 *   - the position is CLAMPED to the viewport on every move, on release, on
 *     resize and on orientationchange, and the top clamp is the live measured
 *     bottom of the sticky #app-header, not a constant. A position saved on a
 *     1440px desktop must not strand the button off-canvas on a 375px phone,
 *     and the header is 68px on desktop but wraps taller on mobile;
 *   - movement under DRAG_SLOP px is a CLICK, anything beyond it is a drag and
 *     the trailing click is swallowed. Get this backwards and the button reads
 *     as broken: either it navigates every time you try to move it, or a clumsy
 *     tap does nothing at all.
 *
 * Dragging is mouse/touch only, on purpose. There is deliberately no keyboard
 * drag mode: the button's PURPOSE — open Messages — is fully keyboard-reachable
 * (it is a real <button>; Tab to it, Enter or Space activates it), and where a
 * decoration happens to sit on screen is not information a keyboard or screen
 * reader user is being denied. Adding an arrow-key reposition mode would put a
 * second, undiscoverable meaning on the arrow keys for no accessibility gain.
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var LS_POS = 'clinic_fab_pos';

  /* px of pointer travel below which a release is still a click. 5px is the
     figure that survives a shaky hand on a trackpad and a fat finger on glass
     without letting a deliberate 10px nudge navigate. */
  var DRAG_SLOP = 5;

  /* Must match the `left`/`top` transition in main.css §25 (.chat-fab.is-snapping).
     Only used to take the class off again once the snap has finished — if the two
     ever drift, the worst case is the class lingering harmlessly for a moment. */
  var SNAP_MS = 220;

  /* Fallbacks for when getComputedStyle cannot tell us (very old engines, or a
     stylesheet that failed to load — in which case there is nothing to see
     anyway). CSS is the source of truth for both; see main.css §25. */
  var FALLBACK_GAP = 16;
  var FALLBACK_SIZE = 56;

  var SAFE_GAP = 12;    /* smallest gap we will leave at the top/bottom edges */

  var fab = null;
  var badge = null;
  var pos = null;               /* {side:'left'|'right', top:<px>} */
  var drag = null;              /* live gesture, see onDown() */

  /* A DEADLINE, NOT A FLAG — and that is a bug fix, not a preference.
     This used to be a sticky boolean set by a real drag and cleared by the
     click it ate. The hole: a drag does not always produce a trailing click.
     'pointercancel' (the system takes the gesture over — an edge swipe, a
     scroll hand-off, a call arriving) goes through onUp with no click behind
     it, and the flag then sat there true.
     A later pointer gesture hid the damage, because onDown clears it. What did
     NOT clear it was activating the button WITHOUT a pointer — i.e. Tab + Enter
     — so the first keyboard press after an interrupted drag was silently eaten
     and the button did nothing. That lands on precisely the user the keyboard
     path exists for. Verified in the browser before and after this change.
     A real click follows pointerup in the same gesture, so a short window
     swallows the one click that must be swallowed and nothing else; anything
     later is a fresh intent and must go through. */
  var suppressClickUntil = 0;
  var SUPPRESS_MS = 400;
  var snapTimer = 0;
  var wired = false;        /* the mount()/unmount() pair of global listeners */
  var gateWired = false;    /* the 'clinic:bootstrap' watcher — module lifetime */

  /* ------------------------------------------------------------- utilities */

  function api() { return Clinic.api || {}; }
  function ui() { return Clinic.ui || {}; }
  function unread() { return Clinic.unread || {}; }

  /* localStorage throws outright in some privacy modes (Safari private, a locked
     down lab profile). A remembered button position is never worth a broken
     page, so every access is wrapped and every failure is silent. */
  function lsGet(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function lsSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* full or blocked */ }
  }
  function lsDel(key) {
    try { window.localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  function num(v, fallback) {
    var n = parseFloat(v);
    return (typeof n === 'number' && !isNaN(n)) ? n : fallback;
  }

  /* Read a CSS custom property off :root so main.css stays the single source of
     truth for the edge gap — it changes in the ≤767px media query and this must
     follow it without a second copy of the breakpoint living in JavaScript. */
  function cssVar(name, fallback) {
    try {
      var v = window.getComputedStyle(document.documentElement)
        .getPropertyValue(name);
      return num(String(v).replace('px', ''), fallback);
    } catch (e) { return fallback; }
  }

  function onMessagesPage() {
    return /(^|\/)messages\.html$/i.test(window.location.pathname || '');
  }

  /* ------------------------------------------------------------- the gate */

  /* Chat can be switched off course-wide from Admin (tbl_Config chat_enabled,
     a mixed-type wire boolean: TRUE / 'TRUE' / 'true' / 1 / '1').

     THE SHAPE OF THIS TEST IS DELIBERATE AND IT IS COPIED FROM unread.js's
     chatExplicitlyOff(), not written fresh. An ABSENT key does NOT disable the
     feature — contract §5 says every v3 field may be missing against a backend
     that has not been re-imported yet, and a bootstrap cache written before the
     config rows existed has no chat_enabled in it at all. Only a value that is
     PRESENT AND FALSY counts as "off". Reading it as "must be exactly TRUE"
     would hide the button for every user whose cached bootstrap predates the
     wave-3 import, including on a tenant where chat works perfectly.
     If you change this test, change unread.js's to match — two modules
     disagreeing about whether chat exists is how you get a nav tab with no
     button, or a button that leads to an inert page. */
  function chatOff() {
    var cfg;
    try { cfg = ui().bootstrapConfig ? ui().bootstrapConfig() : {}; } catch (e) { cfg = {}; }
    var v = cfg ? cfg.chat_enabled : undefined;
    if (v === undefined || v === null || v === '') return false;
    return typeof ui().truthy === 'function' ? !ui().truthy(v) : !v;
  }

  function shouldMount() {
    if (onMessagesPage()) return false;

    /* Degradation: if any of the three modules this file leans on failed to
       load, do nothing at all. No button, no error, no half-built widget. */
    if (typeof api().hasMsgUrl !== 'function') return false;
    if (typeof api().getToken !== 'function') return false;
    if (typeof ui().icon !== 'function') return false;
    if (typeof unread().get !== 'function') return false;

    if (!api().hasMsgUrl()) return false;
    if (!api().getToken()) return false;
    if (chatOff()) return false;

    if (typeof ui().featureState === 'function' &&
        ui().featureState('messages') === 'off') return false;

    return true;
  }

  /* --------------------------------------------------------- measurement */

  /* The `|| 0` chain at the end is not decoration. A page that is parsed while
     its tab/pane is not compositing yet can report window.innerWidth === 0 at
     DOMContentLoaded, and every clamp below then collapses to its minimum and
     parks the button in the TOP-LEFT corner — where it stays, because nothing
     re-places it until the next resize. Found exactly that way in the browser.
     So: try three sources for the viewport, and apply() refuses to write a
     position at all while all three are still zero. The 'load' listener in
     mount() is the second half of the fix — it re-applies once layout is real. */
  function metrics() {
    var doc = document.documentElement || {};
    var body = document.body || {};
    var w = (fab && fab.offsetWidth) || FALLBACK_SIZE;
    var h = (fab && fab.offsetHeight) || FALLBACK_SIZE;
    return {
      vw: window.innerWidth || doc.clientWidth || body.clientWidth || 0,
      vh: window.innerHeight || doc.clientHeight || body.clientHeight || 0,
      w: w,
      h: h,
      gap: cssVar('--fab-gap', FALLBACK_GAP)
    };
  }

  /* The header is position:sticky;top:0 with z-index 1000, so whatever the page
     scroll is it occupies the top strip of the viewport and its rect.bottom IS
     the first y the button may legally use. Measured, not assumed: --header-height
     is 68px but .app-header-inner wraps the nav onto a second row below 767px,
     and renderHeader() can run twice, so the constant is wrong roughly half the
     time on a phone. */
  function headerBottom() {
    var host = document.getElementById('app-header');
    if (!host) return 0;
    try {
      var r = host.getBoundingClientRect();
      return r.bottom > 0 ? r.bottom : 0;
    } catch (e) { return 0; }
  }

  function clampTop(top, m) {
    var min = headerBottom() + SAFE_GAP;
    var max = m.vh - m.h - SAFE_GAP;
    /* A viewport shorter than header + button + margins (a phone in landscape
       with the keyboard up) makes min > max. Under the header is worse than
       under nothing, so the bottom clamp gives way first. */
    if (max < min) return Math.max(SAFE_GAP, max);
    if (top < min) return min;
    if (top > max) return max;
    return top;
  }

  function clampLeft(left, m) {
    var min = SAFE_GAP;
    var max = m.vw - m.w - SAFE_GAP;
    if (max < min) return min;
    if (left < min) return min;
    if (left > max) return max;
    return left;
  }

  /* ------------------------------------------------------------ position */

  /* A BOUNDED STARTUP RETRY, NOT A POLLER — read the difference before you
     touch it. 'resize' and 'load' are the normal way out of the zero-viewport
     state described in metrics(), but a tab that is fully parsed while it is
     not compositing can report 0x0 with readyState already 'complete' and
     never fire either. Seen in the browser: booking.html loaded in a
     background pane, innerWidth 0, load long since past, button permanently
     invisible. So: at most RETRY_MAX attempts, RETRY_MS apart, stopping the
     instant the viewport measures — about two seconds of setTimeout in the
     worst case and none at all in the normal one. It never repeats after
     success, it issues no requests, and it cannot outlive the page. Anything
     genuinely recurring belongs in Clinic.poll, not here. */
  var RETRY_MS = 100;
  var RETRY_MAX = 20;
  var retryTimer = 0;
  var retriesLeft = RETRY_MAX;

  function scheduleRetry() {
    if (retryTimer || retriesLeft <= 0) return;
    retriesLeft--;
    retryTimer = window.setTimeout(function () {
      retryTimer = 0;
      if (fab) apply();
    }, RETRY_MS);
  }

  function defaultPos(m) {
    return { side: 'right', top: clampTop(m.vh - m.h - 24, m) };
  }

  function loadPos() {
    var raw = lsGet(LS_POS);
    if (!raw) return null;
    var o;
    try { o = JSON.parse(raw); } catch (e) { lsDel(LS_POS); return null; }
    if (!o || typeof o !== 'object') return null;
    var top = num(o.top, NaN);
    if (isNaN(top)) return null;
    /* anything that is not literally 'left' is 'right' — a corrupted blob must
       land somewhere sane rather than be thrown away */
    return { side: (o.side === 'left' ? 'left' : 'right'), top: top };
  }

  function savePos() {
    if (!pos) return;
    try {
      lsSet(LS_POS, JSON.stringify({ side: pos.side, top: Math.round(pos.top) }));
    } catch (e) { /* ignore */ }
  }

  /* Writes the position to the element AND mirrors the docked side onto <body>,
     which is what lets main.css §25 lift #toasts clear of the button only when
     the button is actually parked on the same corner as the toast stack. */
  function apply() {
    if (!fab) return;
    var m = metrics();
    /* No measurable viewport yet — see metrics(). Deciding a position now would
       clamp everything to 12,12 and strand the button in the top-left corner,
       so instead it stays visibility:hidden and the decision is deferred to the
       'load' / 'resize' listeners. The button is decorative; half a frame of
       nothing is much cheaper than a wrong placement nobody can undo. */
    if (m.vw <= 0 || m.vh <= 0) {
      fab.classList.add('is-unplaced');
      scheduleRetry();
      return;
    }
    /* First measurable paint: this is where the saved position is honoured,
       and where the default (bottom-right) is worked out from a real viewport
       rather than from zeros. */
    if (!pos) pos = loadPos() || defaultPos(m);
    fab.classList.remove('is-unplaced');
    pos.top = clampTop(pos.top, m);
    var left = (pos.side === 'left') ? m.gap : (m.vw - m.w - m.gap);
    fab.style.left = clampLeft(left, m) + 'px';
    fab.style.top = pos.top + 'px';
    var body = document.body;
    if (body && body.classList) {
      body.classList.add('has-chat-fab');
      if (pos.side === 'left') {
        body.classList.remove('chat-fab-right');
        body.classList.add('chat-fab-left');
      } else {
        body.classList.remove('chat-fab-left');
        body.classList.add('chat-fab-right');
      }
    }
  }

  /* --------------------------------------------------------------- paint */

  /* The badge is aria-hidden and the count lives on the button's aria-label
     instead. Both would be announced otherwise — "3, Messages 3 unread" — and
     of the two the label is the one that reads as a sentence.

     There is deliberately no aria-live on any of this, for the same reason
     unread.js keeps the nav badge silent (§10.9): a number that changes while
     somebody is reading a thread would interrupt them mid-sentence to announce
     a button they did not ask about. The new count is simply there, correct,
     the moment they Tab to it. */
  function paint(total) {
    if (!fab || !badge) return;
    var n = Math.max(0, parseInt(total, 10) || 0);
    if (n > 0) {
      badge.textContent = n > 9 ? '9+' : String(n);
      badge.hidden = false;
      fab.classList.add('has-unread');
      fab.setAttribute('aria-label', 'Messages, ' + n + ' unread');
    } else {
      badge.textContent = '';
      badge.hidden = true;
      fab.classList.remove('has-unread');
      fab.setAttribute('aria-label', 'Messages');
    }
  }

  function currentTotal() {
    try {
      var s = unread().get ? unread().get() : null;
      return (s && s.total) || 0;
    } catch (e) { return 0; }
  }

  /* --------------------------------------------------------------- drag */

  function pointFrom(e) {
    if (e.touches && e.touches.length) {
      return { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }
    if (e.changedTouches && e.changedTouches.length) {
      return { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
    }
    return { x: e.clientX, y: e.clientY };
  }

  function attachMove(kind) {
    if (kind === 'pointer') {
      /* setPointerCapture retargets every subsequent pointer event to the
         button, so the listeners go on the button and the gesture survives the
         cursor leaving it, entering an iframe, or the button moving out from
         under the finger. */
      fab.addEventListener('pointermove', onMove, false);
      fab.addEventListener('pointerup', onUp, false);
      fab.addEventListener('pointercancel', onUp, false);
      /* The backstop for a gesture whose end we never see. The browser releases
         capture implicitly the instant the owning pointer goes up or is
         cancelled, so losing capture while `drag` is still set means the
         gesture is over whether or not a pointerup reached us. Ordering is
         safe: on the normal path onUp() has already run detachMove() by the
         time the implicit release fires, so this listener is gone and cannot
         double-finish. */
      fab.addEventListener('lostpointercapture', onLostCapture, false);
    } else if (kind === 'mouse') {
      /* mouse has no capture, and the cursor WILL outrun a 56px button, so
         these have to be on the document */
      document.addEventListener('mousemove', onMove, false);
      document.addEventListener('mouseup', onUp, false);
    } else {
      /* Touch events are implicitly captured by their original target, so the
         button is the right host — and it has to be. Chrome treats
         touchstart/touchmove on document, window and body as PASSIVE by
         default, so a preventDefault() from a document-level listener is
         ignored with a console warning. Listening on the element keeps the
         option, though `touch-action: none` in main.css §25 is what actually
         stops the page scrolling under the drag. */
      fab.addEventListener('touchmove', onMove, false);
      fab.addEventListener('touchend', onUp, false);
      fab.addEventListener('touchcancel', onUp, false);
    }
  }

  function detachMove(kind) {
    if (kind === 'pointer') {
      fab.removeEventListener('pointermove', onMove, false);
      fab.removeEventListener('pointerup', onUp, false);
      fab.removeEventListener('pointercancel', onUp, false);
      fab.removeEventListener('lostpointercapture', onLostCapture, false);
    } else if (kind === 'mouse') {
      document.removeEventListener('mousemove', onMove, false);
      document.removeEventListener('mouseup', onUp, false);
    } else {
      fab.removeEventListener('touchmove', onMove, false);
      fab.removeEventListener('touchend', onUp, false);
      fab.removeEventListener('touchcancel', onUp, false);
    }
  }

  function onDown(e) {
    if (!fab || drag) return;
    /* right/middle button opens a context menu or pastes on Linux — not a drag */
    if ((e.type === 'mousedown' || e.type === 'pointerdown') && e.button > 0) return;
    /* A pointerdown is always followed by pointer* events; if the browser also
       synthesises mousedown afterwards we must not start a second gesture. */
    if (e.type === 'mousedown' && window.PointerEvent) return;
    if (e.type === 'touchstart' && window.PointerEvent) return;

    var p = pointFrom(e);
    var r = fab.getBoundingClientRect();
    var kind = (e.type === 'pointerdown') ? 'pointer'
      : (e.type === 'mousedown') ? 'mouse' : 'touch';

    drag = {
      kind: kind,
      x0: p.x,
      y0: p.y,
      /* grab offset — the button must not jump so its centre is under the
         finger the moment you touch it */
      dx: p.x - r.left,
      dy: p.y - r.top,
      moved: 0,
      id: (e.pointerId === undefined) ? null : e.pointerId
    };

    suppressClickUntil = 0;
    if (snapTimer) { window.clearTimeout(snapTimer); snapTimer = 0; }
    fab.classList.remove('is-snapping');
    fab.classList.add('is-dragging');

    if (kind === 'pointer' && fab.setPointerCapture) {
      try { fab.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    }
    attachMove(kind);
  }

  function onMove(e) {
    if (!drag || !fab) return;
    if (drag.id !== null && e.pointerId !== undefined && e.pointerId !== drag.id) return;

    var p = pointFrom(e);
    var mdx = p.x - drag.x0;
    var mdy = p.y - drag.y0;
    var dist = Math.sqrt(mdx * mdx + mdy * mdy);
    if (dist > drag.moved) drag.moved = dist;

    /* belt and braces next to touch-action:none — a second finger, or an engine
       that does not honour touch-action, must not scroll the page mid-drag */
    if (e.cancelable && e.preventDefault) e.preventDefault();

    var m = metrics();
    fab.style.left = clampLeft(p.x - drag.dx, m) + 'px';
    fab.style.top = clampTop(p.y - drag.dy, m) + 'px';
  }

  /* Is the pointer that OWNS the live gesture still down?
     Pointer capture is the only honest answer available synchronously: onDown()
     asked for it, and the browser drops it the moment that pointer goes up or
     is cancelled. "We never got capture" (an engine without
     setPointerCapture, or a call that threw — both are caught and ignored in
     onDown) has to resolve to FALSE, i.e. "finish the gesture". Ending a drag a
     fraction early is a nuisance; a button stuck in .is-dragging with the move
     listeners still live is broken, and there is no third gesture that clears
     it — see onUp(). */
  function ownerPointerLive(d) {
    if (!fab || !d || d.id === null) return false;
    try {
      return !!(fab.hasPointerCapture && fab.hasPointerCapture(d.id));
    } catch (err) { return false; }
  }

  /* Capture went away while a gesture was still running. Route it through the
     normal release path — onUp() reads no coordinates off the event, only
     e.pointerId, so a lostpointercapture is a perfectly good "finish". */
  function onLostCapture(e) {
    if (drag) onUp(e);
  }

  function onUp(e) {
    if (!drag || !fab) return;
    if (drag.id !== null && e.pointerId !== undefined && e.pointerId !== drag.id) {
      /* A DIFFERENT pointer released. Usually a second finger landing on the
         button mid-drag, which is trivial on glass, and this is not the end of
         OUR gesture — so while our pointer is demonstrably still down, ignore
         it exactly as before.
         WHAT THIS USED TO BE was a bare `return`, and that was the bug: it
         skipped detachMove(), so `drag` stayed set and pointermove/pointerup
         stayed wired. If the owning pointer's own release had already been
         swallowed (capture handed off, the gesture stolen by the system, a
         touch sequence that ends out of order), nothing else in this file
         cleared the state — onDown() bails while `drag` is truthy, so not even
         a fresh press recovered it — and the button stayed permanently
         "dragging": scaled, click-suppressed, following nothing.
         So: only bail out when the owner is provably still down. Otherwise
         fall through and complete the gesture. The completion path below is
         safe to run from a foreign event because it takes its position from
         fab.style.left/top, never from the event. */
      if (ownerPointerLive(drag)) return;
    }

    var d = drag;
    drag = null;
    detachMove(d.kind);
    if (d.kind === 'pointer' && d.id !== null && fab.releasePointerCapture) {
      try { fab.releasePointerCapture(d.id); } catch (err) { /* ignore */ }
    }
    fab.classList.remove('is-dragging');

    if (d.moved <= DRAG_SLOP) {
      /* A tap, not a drag. Put it back on the edge it came from — a 3px wobble
         must leave no trace — and let the click through to onClick(). */
      apply();
      return;
    }

    /* A real drag. Snap to the nearer vertical edge, keep the height. A button
       abandoned in mid-canvas looks like a bug; the edge is where a floating
       control belongs however clumsily it was thrown. */
    suppressClickUntil = Date.now() + SUPPRESS_MS;

    var m = metrics();
    var r = fab.getBoundingClientRect();
    if (!pos) pos = defaultPos(m);      /* cannot happen — .is-unplaced is not hit-testable */

    /* DO NOT REACH FOR getBoundingClientRect() HERE. IT LIES, AND IT LIES BY A
       CONSTANT, WHICH IS THE WORST KIND.
       .chat-fab.is-dragging carries `transform: scale(1.06)` and the base rule
       carries `transition: transform 160ms ease`. The class was removed four
       lines up, but a transition's value at elapsed time zero is the START
       value in every engine, so the very next synchronous rect read still
       returns the SCALED box: width 59.36 instead of 56, and a top 1.68px
       (= 56 * 0.06 / 2) above the true top, because the scale is centred.
       Feeding that top back through clampTop -> apply() -> savePos() moved the
       remembered position 1.68px up on EVERY release, and the error is
       persisted, so it accumulated: ten purely horizontal drags at 1280x800
       walked the button from top 720 to top 703 and it kept climbing across
       sessions until it hit the header clamp. Measured in the browser.
       The inline style the drag itself just wrote is the honest number — it is
       what onMove() clamped and set, untouched by any transform — and
       m.w comes from offsetWidth, which is a layout box and ignores transforms
       too. Read from those, not from the rendered rect. The rect is kept only
       as a last-resort fallback for the (impossible) case of a drag that
       exceeded DRAG_SLOP without onMove() ever writing a style. */
    var sLeft = num(fab.style.left, r.left);
    pos.side = ((sLeft + m.w / 2) < (m.vw / 2)) ? 'left' : 'right';
    pos.top = clampTop(num(fab.style.top, r.top), m);

    fab.classList.add('is-snapping');
    apply();
    savePos();

    /* One-shot, not a repeating timer — Clinic.poll owns recurring work and
       this is a single class removal 220ms after a gesture the user made. */
    snapTimer = window.setTimeout(function () {
      snapTimer = 0;
      if (fab) fab.classList.remove('is-snapping');
    }, SNAP_MS + 60);
  }

  function onClick(e) {
    /* Inside the window: this is the click the drag generated. Eat it, and
       close the window immediately so a genuine second click still lands. */
    if (suppressClickUntil && Date.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      return;
    }
    suppressClickUntil = 0;
    /* chat-panel.js turns this button into a popover; without that file the
       button does exactly what it always did. Keeping the navigation as the
       fallback rather than assuming the panel is what makes the panel additive —
       delete chat-panel.js and its <script> tag and nothing here breaks.
       toggle() so a second click closes it, which is what a floating button
       that opens a panel is expected to do. */
    if (Clinic.chatPanel && typeof Clinic.chatPanel.toggle === 'function') {
      try { Clinic.chatPanel.toggle(); return; } catch (err) { /* fall through */ }
    }
    window.location.href = 'messages.html';
  }

  /* Long-press on a touch device otherwise offers "Save image"/"Copy link" over
     the icon halfway through a drag. */
  function onContextMenu(e) {
    if (drag && e.preventDefault) e.preventDefault();
  }

  /* ---------------------------------------------------------- lifecycle */

  function onResize() {
    /* No `|| !pos` guard here: pos being null is exactly the deferred-placement
       state apply() exists to resolve, and this is the event that resolves it. */
    if (!fab) return;
    /* Any of these events means the environment changed, so the retry budget
       spent on the previous state is not evidence about this one. Without this
       reset a button that used up its 20 attempts while the tab was not
       rendering would stay invisible for the rest of the page's life. */
    retriesLeft = RETRY_MAX;
    /* Re-clamp, do not re-place: the whole point is that a top saved on a
       1440x900 desktop lands somewhere legal on a 375x667 phone instead of
       hanging 200px below the fold. apply() clamps as it writes. */
    apply();
  }

  function onUnreadEvent(e) {
    var detail = e && e.detail;
    paint(detail ? detail.total : currentTotal());
  }

  function onBootstrap() {
    /* Config landed (or was refreshed). THREE things can have changed: the
       instructor may have switched chat off, the instructor may have switched
       chat ON, and renderHeader() will have run again with a possibly
       different height, so the top clamp moved.

       Each of the three branches below is a no-op when nothing changed, which
       is what keeps this safe against a bootstrap that fires every 60s or
       twice in a row: gate closed + no button does nothing, gate open + button
       already up is a re-clamp and nothing more. There is no path here that
       unmounts and remounts in the same call, so no flicker and no loop. */
    if (!shouldMount()) {
      if (fab) unmount();
      return;
    }
    if (!fab) {
      /* THE GATE JUST REOPENED. mount() — not apply(), which begins
         `if (!fab) return;` and was the whole of D2. mount() rebuilds the
         button, apply() restores the position (in-memory first, then
         clinic_fab_pos, then the default) and paint() re-seeds the badge from
         Clinic.unread.get(), so it comes back where it was with the right
         count on it, without a reload. */
      mount();
      return;
    }
    apply();
  }

  function build() {
    var btn = document.createElement('button');
    btn.type = 'button';                 /* not 'submit' — new.html has a form */
    btn.className = 'chat-fab';
    btn.id = 'chat-fab';
    btn.setAttribute('aria-label', 'Messages');

    /* ui.js owns the icon set; this uses ui.icon() rather than pasting the path
       data so the 'comment-discussion' glyph stays one drawing in one file. It
       is sized up to 24px by CSS, not by an attribute. */
    btn.appendChild(ui().icon('comment-discussion', 'chat-fab-icon'));

    var span = document.createElement('span');
    span.className = 'chat-fab-badge';
    span.setAttribute('aria-hidden', 'true');   /* see paint() */
    span.hidden = true;
    btn.appendChild(span);

    return { btn: btn, badge: span };
  }

  /* ---- global listeners: added by mount(), removed by unmount() ------------
     EVERY handler below is a named function declared at module scope, and that
     is a requirement rather than a style choice: removeEventListener matches on
     identity, so an anonymous function passed to addEventListener can never be
     taken off again. If you add a listener here, add its mirror image to
     unwireGlobals() in the same edit.

     WHAT THIS FIXES, stated precisely because the loose version of it is
     misleading: unmount() used to remove the button and NONE of these, and it
     never cleared the `wired` latch either. The latch did stop them stacking up
     one set per cycle — that part was never broken — but it also meant they
     were registered once and then never removed for the life of the document,
     against an element that no longer existed. Every handler opens with a
     `!fab` guard so nothing misbehaved, and that is exactly the problem: silent
     debris that becomes a real leak the first time one of these handlers grows
     a closure over something bigger than a module-scope `null`, and a header
     that has always promised unmount() takes its listeners with it. Now it
     does, and the latch is cleared with them so the next mount() re-registers.
     Both functions stay latched, so mount() twice with no unmount() in between
     still cannot double-register. */
  function wireGlobals() {
    if (wired) return;
    wired = true;
    window.addEventListener('clinic:unread', onUnreadEvent, false);
    window.addEventListener('resize', onResize, false);
    window.addEventListener('orientationchange', onResize, false);
    /* 'load' is the safety net for the zero-viewport case in metrics(): by
       then the pane is composited, fonts are in and the header has its final
       height, so this is the first moment the clamps are certainly honest. */
    window.addEventListener('load', onResize, false);
    /* And the other half of it: a tab parsed in the background can be fully
       'complete' with a 0x0 viewport, and the first honest measurement only
       becomes possible when it is brought to the front. This is a free
       re-clamp — it reads the DOM and nothing else. (unread.js hangs its
       rate-limited probe off the same event; this one costs no request.) */
    document.addEventListener('visibilitychange', onResize, false);
  }

  function unwireGlobals() {
    if (!wired) return;
    wired = false;
    window.removeEventListener('clinic:unread', onUnreadEvent, false);
    window.removeEventListener('resize', onResize, false);
    window.removeEventListener('orientationchange', onResize, false);
    window.removeEventListener('load', onResize, false);
    document.removeEventListener('visibilitychange', onResize, false);
  }

  /* THE ONE LISTENER unmount() DOES NOT TOUCH — see the two-way-gate note in
     the file header. It watches the gate itself, so tying it to the mounted
     state would make the closed state permanent, which is D2 all over again.
     Registered at most once per document: from boot(), so a page that never
     passes the gate still notices when config later says it should, and from
     mount(), so a page script that calls Clinic.fab.mount() before
     DOMContentLoaded is equally covered. */
  function wireGate() {
    if (gateWired) return;
    gateWired = true;
    window.addEventListener('clinic:bootstrap', onBootstrap, false);
  }

  function mount() {
    wireGate();
    if (fab) { apply(); return true; }
    if (!shouldMount()) return false;
    if (!document.body) return false;

    /* shouldMount() proves the modules are THERE; it cannot prove they WORK.
       A ui.icon() that throws (a half-applied hotfix, a browser extension that
       has monkey-patched createElement) must leave no half-built button behind
       and must not take the caller down with it — a page script that calls
       mount() directly gets false, exactly like every other refusal. */
    var built;
    retriesLeft = RETRY_MAX;            /* a fresh mount gets a fresh budget */
    try {
      built = build();
      fab = built.btn;
      badge = built.badge;
      fab.classList.add('is-unplaced');   /* apply() takes it off once placed */
      document.body.appendChild(fab);

      /* `pos` is deliberately NOT reset here. On a first mount it is already
         null and apply() decides it (saved position, else the default). On a
         RE-mount — the gate closing and reopening, see onBootstrap() — keeping
         it is what stops the button walking back to the bottom-right corner
         mid-session. clinic_fab_pos usually covers that on its own, but
         localStorage throws outright in some privacy modes (see lsGet), and a
         user who dragged the button in Safari private browsing should not be
         punished for it. apply() re-clamps whatever it gets against the live
         viewport, so a stale top cannot strand it. */
      apply();
      paint(currentTotal());
    } catch (e) {
      unmount();
      return false;
    }

    fab.addEventListener('click', onClick, false);
    fab.addEventListener('contextmenu', onContextMenu, false);
    if (window.PointerEvent) {
      fab.addEventListener('pointerdown', onDown, false);
    } else {
      fab.addEventListener('mousedown', onDown, false);
      fab.addEventListener('touchstart', onDown, false);
    }

    wireGlobals();
    return true;
  }

  function unmount() {
    unwireGlobals();
    if (snapTimer) { window.clearTimeout(snapTimer); snapTimer = 0; }
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = 0; }
    if (drag) { detachMove(drag.kind); drag = null; }
    if (fab) {
      fab.removeEventListener('click', onClick, false);
      fab.removeEventListener('contextmenu', onContextMenu, false);
      fab.removeEventListener('pointerdown', onDown, false);
      fab.removeEventListener('mousedown', onDown, false);
      fab.removeEventListener('touchstart', onDown, false);
      fab.removeEventListener('lostpointercapture', onLostCapture, false);
      if (fab.parentNode) fab.parentNode.removeChild(fab);
    }
    fab = null;
    badge = null;
    var body = document.body;
    if (body && body.classList) {
      body.classList.remove('has-chat-fab');
      body.classList.remove('chat-fab-left');
      body.classList.remove('chat-fab-right');
    }
  }

  function reset() {
    lsDel(LS_POS);
    if (!fab) return;
    var m = metrics();
    pos = (m.vw > 0 && m.vh > 0) ? defaultPos(m) : null;
    apply();
  }

  Clinic.fab = {
    mount: mount,
    unmount: unmount,
    reset: reset,
    isMounted: function () { return !!fab; },
    el: function () { return fab; },
    LS_POS: LS_POS
  };

  /* Mount on DOMContentLoaded, never earlier. defer scripts all run BEFORE that
     event, and ui.js's safety-net renderHeader() is itself a DOMContentLoaded
     handler registered earlier in the page, so waiting is what guarantees there
     is a header to measure for the top clamp. Everything in here is wrapped:
     a throw from a half-loaded dependency must cost the page nothing, and there
     is no console.error on any path — a not-yet-configured backend has to
     produce a quiet, complete-looking page (contract §10.10). */
  function boot() {
    /* wireGate() FIRST and outside the try: a gate that is shut right now is
       the case that most needs the watcher, and mount() returns false without
       ever reaching its own wireGate() call in that case. Cheap enough to be
       unconditional — one addEventListener, no work until an event arrives. */
    try { wireGate(); } catch (e) { /* nothing left to try */ }
    try { mount(); } catch (e) { /* no button, no noise */ }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, false);
  } else {
    boot();
  }

})(window, document);
