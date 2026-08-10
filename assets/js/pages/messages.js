/*!
 * NUS Coding Clinic — messages.html   (owner: F4)
 * Direct messages between a student and the instructor. Contract §10.7, §10.8,
 * §10.9; D1.
 *
 * Mounts on #messages-main (F1 ships it EMPTY, §8.5) and builds everything
 * beneath: .msg-layout > .msg-pane-list + .msg-pane-thread.
 *
 * ===========================================================================
 * THE CENTRAL DESIGN PROBLEM: THE ~30 SECOND WRITE-VISIBILITY LAG
 * ===========================================================================
 * The backend is an Excel workbook driven by Power Automate. A row written by
 * AddRowV2 is NOT readable by a subsequent GetItems for up to about half a
 * minute. So a message you just sent will not come back from messages.get for
 * up to 30 seconds, and messages.send has a real history of returning HTTP 502
 * while having actually succeeded (slots.book did exactly that).
 *
 * Everything awkward in this file follows from those two facts:
 *
 *   - We render the message optimistically the instant it is typed, in a
 *     visibly PENDING state, and keep it in pending[] until the server echoes
 *     it back. It is also mirrored into sessionStorage, so a refresh in the
 *     middle of the lag does not silently lose a message that was actually
 *     delivered.
 *   - Reconciliation matches on client_msg_id, NEVER on body text. Two
 *     identical "thanks!" messages are both legitimate and must both survive.
 *     client_msg_id is the entire reason that column exists.
 *   - The Retry affordance is SUPPRESSED (not disabled - not rendered at all)
 *     until the pending entry is 45 s old. This client-side rule, not the
 *     flow's idempotency filter, is what actually prevents a double-post: the
 *     flow checks for an existing client_msg_id by READING tbl_Messages, and
 *     that read is subject to the same ~30 s lag, so a row written three
 *     seconds ago by an attempt that 502'd is not findable yet. The window in
 *     which the flow-side check is blind is exactly the window in which a human
 *     jabs Retry. Browser state is not lagged; that is why the guarantee lives
 *     here. Both halves are required, neither alone is sufficient.
 *   - After 180 s with no echo the bubble says "Not delivered" honestly, with
 *     Retry and Copy text. It is NEVER auto-retried: a 502-that-succeeded would
 *     double-post, so the human decides.
 *
 * PRIVACY, NON-NEGOTIABLE (§4.3, §10.8)
 * The flow returns only conversations the caller participates in. There is
 * therefore NO code path in this file that filters a conversation out of a
 * rendered payload - a reviewer must be able to confirm that by the absence of
 * one. The instructor's name box is a DISPLAY filter that §10.8 explicitly
 * asks for: every conversation from the payload is still built into the DOM and
 * only [hidden] is toggled, so even that is a hide, not a filter.
 *
 * COST (§10.8, R1/R2)
 *   conversation poller  messages.get  3 Excel calls/tick (4 on first open),
 *                                      interval = config.messages_poll_seconds
 *                                      (default 90 s), suspended while hidden
 *   list poller          messages.list 4 Excel calls/tick, 180 s, INSTRUCTOR
 *                                      ONLY - a student's list has one row and
 *                                      the open conversation already covers it
 * Clinic.unread.stop() is called at module load so this page never issues an
 * overlapping messages.unread on top of those two.
 */
