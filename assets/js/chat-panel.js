/*!
 * MScPHMxAI Coding Clinic — chat-panel.js   (owner: F9, with chat-fab.js)
 * The chat popover the floating button opens, so reading a thread and answering
 * a DM stop being two different pages.
 *
 *   Clinic.chatPanel.open([conversationId])   build + show; loads the inbox
 *   Clinic.chatPanel.close()                  hide, destroy the poller, restore focus
 *   Clinic.chatPanel.toggle()                 what the FAB calls
 *   Clinic.chatPanel.isOpen()  -> bool
 *   Clinic.chatPanel.destroy()                remove everything (tests, teardown)
 *
 * chat-fab.js calls toggle() when this file is present and falls back to
 * navigating to messages.html when it is not, so the panel is additive: delete
 * this one file and the button behaves exactly as it did before.
 *
 * =========================================================================
 * WHAT THIS COSTS, BECAUSE COST IS THE BINDING CONSTRAINT HERE
 * =========================================================================
 * Every number below is Excel connector calls, and R2 is the reason they are
 * counted: the tenant's daily request allocation is SHARED WITH SIGN-IN, so
 * overspending here does not degrade chat, it stops people logging in.
 *
 *   opening the panel        messages.list   4 calls   (once per open)
 *   opening a conversation   messages.get    2 calls
 *   each poll tick           messages.get    2 calls   (only while one is open)
 *   sending                  messages.send   7 calls
 *
 * The rule that keeps this bounded, and it is not negotiable: THE POLLER EXISTS
 * ONLY WHILE A CONVERSATION IS OPEN IN THE PANEL. It is created by
 * openConversation() and destroyed by close(), it runs at
 * `messages_poll_seconds` (90 s default) straight from config, and it suspends
 * completely while the tab is hidden (hiddenIntervalMs: 0).
 *
 * That matters more for a panel than it ever did for messages.html. The full
 * page polls while you are looking at the full page; a popover can be left open
 * on top of whatever else someone is doing, on every page, in several tabs. If
 * you are tempted to keep polling after close, or to poll the inbox in the
 * background so the panel opens "instantly", read the arithmetic at the top of
 * unread.js first: a 60 s background poller on every content page is ~28,800
 * flow runs a day at N=60, which is the whole daily allocation.
 *
 * The unread badge is still NOT polled from here. It is read from
 * Clinic.unread — which is also how the FAB gets its number — and pushed back
 * with unread.set()/markSeen() when a conversation is read, so opening a
 * conversation zeroes the badge locally without waiting ~30 s for the
 * tbl_MsgState write to become readable.
 *
 * =========================================================================
 * WHAT THIS PANEL DELIBERATELY DOES NOT DO
 * =========================================================================
 * It is a thin client, not a second implementation of messages.js. No image
 * paste, no attachments, no `since` deltas, no day separators, no conversation
 * search. Every one of those already exists on messages.html, and the "Open
 * full page" link in the header is one click away. Duplicating the optimistic
 * send + reconciliation logic once was necessary; duplicating the whole page
 * would guarantee the two drift.
 *
 * IT ALSO DOES NOT PROMISE INSTANT DELIVERY, and the visible cadence line is
 * part of the design rather than decoration. Your own message appears at once
 * because it is appended optimistically — but messages.send takes 10-21 s to
 * acknowledge, a write needs up to ~30 s to become readable by the other side,
 * and their poll runs every 90 s. Worst case a reply surfaces about two minutes
 * after it was sent. A bubble UI that implied otherwise would earn "chat is
 * broken" for behaviour that is working exactly as designed, so the footer says
 * what the cadence is and offers a manual check.
 *
 * CSS: every class inside the panel is already in the §9 registry — .msg-log,
 * .msg-bubble/.is-mine/.is-theirs/.is-pending/.is-failed, .msg-bubble-meta,
 * .msg-retry, .msg-composer, .msg-conv-*, .msg-privacy-note, .msg-poll-stalled,
 * .unread-dot, .is-unread. Only the popover SHELL is new (.chat-panel*), and it
 * lives in main.css §25 next to the FAB it belongs to.
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var MAX_BODY = 4000;              /* messages.send rejects longer (§4.3) */
  var POLL_FALLBACK_SECONDS = 90;

  var root = null;                  /* .chat-panel */
  var els = null;                   /* cached child nodes */
  var poller = null;
  var open = false;
  var view = 'list';                /* 'list' | 'conv' */
  var conv = null;                  /* {conversation_id, other} */
  var rows = [];                    /* server messages, oldest first */
  var pending = [];                 /* optimistic sends awaiting acknowledgement */
  var convs = [];
  var loading = false;
  var sending = false;
  var stalled = false;
  var lastFocus = null;

  /* GENERATION COUNTER — and this is a bug fix, not bookkeeping.
     Every network call in here resolves into a panel that may no longer be the
     panel that asked. Found in the browser: open the panel and close it again
     inside the ~15 s that messages.get takes, and loadConversation's success
     handler still ran startPoll() — so a CLOSED panel was left holding a live
     90 s poller, 2 Excel calls a tick, for the rest of the page's life. Nothing
     on screen showed it (the render guards all bailed correctly); only
     Clinic.poll.count() did. That is precisely the invisible cost leak R1 is
     about, arriving through the back door.
     closePanel() bumps gen, every async entry point captures it, and a stale
     continuation returns instead of touching anything. This also covers the
     other race in the same family: open conversation A, switch to B, and A's
     slower response lands afterwards. */
  var gen = 0;

  function stale(myGen) { return myGen !== gen || !open; }

  /* ------------------------------------------------------------- utilities */

  function api() { return Clinic.api || {}; }
  function ui() { return Clinic.ui || {}; }
  function unread() { return Clinic.unread || {}; }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }

  function icon(name) {
    try {
      var i = ui().icon(name);
      return (i && i.nodeType) ? i : el('span');
    } catch (e) { return el('span'); }
  }

  function relTime(iso) {
    try { return ui().relTime(iso) || ''; } catch (e) { return ''; }
  }

  function toast(msg, type) { try { ui().toast(msg, type); } catch (e) { /* ignore */ } }

  function errText(e) {
    return (e && (e.message || e.error)) || 'Something went wrong.';
  }

  /* Same shape as chat-fab.js's chatOff() and unread.js's chatExplicitlyOff():
     an ABSENT chat_enabled must not disable the feature (contract §5 — every v3
     config row may be missing against a backend that has not been re-imported),
     so only a value that is PRESENT AND FALSY counts as off. Three copies of
     this test now exist and they must keep agreeing. */
  function chatOff() {
    var cfg;
    try { cfg = ui().bootstrapConfig ? ui().bootstrapConfig() : {}; } catch (e) { cfg = {}; }
    var v = cfg ? cfg.chat_enabled : undefined;
    if (v === undefined || v === null || v === '') return false;
    return typeof ui().truthy === 'function' ? !ui().truthy(v) : !v;
  }

  function canOpen() {
    if (typeof api().call !== 'function') return false;
    if (typeof api().hasMsgUrl !== 'function' || !api().hasMsgUrl()) return false;
    if (typeof api().getToken !== 'function' || !api().getToken()) return false;
    if (chatOff()) return false;
    if (typeof ui().featureState === 'function' &&
        ui().featureState('messages') === 'off') return false;
    return true;
  }

  function isInstructor() {
    try { return !!(api().isInstructor && api().isInstructor()); } catch (e) { return false; }
  }

  /* The FEATURE-ABSENT detector, delegated so there is one answer per session.
     A backend that has never heard of messages.* must make this panel go quiet
     and stay quiet, not retry into a flow that will never know the action. */
  function isUnknownAction(err) {
    try {
      if (typeof api().isUnknownAction === 'function') return !!api().isUnknownAction(err);
      if (typeof ui().isUnknownAction === 'function') return !!ui().isUnknownAction(err);
    } catch (e) { /* fall through */ }
    return false;
  }

  function goInert(err) {
    try { if (ui().featureOff) ui().featureOff('messages'); } catch (e) { /* ignore */ }
    close();
    try { if (Clinic.fab && Clinic.fab.unmount) Clinic.fab.unmount(); } catch (e) { /* ignore */ }
    if (err) { /* deliberately silent: a feature that is not switched on is not an error */ }
  }

  function newClientMsgId() {
    /* Same shape as messages.js's, so a message sent from the panel and one sent
       from the full page are indistinguishable in tbl_Messages. */
    return 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  }

  /* ------------------------------------------------------------------ build */

  function build() {
    var panel = el('div', 'chat-panel');
    panel.id = 'chat-panel';
    panel.setAttribute('role', 'dialog');
    /* NOT aria-modal: the page behind stays usable on purpose — the entire point
       of a panel over a page navigation is that you keep your place in the
       thread you were reading. A modal would claim otherwise to a screen
       reader. */
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-label', 'Messages');

    var head = el('div', 'chat-panel-head');

    var back = el('button', 'chat-panel-back');
    back.type = 'button';
    back.setAttribute('aria-label', 'Back to conversations');
    back.appendChild(icon('chevron-right'));
    back.hidden = true;
    back.addEventListener('click', showList);
    head.appendChild(back);

    var title = el('span', 'chat-panel-title', 'Messages');
    head.appendChild(title);

    var full = el('a', 'chat-panel-full', 'Open full page');
    full.href = 'messages.html';
    full.title = 'Attachments, pasted screenshots and search live on the full page';
    head.appendChild(full);

    /* closeBtn, not close: there is a module-level close() and a local `var
       close` here would shadow it inside this function for no reason. */
    var closeBtn = el('button', 'chat-panel-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close messages');
    closeBtn.appendChild(icon('x'));
    closeBtn.addEventListener('click', function () { closePanel(); });
    head.appendChild(closeBtn);

    panel.appendChild(head);

    var body = el('div', 'chat-panel-body');
    panel.appendChild(body);

    var foot = el('div', 'chat-panel-foot');
    foot.hidden = true;

    /* §9.5 makes this line REQUIRED wherever a DM can be written: chat is
       private but it is not anonymous (R9), and the board's anonymous route is
       the one people actually need to be told about at the moment they are
       about to type. */
    var privacy = el('div', 'msg-privacy-note',
      'The instructor can see who you are here. To stay anonymous, post on the ' +
      'board with Post anonymously ticked instead.');
    foot.appendChild(privacy);

    var composer = el('div', 'msg-composer');
    var ta = el('textarea', 'textarea');
    ta.rows = 1;
    ta.setAttribute('aria-label', 'Write a message');
    ta.placeholder = 'Write a message…  (Enter to send, Shift+Enter for a new line)';
    ta.addEventListener('input', autoGrow);
    ta.addEventListener('keydown', onComposerKey);
    composer.appendChild(ta);

    var send = el('button', 'btn btn-primary btn-sm', 'Send');
    send.type = 'button';
    send.addEventListener('click', function () { doSend(); });
    composer.appendChild(send);
    foot.appendChild(composer);

    /* The honest cadence line. See the header note on why this is not
       decoration. */
    var cadence = el('div', 'chat-panel-cadence');
    var cadenceText = el('span', null, '');
    cadence.appendChild(cadenceText);
    var refresh = el('button', 'btn btn-invisible btn-sm', 'Check now');
    refresh.type = 'button';
    refresh.addEventListener('click', function () {
      if (poller && poller.now) poller.now();
      else if (conv) loadConversation(conv.conversation_id, conv.other, true);
    });
    cadence.appendChild(refresh);
    foot.appendChild(cadence);

    panel.appendChild(foot);

    els = {
      panel: panel, head: head, back: back, title: title, full: full,
      body: body, foot: foot, privacy: privacy, composer: composer,
      textarea: ta, send: send, cadence: cadence, cadenceText: cadenceText,
      refresh: refresh
    };
    return panel;
  }

  function autoGrow() {
    var ta = els && els.textarea;
    if (!ta) return;
    ta.style.height = 'auto';
    /* 6-row cap, matching §9.6's composer spec. */
    var max = 6 * 22 + 20;
    ta.style.height = Math.min(ta.scrollHeight, max) + 'px';
  }

  function onComposerKey(ev) {
    if (ev.key !== 'Enter' && ev.keyCode !== 13) return;
    if (ev.shiftKey) return;                 /* newline */
    ev.preventDefault();
    doSend();
  }

  /* ------------------------------------------------------------------ views */

  function setBusyBody(message) {
    if (!els) return;
    clear(els.body);
    var box = el('div', 'empty-state');
    box.appendChild(el('span', 'spinner'));
    if (message) box.appendChild(el('p', null, message));
    els.body.appendChild(box);
  }

  function setBodyMessage(title, message, actionText, onAction) {
    if (!els) return;
    clear(els.body);
    var box = el('div', 'empty-state');
    box.appendChild(icon('comment-discussion'));
    if (title) box.appendChild(el('h3', null, title));
    if (message) box.appendChild(el('p', null, message));
    if (actionText) {
      var b = el('button', 'btn btn-sm', actionText);
      b.type = 'button';
      b.addEventListener('click', onAction);
      box.appendChild(b);
    }
    els.body.appendChild(box);
  }

  function showList() {
    view = 'list';
    conv = null;
    rows = [];
    pending = [];
    stopPoll();
    if (!els) return;
    els.back.hidden = true;
    els.title.textContent = 'Messages';
    els.foot.hidden = true;
    renderList();
  }

  function renderList() {
    if (!els || view !== 'list') return;
    clear(els.body);

    if (!convs.length) {
      setBodyMessage('No messages yet',
        isInstructor()
          ? 'Conversations appear here as students start them.'
          : 'Start a private conversation with your instructor — useful when a ' +
            'question does not belong on the public board.',
        'Open full page',
        function () { window.location.href = 'messages.html'; });
      return;
    }

    var list = el('ul', 'msg-conv-list');
    convs.forEach(function (c) {
      var li = el('li');
      var item = el('button', 'msg-conv-item');
      item.type = 'button';
      var n = Math.max(0, parseInt(c.unread, 10) || 0);
      if (n > 0) item.classList.add('is-unread');

      var other = c.other || {};
      try {
        var av = ui().avatar ? ui().avatar(other, 28) : null;
        if (av && av.nodeType) item.appendChild(av);
      } catch (e) { /* no avatar helper: the name below still identifies them */ }

      var mid = el('span', 'grow');
      mid.appendChild(el('span', 'msg-conv-name', other.display_name || 'Unknown'));
      if (c.last_excerpt) {
        mid.appendChild(el('span', 'msg-conv-preview', c.last_excerpt));
      }
      item.appendChild(mid);

      if (n > 0) {
        var dot = el('span', 'unread-dot');
        dot.setAttribute('aria-hidden', 'true');
        item.appendChild(dot);
        item.setAttribute('aria-label',
          (other.display_name || 'Conversation') + ', ' + n + ' unread');
      }
      if (c.last_at) item.appendChild(el('span', 'msg-conv-time', relTime(c.last_at)));

      item.addEventListener('click', function () {
        loadConversation(c.conversation_id, other, false);
      });
      li.appendChild(item);
      list.appendChild(li);
    });
    els.body.appendChild(list);
  }

  /* ------------------------------------------------- markdown stack, on demand */

  /* index.html is the ONE page that does not ship marked/purify/highlight in its
     markup, and this is what pays for that. Those three are ~179 KB which a
     defer-everything page must download AND execute before DOMContentLoaded
     fires — and DOMContentLoaded is what boots the board — so on the most-visited
     cold load in the app they sat directly between the student and the first
     threads.list call, for a page that renders no markdown at boot. The bubbles
     below were their only consumer there, so the board dropped the tags and we
     fetch them here instead: opening the panel already costs a messages.list or
     messages.get round trip of ~11 s, and a local sub-second script load hides
     completely inside a wait the student is already having. No new flow run is
     involved — these are same-origin static files, not API calls.

     markdown.js itself is deliberately NOT in this list. Every page that ships
     chat-panel.js also ships markdown.js (index.html keeps it because
     mock-data.js needs Clinic.md.strip() for its card excerpts), and markdown.js
     has no load-time dependency on the vendor libs — it configures marked,
     DOMPurify and hljs lazily on first render, which is the whole reason they can
     arrive this late and still work.

     KaTeX is not fetched either, and that is not an oversight: index.html has
     never loaded katex.min.js, so maths has never been typeset in the panel on
     that page. markdown.js leaves the $…$ source visible, exactly as today. */

  var MD_VENDOR = [
    'assets/vendor/marked.min.js',
    'assets/vendor/purify.min.js',
    'assets/vendor/highlight.min.js'
  ];

  var mdState = 0;                  /* 0 = untried, 1 = in flight, 2 = settled */
  var mdWaiters = [];

  /* available() is the real precondition — marked AND DOMPurify both parsed and
     exposed. Testing for Clinic.md alone would report ready on index.html, where
     markdown.js is present but the three libs it drives are not. */
  function mdReady() {
    try {
      return !!(Clinic.md && typeof Clinic.md.available === 'function' &&
        Clinic.md.available());
    } catch (e) { return false; }
  }

  function mdSettle() {
    mdState = 2;
    var list = mdWaiters;
    mdWaiters = [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](); } catch (e) { /* one bad waiter must not strand the rest */ }
    }
  }

  /* Resolves when the stack is usable OR when it is definitively not going to be.
     It NEVER rejects: a script that 404s has to leave the existing plain-text
     fallback in charge, not take the panel down with it. */
  function ensureMarkdown() {
    return new Promise(function (resolve) {
      /* Instant no-op on every page that already has the libs in its markup, and
         on every open after the first. */
      if (mdState === 2 || mdReady()) { resolve(); return; }
      mdWaiters.push(resolve);
      if (mdState === 1) return;    /* already injecting — two rapid opens, one fetch */
      mdState = 1;

      var i = 0;
      function next() {
        if (i >= MD_VENDOR.length) { mdSettle(); return; }
        var s = document.createElement('script');
        /* async = false is load-bearing. An INJECTED script defaults to
           async = true, which would let purify.min.js execute before
           marked.min.js and leave markdown.js half-armed. This is the same
           ordering rule config.js documents for its document.write()n tag. */
        s.async = false;
        s.src = MD_VENDOR[i++];
        s.onload = next;
        /* Stop at the first failure rather than press on: without marked there is
           nothing for purify to sanitise, and the text fallback is already right. */
        s.onerror = function () { mdSettle(); };
        (document.head || document.body || document.documentElement).appendChild(s);
      }
      try { next(); } catch (e) { mdSettle(); }
    });
  }

  /* --------------------------------------------------------------- bubbles */

  function bubbleFor(msg, isPendingEntry) {
    var mine = isPendingEntry ? true : !!msg.from_me;
    var b = el('div', 'msg-bubble ' + (mine ? 'is-mine' : 'is-theirs'));
    if (msg.client_msg_id) b.setAttribute('data-client-msg-id', msg.client_msg_id);
    if (msg.message_id) b.setAttribute('data-message-id', msg.message_id);

    var text = el('div');
    /* renderInto sanitises, rewrites images and runs the KaTeX pass, and falls
       back to plain text when the vendor libs are absent — never set innerHTML
       from a message body by any other route. */
    try {
      if (Clinic.md && typeof Clinic.md.renderInto === 'function') {
        Clinic.md.renderInto(text, msg.body_md || '');
      } else {
        text.textContent = String(msg.body_md || '');
      }
    } catch (e) { text.textContent = String(msg.body_md || ''); }
    b.appendChild(text);

    var meta = el('span', 'msg-bubble-meta');
    if (isPendingEntry) {
      if (msg.failed) {
        b.classList.add('is-failed');
        meta.textContent = msg.error || 'Not sent. ';
        var retry = el('button', 'msg-retry', 'Try again');
        retry.type = 'button';
        retry.addEventListener('click', function () { retrySend(msg); });
        meta.appendChild(retry);
      } else {
        b.classList.add('is-pending');
        meta.textContent = 'Sending…';
      }
    } else {
      meta.textContent = relTime(msg.created_at);
    }
    b.appendChild(meta);
    return b;
  }

  function renderThread(keepScroll) {
    if (!els || view !== 'conv') return;
    var prevBottom = atBottom();
    clear(els.body);

    var log = el('div', 'msg-log');

    if (stalled) {
      /* §9.5's .msg-poll-stalled: the poller has been failing, so say so and
         offer the manual path rather than letting the panel look up to date. */
      var warn = el('div', 'msg-poll-stalled');
      warn.appendChild(icon('alert'));
      warn.appendChild(el('span', null,
        'Not able to check for new messages right now.'));
      var again = el('button', 'btn btn-sm', 'Retry');
      again.type = 'button';
      again.addEventListener('click', function () {
        if (poller && poller.now) poller.now();
      });
      warn.appendChild(again);
      log.appendChild(warn);
    }

    if (!rows.length && !pending.length) {
      var hint = el('p', 'field-hint');
      hint.textContent = 'No messages in this conversation yet. Say what you need.';
      log.appendChild(hint);
    }

    rows.forEach(function (m) { log.appendChild(bubbleFor(m, false)); });
    pending.forEach(function (p) { log.appendChild(bubbleFor(p, true)); });

    els.body.appendChild(log);
    if (!keepScroll || prevBottom) scrollToEnd();
  }

  function atBottom() {
    if (!els || !els.body) return true;
    var b = els.body;
    return (b.scrollHeight - b.scrollTop - b.clientHeight) < 40;
  }

  function scrollToEnd() {
    if (!els || !els.body) return;
    els.body.scrollTop = els.body.scrollHeight;
  }

  function setCadenceText() {
    if (!els) return;
    var secs = Math.round(pollIntervalMs() / 1000);
    els.cadenceText.textContent = 'Checking for replies every ' + secs + ' seconds.';
  }

  /* ------------------------------------------------------------------ data */

  function loadInbox() {
    if (loading) return;
    loading = true;
    var myGen = gen;
    setBusyBody('Loading your messages…');
    api().call('messages.list', {}).then(function (data) {
      loading = false;
      if (stale(myGen)) return;
      data = data || {};
      convs = (data.conversations || []).slice(0).sort(function (a, b) {
        return String(b.last_at || '').localeCompare(String(a.last_at || ''));
      });

      /* Keep the badge and the FAB honest from a payload we already paid for —
         unread.set() costs nothing and is the fourth of unread.js's four
         refresh events. */
      try {
        if (unread().set) {
          unread().set(data.unread_total, data.conversations || []);
        }
      } catch (e) { /* ignore */ }

      /* A student has exactly one conversation (§4.3). Opening it directly saves
         them a tap on a list of one. The instructor gets the list. */
      if (convs.length === 1 && !isInstructor()) {
        loadConversation(convs[0].conversation_id, convs[0].other, false);
        return;
      }
      showList();
    }, function (err) {
      loading = false;
      if (isUnknownAction(err)) { goInert(err); return; }
      if (err && err.code === 'unauthorized') { closePanel(); return; }
      if (err && err.code === 'forbidden') { goInert(err); return; }
      if (stale(myGen)) return;
      setBodyMessage('Could not load messages', errText(err), 'Try again', loadInbox);
    });
  }

  function loadConversation(cid, other, quiet) {
    if (!cid) return;
    var myGen = gen;
    view = 'conv';
    conv = { conversation_id: cid, other: other || {} };
    rows = [];
    pending = [];
    stalled = false;
    if (els) {
      els.back.hidden = !(convs.length > 1 || isInstructor());
      els.title.textContent = (conv.other.display_name || 'Conversation');
      els.foot.hidden = false;
      /* The privacy note is for the person who can be identified by it. The
         instructor already knows who they are talking to. */
      els.privacy.hidden = isInstructor();
      setCadenceText();
    }
    if (!quiet) setBusyBody('Opening…');

    api().call('messages.get', { conversation_id: cid }).then(function (data) {
      /* THE GUARD THAT MATTERS MOST IN THIS FILE. Without it a panel closed
         during this call still reached startPoll() below and kept a live poller
         forever. See the note on `gen`. */
      if (stale(myGen) || !conv || conv.conversation_id !== cid) return;
      data = data || {};
      if (data.other && data.other.display_name && els) {
        conv.other = data.other;
        els.title.textContent = data.other.display_name;
      }
      rows = (data.messages || []).slice(0);
      /* Paint, mark read and start the poller UNCONDITIONALLY — none of them may
         wait on a <script> element, which can hang without ever firing onload or
         onerror and would strand the panel on "Opening…" for good. ensureMarkdown()
         was started when the panel opened and this call has just spent ~11 s, so on
         index.html the libs have landed and the first paint below is already
         markdown; the upgrade below only exists for the rare case where they have
         not, and it re-renders once rather than leaving fallback bubbles behind.
         The mdState test is not redundant with mdReady(): available() asks only
         for marked and DOMPurify, and the three tags are injected in series, so
         mid-injection both of those can be live while highlight.min.js is still
         downloading. Treating that as "already had markdown" would paint code
         blocks unhighlighted and then skip the upgrade. Requiring the loader to
         have settled means the pages that ship the libs in markup still take the
         no-op path (their state never leaves 0) and a 404'd vendor file still
         latches at 2, so neither gets a pointless extra render. */
      var hadMd = mdReady() && mdState !== 1;
      renderThread(false);
      markRead(cid);
      startPoll(cid);
      if (!hadMd) {
        ensureMarkdown().then(function () {
          if (stale(myGen) || view !== 'conv' || !conv ||
              conv.conversation_id !== cid) return;
          if (mdReady()) renderThread(true);
        });
      }
    }, function (err) {
      if (isUnknownAction(err)) { goInert(err); return; }
      if (err && err.code === 'unauthorized') { closePanel(); return; }
      if (stale(myGen)) return;
      setBodyMessage('Could not open this conversation', errText(err), 'Try again',
        function () { loadConversation(cid, other, false); });
    });
  }

  /* messages.read is fire-and-forget on purpose: its whole job is to move a
     counter, the write takes ~30 s to become readable anyway, and a failure must
     never block reading. The local overlay below is what makes the badge correct
     immediately — see the write-lag overlay note in unread.js. */
  function markRead(cid) {
    var newest = '';
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].created_at) { newest = rows[i].created_at; break; }
    }
    try { if (unread().markSeen) unread().markSeen(cid, newest); } catch (e) { /* ignore */ }
    try {
      if (unread().set) {
        var remaining = 0;
        convs.forEach(function (c) {
          if (c.conversation_id !== cid) remaining += (parseInt(c.unread, 10) || 0);
        });
        unread().set(remaining, []);
      }
    } catch (e) { /* ignore */ }
    try { api().call('messages.read', { conversation_id: cid })['catch'](function () { }); }
    catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------------ poll */

  function pollIntervalMs() {
    if (Clinic.poll && typeof Clinic.poll.secondsFromConfig === 'function') {
      return Clinic.poll.secondsFromConfig('messages_poll_seconds', POLL_FALLBACK_SECONDS);
    }
    return POLL_FALLBACK_SECONDS * 1000;
  }

  function startPoll(cid) {
    stopPoll();
    if (!Clinic.poll || typeof Clinic.poll.create !== 'function') return;

    poller = Clinic.poll.create({
      name: 'chat-panel',
      intervalMs: pollIntervalMs(),
      /* 0 = stop entirely while the tab is hidden. A panel someone left open
         behind another tab must cost nothing at all. */
      hiddenIntervalMs: 0,
      /* The conversation was just fetched by loadConversation(); ticking again
         immediately would be two identical reads in one second. */
      immediate: false,
      fn: function () {
        return api().call('messages.get', { conversation_id: cid });
      },
      onData: function (data) {
        if (!open || view !== 'conv' || !conv || conv.conversation_id !== cid) return;
        var was = stalled;
        stalled = false;
        mergeServerRows((data && data.messages) || []);
        renderThread(true);
        if (was) setCadenceText();
        markSeenOnly(cid);
      },
      onError: function (err) {
        if (isUnknownAction(err)) { goInert(err); return; }
        if (err && err.code === 'unauthorized') { closePanel(); return; }
        /* poll.js is already backing off exponentially. Surface it after the
           first failure so the panel never looks current when it is not. */
        stalled = true;
        if (open && view === 'conv') renderThread(true);
      }
    });
    poller.start();
    setCadenceText();
  }

  function stopPoll() {
    if (!poller) return;
    try { poller.destroy(); } catch (e) { /* ignore */ }
    poller = null;
  }

  /* Seen-mark only, no messages.read round trip: the poller runs every 90 s and
     a write per tick would be pure waste. markRead() does the full job when the
     conversation is opened. */
  function markSeenOnly(cid) {
    var newest = '';
    for (var i = rows.length - 1; i >= 0; i--) {
      if (rows[i] && rows[i].created_at) { newest = rows[i].created_at; break; }
    }
    try { if (unread().markSeen) unread().markSeen(cid, newest); } catch (e) { /* ignore */ }
  }

  /* Dedupe on message_id, and clear a pending entry when its client_msg_id comes
     back from the server — NEVER match on body text. Two identical "thanks!"
     messages are a completely ordinary thing to send, and client_msg_id is the
     entire reason that column exists. */
  function mergeServerRows(incoming) {
    var seen = {};
    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].message_id) seen[String(rows[i].message_id)] = true;
    }
    for (i = 0; i < incoming.length; i++) {
      var m = incoming[i];
      if (!m) continue;
      var id = String(m.message_id || '');
      if (id && seen[id]) continue;
      if (id) seen[id] = true;
      rows.push(m);
      if (m.client_msg_id) dropPending(String(m.client_msg_id));
    }
    rows.sort(function (a, b) {
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
  }

  function dropPending(cmid) {
    for (var i = 0; i < pending.length; i++) {
      if (pending[i].client_msg_id === cmid) { pending.splice(i, 1); return; }
    }
  }

  /* ------------------------------------------------------------------ send */

  function doSend() {
    if (sending || !els || view !== 'conv' || !conv) return;
    var body = String(els.textarea.value || '').trim();
    if (!body) return;
    if (body.length > MAX_BODY) {
      toast('That message is too long — ' + body.length + ' characters, the limit is ' +
        MAX_BODY + '.', 'error');
      return;
    }
    var entry = {
      client_msg_id: newClientMsgId(),
      body_md: body,
      created_at: new Date().toISOString(),
      failed: false,
      error: ''
    };
    els.textarea.value = '';
    autoGrow();
    pending.push(entry);
    renderThread(false);
    postPending(entry);
  }

  function retrySend(entry) {
    if (!entry) return;
    entry.failed = false;
    entry.error = '';
    renderThread(true);
    /* The SAME client_msg_id, deliberately. messages.send filters tbl_Messages
       on it before writing and returns duplicate:true rather than posting twice,
       which is what makes a retry safe after a 502-that-actually-succeeded. */
    postPending(entry);
  }

  function postPending(entry) {
    if (!conv) return;
    sending = true;
    if (els) els.send.disabled = true;

    api().call('messages.send', {
      conversation_id: conv.conversation_id,
      body_md: entry.body_md,
      client_msg_id: entry.client_msg_id
    }).then(function (data) {
      sending = false;
      if (els) els.send.disabled = false;
      data = data || {};
      /* Promote the optimistic bubble to a real one. The next poll would do this
         too, but that is up to 90 s away and the bubble would sit at .62 opacity
         reading "Sending…" the whole time for a message that has landed. */
      dropPending(entry.client_msg_id);
      rows.push({
        message_id: data.message_id || '',
        from_me: true,
        body_md: entry.body_md,
        client_msg_id: entry.client_msg_id,
        created_at: data.created_at || entry.created_at
      });
      renderThread(false);
    }, function (err) {
      sending = false;
      if (els) els.send.disabled = false;
      if (isUnknownAction(err)) { goInert(err); return; }
      if (err && err.code === 'unauthorized') { closePanel(); return; }
      entry.failed = true;
      /* 'network' is the one code that means the write MAY have landed (api.js
         decides it from the status line, before the body). Say so, because
         retrying is safe here and the idempotency key is why. */
      entry.error = (err && err.code === 'network')
        ? 'Not sure that sent. '
        : (errText(err) + ' ');
      renderThread(true);
    });
  }

  /* -------------------------------------------------------------- lifecycle */

  function onKeyDown(ev) {
    if (ev.key !== 'Escape' && ev.keyCode !== 27) return;
    if (!open) return;
    ev.stopPropagation();
    closePanel();
  }

  function openPanel(conversationId) {
    if (!canOpen()) return false;
    if (!document.body) return false;

    if (!root) {
      root = build();
      document.body.appendChild(root);
      document.addEventListener('keydown', onKeyDown, true);
    }
    if (open) return true;

    lastFocus = document.activeElement;
    open = true;
    root.classList.add('is-open');
    if (document.body.classList) document.body.classList.add('has-chat-panel');

    /* Kick the markdown fetch off HERE, before the call below rather than after
       it, so it runs in parallel with a ~11 s messages.list/get and has landed
       long before there is a bubble to paint. On every page but index.html this
       returns immediately without touching the network. */
    ensureMarkdown();

    if (conversationId) loadConversation(conversationId, null, false);
    else loadInbox();

    /* Focus the composer when there is one, otherwise the panel itself, so a
       keyboard user lands inside rather than back at the top of the page. */
    window.setTimeout(function () {
      if (!open || !els) return;
      try {
        if (!els.foot.hidden) els.textarea.focus();
        else root.focus();
      } catch (e) { /* ignore */ }
    }, 30);
    return true;
  }

  function closePanel() {
    if (!open) return;
    open = false;
    /* Bump BEFORE stopPoll(), so anything already in flight is stale the moment
       this function is entered rather than at the end of it. */
    gen++;
    stopPoll();
    if (root) root.classList.remove('is-open');
    if (document.body && document.body.classList) {
      document.body.classList.remove('has-chat-panel');
    }
    /* Back to whatever opened it — the FAB, normally. Without this a keyboard
       user is returned to the top of the document. */
    try { if (lastFocus && lastFocus.focus) lastFocus.focus(); } catch (e) { /* ignore */ }
    lastFocus = null;
  }

  function destroy() {
    closePanel();
    document.removeEventListener('keydown', onKeyDown, true);
    if (root && root.parentNode) root.parentNode.removeChild(root);
    root = null;
    els = null;
    convs = [];
    rows = [];
    pending = [];
    view = 'list';
    conv = null;
  }

  function close() { closePanel(); }

  Clinic.chatPanel = {
    open: openPanel,
    close: close,
    toggle: function () { if (open) closePanel(); else openPanel(); },
    isOpen: function () { return open; },
    destroy: destroy,
    /* introspection, for the console and for tests */
    pollState: function () { return poller && poller.state ? poller.state() : null; }
  };

})(window, document);
