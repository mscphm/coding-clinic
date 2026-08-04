/* ============================================================================
 * thread.js — single discussion view (agent A2)   thread.html?id=t_xxx
 *
 * Thread header (+ accepted-answer chip), OP as the first .comment, replies in
 * a .timeline with ONE level of nesting, votes on the thread and every live
 * post, accept-answer for the thread author or the instructor, reply composer
 * with markdown toolbar / preview / anonymous option, per-comment "Copy link".
 * ==========================================================================*/
(function () {
  'use strict';

  var MAX_BODY = 10000;
  var ANON_HINT = "Classmates see 'Anonymous'. The instructor can see who posted only in the admin export.";

  /* ---------------------------------------------------------------- shims */
  function UI() { return (window.Clinic && window.Clinic.ui) || {}; }
  function API() { return (window.Clinic && window.Clinic.api) || {}; }
  function MD() { return (window.Clinic && window.Clinic.md) || {}; }

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }
  function clear(n) { while (n && n.firstChild) n.removeChild(n.firstChild); }
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
  function fmtDateTime(iso) { try { return UI().fmtDateTime(iso) || ''; } catch (e) { return ''; } }
  function toast(msg, type) { try { UI().toast(msg, type); } catch (e) {} }
  function errText(e) {
    return (e && (e.message || e.error)) || 'Something went wrong. Please try again.';
  }

  /* ==========================================================================
   * MARKDOWN EDITOR (toolbar + Write/Preview)
   * ---------------------------------------------------------------------------
   * Deliberately duplicated in assets/js/pages/new.js and thread.js: page
   * scripts are separate <script defer> files and only one loads per page, so
   * there is nowhere shared to put this without touching another agent's file.
   * KEEP THE TWO COPIES IDENTICAL.
   * ========================================================================*/
  function edFire(ta) {
    var ev;
    try { ev = new Event('input', { bubbles: true }); }
    catch (e) { ev = document.createEvent('Event'); ev.initEvent('input', true, false); }
    ta.dispatchEvent(ev);
  }
  function edSurround(ta, before, after, placeholder) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    var sel = v.slice(s, e) || placeholder || '';
    ta.value = v.slice(0, s) + before + sel + after + v.slice(e);
    var caret = s + before.length;
    ta.focus();
    ta.setSelectionRange(caret, caret + sel.length);
    edFire(ta);
  }
  function edLinePrefix(ta, prefix) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    var ls = v.lastIndexOf('\n', s - 1) + 1;
    var le = v.indexOf('\n', e);
    if (le === -1) le = v.length;
    var repl = v.slice(ls, le).split('\n').map(function (l) {
      return l.indexOf(prefix) === 0 ? l : prefix + l;
    }).join('\n');
    ta.value = v.slice(0, ls) + repl + v.slice(le);
    ta.focus();
    ta.setSelectionRange(ls, ls + repl.length);
    edFire(ta);
  }
  function edCodeBlock(ta) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    var sel = v.slice(s, e) || 'paste your code here';
    var lead = (s > 0 && v.charAt(s - 1) !== '\n') ? '\n' : '';
    var ins = lead + '```python\n' + sel + '\n```\n';
    ta.value = v.slice(0, s) + ins + v.slice(e);
    var start = s + lead.length + 10;              /* just after "```python\n" */
    ta.focus();
    ta.setSelectionRange(start, start + sel.length);
    edFire(ta);
  }
  var MD_TOOLS = [
    { label: 'B', title: 'Bold', fn: function (ta) { edSurround(ta, '**', '**', 'bold text'); } },
    { label: 'I', title: 'Italic', fn: function (ta) { edSurround(ta, '_', '_', 'italic text'); } },
    { sep: true },
    { label: '</>', title: 'Inline code', fn: function (ta) { edSurround(ta, '`', '`', 'code'); } },
    { label: '```', title: 'Code block', fn: function (ta) { edCodeBlock(ta); } },
    { sep: true },
    { label: 'Link', title: 'Link', fn: function (ta) { edSurround(ta, '[', '](https://)', 'link text'); } },
    { label: '• List', title: 'Bulleted list', fn: function (ta) { edLinePrefix(ta, '- '); } }
  ];
  function buildEditor(opts) {
    opts = opts || {};
    var wrap = el('div', 'composer');

    var tabs = el('div', 'md-tabs');
    var tWrite = el('button', 'tab active', 'Write');
    var tPrev = el('button', 'tab', 'Preview');
    tWrite.type = 'button'; tPrev.type = 'button';
    tWrite.setAttribute('aria-selected', 'true');
    tPrev.setAttribute('aria-selected', 'false');
    tabs.appendChild(tWrite);
    tabs.appendChild(tPrev);

    var bar = el('div', 'md-toolbar');

    var ta = el('textarea', 'textarea');
    ta.rows = opts.rows || 10;
    ta.placeholder = opts.placeholder || '';
    if (opts.id) ta.id = opts.id;
    if (opts.maxlength) ta.maxLength = opts.maxlength;
    ta.setAttribute('aria-label', opts.label || 'Markdown editor');

    var prev = el('div', 'md-preview');
    prev.hidden = true;

    MD_TOOLS.forEach(function (t) {
      if (t.sep) { bar.appendChild(el('span', 'md-tool-sep')); return; }
      var b = el('button', null, t.label);
      b.type = 'button';
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      b.addEventListener('click', function () { showWrite(); t.fn(ta); });
      bar.appendChild(b);
    });

    function showWrite() {
      tWrite.classList.add('active'); tPrev.classList.remove('active');
      tWrite.setAttribute('aria-selected', 'true'); tPrev.setAttribute('aria-selected', 'false');
      ta.hidden = false; bar.hidden = false; prev.hidden = true;
    }
    function showPreview() {
      tPrev.classList.add('active'); tWrite.classList.remove('active');
      tPrev.setAttribute('aria-selected', 'true'); tWrite.setAttribute('aria-selected', 'false');
      ta.hidden = true; bar.hidden = true; prev.hidden = false;
      var md = MD();
      if (md && typeof md.renderInto === 'function') md.renderInto(prev, ta.value);
      else { clear(prev); prev.appendChild(el('pre', null, ta.value)); }
    }
    tWrite.addEventListener('click', showWrite);
    tPrev.addEventListener('click', showPreview);

    ta.addEventListener('keydown', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var k = String(ev.key || '').toLowerCase();
      if (k === 'b') { ev.preventDefault(); edSurround(ta, '**', '**', 'bold text'); }
      else if (k === 'i') { ev.preventDefault(); edSurround(ta, '_', '_', 'italic text'); }
    });

    wrap.appendChild(tabs);
    wrap.appendChild(bar);
    wrap.appendChild(ta);
    wrap.appendChild(prev);
    if (opts.footer) wrap.appendChild(opts.footer);
    return { root: wrap, textarea: ta, preview: prev, showWrite: showWrite };
  }
  /* ==================================================== end shared editor === */

  /* ------------------------------------------------------------ page state */
  var threadId = new URLSearchParams(location.search).get('id') || '';
  var me = null;
  var model = { thread: null, posts: [] };
  var voted = {};                /* target_id -> true                        */
  var topContrib = {};           /* user_id -> true, all-time top 3          */
  var replyParent = '';          /* '' = top-level reply                     */
  var draft = { body: '', anon: false };
  var editor = null;
  var anonBox = null;
  var busy = false;

  function isInstructor() { return !!(me && me.role === 'instructor'); }
  function isMe(author) { return !!(me && author && author.user_id && author.user_id === me.user_id); }

  /* "Did I start this thread?" — ThreadCard/ThreadFull carry `mine`, which is
     true even for anonymous threads where `author` is masked to "anon" (so the
     author keeps their own accept button and booking link without being
     unmasked to anyone else). Fall back to matching the author id when an
     older payload has no `mine` field. */
  function isThreadAuthor() {
    var t = model.thread;
    if (!t) return false;
    return t.mine === true || isMe(t.author);
  }
  function normAuthor(a) {
    /* anonymous posts arrive already masked; render them with the anon avatar */
    if (!a || !a.user_id || a.user_id === 'anon') {
      return { user_id: 'anon', display_name: 'Anonymous' };
    }
    return { user_id: a.user_id, display_name: a.display_name || 'Unknown' };
  }
  function labelsOf(t) {
    return Array.isArray(t.labels) ? t.labels : (t.labels ? String(t.labels).split(',') : []);
  }
  function answered() {
    var t = model.thread;
    return !!(t && (t.status === 'answered' || t.accepted || t.accepted_post_id));
  }

  /* -------------------------------------------------------------- helpers */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      } catch (e) { reject(e); }
    });
  }

  /* scroll to a comment and pulse it — used by #post_id links and after posting */
  function flash(id) {
    var n = id && document.getElementById(id);
    if (!n) return;
    /* instant, not smooth: some engines (and reduced-motion settings) turn a
       smooth scrollIntoView into no scroll at all, which would strand the
       reader above the comment they followed a link to. */
    try { n.scrollIntoView({ block: 'center' }); }
    catch (e) { n.scrollIntoView(); }
    var before = n.style.boxShadow;
    n.style.transition = 'box-shadow .25s ease';
    n.style.boxShadow = '0 0 0 3px var(--focus-ring)';
    setTimeout(function () { n.style.boxShadow = before; }, 2400);
  }

  /* re-applied after every re-render, since a render replaces the element the
     highlight was painted on */
  function flashHash() {
    if (!location.hash || location.hash.length < 2) return;
    var id;
    try { id = decodeURIComponent(location.hash.slice(1)); }
    catch (e) { id = location.hash.slice(1); }
    setTimeout(function () { flash(id); }, 60);
  }

  function postLink(postId) {
    var base = location.origin + location.pathname + location.search;
    return postId ? base + '#' + postId : base;
  }

  /* ---------------------------------------------------------- vote button */
  function voteButton(targetType, targetId, count, selfOwned) {
    var b = el('button', 'vote-btn');
    b.type = 'button';
    b.appendChild(icon('arrow-up'));
    var num = el('span', null, String(Number(count) || 0));
    b.appendChild(num);

    function paint(on, n) {
      num.textContent = String(n);
      b.classList[on ? 'add' : 'remove']('voted');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = selfOwned ? 'You cannot upvote your own post'
                          : (on ? 'Remove your upvote' : 'Upvote');
      b.setAttribute('aria-label', b.title + ' — ' + n + ' so far');
    }
    paint(!!voted[targetId], Number(count) || 0);

    b.addEventListener('click', function () {
      if (selfOwned) { toast('You cannot upvote your own post.', 'error'); return; }
      if (b.disabled) return;

      var wasOn = !!voted[targetId];
      var wasN = Number(num.textContent) || 0;
      var nowOn = !wasOn;
      var nowN = Math.max(0, wasN + (nowOn ? 1 : -1));

      voted[targetId] = nowOn;                       /* optimistic */
      paint(nowOn, nowN);
      b.disabled = true;

      API().call('votes.toggle', { target_type: targetType, target_id: targetId })
        .then(function (res) {
          b.disabled = false;
          var on = (res && typeof res.voted !== 'undefined') ? !!res.voted : nowOn;
          var n = (res && typeof res.count !== 'undefined') ? Number(res.count) : nowN;
          voted[targetId] = on;
          paint(on, n);
          /* keep the model in step so a re-render shows the same numbers */
          if (targetType === 'thread') {
            if (model.thread) model.thread.upvotes = n;
          } else {
            model.posts.forEach(function (p) { if (p.post_id === targetId) p.upvotes = n; });
          }
        })['catch'](function (e) {
          b.disabled = false;
          voted[targetId] = wasOn;
          paint(wasOn, wasN);
          if (e && e.code === 'unauthorized') return;
          toast(errText(e), 'error');
        });
    });
    return b;
  }

  /* ----------------------------------------------------------- kebab menu */
  function kebab(url) {
    var wrap = el('span');
    wrap.style.position = 'relative';

    var btn = el('button', 'btn btn-sm btn-icon');
    btn.type = 'button';
    btn.title = 'More options';
    btn.setAttribute('aria-label', 'More options');
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.appendChild(icon('kebab'));

    var menu = el('div', 'menu-dropdown');
    menu.setAttribute('role', 'menu');
    menu.hidden = true;

    var copy = el('button', 'menu-item');
    copy.type = 'button';
    copy.setAttribute('role', 'menuitem');
    copy.appendChild(icon('link'));
    copy.appendChild(el('span', null, 'Copy link'));
    copy.addEventListener('click', function () {
      close();
      copyText(url).then(function () {
        toast('Link copied.', 'success');
      })['catch'](function () {
        toast('Could not copy automatically — the link is ' + url, 'error');
      });
    });
    menu.appendChild(copy);

    function onDoc(ev) { if (!wrap.contains(ev.target)) close(); }
    function onKey(ev) { if (ev.key === 'Escape') { close(); btn.focus(); } }
    function open() {
      menu.hidden = false;
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('click', onDoc, true);
      document.addEventListener('keydown', onKey, true);
    }
    function close() {
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    }
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (menu.hidden) open(); else close();
    });

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    return wrap;
  }

  /* -------------------------------------------------------------- comment */
  /* o = {domId, author, created_at, body_md, deleted, accepted, nested, opBadge,
   *      voteType, voteId, upvotes, selfOwned, canAccept, onAccept,
   *      canReply, onReply, link} */
  function commentEl(o) {
    var box = el('div', 'comment' +
      (o.nested ? ' comment-nested' : '') +
      (o.accepted ? ' comment-accepted' : ''));
    if (o.domId) box.id = o.domId;

    /* "Marked as answer" strip must be the first child (see main.css §10) */
    if (o.accepted) {
      var strip = el('div', 'answer-strip');
      strip.appendChild(icon('check-circle'));
      strip.appendChild(el('span', null, 'Marked as answer ✓'));
      box.appendChild(strip);
    }

    var head = el('div', 'comment-header');
    var author = normAuthor(o.author);
    head.appendChild(avatar(author));
    head.appendChild(el('span', 'comment-author', author.display_name));

    if (topContrib[author.user_id]) {
      var tc = el('span', 'badge-top-contrib');
      tc.title = 'Top 3 all-time contributor';
      tc.appendChild(icon('trophy'));
      tc.appendChild(el('span', null, 'Top contributor'));
      head.appendChild(tc);
    }
    if (o.opBadge) {
      var ob = el('span', 'pill', 'Author');
      ob.title = 'Started this discussion';
      head.appendChild(ob);
    }

    var when = el('span', 'comment-time', o.created_at ? relTime(o.created_at) : '');
    if (o.created_at) when.title = fmtDateTime(o.created_at);
    head.appendChild(when);

    var actions = el('span', 'comment-actions');
    if (!o.deleted) {
      actions.appendChild(voteButton(o.voteType, o.voteId, o.upvotes, o.selfOwned));
      if (o.canAccept) {
        var ab = el('button', 'accept-btn');
        ab.type = 'button';
        ab.title = 'Mark this reply as the answer';
        ab.appendChild(icon('check-circle'));
        ab.appendChild(el('span', null, 'Mark as answer'));
        ab.addEventListener('click', function () { o.onAccept(ab); });
        actions.appendChild(ab);
      }
      if (o.canReply) {
        var rb = el('button', 'btn btn-sm btn-invisible', 'Reply');
        rb.type = 'button';
        rb.addEventListener('click', o.onReply);
        actions.appendChild(rb);
      }
    }
    actions.appendChild(kebab(o.link));
    head.appendChild(actions);
    box.appendChild(head);

    if (o.deleted) {
      box.appendChild(el('div', 'comment-removed', '[removed by instructor]'));
    } else {
      var body = el('div', 'comment-body');
      var md = MD();
      if (md && typeof md.renderInto === 'function') md.renderInto(body, o.body_md || '');
      else body.appendChild(el('pre', null, o.body_md || ''));
      box.appendChild(body);
    }

    return box;
  }

  /* -------------------------------------------------------------- actions */
  function acceptPost(postId, btn) {
    if (busy) return;
    busy = true;
    if (btn) btn.disabled = true;

    API().call('threads.accept', { thread_id: threadId, post_id: postId })
      .then(function () {
        busy = false;
        var t = model.thread;
        t.status = 'answered';
        t.accepted = true;
        t.accepted_post_id = postId;
        if (!t.resolved_via) t.resolved_via = 'async';
        model.posts.forEach(function (p) { p.is_accepted = (p.post_id === postId); });
        render();
        flash(postId);
        toast('Marked as the answer.', 'success');
      })['catch'](function (e) {
        busy = false;
        if (btn) btn.disabled = false;
        if (e && e.code === 'unauthorized') return;
        toast(errText(e), 'error');
      });
  }

  function submitReply(btn, errBox) {
    if (busy) return;
    var body = (editor ? editor.textarea.value : '').trim();
    var anon = !!(anonBox && anonBox.checked);

    function fail(msg) {
      if (errBox) {
        clear(errBox);
        errBox.appendChild(el('span', null, msg));
        errBox.removeAttribute('hidden');
      }
      toast(msg, 'error');
    }
    if (!body) return fail('Write something before posting.');
    if (body.length > MAX_BODY) {
      return fail('Reply is ' + body.length + ' characters — the limit is ' + MAX_BODY + '.');
    }
    if (errBox) { clear(errBox); errBox.setAttribute('hidden', 'hidden'); }

    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Posting…'; }

    var payload = { thread_id: threadId, body_md: body, is_anonymous: anon };
    if (replyParent) payload.parent_post_id = replyParent;

    API().call('posts.create', payload)
      .then(function (res) {
        busy = false;
        draft.body = '';
        draft.anon = anon;                 /* the choice stays put on this page */
        replyParent = '';
        var newId = res && res.post_id;
        return reload().then(function () {
          if (newId) flash(newId);
          toast('Reply posted.', 'success');
        });
      })['catch'](function (e) {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Comment'; }
        if (e && e.code === 'unauthorized') return;
        fail(errText(e));
      });
  }

  /* --------------------------------------------------------------- render */
  function threadHeader() {
    var t = model.thread;
    var wrap = el('div', 'thread-header');

    var back = el('a', 'field-hint mt-0 mb-8', '← Back to discussions');
    back.href = 'index.html';
    back.style.display = 'inline-block';
    wrap.appendChild(back);

    var h1 = el('h1', 'thread-title', t.title || '(untitled)');
    wrap.appendChild(h1);

    var sub = el('div', 'thread-sub');
    if (t.pinned) sub.appendChild(el('span', 'badge-pinned', 'Pinned'));
    sub.appendChild(answered()
      ? el('span', 'badge-answered', 'Answered')
      : el('span', 'badge', 'Open'));

    var a = normAuthor(t.author);
    sub.appendChild(avatar(a));
    var byline = el('span', null, a.display_name + ' asked ' + relTime(t.created_at));
    if (t.created_at) byline.title = fmtDateTime(t.created_at);
    sub.appendChild(byline);

    if (t.category) {
      var cp = el('a', 'pill pill-category', t.category);
      cp.href = 'index.html?category=' + encodeURIComponent(t.category);
      cp.title = 'See everything in ' + t.category;
      sub.appendChild(cp);
    }
    labelsOf(t).forEach(function (raw) {
      var l = String(raw).trim();
      if (!l) return;
      var p = pill(l);
      if (p.tagName === 'A') p.href = 'index.html?label=' + encodeURIComponent(l);
      else {
        p.setAttribute('role', 'link');
        p.setAttribute('tabindex', '0');
        p.style.cursor = 'pointer';
        var go = function () { location.href = 'index.html?label=' + encodeURIComponent(l); };
        p.addEventListener('click', go);
        p.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') { ev.preventDefault(); go(); }
        });
      }
      p.title = 'See everything labelled ' + l;
      sub.appendChild(p);
    });
    wrap.appendChild(sub);

    /* jump-to-answer chip */
    if (t.accepted_post_id) {
      var row = el('div', 'row mt-8');
      var chip = el('a', 'badge-answered');
      chip.href = '#' + t.accepted_post_id;
      chip.appendChild(icon('check-circle'));
      chip.appendChild(el('span', null, 'Answered — jump to the accepted answer'));
      chip.addEventListener('click', function (ev) {
        ev.preventDefault();
        try { history.replaceState(null, '', '#' + t.accepted_post_id); } catch (e) {}
        flash(t.accepted_post_id);
      });
      row.appendChild(chip);
      wrap.appendChild(row);
    }

    /* clinic booking is only offered to the person who asked */
    if (isThreadAuthor()) {
      var bookRow = el('div', 'row mt-8');
      var link = el('a', 'btn btn-sm');
      link.href = 'booking.html?thread=' + encodeURIComponent(t.thread_id);
      link.appendChild(icon('calendar'));
      link.appendChild(el('span', null, 'Book a clinic slot about this thread'));
      bookRow.appendChild(link);
      wrap.appendChild(bookRow);
    }

    return wrap;
  }

  function composer() {
    var box = el('div', 'reply-box');
    box.id = 'composer-box';

    var head = el('div', 'row');
    head.appendChild(el('h2', 'mb-0', replyParent ? 'Write a reply' : 'Join the discussion'));
    if (replyParent) {
      var to = null;
      model.posts.forEach(function (p) { if (p.post_id === replyParent) to = p; });
      head.appendChild(el('span', 'field-hint mt-0',
        'Replying to ' + (to ? normAuthor(to.author).display_name : 'a comment')));
      var cancel = el('button', 'btn btn-sm btn-invisible', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', function () {
        draft.body = editor ? editor.textarea.value : draft.body;
        replyParent = '';
        render();
        var ta = $('reply-body');
        if (ta) ta.focus();
      });
      head.appendChild(cancel);
    }
    box.appendChild(head);

    /* composer footer: anonymity + submit */
    var foot = el('div', 'composer-footer');
    var cbRow = el('div', 'checkbox-row');
    anonBox = el('input');
    anonBox.type = 'checkbox';
    anonBox.id = 'reply-anon';
    anonBox.checked = !!draft.anon;
    var lab = el('label', null, 'Post anonymously');
    lab.setAttribute('for', 'reply-anon');
    cbRow.appendChild(anonBox);
    cbRow.appendChild(lab);
    foot.appendChild(cbRow);
    foot.appendChild(el('span', 'grow'));
    var send = el('button', 'btn btn-sm btn-primary', 'Comment');
    send.type = 'button';
    foot.appendChild(send);

    editor = buildEditor({
      id: 'reply-body',
      rows: 6,
      label: 'Reply',
      maxlength: MAX_BODY,
      footer: foot,
      placeholder: 'Answer the question, or add what you have found so far. Ctrl+Enter posts.'
    });
    editor.textarea.value = draft.body || '';
    box.appendChild(editor.root);

    box.appendChild(el('div', 'field-hint', ANON_HINT));

    var err = el('div', 'form-error');
    err.setAttribute('role', 'alert');
    err.setAttribute('hidden', 'hidden');
    box.appendChild(err);

    send.addEventListener('click', function () { submitReply(send, err); });
    anonBox.addEventListener('change', function () { draft.anon = anonBox.checked; });
    editor.textarea.addEventListener('input', function () { draft.body = editor.textarea.value; });
    editor.textarea.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
        ev.preventDefault();
        submitReply(send, err);
      }
    });

    return box;
  }

  function render() {
    var root = $('thread-root');
    if (!root || !model.thread) return;
    var t = model.thread;
    clear(root);

    document.title = (t.title || 'Discussion') + ' · NUS Coding Clinic';

    root.appendChild(threadHeader());

    /* --- the question itself, as the first comment --- */
    root.appendChild(commentEl({
      domId: t.thread_id,
      author: t.author,
      created_at: t.created_at,
      body_md: t.body_md || '',
      voteType: 'thread',
      voteId: t.thread_id,
      upvotes: t.upvotes,
      selfOwned: isMe(t.author),
      link: postLink('')
    }));

    /* --- replies, one level of nesting --- */
    var posts = (model.posts || []).slice().sort(function (a, b) {
      return String(a.created_at || '').localeCompare(String(b.created_at || ''));
    });
    var byId = {};
    posts.forEach(function (p) { byId[p.post_id] = p; });

    var tops = [], kids = {};
    posts.forEach(function (p) {
      /* a child whose parent is missing is promoted to top level */
      var parent = (p.parent_post_id && byId[p.parent_post_id]) ? p.parent_post_id : '';
      if (parent) (kids[parent] = kids[parent] || []).push(p);
      else tops.push(p);
    });

    var canAccept = (isThreadAuthor() || isInstructor());

    function postEl(p, nested) {
      var accepted = !!(p.is_accepted || (t.accepted_post_id && t.accepted_post_id === p.post_id));
      return commentEl({
        domId: p.post_id,
        author: p.author,
        created_at: p.created_at,
        body_md: p.body_md || '',
        deleted: !!p.deleted,
        accepted: accepted,
        nested: !!nested,
        opBadge: !!(t.author && p.author && p.author.user_id &&
                    p.author.user_id !== 'anon' && t.author.user_id === p.author.user_id),
        voteType: 'post',
        voteId: p.post_id,
        upvotes: p.upvotes,
        selfOwned: isMe(p.author),
        canAccept: canAccept && !nested && !p.deleted && !accepted,
        onAccept: function (btn) { acceptPost(p.post_id, btn); },
        canReply: !nested && !p.deleted,
        onReply: function () {
          draft.body = editor ? editor.textarea.value : draft.body;
          replyParent = p.post_id;
          render();
          var ta = $('reply-body');
          if (ta) {
            ta.focus();
            try { ta.scrollIntoView({ block: 'center' }); } catch (e) {}
          }
        },
        link: postLink(p.post_id)
      });
    }

    var timeline = el('div', 'timeline mt-16');
    if (!tops.length) {
      timeline.appendChild(el('div', 'field-hint mt-0', 'No replies yet — be the first to help.'));
    } else {
      tops.forEach(function (p) {
        timeline.appendChild(postEl(p, false));
        (kids[p.post_id] || []).forEach(function (c) { timeline.appendChild(postEl(c, true)); });
      });
    }
    root.appendChild(timeline);

    root.appendChild(composer());
  }

  function bigMessage(title, msg, actionText, onAction) {
    var root = $('thread-root');
    if (!root) return;
    clear(root);
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
    root.appendChild(box);
  }

  function notFound() {
    bigMessage(
      'Discussion not found',
      'This discussion does not exist, or the instructor has removed it.',
      'Back to discussions',
      function () { location.href = 'index.html'; }
    );
  }

  /* SPEC §8 asks for the "Top contributor" badge in threads as well as on the
     home page, but threads.get carries no contrib data. Fetch the aggregate
     after the thread is on screen (never blocking it) and only re-render when
     somebody visible actually earns a badge. */
  function loadTopContributors() {
    API().call('threads.list', {}).then(function (res) {
      var rows = (res && res.contrib) || [];
      topContrib = {};
      rows.map(function (c) {
        return {
          user_id: c.user_id,
          score: (Number(c.replies) || 0) * 2 +
                 (Number(c.accepted) || 0) * 5 +
                 (Number(c.upvotes_received) || 0) * 1
        };
      }).filter(function (c) {
        return c.score > 0 && c.user_id && c.user_id !== 'anon';
      }).sort(function (a, b) {
        return b.score - a.score;
      }).slice(0, 3).forEach(function (c) { topContrib[c.user_id] = true; });

      var visible = [];
      if (model.thread && model.thread.author) visible.push(model.thread.author.user_id);
      (model.posts || []).forEach(function (p) { if (p.author) visible.push(p.author.user_id); });
      if (visible.some(function (u) { return topContrib[u]; })) { render(); flashHash(); }
    })['catch'](function () { /* badges are decoration — never block the thread */ });
  }

  function absorb(d) {
    model.thread = d && d.thread;
    model.posts = (d && d.posts) || [];
    voted = {};
    ((d && d.my_votes) || []).forEach(function (id) { voted[id] = true; });
  }

  function reload() {
    return API().call('threads.get', { thread_id: threadId }).then(function (d) {
      absorb(d);
      if (!model.thread) { notFound(); return; }
      render();
    });
  }

  function boot() {
    var api = API();
    if (!api || typeof api.call !== 'function') return;
    try {
      if (api.requireLogin && api.requireLogin() === false) return;
    } catch (e) { return; }

    try { if (UI().renderHeader) UI().renderHeader('discussions'); } catch (e) {}

    if (!threadId) {
      bigMessage('No discussion selected',
        'That link is missing a discussion id. Pick one from the list.',
        'Back to discussions', function () { location.href = 'index.html'; });
      return;
    }

    /* api.bootstrap() answers from the localStorage cache first, so its `user`
       can lag a session change (login as somebody else without logging out).
       clinic_user is rewritten by every auth grant AND every bootstrap refresh,
       so it is never staler — prefer it, and re-render if the refresh disagrees.
       Getting this wrong would show accept/booking controls to the wrong person. */
    function currentUser(boot) {
      var stored = (typeof api.getUser === 'function') ? api.getUser() : null;
      return stored || (boot && boot.user) || null;
    }

    window.addEventListener('clinic:bootstrap', function (ev) {
      var fresh = ev && ev.detail && ev.detail.user;
      if (!fresh || !model.thread) return;
      if (!me || me.user_id !== fresh.user_id || me.role !== fresh.role) {
        me = fresh;
        render();
      }
    });

    var bootP = (typeof api.bootstrap === 'function')
      ? api.bootstrap()
      : api.call('meta.bootstrap', {});

    Promise.all([bootP, api.call('threads.get', { thread_id: threadId })])
      .then(function (res) {
        me = currentUser(res[0]);
        absorb(res[1]);
        if (!model.thread) { notFound(); return; }
        render();
        flashHash();
        loadTopContributors();
      })['catch'](function (e) {
        if (e && e.code === 'unauthorized') return;      /* api.js already bounced */
        if (e && e.code === 'not_found') { notFound(); return; }
        bigMessage('Could not load this discussion', errText(e), 'Try again',
          function () { location.reload(); });
        toast(errText(e), 'error');
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