(function (window, document) {
  'use strict';

  var Clinic = window.Clinic || {};
  var api = Clinic.api;
  var ui = Clinic.ui || {};

  /* On THIS page the two pollers below own the counts. Called at module
     execution time, which is before DOMContentLoaded, so unread.js's own
     auto-start never fires here. (Defer scripts all run to completion before
     DOMContentLoaded - that ordering is the whole mechanism.) */
  if (Clinic.unread && typeof Clinic.unread.stop === 'function') {
    try { Clinic.unread.stop(); } catch (e) { /* ignore */ }
  }

  var PENDING_KEY = 'clinic_msg_pending';
  var RETRY_SUPPRESS_MS = 45000;      /* §10.7 step 2 */
  var EXPIRY_MS = 180000;             /* §10.7 step 5 */
  var PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  var LIST_POLL_MS = 180000;          /* §10.8 */
  var SINCE_SLACK_MS = 1000;          /* see pollSince() */
  var MAX_BODY = 4000;                /* mirrors the flow's guard, §4.3 */
  var NARROW_QUERY = '(max-width: 767px)';

  var PRIVACY_TEXT =
    'The instructor can see who you are here. To stay anonymous, post on the ' +
    'board with Post anonymously ticked instead.';

  var state = {
    me: null,
    instructor: false,
    ready: false,
    conversations: [],        /* the payload, verbatim. Never filtered. */
    filterText: '',
    chatEnabled: true,
    conversationId: '',       /* '' none open, 'new' composing a first message */
    other: null,
    messages: [],
    seenIds: {},
    newestAt: '',
    lastDayKey: '',
    pending: [],
    sending: false,
    convErrors: 0,
    lastConvId: ''
  };

  var nodes = {};             /* long-lived DOM references */
  var convPoller = null;
  var listPoller = null;
  var pendingTimer = null;
  var uploadDetach = null;
  var mql = null;

  /* ====================================================================== *
     small helpers — deliberately local, this file never sets innerHTML
   * ====================================================================== */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

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
    if (typeof ui.toast === 'function') {
      try { ui.toast(msg, type); } catch (e) { /* ignore */ }
    }
  }

  function errMsg(e, fallback) {
    return (e && (e.message || e.error)) || fallback;
  }

  function isArray(v) {
    return Object.prototype.toString.call(v) === '[object Array]';
  }

  function parseIso(v) {
    if (!v) return 0;
    var t = Date.parse(String(v));
    return isNaN(t) ? 0 : t;
  }

  /* Never write a new date formatter (§8.3 rule 6) — these are SGT-fixed. */
  function fmtTime(iso) {
    return (typeof ui.fmtTime === 'function') ? ui.fmtTime(iso) : '';
  }
  function fmtDayDate(iso) {
    return (typeof ui.fmtDayDate === 'function') ? ui.fmtDayDate(iso) : '';
  }
  function relTime(iso) {
    return (typeof ui.relTime === 'function') ? ui.relTime(iso) : '';
  }

  function isNarrow() {
    if (mql) return !!mql.matches;
    return (window.innerWidth || 1024) <= 767;
  }

  function ssGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (e) { return null; }
  }
  function ssSet(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (e) { /* ignore */ }
  }

  function isUnknown(err) {
    try {
      if (api && typeof api.isUnknownAction === 'function' && api.isUnknownAction(err)) return true;
      if (typeof ui.isUnknownAction === 'function' && ui.isUnknownAction(err)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  /* ====================================================================== *
     who am I
   * ====================================================================== */

  function currentUser() {
    try {
      if (api && typeof api.getUser === 'function') {
        var u = api.getUser();
        if (u) return u;
      }
    } catch (e) { /* ignore */ }
    if (typeof ui.currentUser === 'function') {
      try { return ui.currentUser(); } catch (e) { /* ignore */ } }
    return null;
  }

  /* The msg flow's role_eff_m does NOT read tbl_Users.role — it can only see
     admin_emails and instructor_user_id (R17's fail-closed limitation, faithfully
     reproduced by the mock). So test all three signals and take the union: the
     cost of getting this wrong is only cosmetic here (which pane auto-opens,
     whether the 180 s list poller runs), because every authorisation decision
     is made flow-side on ITS notion of the role, never on this one. */
  function computeInstructor(me) {
    if (!me || !me.user_id) return false;
    try {
      if (typeof ui.instructorUserId === 'function' && ui.instructorUserId() === me.user_id) return true;
      if (typeof ui.instructorIds === 'function' && ui.instructorIds().indexOf(me.user_id) !== -1) return true;
    } catch (e) { /* ignore */ }
    return String(me.role || '').toLowerCase() === 'instructor';
  }

  /* ====================================================================== *
     pending[] persistence  (§10.7 step 1)
     sessionStorage, keyed by conversation id, so a refresh mid-lag does not
     silently lose a message that the server may well have stored.
   * ====================================================================== */

  function pendingStoreRead() {
    var raw = ssGet(PENDING_KEY);
    if (!raw) return {};
    try {
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object' && !isArray(obj)) ? obj : {};
    } catch (e) { return {}; }
  }

  function pendingKey() {
    return state.conversationId || 'new';
  }

  function pendingSave() {
    var store = pendingStoreRead();
    var now = Date.now();
    var keep = [];
    for (var i = 0; i < state.pending.length; i++) {
      var p = state.pending[i];
      if ((now - p.first_attempt_at) > PENDING_MAX_AGE_MS) continue;
      keep.push({
        client_msg_id: p.client_msg_id,
        body: p.body,
        created_at_local: p.created_at_local,
        first_attempt_at: p.first_attempt_at,
        state: p.state,
        message_id: p.message_id || '',
        error: p.error || ''
      });
    }
    if (keep.length) store[pendingKey()] = keep;
    else delete store[pendingKey()];
    try { ssSet(PENDING_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
  }

  function pendingLoad(cid) {
    var store = pendingStoreRead();
    var rows = store[cid || 'new'];
    var out = [];
    if (!isArray(rows)) return out;
    var now = Date.now();
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || {};
      if (!r.client_msg_id) continue;
      if ((now - (r.first_attempt_at || 0)) > PENDING_MAX_AGE_MS) continue;
      out.push({
        client_msg_id: String(r.client_msg_id),
        body: String(r.body || ''),
        created_at_local: r.created_at_local || new Date(r.first_attempt_at || now).toISOString(),
        /* first_attempt_at is set ONCE, on the first attempt, and is never
           updated by a retry — which is exactly why it has to survive the
           refresh, or the 45 s suppression would reset itself. */
        first_attempt_at: r.first_attempt_at || now,
        state: r.state === 'failed' ? 'failed' : (r.state === 'sent' ? 'sent' : 'pending'),
        message_id: r.message_id || '',
        error: r.error || '',
        node: null
      });
    }
    return out;
  }

  function pendingByClientId(cmid) {
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i].client_msg_id === cmid) return state.pending[i];
    }
    return null;
  }

  function pendingRemove(entry) {
    for (var i = 0; i < state.pending.length; i++) {
      if (state.pending[i] === entry) { state.pending.splice(i, 1); break; }
    }
    pendingSave();
    schedulePendingTick();
  }

  /* One timer for the whole page, re-armed to the EARLIEST interesting deadline.
     setTimeout, not setInterval: §8.3 rule 5 bans recurring intervals outside
     Clinic.poll, and these are one-shot state transitions (reveal Retry at 45 s,
     flip to "Not delivered" at 180 s), not recurring work. */
  function schedulePendingTick() {
    if (pendingTimer !== null) { window.clearTimeout(pendingTimer); pendingTimer = null; }
    var now = Date.now();
    var next = 0;
    for (var i = 0; i < state.pending.length; i++) {
      var p = state.pending[i];
      var due;
      if (p.state === 'failed') due = p.first_attempt_at + RETRY_SUPPRESS_MS;
      else due = p.first_attempt_at + EXPIRY_MS;
      if (due > now && (!next || due < next)) next = due;
    }
    if (!next) return;
    pendingTimer = window.setTimeout(function () {
      pendingTimer = null;
      expirePending();
      redrawPending();
      schedulePendingTick();
    }, Math.max(500, next - now) + 250);
  }

  function expirePending() {
    var now = Date.now();
    for (var i = 0; i < state.pending.length; i++) {
      var p = state.pending[i];
      if (p.state !== 'failed' && (now - p.first_attempt_at) >= EXPIRY_MS) {
        /* No server echo after three minutes. Say so plainly rather than
           spinning forever or dropping it on the floor. */
        p.state = 'failed';
        p.error = 'Not delivered.';
      }
    }
    pendingSave();
  }

  function redrawPending() {
    for (var i = 0; i < state.pending.length; i++) {
      var p = state.pending[i];
      if (p.node) fillPendingBubble(p.node, p);
    }
  }

  /* ====================================================================== *
     page chrome
   * ====================================================================== */

  function main() { return document.getElementById('messages-main'); }

  function showFatal(title, message, retry) {
    var host = main();
    if (!host) return;
    clear(host);
    var box = el('div', 'empty-state mt-16');
    box.appendChild(iconEl('mail'));
    box.appendChild(el('h3', '', title));
    box.appendChild(el('p', '', message));
    if (retry) {
      var btn = el('button', 'btn btn-sm mt-8', 'Try again');
      btn.type = 'button';
      btn.addEventListener('click', boot);
      box.appendChild(btn);
    }
    host.appendChild(box);
  }

  /* The ONE degradation state, in the one shared visual language (§9.3a,
     §10.10). No spinner, no console error, no half-working composer. */
  function showInert(reason) {
    var host = main();
    if (!host) return;
    clear(host);
    var box = el('div', 'empty-state mt-16');
    box.appendChild(iconEl('mail'));
    box.appendChild(el('h3', '', 'Direct messages are not switched on yet'));

    var note = el('div', 'inert-note mt-8');
    note.appendChild(iconEl('info'));
    var body = el('div');
    body.appendChild(el('div', 'inert-note-title', 'Not switched on yet'));
    body.appendChild(el('div', '', reason ||
      'Private messages to the instructor will appear here once the course ' +
      'has switched them on. Nothing is lost — post on the board in the ' +
      'meantime, and tick "Post anonymously" if you would rather not be named.'));
    note.appendChild(body);
    box.appendChild(note);

    var link = el('a', 'btn btn-sm mt-8', 'Go to the discussion board');
    link.href = 'index.html';
    box.appendChild(link);

    host.appendChild(box);

    if (typeof ui.featureOff === 'function') {
      try { ui.featureOff('messages'); } catch (e) { /* ignore */ }
    }
  }

  /* ====================================================================== *
     layout
   * ====================================================================== */

  function buildLayout() {
    var host = main();
    clear(host);

    var layout = el('div', 'msg-layout');

    /* ---------------- list pane ---------------- */
    var listPane = el('div', 'msg-pane-list');
    /* .page-head styles its own h1 (main.css §…/page-head h1) — there is no
       .page-title class in the registry, so do not invent one. */
    var head = el('div', 'page-head');
    head.appendChild(el('h1', '', 'Messages'));
    listPane.appendChild(head);

    if (state.instructor) {
      /* §10.8: a client-side filter box over peer display names. Zero extra
         calls — the payload is already in memory. It HIDES rows, it does not
         filter the payload; see the privacy note in the file header. */
      var filterWrap = el('div', 'mb-8');
      var filterLabel = el('label', 'sr-only', 'Filter conversations by name');
      filterLabel.setAttribute('for', 'msg-filter');
      var filter = el('input', 'input');
      filter.type = 'search';
      filter.id = 'msg-filter';
      filter.placeholder = 'Filter by name';
      filter.setAttribute('aria-label', 'Filter conversations by name');
      filter.addEventListener('input', function () {
        state.filterText = String(filter.value || '').toLowerCase();
        applyConvFilter();
      });
      filterWrap.appendChild(filterLabel);
      filterWrap.appendChild(filter);
      listPane.appendChild(filterWrap);
      nodes.filter = filter;
    }

    var list = el('ul', 'msg-conv-list');
    listPane.appendChild(list);
    nodes.convList = list;

    var listEmpty = el('div', 'empty-state');
    listEmpty.appendChild(el('p', '', 'No conversations yet.'));
    listEmpty.hidden = true;
    listPane.appendChild(listEmpty);
    nodes.listEmpty = listEmpty;

    /* ---------------- thread pane ---------------- */
    var threadPane = el('div', 'msg-pane-thread');

    var header = el('div', 'msg-header');
    var back = el('button', 'msg-back btn-icon');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to conversations');
    back.appendChild(document.createTextNode('← Back'));
    back.addEventListener('click', function () { closeConversation(true); });
    header.appendChild(back);
    nodes.back = back;

    var avatarSlot = el('span', 'msg-header-avatar');
    header.appendChild(avatarSlot);
    nodes.avatarSlot = avatarSlot;

    /* tabindex="-1" so opening a conversation can move focus here (§10.9); the
       focus ring for it is already in main.css §20. */
    var peer = el('h2', 'msg-peer-name', 'Messages');
    peer.setAttribute('tabindex', '-1');
    header.appendChild(peer);
    nodes.peer = peer;

    var badgeSlot = el('span', 'msg-header-badge');
    header.appendChild(badgeSlot);
    nodes.badgeSlot = badgeSlot;

    threadPane.appendChild(header);

    var stalled = el('div', 'msg-poll-stalled');
    stalled.hidden = true;
    stalled.appendChild(iconEl('alert'));
    stalled.appendChild(el('span', '',
      'Not getting new messages right now — the server is not answering.'));
    var stalledBtn = el('button', 'btn btn-sm', 'Retry');
    stalledBtn.type = 'button';
    stalledBtn.addEventListener('click', function () {
      stalled.hidden = true;
      state.convErrors = 0;
      if (convPoller) { convPoller.start(); convPoller.now(); }
    });
    stalled.appendChild(stalledBtn);
    threadPane.appendChild(stalled);
    nodes.stalled = stalled;

    /* role="log" + aria-live="polite" + aria-relevant="additions": polling
       APPENDS, never clears and rebuilds, or every tick re-announces the whole
       conversation to a screen reader (§10.9). */
    var log = el('div', 'msg-log');
    log.setAttribute('role', 'log');
    log.setAttribute('aria-live', 'polite');
    log.setAttribute('aria-relevant', 'additions');
    log.setAttribute('aria-label', 'Conversation');
    threadPane.appendChild(log);
    nodes.log = log;

    var privacy = el('p', 'msg-privacy-note', PRIVACY_TEXT);
    threadPane.appendChild(privacy);
    nodes.privacy = privacy;

    var tray = el('div', 'upload-tray');
    tray.setAttribute('role', 'status');
    threadPane.appendChild(tray);
    nodes.tray = tray;

    var composer = el('form', 'msg-composer');
    composer.setAttribute('novalidate', 'novalidate');
    var taLabel = el('label', 'sr-only', 'Message');
    taLabel.setAttribute('for', 'msg-input');
    var ta = el('textarea', 'textarea');
    ta.id = 'msg-input';
    ta.rows = 1;
    ta.placeholder = 'Write a message…  (Enter to send, Shift+Enter for a new line)';
    ta.setAttribute('aria-label', 'Message');
    var send = el('button', 'btn btn-primary btn-sm', 'Send');
    send.type = 'submit';
    composer.appendChild(taLabel);
    composer.appendChild(ta);
    composer.appendChild(send);
    threadPane.appendChild(composer);
    nodes.composer = composer;
    nodes.textarea = ta;
    nodes.send = send;

    composer.addEventListener('submit', function (ev) {
      ev.preventDefault();
      doSend();
    });
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', function (ev) {
      /* Enter sends, Shift+Enter is a newline. Also leave Ctrl/Cmd+Enter as a
         send, because half the world learned that shortcut instead. */
      if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
      if (ev.shiftKey) return;
      if (ev.isComposing) return;        /* mid-IME composition: not a send */
      ev.preventDefault();
      doSend();
    });

    layout.appendChild(listPane);
    layout.appendChild(threadPane);
    host.appendChild(layout);

    nodes.layout = layout;
    nodes.listPane = listPane;
    nodes.threadPane = threadPane;
    ensureThreadPaneBounded();
  }

  function autoGrow() {
    var ta = nodes.textarea;
    if (!ta) return;
    /* The 6-row cap lives in main.css (max-height: 9.5em) so it is not
       duplicated here as a magic pixel number. */
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  /* Below 767px only the pane matching the URL is shown. .is-thread-open is the
     state co-class F1 pinned for the "conversation open" half; the other half
     (hiding the empty thread pane on the list URL) has no CSS hook, so it is
     done here with [hidden] behind a matchMedia test. Without matchMedia both
     panes simply stack — degraded, never broken. */
  function applyPaneVisibility() {
    if (!nodes.layout) return;
    var open = !!state.conversationId;
    if (open) nodes.layout.className = 'msg-layout is-thread-open';
    else nodes.layout.className = 'msg-layout';
    nodes.threadPane.hidden = (isNarrow() && !open);
  }

  /* ====================================================================== *
     conversation list
   * ====================================================================== */

  function sortedConversations() {
    var rows = state.conversations.slice(0);
    /* Unread first, then newest activity first. GetItems gives no ordering
       guarantee and the mock deliberately returns table order, so this sort is
       not optional. */
    rows.sort(function (a, b) {
      /* displayUnread, not the raw count: the order and the dot must agree, or
         a conversation sorts to the top of the "needs a reply" group while
         visibly showing nothing unread. */
      var au = displayUnread(a) > 0 ? 1 : 0;
      var bu = displayUnread(b) > 0 ? 1 : 0;
      if (au !== bu) return bu - au;
      return parseIso(b.last_at) - parseIso(a.last_at);
    });
    return rows;
  }

  function displayUnread(conv) {
    var n = parseInt(conv.unread, 10) || 0;
    if (!n) return 0;
    /* The write-lag overlay lives in unread.js so the badge and this list can
       never disagree. */
    if (Clinic.unread && typeof Clinic.unread.seenAt === 'function') {
      var seen = Clinic.unread.seenAt(conv.conversation_id);
      if (seen && conv.last_at && parseIso(conv.last_at) <= parseIso(seen)) return 0;
    }
    if (conv.conversation_id === state.conversationId) return 0;
    return n;
  }

  function renderConvList() {
    var list = nodes.convList;
    if (!list) return;
    clear(list);
    var rows = sortedConversations();
    nodes.listEmpty.hidden = rows.length > 0;

    for (var i = 0; i < rows.length; i++) {
      var conv = rows[i];
      var unread = displayUnread(conv);
      var other = conv.other || {};
      var name = other.display_name || 'Unknown';

      var li = el('li');
      var btn = el('button', 'msg-conv-item' + (unread ? ' is-unread' : '') +
        (conv.conversation_id === state.conversationId ? ' is-active' : ''));
      btn.type = 'button';
      btn.setAttribute('data-cid', conv.conversation_id);

      if (typeof ui.avatar === 'function') {
        try { btn.appendChild(ui.avatar(other, 32)); } catch (e) { /* ignore */ }
      }

      var body = el('span', 'msg-conv-body');
      body.appendChild(el('span', 'msg-conv-name', name));
      body.appendChild(el('span', 'msg-conv-preview',
        conv.last_excerpt || 'No messages yet'));
      btn.appendChild(body);

      btn.appendChild(el('span', 'msg-conv-time', relTime(conv.last_at)));

      if (unread) {
        var dot = el('span', 'unread-dot');
        dot.setAttribute('aria-hidden', 'true');
        btn.appendChild(dot);
      }

      /* The accessible name carries the count; the dot itself is aria-hidden. */
      btn.setAttribute('aria-label', name +
        (unread ? ', ' + unread + ' unread' : '') +
        (conv.last_at ? ', last message ' + relTime(conv.last_at) : ''));
      if (conv.conversation_id === state.conversationId) {
        btn.setAttribute('aria-current', 'true');
      }

      (function (cid, button) {
        button.addEventListener('click', function () {
          state.lastConvId = cid;
          openConversation(cid, true, true);
        });
      })(conv.conversation_id, btn);

      li.appendChild(btn);
      list.appendChild(li);
    }
    applyConvFilter();
  }

  /* HIDE, do not filter. Every conversation the server returned is in the DOM;
     the instructor's typed text only toggles [hidden] on rows that do not match.
     This is the display filter §10.8 asks for and it is the ONLY one in the
     file. */
  function applyConvFilter() {
    var list = nodes.convList;
    if (!list) return;
    var q = state.filterText;
    var items = list.getElementsByTagName('li');
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var nameNode = items[i].querySelector('.msg-conv-name');
      var name = nameNode ? String(nameNode.textContent || '').toLowerCase() : '';
      var match = !q || name.indexOf(q) !== -1;
      items[i].hidden = !match;
      if (match) shown++;
    }
    if (!nodes.listEmpty) return;
    /* Two different empty states, and conflating them is a bug people hit: a
       cohort with no conversations yet, versus a filter that matched nobody. */
    if (!state.conversations.length) {
      nodes.listEmpty.textContent = '';
      nodes.listEmpty.appendChild(el('p', '', 'No conversations yet.'));
      nodes.listEmpty.hidden = false;
    } else if (!shown) {
      nodes.listEmpty.textContent = '';
      nodes.listEmpty.appendChild(el('p', '', 'No one matches that name.'));
      nodes.listEmpty.hidden = false;
    } else {
      nodes.listEmpty.hidden = true;
    }
  }

  function conversationById(cid) {
    for (var i = 0; i < state.conversations.length; i++) {
      if (state.conversations[i].conversation_id === cid) return state.conversations[i];
    }
    return null;
  }

  /* Push the counts we already hold to the nav badge — free, no network. */
  function pushUnread() {
    if (!Clinic.unread || typeof Clinic.unread.set !== 'function') return;
    var by = [];
    var total = 0;
    for (var i = 0; i < state.conversations.length; i++) {
      var c = state.conversations[i];
      var n = displayUnread(c);
      total += n;
      by.push({ conversation_id: c.conversation_id, unread: n, last_at: c.last_at });
    }
    try { Clinic.unread.set(total, by); } catch (e) { /* ignore */ }
  }

  /* ====================================================================== *
     bubbles
   * ====================================================================== */

  function dayKey(iso) {
    var d = (typeof ui.parseIso === 'function') ? ui.parseIso(iso) : new Date(iso);
    if (!d) return '';
    var p = (typeof ui.sgParts === 'function') ? ui.sgParts(d) : null;
    if (!p) return String(iso).slice(0, 10);
    return p.year + '-' + p.month + '-' + p.day;
  }

  function maybeDaySeparator(iso) {
    var key = dayKey(iso);
    if (!key || key === state.lastDayKey) return;
    state.lastDayKey = key;
    nodes.log.appendChild(el('div', 'msg-day-sep', fmtDayDate(iso)));
  }

  /* HISTORY, kept because the trap is easy to re-introduce.
     .msg-bubble.is-mine is white-on-navy, but Clinic.md.render() returns a
     .markdown-body, and main.css sets an explicit dark `color` on
     .markdown-body itself and on h1-h6, strong and blockquote inside it. Those
     win over the bubble's white by specificity, so an outgoing message rendered
     dark-navy-on-navy — measured 1.02:1 in the browser (rgb(44,62,80) on
     rgb(0,61,124)), i.e. invisible. §9.6 shipped rules for `a` and `code` and
     missed the other five selectors.
     This file carried an inline `color: inherit` workaround for that. main.css
     §20 now states the real rules (both for .is-mine and for the .is-failed
     bubble, which drops the navy fill again), so the workaround is GONE and
     there is one source of truth. If an outgoing DM ever looks dark again, fix
     it in main.css — do not put the inline style back. */

  function bodyInto(bubble, md, mine) {
    var holder;
    if (Clinic.md && typeof Clinic.md.render === 'function') {
      try {
        holder = Clinic.md.render(md);
      } catch (e) {
        holder = null;
      }
    }
    if (!holder || !holder.nodeType) {
      holder = el('div', 'markdown-body');
      holder.appendChild(el('p', '', md));
    }
    /* `mine` is still the parameter that decides the bubble class, and
       main.css keys the outgoing colours off .msg-bubble.is-mine .markdown-body
       — nothing to do here any more. See the note above bodyInto's helpers. */
    bubble.appendChild(holder);
  }

  function serverBubble(msg) {
    var mine = msg.from_me === true;
    var bubble = el('div', 'msg-bubble ' + (mine ? 'is-mine' : 'is-theirs'));
    bubble.setAttribute('data-message-id', msg.message_id || '');
    if (msg.client_msg_id) bubble.setAttribute('data-client-msg-id', msg.client_msg_id);
    bodyInto(bubble, msg.body_md || '', mine);
    var meta = el('span', 'msg-bubble-meta', fmtTime(msg.created_at));
    bubble.appendChild(meta);
    return bubble;
  }

  function fillPendingBubble(bubble, entry) {
    clear(bubble);
    var failed = entry.state === 'failed';
    bubble.className = 'msg-bubble is-mine ' + (failed ? 'is-failed' : 'is-pending');
    bubble.setAttribute('data-client-msg-id', entry.client_msg_id);
    bodyInto(bubble, entry.body, !failed);

    var meta = el('span', 'msg-bubble-meta');
    var age = Date.now() - entry.first_attempt_at;

    if (!failed) {
      /* "Sent" is not the same as "delivered and visible": the row can exist and
         still not come back from a read for ~30 s. Say the true thing. */
      meta.appendChild(document.createTextNode(
        entry.state === 'sent'
          ? 'Sent — waiting for the server (this can take ~30s)'
          : 'Sending…'));
    } else if (age < RETRY_SUPPRESS_MS) {
      /* §10.7: for the first 45 s the Retry control is NOT RENDERED AT ALL, not
         merely disabled. The flow's idempotency check reads a lagged table and
         cannot see a row written seconds ago, so an immediate retry really does
         double-post. This is the guarantee. */
      meta.appendChild(document.createTextNode('Sending — do not resend yet'));
    } else {
      meta.appendChild(document.createTextNode(entry.error || 'Not delivered.'));
      meta.appendChild(document.createTextNode(' '));

      var retry = el('button', 'msg-retry', 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', function () { retrySend(entry); });
      meta.appendChild(retry);

      meta.appendChild(document.createTextNode(' · '));

      var copy = el('button', 'msg-retry', 'Copy text');
      copy.type = 'button';
      copy.addEventListener('click', function () { copyText(entry.body); });
      meta.appendChild(copy);
    }
    bubble.appendChild(meta);
    return bubble;
  }

  function copyText(text) {
    var done = function () { toast('Message text copied.', 'success'); };
    try {
      if (window.navigator && window.navigator.clipboard &&
          typeof window.navigator.clipboard.writeText === 'function') {
        window.navigator.clipboard.writeText(text).then(done, function () {
          fallbackCopy(text, done);
        });
        return;
      }
    } catch (e) { /* fall through */ }
    fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', 'readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch (e) { toast('Could not copy.', 'error'); }
    document.body.removeChild(ta);
  }

  /* main.css gives .msg-log `overflow-y:auto; flex:1 1 auto` and .msg-pane-list
     a max-height, but .msg-pane-thread has no height bound at all — so the grid
     row stretches to the full height of the conversation, the log never
     overflows, and two things break: the newest message is off the bottom of
     the page on open, and .msg-privacy-note (a REQUIRED persistent line, §9.5)
     scrolls out of view on any conversation longer than a screen.
     Bounding the pane fixes both. It is applied ONLY when the stylesheet has
     not set a max-height itself, so the moment F1 ships one this line stops
     doing anything. See needs_other_owner. */
  function ensureThreadPaneBounded() {
    var pane = nodes.threadPane;
    if (!pane || !window.getComputedStyle) return;
    var current = pane.style.maxHeight;
    if (current) return;
    var cs = window.getComputedStyle(pane);
    if (cs.maxHeight && cs.maxHeight !== 'none') return;
    pane.style.maxHeight = 'calc(100vh - var(--header-height) - 140px)';
  }

  function scrollLogToEnd() {
    var log = nodes.log;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
    /* Belt and braces: if the log is not its own scroller (a future CSS change,
       or a very short conversation), take the page to the composer instead so
       the newest message is what you are looking at. */
    if (log.scrollHeight - log.clientHeight < 2) {
      var doc = document.documentElement || document.body;
      if (doc.scrollHeight - window.innerHeight > 4) {
        try { window.scrollTo(0, doc.scrollHeight); } catch (e) { /* ignore */ }
      }
    }
  }

  function nearBottom() {
    var log = nodes.log;
    if (!log) return true;
    return (log.scrollHeight - log.scrollTop - log.clientHeight) < 80;
  }

  /* ====================================================================== *
     rendering the log
   * ====================================================================== */

  /* Full rebuild — ONLY on a conversation change. aria-live is switched off
     around it so the screen reader does not read the entire history aloud
     (§10.9). */
  function renderLogFull() {
    var log = nodes.log;
    if (!log) return;
    log.setAttribute('aria-live', 'off');
    clear(log);
    state.lastDayKey = '';

    if (!state.messages.length && !state.pending.length) {
      var empty = el('div', 'empty-state');
      empty.appendChild(el('p', '', state.conversationId === 'new'
        ? 'Say hello. Only you and the instructor can read this.'
        : 'No messages yet.'));
      log.appendChild(empty);
    }

    for (var i = 0; i < state.messages.length; i++) {
      var m = state.messages[i];
      maybeDaySeparator(m.created_at);
      log.appendChild(serverBubble(m));
    }
    for (var j = 0; j < state.pending.length; j++) {
      var p = state.pending[j];
      var bubble = el('div', 'msg-bubble');
      p.node = fillPendingBubble(bubble, p);
      log.appendChild(bubble);
    }
    scrollLogToEnd();
    /* Back to polite AFTER the rebuild, so only genuinely new bubbles are
       announced from here on. */
    window.setTimeout(function () {
      if (nodes.log) nodes.log.setAttribute('aria-live', 'polite');
    }, 0);
  }

  function dropEmptyState() {
    var empty = nodes.log ? nodes.log.querySelector('.empty-state') : null;
    if (empty && empty.parentNode) empty.parentNode.removeChild(empty);
  }

  /* Append-only. Returns the number of genuinely new bubbles added. */
  function appendMessages(rows) {
    var added = 0;
    var stick = nearBottom();
    for (var i = 0; i < rows.length; i++) {
      var m = rows[i];
      if (!m || !m.message_id) continue;
      if (state.seenIds[m.message_id]) continue;

      /* ---- RECONCILIATION (§10.7 step 4) ----
         Match the pending entry by client_msg_id, never by body text. When it
         matches, UPGRADE the optimistic bubble in place rather than removing it
         and appending a fresh one: same node, no duplicate, and nothing is
         re-announced to a screen reader. */
      var entry = m.client_msg_id ? pendingByClientId(m.client_msg_id) : null;
      if (entry) {
        state.seenIds[m.message_id] = true;
        state.messages.push(m);
        if (entry.node) {
          clear(entry.node);
          entry.node.className = 'msg-bubble is-mine';
          entry.node.setAttribute('data-message-id', m.message_id);
          bodyInto(entry.node, m.body_md || '', true);
          entry.node.appendChild(el('span', 'msg-bubble-meta', fmtTime(m.created_at)));
        }
        pendingRemove(entry);
        continue;
      }

      state.seenIds[m.message_id] = true;
      state.messages.push(m);
      dropEmptyState();
      maybeDaySeparator(m.created_at);
      nodes.log.appendChild(serverBubble(m));
      added++;
    }

    /* Keep any still-pending bubbles at the bottom — they are by definition the
       newest thing in the conversation. Only touched when something was
       actually appended, so the aria-live region is not churned needlessly. */
    if (added && state.pending.length) {
      for (var k = 0; k < state.pending.length; k++) {
        if (state.pending[k].node) nodes.log.appendChild(state.pending[k].node);
      }
    }
    if (added && stick) scrollLogToEnd();
    return added;
  }

  /* ====================================================================== *
     opening / closing a conversation
   * ====================================================================== */

  function stopConvPoller() {
    if (convPoller) { convPoller.destroy(); convPoller = null; }
  }

  function renderPeerHeader() {
    var other = state.other || {};
    clear(nodes.avatarSlot);
    clear(nodes.badgeSlot);
    if (state.conversationId && typeof ui.avatar === 'function' && other.user_id) {
      try { nodes.avatarSlot.appendChild(ui.avatar(other, 28)); } catch (e) { /* ignore */ }
    }
    nodes.peer.textContent = state.conversationId
      ? (other.display_name || (state.conversationId === 'new' ? 'The instructor' : 'Conversation'))
      : 'Messages';

    var isIns = other.is_instructor === true ||
      (typeof ui.isInstructorAuthor === 'function' && ui.isInstructorAuthor(other));
    if (isIns) {
      var badge = el('span', 'badge badge-instructor');
      badge.appendChild(iconEl('shield'));
      badge.appendChild(document.createTextNode('Instructor'));
      nodes.badgeSlot.appendChild(badge);
    }
  }

  function setComposerEnabled(on, why) {
    if (!nodes.composer) return;
    if (on) nodes.composer.className = 'msg-composer';
    else nodes.composer.className = 'msg-composer is-disabled';
    if (nodes.textarea) nodes.textarea.disabled = !on;
    if (nodes.send) nodes.send.disabled = !on;
    if (why) nodes.privacy.textContent = why;
    else nodes.privacy.textContent = PRIVACY_TEXT;
  }

  function showThreadEmptyState() {
    /* No conversation selected. On desktop the instructor sees this beside the
       list; on mobile the whole pane is hidden by applyPaneVisibility(). */
    clear(nodes.log);
    state.lastDayKey = '';
    var box = el('div', 'empty-state');
    box.appendChild(iconEl('mail'));
    box.appendChild(el('h3', '', state.instructor
      ? 'Choose a conversation'
      : 'No messages yet'));
    if (state.instructor) {
      box.appendChild(el('p', '', 'Pick a student on the left to read and reply.'));
    } else {
      box.appendChild(el('p', '',
        'Ask the instructor something privately — useful when the question ' +
        'has your data or your marks in it.'));
      var start = el('button', 'btn btn-primary btn-sm mt-8', 'Message the instructor');
      start.type = 'button';
      start.addEventListener('click', function () { openConversation('new', true, true); });
      box.appendChild(start);
    }
    nodes.log.appendChild(box);
    nodes.composer.hidden = true;
    nodes.privacy.hidden = true;
  }

  function closeConversation(userInitiated) {
    stopConvPoller();
    /* Detach the paste/drop handlers with the conversation they were scoped to,
       or an attach.create fired from the closed pane would carry a stale
       scope_id. */
    if (uploadDetach) { try { uploadDetach(); } catch (e) { /* ignore */ } uploadDetach = null; }
    state.conversationId = '';
    state.other = null;
    state.messages = [];
    state.seenIds = {};
    state.newestAt = '';
    state.pending = [];
    state.convErrors = 0;
    if (nodes.stalled) nodes.stalled.hidden = true;
    renderPeerHeader();
    showThreadEmptyState();
    applyPaneVisibility();
    renderConvList();
    syncListPoller();
    if (userInitiated) {
      pushUrl('messages.html');
      /* Mobile: focus returns to the .msg-conv-item that was activated (§10.9).
         Look it up by conversation id, NOT by a stashed node reference —
         renderConvList() rebuilds the list on every open and close, so the node
         that was clicked is long gone by the time we get here. Verified in the
         browser: holding the node put focus on the first row instead. */
      var target = null;
      if (nodes.convList && state.lastConvId) {
        target = nodes.convList.querySelector(
          '.msg-conv-item[data-cid="' + String(state.lastConvId).replace(/"/g, '\\"') + '"]');
      }
      if (!target && nodes.convList) target = nodes.convList.querySelector('.msg-conv-item');
      if (target) { try { target.focus(); } catch (e) { /* ignore */ } }
    }
  }

  function openConversation(cid, userInitiated, push) {
    if (!cid) { closeConversation(userInitiated); return; }
    if (cid === state.conversationId) { applyPaneVisibility(); return; }

    stopConvPoller();
    state.conversationId = cid;
    state.messages = [];
    state.seenIds = {};
    state.newestAt = '';
    state.convErrors = 0;
    state.lastDayKey = '';
    state.pending = pendingLoad(cid);
    schedulePendingTick();
    if (nodes.stalled) nodes.stalled.hidden = true;

    var conv = conversationById(cid);
    state.other = conv ? conv.other : (cid === 'new' ? instructorStub() : null);

    nodes.composer.hidden = false;
    nodes.privacy.hidden = false;
    setComposerEnabled(state.chatEnabled !== false);
    renderPeerHeader();
    renderConvList();
    applyPaneVisibility();

    if (push) pushUrl(cid === 'new' ? 'messages.html?c=new' : 'messages.html?c=' + encodeURIComponent(cid));

    /* Only a user action moves focus. Auto-opening the student's single
       conversation on page load must not yank focus out of the document flow
       before they have read anything (§10.9 is about OPENING, not about the
       page arriving already open). */
    if (userInitiated) {
      try { nodes.peer.focus(); } catch (e) { /* ignore */ }
    }

    wireUploads();

    if (cid === 'new') {
      renderLogFull();
      if (!state.messages.length && !state.pending.length) {
        clear(nodes.log);
        var hint = el('div', 'empty-state');
        hint.appendChild(el('p', '',
          'Say hello. Only you and the instructor can read this.'));
        nodes.log.appendChild(hint);
      }
      /* The one case where the composer, not the heading, is the right landing
         spot: there is no history to read, the user just pressed "Message the
         instructor", and typing is the only thing to do. */
      if (userInitiated) focusComposer();
      return;
    }

    /* First load: no `since`, so the payload also carries `other`. */
    clear(nodes.log);
    nodes.log.appendChild(el('div', 'spinner spinner-block'));

    api.call('messages.get', { conversation_id: cid }).then(function (data) {
      if (state.conversationId !== cid) return;      /* the user moved on */
      ingest(data, true);
      markRead(cid);
      startConvPoller(cid);
      /* Focus deliberately STAYS on the .msg-header heading that
         openConversation moved it to (§10.9). Jumping it to the composer here
         would skip a screen-reader user straight past the conversation they
         just asked to read — and the payload only arrives 10-21 s after the
         click, so it would also be a focus jump out of nowhere. */
    }, function (err) {
      if (state.conversationId !== cid) return;
      clear(nodes.log);
      if (isUnknown(err)) { showInert(); return; }
      if (err && err.code === 'unauthorized') return;
      var box = el('div', 'empty-state');
      box.appendChild(el('h3', '', 'Could not open this conversation'));
      box.appendChild(el('p', '', errMsg(err, 'Try again in a moment.')));
      var again = el('button', 'btn btn-sm mt-8', 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () {
        var target = state.conversationId;
        state.conversationId = '';
        openConversation(target, false, false);
      });
      box.appendChild(again);
      nodes.log.appendChild(box);
    });
  }

  function instructorStub() {
    var id = (typeof ui.instructorUserId === 'function') ? ui.instructorUserId() : '';
    return { user_id: id, display_name: 'The instructor', is_instructor: true };
  }

  function focusComposer() {
    if (nodes.textarea && !nodes.textarea.disabled) {
      try { nodes.textarea.focus(); } catch (e) { /* ignore */ }
    }
  }

  /* ====================================================================== *
     ingest + polling
   * ====================================================================== */

  function sortByCreated(rows) {
    rows.sort(function (a, b) { return parseIso(a.created_at) - parseIso(b.created_at); });
    return rows;
  }

  function ingest(data, full) {
    var rows = (data && isArray(data.messages)) ? data.messages.slice(0) : [];
    sortByCreated(rows);

    if (data && data.other) state.other = data.other;

    if (full) {
      state.messages = [];
      state.seenIds = {};
      clear(nodes.log);
      state.lastDayKey = '';
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i] || !rows[i].message_id) continue;
        /* reconcile against anything restored from sessionStorage */
        var entry = rows[i].client_msg_id ? pendingByClientId(rows[i].client_msg_id) : null;
        if (entry) pendingRemove(entry);
        state.seenIds[rows[i].message_id] = true;
        state.messages.push(rows[i]);
      }
      renderPeerHeader();
      renderLogFull();
    } else {
      appendMessages(rows);
    }

    for (var j = 0; j < rows.length; j++) {
      if (rows[j] && parseIso(rows[j].created_at) > parseIso(state.newestAt)) {
        state.newestAt = rows[j].created_at;
      }
    }
    if (state.newestAt && Clinic.unread && typeof Clinic.unread.markSeen === 'function') {
      try { Clinic.unread.markSeen(state.conversationId, state.newestAt); } catch (e) { /* ignore */ }
    }
    /* Locally zero this conversation and repaint the badge — instantly, without
       waiting ~30 s for the messages.read write to become readable. */
    var conv = conversationById(state.conversationId);
    if (conv) conv.unread = 0;
    pushUnread();
    renderConvList();
  }

  /* `since` is nudged one second back and dedupe is done on message_id instead.
     The flow compares ticks(created_at) > ticks(since); Excel timestamps are not
     guaranteed sub-second, so an exact boundary can drop a message that shares
     its second with the newest one we hold. One extra row per tick is free;
     a silently missing message is not. */
  function pollSince() {
    if (!state.newestAt) return '';
    var t = parseIso(state.newestAt);
    if (!t) return '';
    return new Date(t - SINCE_SLACK_MS).toISOString();
  }

  function startConvPoller(cid) {
    stopConvPoller();
    var intervalMs = (Clinic.poll && typeof Clinic.poll.secondsFromConfig === 'function')
      ? Clinic.poll.secondsFromConfig('messages_poll_seconds', 90)
      : 90000;

    convPoller = Clinic.poll.create({
      name: 'messages.get',
      intervalMs: intervalMs,
      hiddenIntervalMs: 0,          /* a hidden tab costs nothing at all */
      immediate: false,             /* we have just done the full load */
      fn: function () {
        var payload = { conversation_id: cid };
        var since = pollSince();
        if (since) payload.since = since;
        return api.call('messages.get', payload);
      },
      onData: function (data) {
        if (state.conversationId !== cid) return;
        state.convErrors = 0;
        if (nodes.stalled) nodes.stalled.hidden = true;
        expirePending();
        ingest(data, false);
        redrawPending();
        schedulePendingTick();
      },
      onError: function (err) {
        if (state.conversationId !== cid) return;
        if (isUnknown(err)) { stopConvPoller(); showInert(); return; }
        if (err && err.code === 'unauthorized') return;
        state.convErrors += 1;
        /* §10.8: three consecutive errors pause the poller and show the strip.
           Never a console error and never a spinner that spins forever. */
        if (state.convErrors >= 3) {
          if (convPoller) convPoller.stop();
          if (nodes.stalled) nodes.stalled.hidden = false;
        }
      }
    });
    convPoller.start();
  }

  function syncListPoller() {
    /* INSTRUCTOR ONLY (§10.8). A student's list has exactly one row and the open
       conversation's own poller already covers it, so polling the list as a
       student would be 4 Excel calls per tick for literally nothing. */
    var wanted = state.instructor && (!isNarrow() || !state.conversationId);
    if (!wanted) {
      if (listPoller) { listPoller.destroy(); listPoller = null; }
      return;
    }
    if (listPoller) { listPoller.start(); return; }
    listPoller = Clinic.poll.create({
      name: 'messages.list',
      intervalMs: LIST_POLL_MS,
      hiddenIntervalMs: 0,
      immediate: false,
      fn: function () { return api.call('messages.list', {}); },
      onData: function (data) { ingestList(data); },
      onError: function (err) {
        if (isUnknown(err)) {
          if (listPoller) { listPoller.destroy(); listPoller = null; }
        }
      }
    });
    listPoller.start();
  }

  function ingestList(data) {
    if (!data) return;
    /* The payload is stored VERBATIM. No conversation is ever dropped here —
       the flow already returned only the ones the caller participates in. */
    state.conversations = isArray(data.conversations) ? data.conversations : [];
    if (data.chat_enabled !== undefined) state.chatEnabled = ui.truthy
      ? ui.truthy(data.chat_enabled) : !!data.chat_enabled;
    /* A conversation that was just created by a first send has no `other` yet —
       messages.get only emits that block on a non-`since` load, which will not
       happen for another 90 s. The list payload has the real name now, so use
       it rather than leaving the header reading "The instructor". */
    if (state.conversationId) {
      var conv = conversationById(state.conversationId);
      if (conv && conv.other && (!state.other || !state.other.user_id)) {
        state.other = conv.other;
        renderPeerHeader();
      }
    }
    renderConvList();
    pushUnread();
  }

  function markRead(cid) {
    if (!cid || cid === 'new') return;
    /* Fire and forget: the badge is already zeroed locally by the overlay, so a
       failure here costs nothing visible. */
    api.call('messages.read', { conversation_id: cid })['catch'](function () { });
  }

  /* ====================================================================== *
     sending  (§10.7)
   * ====================================================================== */

  function newClientMsgId() {
    return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }

  function doSend() {
    if (state.sending) return;
    /* No conversation open = nothing to send to. The composer is [hidden] in
       that state so a person cannot reach it, but a stray Enter from a
       restored-focus race (or a script) would otherwise reach the flow and
       come back with "Pick a conversation to reply to" — an error message for
       something the user never did. */
    if (!state.conversationId) return;
    var ta = nodes.textarea;
    if (!ta || ta.disabled) return;
    var body = String(ta.value || '').replace(/^\s+|\s+$/g, '');
    if (!body) { focusComposer(); return; }
    if (body.length > MAX_BODY) {
      toast('That message is too long (max ' + MAX_BODY + ' characters).', 'error');
      return;
    }

    var entry = {
      client_msg_id: newClientMsgId(),
      body: body,
      created_at_local: new Date().toISOString(),
      first_attempt_at: Date.now(),
      state: 'pending',
      message_id: '',
      error: '',
      node: null
    };
    state.pending.push(entry);
    pendingSave();

    dropEmptyState();
    var bubble = el('div', 'msg-bubble');
    entry.node = fillPendingBubble(bubble, entry);
    nodes.log.appendChild(bubble);
    scrollLogToEnd();
    schedulePendingTick();

    transmit(entry, true);
  }

  function retrySend(entry) {
    /* Same client_msg_id, deliberately: by now the original write is long past
       the ~30 s visibility lag, so the flow's idempotency filter will genuinely
       catch it and return the existing message_id with duplicate:true. */
    entry.state = 'pending';
    entry.error = '';
    if (entry.node) fillPendingBubble(entry.node, entry);
    pendingSave();
    transmit(entry, false);
  }

  function transmit(entry, clearOnSuccess) {
    state.sending = true;
    if (nodes.send) nodes.send.disabled = true;

    var payload = {
      body_md: entry.body,
      client_msg_id: entry.client_msg_id
    };
    /* A student's conversation_id is derived flow-side and ignored if sent, so
       omitting it is both correct and one less thing to get wrong. The
       instructor MUST name the conversation. */
    if (state.instructor && state.conversationId && state.conversationId !== 'new') {
      payload.conversation_id = state.conversationId;
    }

    api.call('messages.send', payload).then(function (data) {
      state.sending = false;
      if (nodes.send) nodes.send.disabled = false;

      entry.state = 'sent';
      entry.message_id = (data && data.message_id) || '';
      entry.error = '';
      if (entry.node) fillPendingBubble(entry.node, entry);

      /* Clear the composer ONLY now that the call has resolved (§10.7 step 2). */
      if (clearOnSuccess && nodes.textarea) {
        nodes.textarea.value = '';
        autoGrow();
      }
      focusComposer();

      var cid = (data && data.conversation_id) || state.conversationId;
      if (cid && cid !== state.conversationId) adoptConversation(cid, entry);
      else { pendingSave(); schedulePendingTick(); }

      /* Deliberately NO immediate poll here. The row is not readable for up to
         ~30 s, so a "refresh now" would cost 3 more Excel calls and return
         exactly nothing. The optimistic bubble is the answer to that wait. */
    }, function (err) {
      state.sending = false;
      if (nodes.send) nodes.send.disabled = false;

      if (err && err.code === 'unauthorized') return;   /* api.js is redirecting */

      if (isUnknown(err)) { showInert(); return; }

      entry.state = 'failed';
      entry.error = errMsg(err, 'Not delivered.');
      if (entry.node) fillPendingBubble(entry.node, entry);
      pendingSave();
      schedulePendingTick();

      /* Restore the text — but never clobber something the user has started
         typing since. The failed bubble's "Copy text" is the backstop. */
      if (nodes.textarea && !String(nodes.textarea.value || '').replace(/^\s+|\s+$/g, '')) {
        nodes.textarea.value = entry.body;
        autoGrow();
      }
      toast(errMsg(err, 'Could not send that message.'), 'error');
      focusComposer();
    });
  }

  /* A student's very first message has no conversation id until the send comes
     back with one. Move the pending entry's storage key across with it. */
  function adoptConversation(cid, entry) {
    var store = pendingStoreRead();
    delete store['new'];
    try { ssSet(PENDING_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }

    state.conversationId = cid;
    pendingSave();
    schedulePendingTick();
    pushUrl('messages.html?c=' + encodeURIComponent(cid));
    renderConvList();
    applyPaneVisibility();
    startConvPoller(cid);
    refreshList();
  }

  /* ====================================================================== *
     URL / history  (§10.8)
   * ====================================================================== */

  function pushUrl(url) {
    try {
      if (window.history && window.history.pushState) window.history.pushState({}, '', url);
    } catch (e) { /* ignore */ }
  }

  function replaceUrl(url) {
    try {
      if (window.history && window.history.replaceState) window.history.replaceState({}, '', url);
    } catch (e) { /* ignore */ }
  }

  function urlConversation() {
    var m = /[?&]c=([^&#]*)/.exec(window.location.search || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  function onPopState() {
    var cid = urlConversation();
    if (!cid) { closeConversation(false); return; }
    if (cid === state.conversationId) return;
    state.conversationId = '';        /* force openConversation to do the work */
    openConversation(cid, false, false);
  }

  /* ====================================================================== *
     uploads (F5's module; entirely optional)
   * ====================================================================== */

  function wireUploads() {
    if (uploadDetach) { try { uploadDetach(); } catch (e) { /* ignore */ } uploadDetach = null; }
    var up = Clinic.uploads;
    if (!up || typeof up.attach !== 'function') return;   /* not built yet: no-op */
    var scopeId = state.conversationId;
    if (!scopeId || scopeId === 'new') {
      /* A student's dm scope_id is overwritten flow-side to 'c_'+their id, so
         this is the right guess and is discarded anyway. */
      scopeId = state.me && state.me.user_id ? 'c_' + state.me.user_id : '';
    }
    try {
      uploadDetach = up.attach({
        textarea: nodes.textarea,
        tray: nodes.tray,
        button: null,
        scope: 'dm',
        scopeId: scopeId,
        onInsert: autoGrow
      });
    } catch (e) { uploadDetach = null; }
  }

  /* ====================================================================== *
     boot
   * ====================================================================== */

  function refreshList() {
    return api.call('messages.list', {}).then(function (data) {
      ingestList(data);
      return data;
    }, function () { return null; });
  }

  function afterList(data) {
    state.conversations = (data && isArray(data.conversations)) ? data.conversations : [];
    state.chatEnabled = (data && data.chat_enabled !== undefined)
      ? (ui.truthy ? ui.truthy(data.chat_enabled) : !!data.chat_enabled)
      : true;

    if (!state.chatEnabled) { showInert('Direct messages are switched off for this course.'); return; }

    buildLayout();
    renderConvList();
    pushUnread();
    showThreadEmptyState();
    applyPaneVisibility();
    syncListPoller();
    state.ready = true;

    var fromUrl = urlConversation();
    if (fromUrl) {
      openConversation(fromUrl, false, false);
      return;
    }

    /* A student has exactly one conversation. Do not make them tap through an
       inbox of one — go straight into it. replaceState, not pushState, so the
       phone back button leaves the page rather than landing on a one-row list
       the student never asked for. */
    if (!state.instructor && state.conversations.length === 1) {
      var cid = state.conversations[0].conversation_id;
      replaceUrl('messages.html?c=' + encodeURIComponent(cid));
      openConversation(cid, false, false);
      return;
    }
    if (!state.instructor && !state.conversations.length) {
      var insId = (typeof ui.instructorUserId === 'function') ? ui.instructorUserId() : '';
      if (!insId) {
        showInert('Direct messages are not set up yet — the course has not ' +
          'named an instructor account for them.');
      }
    }
  }

  function boot() {
    if (!api || typeof api.call !== 'function') {
      showFatal('Messages are unavailable',
        'The page could not load its network module.', false);
      return;
    }
    if (typeof api.requireLogin === 'function' && api.requireLogin() === false) return;
    if (typeof ui.renderHeader === 'function') {
      try { ui.renderHeader('messages'); } catch (e) { /* ignore */ }
    }

    state.me = currentUser() || {};
    state.instructor = computeInstructor(state.me);

    var host = main();
    if (!host) return;

    /* THE GATE. No MSG_URL (or still a PASTE_ placeholder) means chat cannot
       work, and endpointFor would otherwise send messages.* to the app flow —
       three Excel GetItems and 10-21 s per attempt, purely to be told "Unknown
       action". hasMsgUrl() is TRUE in MOCK and FALSE for the placeholder. */
    if (typeof api.hasMsgUrl === 'function' && !api.hasMsgUrl()) { showInert(); return; }
    if (typeof ui.featureState === 'function' && ui.featureState('messages') === 'off') {
      showInert();
      return;
    }

    clear(host);
    host.appendChild(el('div', 'spinner spinner-block'));

    /* bootstrap() answers instantly from the localStorage cache when there is
       one; we need it for messages_poll_seconds, chat_enabled and
       instructor_user_id before the first poller is created. */
    var bootP = (typeof api.bootstrap === 'function')
      ? api.bootstrap()['catch'](function () { return null; })
      : Promise.resolve(null);

    bootP.then(function () {
      state.instructor = computeInstructor(state.me);
      return api.call('messages.list', {});
    }).then(function (data) {
      afterList(data);
    })['catch'](function (err) {
      if (err && err.code === 'unauthorized') return;
      if (isUnknown(err)) { showInert(); return; }
      if (err && err.code === 'forbidden') {
        showInert(errMsg(err, 'Direct messages are switched off for this course.'));
        return;
      }
      showFatal('Could not load your messages',
        errMsg(err, 'The server did not answer. Try again in a moment.'), true);
    });
  }

  /* Layout switches between one pane and two at 767px; the list poller and the
     hidden-pane rule both depend on which side of that we are on. */
  function wireMedia() {
    if (!window.matchMedia) return;
    mql = window.matchMedia(NARROW_QUERY);
    var onChange = function () {
      if (!state.ready) return;
      applyPaneVisibility();
      syncListPoller();
    };
    if (typeof mql.addEventListener === 'function') mql.addEventListener('change', onChange);
    else if (typeof mql.addListener === 'function') mql.addListener(onChange);
  }

  window.addEventListener('popstate', function () {
    if (state.ready) onPopState();
  });

  wireMedia();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

})(window, document);
