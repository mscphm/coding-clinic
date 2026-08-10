/* ============================================================================
 * thread.js — single discussion view (agent A2)   thread.html?id=t_xxx
 *
 * Thread header (+ accepted-answer chip), OP as the first .comment, replies in
 * a .timeline with ONE level of nesting, votes on the thread and every live
 * post, accept-answer for the thread author or the instructor, reply composer
 * with markdown toolbar / preview / anonymous option, per-comment "Copy link".
 *
 * v3 (owner F7) adds, all of it absent-tolerant:
 *   D9  instructor badge on the byline and on every non-anonymous post, driven
 *       by config.instructor_ids — never by a role on the author payload.
 *   D10 endorsement ribbon + the instructor's endorse/un-endorse control, kept
 *       visually and semantically apart from the asker's accepted answer.
 *   D12 lock / unlock, D13 mark / clear duplicate, both through admin.moderate.
 *   D14 archive_mode — the whole board read-only, explained rather than failed.
 *
 * THE DEGRADATION RULE, which shapes every read below: the backend may not have
 * been re-imported yet. `locked`, `duplicate_of`, `endorsed`, `instructor_ids`
 * and `archive_mode` may all simply be missing. Every one of them is read
 * through ui.truthy()/`|| ''`, so absent means "off" and the page renders
 * EXACTLY as it did in v2 — no badge, no ribbon, no banner, no console error.
 * ==========================================================================*/
(function () {
  'use strict';

  var MAX_BODY = 10000;
  var ANON_HINT = "Classmates see 'Anonymous'. The instructor can see who posted only in the admin export.";

  /* One feature name for all four v3 moderation ops. They ship in the same
     admin flow import, so one probe answers for all of them: the first
     "unknown action" turns the whole control set inert for the session rather
     than letting the instructor click four buttons that each fail once. */
  var MOD_FEATURE = 'moderate_v3';

  /* Backoff schedules for the Excel Online write/read propagation lag (see
     bug ticket): a write can take up to ~30s, occasionally longer, before it
     is visible to a subsequent read. Every wait below is non-blocking. */
  var NOT_FOUND_RETRY_DELAYS_MS = [2000, 4000, 6000, 8000, 10000, 10000, 10000];
  var REPLY_CONFIRM_DELAYS_MS = [1500, 3000];

  /* ==========================================================================
   * OPTIMISTIC RENDER STASH  (PERF FIX 1)
   * ---------------------------------------------------------------------------
   * The measured problem: a reply used to cost ELEVEN sequential Excel round
   * trips best case and twenty-three plus 4.5 s of deliberate sleeping worst
   * case, because posts.create resolving was not trusted — the page re-fetched
   * threads.get (6 calls each) up to twice to "confirm" the row it had just
   * written. It is confirmed: a resolved posts.create means add_post succeeded.
   *
   * So the reply is now drawn locally from the response and a reply costs ONE
   * flow run. The ~30 s Excel write/read propagation lag has NOT gone away —
   * this moves the cost off the critical path, it does not deny it. What used
   * to be paid in a spinner is now paid in a stash:
   *
   *   posts   the just-written reply, so a refresh inside the propagation
   *           window still shows it instead of appearing to swallow it
   *   thread  the just-created thread, written by new.js, so thread.html paints
   *           instantly instead of running the up-to-50 s retry ladder
   *
   * RECONCILIATION IS BY id, ALWAYS. A stashed row is merged only when the
   * server has NOT returned that id yet, and is dropped the moment it has, so
   * nothing is ever drawn twice. Entries expire on their own (STASH_TTL_MS) so
   * a row that never lands cannot haunt the page forever.
   *
   * sessionStorage throws outright in some privacy modes. Every access below is
   * wrapped and every failure degrades to "no stash" — i.e. to exactly the
   * pre-fix behaviour, retry ladders and all. It must never break the page.
   * ========================================================================*/
  var STASH_NEW_THREAD = 'clinic_new_thread_v1';
  var STASH_PENDING_POSTS = 'clinic_pending_posts_v1';
  var STASH_TTL_MS = 10 * 60 * 1000;

  function ssRead(key) {
    try {
      var raw = window.sessionStorage.getItem(key);
      if (!raw) return null;
      var v = JSON.parse(raw);
      return (v && typeof v === 'object') ? v : null;
    } catch (e) { return null; }
  }
  function ssWrite(key, value) {
    try { window.sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota, private mode */ }
  }
  function ssRemove(key) {
    try { window.sessionStorage.removeItem(key); } catch (e) { /* private mode */ }
  }
  function stashFresh(at) {
    var t = Number(at) || 0;
    return t > 0 && (Date.now() - t) < STASH_TTL_MS;
  }

  /* ---- pending replies, keyed by thread id ---- */
  function pendingBox() {
    var box = ssRead(STASH_PENDING_POSTS) || {};
    var keys = Object.keys(box);
    var dirty = false;
    for (var i = 0; i < keys.length; i++) {
      var slot = box[keys[i]];
      if (!slot || !stashFresh(slot.at) || !Array.isArray(slot.posts)) {
        delete box[keys[i]];
        dirty = true;
      }
    }
    if (dirty) ssWrite(STASH_PENDING_POSTS, box);
    return box;
  }
  function pendingFor(tid) {
    var slot = pendingBox()[tid];
    return (slot && Array.isArray(slot.posts)) ? slot.posts : [];
  }
  function pendingAdd(tid, post) {
    var box = pendingBox();
    var slot = box[tid] || { at: Date.now(), posts: [] };
    slot.at = Date.now();
    for (var i = 0; i < slot.posts.length; i++) {
      if (slot.posts[i] && slot.posts[i].post_id === post.post_id) return;
    }
    slot.posts.push(post);
    box[tid] = slot;
    ssWrite(STASH_PENDING_POSTS, box);
  }
  function pendingDrop(tid, ids) {
    if (!ids || !ids.length) return;
    var box = pendingBox();
    var slot = box[tid];
    if (!slot || !Array.isArray(slot.posts)) return;
    slot.posts = slot.posts.filter(function (p) {
      return p && ids.indexOf(p.post_id) === -1;
    });
    if (!slot.posts.length) delete box[tid]; else box[tid] = slot;
    ssWrite(STASH_PENDING_POSTS, box);
  }

  /* ---- the just-created thread, written by new.js ---- */
  function newThreadStash(id) {
    var box = ssRead(STASH_NEW_THREAD);
    if (!box || !stashFresh(box.at) || !box.thread) return null;
    if (String(box.thread_id || '') !== String(id)) return null;
    /* Guard against a stash from a different sign-in in the same tab. */
    if (String(box.thread.thread_id || '') !== String(id)) return null;
    return box.thread;
  }
  function dropNewThreadStash(id) {
    var box = ssRead(STASH_NEW_THREAD);
    if (box && String(box.thread_id || '') === String(id)) ssRemove(STASH_NEW_THREAD);
  }

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
   * RETRY / PROPAGATION HELPER
   * ---------------------------------------------------------------------------
   * retryWhile(fn, delaysMs, shouldRetry) calls fn(attempt), and if the
   * settled outcome (value on success, err on failure) says "not yet" per
   * shouldRetry(err, value), waits delaysMs[attempt] — always a setTimeout
   * under a Promise, never a busy wait — and tries again. Once delaysMs is
   * exhausted, the last outcome is returned as-is (resolved value, or the
   * rejection re-thrown). Used both for the "just-created thread not found
   * yet" wait on load and for confirming a new reply has become visible.
   * ========================================================================*/
  function waitMs(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }
  function retryWhile(fn, delaysMs, shouldRetry) {
    function attempt(i) {
      return fn(i).then(function (value) {
        if (i >= delaysMs.length || !shouldRetry(null, value)) return value;
        return waitMs(delaysMs[i]).then(function () { return attempt(i + 1); });
      }, function (err) {
        if (i >= delaysMs.length || !shouldRetry(err, undefined)) throw err;
        return waitMs(delaysMs[i]).then(function () { return attempt(i + 1); });
      });
    }
    return attempt(0);
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
  var allThreads = [];           /* threads.list cache, for the dupe picker  */
  var modBusy = false;           /* one moderation write in flight at a time */

  /* ==========================================================================
   * THE PENDING GATE  (PERF FIX 1, correctness follow-up)
   * ---------------------------------------------------------------------------
   * An optimistically drawn row is REAL — posts.create/threads.create resolved,
   * so it is in the workbook — but it is not yet READABLE: Excel Online takes
   * ~30 s to make a write visible to a subsequent read. Drawing it is safe.
   * Letting the viewer act on it is not, because every action that touches it
   * goes back through a flow that re-reads the table and 404s:
   *
   *   threads.accept   list_posts_a ($filter thread_id) -> f_target_post ->
   *                    chk_a_post   -> {"code":"not_found"}
   *   votes.toggle     list_vt_post / list_vt_thread -> chk_v_target -> ditto
   *   posts.create     list_thread_p -> chk_p_thread -> ditto  (this is the one
   *                    that bites on a STASHED NEW THREAD, whose row is what is
   *                    not readable yet)
   *   admin.moderate   endorse_post is a bare PatchItem keyed on post_id, which
   *                    has to find the row before it can patch it
   *
   * Before FIX 1 the UI gated on readability by accident: no control existed
   * until confirmReplyVisible() had re-fetched and seen the row. Removing that
   * re-fetch removed the accidental gate with it, and the most natural workflow
   * on the platform walks straight into it — an instructor answers a question
   * and immediately marks their own answer as accepted, and is told "That item
   * no longer exists." about a post they are looking at.
   *
   * So the gate is now explicit and deliberate: `pending` is set on the local
   * row, cleared the instant the server returns it, and the two server-round-
   * trip verbs (accept, endorse) plus voting are withheld while it is set.
   * Replying to a pending POST is deliberately still allowed — posts.create
   * writes parent_post_id without validating the parent, and its only read is
   * against tbl_Threads — but replying to a pending THREAD is not, because that
   * read is exactly the one that fails.
   *
   * RECONCILE_DELAY_MS then makes the gate self-clearing for the only people it
   * can inconvenience. See armReconcile().
   * ========================================================================*/
  var PENDING_POST_MSG = 'Just posted — this reply is still saving. Give it a few seconds.';
  var PENDING_THREAD_MSG = 'Just posted — this question is still saving. Give it a few seconds.';
  var RECONCILE_DELAY_MS = 30000;
  var reconcileTimer = null;     /* one-shot, never stacked                   */
  var threadPending = false;     /* the thread row itself is not readable yet */
  var uploadDetach = null;       /* D11: teardown from the last uploads.attach */

  function isInstructor() { return !!(me && me.role === 'instructor'); }
  function isMe(author) { return !!(me && author && author.user_id && author.user_id === me.user_id); }

  /* ======================================================================
   * v3 STATE READS — every one of them absent-tolerant (contract §5)
   * ====================================================================*/

  /* ui.truthy is the ONE mixed-type wire-boolean normaliser (§10.6). Excel
     hands back TRUE / 'TRUE' / 'true' / 1 / '1' for the same column depending
     on how the cell was written, and `if (t.locked)` on the string 'FALSE' is
     true — which would lock every thread on the board. */
  function truthy(v) {
    try { return !!UI().truthy(v); } catch (e) { return v === true || v === 1; }
  }
  function cfg() {
    try { return UI().bootstrapConfig() || {}; } catch (e) { return {}; }
  }
  /* Absent config → false → no banner, writes enabled, page unchanged. */
  function archived() { return truthy(cfg().archive_mode); }
  function threadLocked() { return !!(model.thread && truthy(model.thread.locked)); }
  function duplicateOf() {
    var t = model.thread;
    return (t && t.duplicate_of) ? String(t.duplicate_of).replace(/^\s+|\s+$/g, '') : '';
  }
  /* Mirrors the flow guards in §5.4 exactly: posts and votes are refused on an
     archived board AND on a locked thread; accept-answer is refused on an
     archived board only (marking which existing reply solved it is exactly the
     tidy-up a locked thread wants). The flow rejects the write regardless —
     this is only so the UI explains instead of failing. */
  function canPost() { return !archived() && !threadLocked(); }
  function canAccept() { return !archived(); }

  function isInstructorAuthor(a) {
    try { return !!UI().isInstructorAuthor(a); } catch (e) { return false; }
  }

  /* The FEATURE-ABSENT detector. Prefer api.js's, which is deliberately broader
     than ui.js's /unknown action/i: the live admin flow answers an unknown op
     with "Unknown moderation action." (admin.definition.json:1242), which does
     NOT contain the substring "unknown action". Getting this wrong would leave
     the lock/endorse buttons retrying forever against a flow that will never
     know them. The inline regex is the same one, for the case where an older
     api.js is on the page. */
  function unknownAction(e) {
    var api = API();
    if (api && typeof api.isUnknownAction === 'function') {
      try { return !!api.isUnknownAction(e); } catch (ignore) { /* fall through */ }
    }
    return !!(e && e.code === 'bad_request' &&
      /unknown\s+(?:[a-z]+\s+)?(?:action|op|operation)\b/i.test(e.message || e.error || ''));
  }
  function modAvailable() {
    try { return UI().featureState(MOD_FEATURE) !== 'off'; } catch (e) { return true; }
  }
  function markModAbsent() {
    try { UI().featureOff(MOD_FEATURE); } catch (e) { /* private mode */ }
  }

  /* Every v3 moderation write goes through here, so the "the admin flow has not
     been re-imported yet" answer is handled in exactly one place: turn the
     control set inert for the session, say so once in plain language, and never
     call that action again. Never console.error — §10.10. */
  function moderate(payload) {
    return API().call('admin.moderate', payload)['catch'](function (e) {
      if (unknownAction(e)) {
        markModAbsent();
        render();
        toast('Locking, duplicates and endorsements are not switched on yet — ' +
              'the admin flow still needs its v3 import.', '');
      }
      throw e;
    });
  }

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
  /* `frozen` is the plain-English reason votes are refused right now (locked
     thread or archived board), or '' when voting is live. votes.toggle is
     guarded flow-side for both (§5.4); this only stops the student spending
     15 seconds to be told no. */
  function voteButton(targetType, targetId, count, selfOwned, frozen) {
    var b = el('button', 'vote-btn');
    b.type = 'button';
    b.appendChild(icon('arrow-up'));
    var num = el('span', null, String(Number(count) || 0));
    b.appendChild(num);
    if (frozen) b.disabled = true;

    function paint(on, n) {
      num.textContent = String(n);
      b.classList[on ? 'add' : 'remove']('voted');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.title = frozen ? frozen
                       : (selfOwned ? 'You cannot upvote your own post'
                                    : (on ? 'Remove your upvote' : 'Upvote'));
      b.setAttribute('aria-label', b.title + ' — ' + n + ' so far');
    }
    paint(!!voted[targetId], Number(count) || 0);

    b.addEventListener('click', function () {
      if (frozen) { toast(frozen, ''); return; }
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

  /* --------------------------------------------------- v3 badges & ribbon */

  /* D9. FILLED navy + shield (§9.1). It is deliberately the loudest badge on a
     post: in a thread of twenty replies "which one of these is the answer from
     the person who marks my assignment" has to be answerable at a glance.
     isInstructorAuthor() returns false for `anon`, so an instructor who ticked
     "Post anonymously" is never unmasked by it — and false for everybody when
     config.instructor_ids is absent, so a not-yet-imported backend shows no
     badge at all rather than a wrong one. */
  function instructorBadge() {
    var b = el('span', 'badge-instructor');
    b.title = 'Posted by the instructor';
    b.appendChild(icon('shield'));
    b.appendChild(el('span', null, 'Instructor'));
    return b;
  }

  /* D10. OUTLINED navy, and never green: green is the asker saying "this solved
     my problem", navy is the instructor saying "this is correct". A post can be
     both, and when it is, the green filled strip sits on top of this one —
     main.css squares off the join so it reads as two separate statements
     rather than one two-tone banner. */
  function endorseStrip() {
    var s = el('div', 'endorse-strip');
    s.appendChild(icon('star'));
    s.appendChild(el('span', null, 'Endorsed by the instructor'));
    return s;
  }

  /* -------------------------------------------------------------- comment */
  /* o = {domId, author, created_at, body_md, deleted, accepted, nested, opBadge,
   *      voteType, voteId, upvotes, selfOwned, frozen, canAccept, onAccept,
   *      endorsed, canEndorse, onEndorse, canReply, onReply, link} */
  function commentEl(o) {
    var box = el('div', 'comment' +
      (o.nested ? ' comment-nested' : '') +
      (o.accepted ? ' comment-accepted' : '') +
      (o.endorsed ? ' comment-endorsed' : ''));
    if (o.domId) box.id = o.domId;

    /* "Marked as answer" strip must be the first child (see main.css §10) */
    if (o.accepted) {
      var strip = el('div', 'answer-strip');
      strip.appendChild(icon('check-circle'));
      strip.appendChild(el('span', null, 'Marked as answer ✓'));
      box.appendChild(strip);
    }
    /* ORDER MATTERS: accepted strip first, endorsed strip directly beneath it.
       main.css keys its corner radii off exactly that
       (`.comment-accepted > .answer-strip + .endorse-strip`), so swapping these
       two lines produces rounded corners in the middle of the card. */
    if (o.endorsed) box.appendChild(endorseStrip());

    var head = el('div', 'comment-header');
    var author = normAuthor(o.author);
    head.appendChild(avatar(author));
    head.appendChild(el('span', 'comment-author', author.display_name));
    if (isInstructorAuthor(author)) head.appendChild(instructorBadge());

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
    /* Found in the browser at 375px: `.comment-actions` was a nowrap flex row
       and v3 adds a FIFTH control to it (vote, Mark as answer, Endorse, Reply,
       kebab). For the instructor that row measured 377px inside a 375px
       viewport and pushed the whole page into horizontal scroll.
       This file used to set flexWrap/justifyContent inline as a stopgap. Both
       now live on `.comment-actions` in main.css §17, so the inline pair is
       GONE — one source of truth. If the row overflows again, fix the CSS. */
    if (!o.deleted) {
      actions.appendChild(voteButton(o.voteType, o.voteId, o.upvotes, o.selfOwned, o.frozen));
      if (o.canAccept) {
        var ab = el('button', 'accept-btn');
        ab.type = 'button';
        ab.title = 'Mark this reply as the answer';
        ab.appendChild(icon('check-circle'));
        ab.appendChild(el('span', null, 'Mark as answer'));
        ab.addEventListener('click', function () { o.onAccept(ab); });
        actions.appendChild(ab);
      }
      /* Sits beside .accept-btn on purpose (§9.2) — the two verbs belong to two
         different people and seeing them side by side is what makes that
         legible. Students never get this button, and admin.moderate's chk_role
         gate Terminates for them even if they conjure one from devtools. */
      if (o.canEndorse) {
        var eb = el('button', 'endorse-btn' + (o.endorsed ? ' is-endorsed' : ''));
        eb.type = 'button';
        eb.setAttribute('aria-pressed', o.endorsed ? 'true' : 'false');
        eb.title = o.endorsed
          ? 'Remove your endorsement of this reply'
          : 'Vouch for this reply as the instructor — it does not mark it as the answer';
        eb.appendChild(icon('star'));
        eb.appendChild(el('span', null, o.endorsed ? 'Endorsed' : 'Endorse'));
        eb.addEventListener('click', function () { o.onEndorse(eb); });
        actions.appendChild(eb);
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
    if (!canAccept()) {
      toast('The board is archived for the semester — it is read-only now.', 'error');
      return;
    }
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

  /* ==========================================================================
   * D10 / D12 / D13 — instructor moderation, optimistic with rollback
   * ---------------------------------------------------------------------------
   * The same shape as admin.js's moderate(): paint the new state immediately,
   * fire the call, put it back if the server disagrees. On a 10-21 s backend a
   * spinner-then-truth would make the instructor think the click missed.
   * ========================================================================*/

  function toggleEndorse(postId, btn) {
    if (modBusy) return;
    var post = null;
    model.posts.forEach(function (p) { if (p.post_id === postId) post = p; });
    if (!post) return;

    var was = !!post.endorsed;
    modBusy = true;
    post.endorsed = !was;
    render();
    flash(postId);

    moderate({ op: was ? 'unendorse_post' : 'endorse_post', post_id: postId })
      .then(function () {
        modBusy = false;
        toast(was ? 'Endorsement removed.' : 'Endorsed — students now see the instructor ribbon on it.',
          'success');
      })['catch'](function (e) {
        modBusy = false;
        post.endorsed = was;
        render();
        if (e && e.code === 'unauthorized') return;
        if (unknownAction(e)) return;             /* moderate() already explained */
        toast(errText(e), 'error');
      });
  }

  function toggleLock() {
    if (modBusy) return;
    var t = model.thread;
    if (!t) return;
    var was = threadLocked();
    modBusy = true;
    t.locked = !was;
    render();

    moderate({ op: was ? 'unlock_thread' : 'lock_thread', thread_id: threadId })
      .then(function () {
        modBusy = false;
        toast(was ? 'Unlocked — students can reply again.'
                  : 'Locked. Students can still read and can still message you.', 'success');
      })['catch'](function (e) {
        modBusy = false;
        t.locked = was;
        render();
        if (e && e.code === 'unauthorized') return;
        if (unknownAction(e)) return;
        toast(errText(e), 'error');
      });
  }

  function clearDuplicate() {
    if (modBusy) return;
    var t = model.thread;
    if (!t) return;
    var was = duplicateOf();
    modBusy = true;
    t.duplicate_of = '';
    render();

    /* clear_duplicate writes duplicate_of and NOTHING else — it deliberately
       does not unlock. If the instructor locked it as part of marking it, they
       unlock it with the Unlock control, because only they know whether the
       lock was for the duplication or for its own reasons (contract §4.4). */
    moderate({ op: 'clear_duplicate', thread_id: threadId })
      .then(function () {
        modBusy = false;
        toast(threadLocked()
          ? 'Duplicate mark cleared. It is still locked — use Unlock if that was only for the duplicate.'
          : 'Duplicate mark cleared.', 'success');
      })['catch'](function (e) {
        modBusy = false;
        t.duplicate_of = was;
        render();
        if (e && e.code === 'unauthorized') return;
        if (unknownAction(e)) return;
        toast(errText(e), 'error');
      });
  }

  /* set_duplicate first, THEN lock_thread as a separate call — two independent
     flags, so that clearing one restores the thread exactly and the other is
     untouched. Never one op that writes both. */
  function applyDuplicate(targetId, alsoLock) {
    if (modBusy) return;
    var t = model.thread;
    if (!t) return;
    var wasDupe = duplicateOf();
    var wasLock = threadLocked();
    modBusy = true;
    t.duplicate_of = targetId;
    if (alsoLock) t.locked = true;
    render();

    moderate({ op: 'set_duplicate', thread_id: threadId, duplicate_of: targetId })
      .then(function () {
        if (!alsoLock || wasLock) return null;
        return moderate({ op: 'lock_thread', thread_id: threadId })['catch'](function (e2) {
          /* The mark saved; only the lock did not. Say exactly that, and put
             the lock state back so the header stops claiming otherwise. */
          t.locked = wasLock;
          render();
          if (!unknownAction(e2)) {
            toast('Marked as a duplicate, but locking it did not save. Try Lock on its own.', 'error');
          }
          return null;
        });
      })
      .then(function () {
        modBusy = false;
        toast('Marked as a duplicate. It drops out of the unanswered count.', 'success');
      })['catch'](function (e) {
        modBusy = false;
        t.duplicate_of = wasDupe;
        t.locked = wasLock;
        render();
        if (e && e.code === 'unauthorized') return;
        if (unknownAction(e)) return;
        toast(errText(e), 'error');
      });
  }

  /* ==========================================================================
   * D13 — the duplicate picker, a real modal dialog (§10.9)
   * ---------------------------------------------------------------------------
   * role=dialog + aria-modal, focus moved into the filter box, Tab trapped,
   * Escape closes, focus restored to the button that opened it. Candidates come
   * from the threads.list payload this page already fetches for the "Top
   * contributor" badges, so opening the dialog normally costs ZERO extra calls;
   * api.js's DEDUPE means even the cold path shares one in-flight request.
   * ========================================================================*/
  function duplicateDialog(invoker) {
    var opener = invoker || document.activeElement;

    var backdrop = el('div', 'modal-backdrop');
    var modal = el('div', 'modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'dupe-dialog-title');

    var header = el('div', 'modal-header', 'Mark as a duplicate');
    header.id = 'dupe-dialog-title';
    var body = el('div', 'modal-body');
    body.appendChild(el('p', 'field-hint mt-0',
      'Pick the earlier discussion this one repeats. It stays readable and keeps its ' +
      'replies — it just drops out of the unanswered count and points at the original.'));

    var filter = el('input', 'input');
    filter.type = 'search';
    filter.placeholder = 'Filter by title…';
    filter.setAttribute('aria-label', 'Filter discussions by title');
    body.appendChild(filter);

    var list = el('div', 'col gap-8 mt-8');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Earlier discussions');
    list.style.maxHeight = '38vh';
    list.style.overflowY = 'auto';
    body.appendChild(list);

    var cbRow = el('div', 'checkbox-row mt-8');
    var lockBox = el('input');
    lockBox.type = 'checkbox';
    lockBox.id = 'dupe-also-lock';
    lockBox.checked = true;                 /* ticked by default, contract §4.4 */
    var lockLab = el('label', null, 'Also lock this discussion');
    lockLab.setAttribute('for', 'dupe-also-lock');
    cbRow.appendChild(lockBox);
    cbRow.appendChild(lockLab);
    body.appendChild(cbRow);
    body.appendChild(el('div', 'field-hint',
      'Locking is a separate change. Clearing the duplicate mark later does not unlock it.'));

    var footer = el('div', 'modal-footer');
    var cancel = el('button', 'btn', 'Cancel');
    cancel.type = 'button';
    footer.appendChild(cancel);

    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);

    var done = false;
    function close() {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (opener && opener.focus) { try { opener.focus(); } catch (e) { /* ignore */ } }
    }
    /* Tab trap. Without it Tab walks out of the dialog and into the page behind
       it, which for a screen-reader user is indistinguishable from the dialog
       having closed. */
    function focusables() {
      var all = modal.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])');
      var out = [];
      for (var i = 0; i < all.length; i++) if (!all[i].disabled && all[i].offsetParent !== null) out.push(all[i]);
      return out;
    }
    function onKey(ev) {
      if (ev.key === 'Escape') { ev.preventDefault(); close(); return; }
      if (ev.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
      else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
    }
    cancel.addEventListener('click', close);
    backdrop.addEventListener('mousedown', function (ev) { if (ev.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);

    function paint() {
      clear(list);
      var q = filter.value.toLowerCase().replace(/^\s+|\s+$/g, '');
      var rows = allThreads.filter(function (t) {
        if (!t || !t.thread_id || t.thread_id === threadId) return false;
        if (!q) return true;
        return String(t.title || '').toLowerCase().indexOf(q) !== -1;
      }).slice(0, 40);

      if (!rows.length) {
        list.appendChild(el('p', 'field-hint mt-0',
          allThreads.length ? 'Nothing matches that.' : 'Loading discussions…'));
        return;
      }
      rows.forEach(function (t) {
        var b = el('button', 'btn btn-sm');
        b.type = 'button';
        b.setAttribute('role', 'option');
        b.style.textAlign = 'left';
        b.style.display = 'block';
        b.style.width = '100%';
        b.appendChild(el('span', null, t.title || '(untitled)'));
        var meta = el('span', 'field-hint mt-0',
          (t.category || '') + (t.created_at ? ' · ' + relTime(t.created_at) : ''));
        meta.style.display = 'block';
        b.appendChild(meta);
        b.addEventListener('click', function () {
          var lock = lockBox.checked;
          close();
          applyDuplicate(t.thread_id, lock);
        });
        list.appendChild(b);
      });
    }

    filter.addEventListener('input', paint);
    document.body.appendChild(backdrop);
    paint();
    try { filter.focus(); } catch (e) { /* ignore */ }

    /* Cold path only: the badge fetch has not landed yet (or failed). */
    if (!allThreads.length) {
      API().call('threads.list', {}).then(function (res) {
        allThreads = (res && res.threads) || [];
        if (!done) paint();
      })['catch'](function () {
        if (done) return;
        clear(list);
        list.appendChild(el('p', 'field-hint mt-0',
          'Could not load the list of discussions. Close this and try again.'));
      });
    }
  }

  /* ==========================================================================
   * OPTIMISTIC REPLY (PERF FIX 1)
   * ---------------------------------------------------------------------------
   * localReply() builds the reply we have just written in EXACTLY the shape
   * threads.get returns for a post (thread_id, parent_post_id, body_md, author,
   * is_accepted, created_at, upvotes, deleted, endorsed). That is the whole
   * trick: it is then rendered by the same postEl() -> commentEl() path as a
   * server-rendered post, through the same markdown pipeline, with the same
   * byline, the same avatar, the same Author/Instructor badges and the same
   * relTime() timestamp. Nothing about it looks provisional, because nothing
   * about it IS provisional — the row exists.
   *
   * Returns null when the reply cannot be rendered faithfully (no `me` yet), and
   * the caller then falls back to confirmReplyVisible(). Better a slow correct
   * reply than a fast wrong one.
   * ========================================================================*/
  function localReply(postId, bodyMd, anon, parentId) {
    var author;
    if (anon) {
      author = { user_id: 'anon', display_name: 'Anonymous' };
    } else if (me && me.user_id) {
      author = { user_id: me.user_id, display_name: me.display_name || 'Unknown' };
    } else {
      return null;                       /* cannot draw the byline truthfully */
    }
    /* ONE level of nesting, same as the flow and the mock: a reply to a nested
       reply lands flat under the same top-level post. Getting this wrong would
       put the optimistic copy at a different indent from the row that lands. */
    var flat = '';
    if (parentId) {
      model.posts.forEach(function (p) {
        if (p.post_id === parentId) flat = p.parent_post_id || p.post_id;
      });
      if (!flat) flat = parentId;
    }
    return {
      post_id: postId,
      thread_id: threadId,
      parent_post_id: flat,
      body_md: bodyMd,
      author: author,
      is_accepted: false,
      /* The client's own clock, read back by the client's own relTime() — so
         this reads "just now" whatever the clock skew. The server timestamp
         replaces it the moment the real row lands. */
      created_at: new Date().toISOString(),
      upvotes: 0,
      deleted: false,
      endorsed: false,
      /* NOT part of the threads.get post shape — see THE PENDING GATE. The
         server row never carries it, so absorb() replacing model.posts is what
         clears it, and `pending` can only ever mean "not readable yet". */
      pending: true
    };
  }

  function addLocalReply(p) {
    var have = false;
    model.posts.forEach(function (x) { if (x.post_id === p.post_id) have = true; });
    if (!have) model.posts.push(p);
    pendingAdd(threadId, p);
  }

  /* ==========================================================================
   * armReconcile()  — makes the pending gate self-clearing, for the few
   * ---------------------------------------------------------------------------
   * The gate above would otherwise hold until the next page load, which is a
   * bad answer for the instructor who just answered a question and wants to
   * accept it. So exactly one background threads.get is armed, RECONCILE_DELAY_MS
   * after the write, purely to turn the buttons back on by itself.
   *
   * It is armed ONLY when this viewer could actually use those buttons — the
   * instructor, or the thread's own author. A student replying to somebody
   * else's question has no accept and no endorse to unlock, so they pay nothing
   * and the reply stays a one-flow-run click for them, which is the whole point
   * of FIX 1. Whoever does pay, pays it in the background, off the critical
   * path, after their reply is already on screen.
   *
   * One shot, never stacked, and silent on failure: this is decoration on top
   * of a write that has already succeeded, so it must never surface an error
   * (§10.10) and must never replace what is painted.
   * ========================================================================*/
  function armReconcile() {
    if (reconcileTimer) return;                    /* one in flight is enough */
    if (!(isInstructor() || isThreadAuthor())) return;
    reconcileTimer = setTimeout(function () {
      reconcileTimer = null;
      API().call('threads.get', { thread_id: threadId }).then(function (d) {
        if (!d || !d.thread) return;               /* still not readable */
        var before = modelSig();
        absorb(d);
        threadPending = false;
        if (modelSig() !== before) quietRender();
      })['catch'](function () { /* quiet: the write already succeeded */ });
    }, RECONCILE_DELAY_MS);
  }

  /* ==========================================================================
   * quietRender() — a re-render the user did not ask for
   * ---------------------------------------------------------------------------
   * Both background reconciles (the one armed above and the just-created-thread
   * ladder in boot()) can land ~30 s after the write, which is easily long
   * enough for the student to have started typing their next reply. render()
   * rebuilds the composer from scratch, so an unprompted render takes the caret
   * with it — the text survives via draft.body, the CURSOR does not, and having
   * the cursor jump to the end of the box mid-sentence is exactly the kind of
   * thing that gets blamed on "the site".
   *
   * The FIX 1 author guarded this by suppressing the render when the fingerprint
   * had not changed. That guard no longer covers it: clearing the pending gate
   * ALWAYS changes the fingerprint (it has to — that is what makes the buttons
   * come back), so these renders now always fire. Hence: capture where the caret
   * is, render, put it back.
   * ========================================================================*/
  function quietRender() {
    var active = document.activeElement;
    var id = (active && active.id) || '';
    var start = 0, end = 0, restore = false;
    if (id && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
      try {
        start = active.selectionStart;
        end = active.selectionEnd;
        restore = true;
      } catch (e) { restore = false; }   /* selectionStart throws on some input types */
    }
    render();
    if (!restore) return;
    var back = document.getElementById(id);
    if (!back) return;                   /* the control is gone — nothing to restore to */
    try {
      back.focus();
      back.setSelectionRange(start, end);
    } catch (e2) { /* never let focus restoration break the render */ }
  }

  function submitReply(btn, errBox) {
    if (busy) return;
    if (!canPost()) {
      toast(archived()
        ? 'The board is archived for the semester — it is read-only now.'
        : 'This discussion is locked, so replies are closed.', 'error');
      return;
    }
    /* THE PENDING GATE, thread level. posts.create reads tbl_Threads first
       (list_thread_p -> chk_p_thread) and a thread written seconds ago is not
       readable yet, so the call would come back "That item no longer exists."
       about the question on screen. Refuse here instead, and say something
       true. Nothing is cleared: every word they have typed is still in the
       textarea and in `draft.body`, and armReconcile()/the background ladder in
       boot() lifts this by itself. */
    if (threadPending) {
      toast('Your question is still saving — give it a few seconds, then post your reply.', '');
      return;
    }
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

    /* Captured now: finish() clears replyParent, and the .then below needs the
       value that was in force when the student pressed Comment. */
    var parentId = replyParent;

    var payload = { thread_id: threadId, body_md: body, is_anonymous: anon };
    if (parentId) payload.parent_post_id = parentId;

    /* Never clear the composer until the post is confirmed created:
       posts.create RESOLVING is the real confirmation the write happened, so
       that — not a re-read — is what clears the box. The typed text survives a
       rejection untouched: the catch below re-enables the button and does not
       render(), so `draft.body` and the textarea still hold every word. */
    function finish(newId, found) {
      busy = false;
      draft.body = '';
      draft.anon = anon;                 /* the choice stays put on this page */
      replyParent = '';
      render();
      if (found) {
        if (newId) flash(newId);
        toast('Reply posted.', 'success');
      } else {
        toast('Posted — it may take a few seconds to appear.', '');
      }
    }

    API().call('posts.create', payload)
      .then(function (res) {
        var newId = (res && res.post_id) || '';

        /* THE FAST PATH — one flow run, no confirmation round trip. */
        var local = newId ? localReply(newId, body, anon, parentId) : null;
        if (local) {
          addLocalReply(local);
          finish(newId, true);
          /* AFTER finish(), so the reply is already painted and the composer
             already cleared before a single further byte goes over the wire.
             No-ops for a student replying to somebody else's question. */
          armReconcile();
          return null;
        }

        /* THE FALLBACK, still correct and still reachable: the backend answered
           without a post_id (or we have no signed-in user to draw a byline
           from), so there is no id to reconcile on and nothing we could render
           faithfully. Wait the row out exactly as before. */
        return confirmReplyVisible(newId).then(function () {
          finish(newId, hasPost(newId));
        }, function () {
          finish(newId, false);
        });
      })['catch'](function (e) {
        busy = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Comment'; }
        if (e && e.code === 'unauthorized') return;
        fail(errText(e));
      });
  }

  /* ------------------------------------------------------- state banners */
  /* Tinted informational strips, never --danger and never an alert icon: "this
     thread is locked" is a normal thing for a thread to be, and a red box would
     read as "you broke something". Each one says what is true AND what to do
     instead — a locked thread with no escape hatch just leaves a student stuck,
     so the lock banner names chat and the clinic. */
  function stateBanners() {
    var frag = document.createDocumentFragment();

    if (archived()) {
      var ar = el('div', 'thread-banner thread-banner-archived');
      ar.appendChild(icon('lock'));
      var arTxt = el('span', null, '');
      arTxt.appendChild(el('strong', null, 'The board is archived for the semester. '));
      arTxt.appendChild(document.createTextNode(
        'Everything here stays readable and searchable — nothing new can be posted, ' +
        'replied to or voted on.'));
      ar.appendChild(arTxt);
      frag.appendChild(ar);
    }

    var dupe = duplicateOf();
    if (dupe) {
      var db = el('div', 'thread-banner thread-banner-duplicate');
      db.appendChild(icon('copy'));
      var dTxt = el('span', null, 'The instructor marked this as already asked. ');
      db.appendChild(dTxt);
      /* No duplicate_of_title on the wire, deliberately (§5.3): resolving it
         would cost a second unfiltered read of tbl_Threads. The target page
         supplies its own title, so the link carries the label instead. */
      var dLink = el('a', null, 'Duplicate — see the earlier question');
      dLink.href = 'thread.html?id=' + encodeURIComponent(dupe);
      db.appendChild(dLink);
      frag.appendChild(db);
    }

    if (threadLocked()) {
      var lb = el('div', 'thread-banner thread-banner-locked');
      lb.appendChild(icon('lock'));
      var lTxt = el('span', null, '');
      lTxt.appendChild(el('strong', null, 'This discussion is locked. '));
      /* "Message the instructor" is the escape hatch a locked thread owes the
         student — but reading it addressed to yourself is nonsense, so the
         instructor gets the version that is true for them. */
      lTxt.appendChild(document.createTextNode(isInstructor()
        ? 'Nobody can reply or vote, including you. It stays readable, and Unlock puts it back.'
        : 'You can still read it and follow its links. If you have something to add, ' +
          'message the instructor or bring it to the clinic.'));
      lb.appendChild(lTxt);
      frag.appendChild(lb);
    }

    return frag;
  }

  /* ------------------------------------------- instructor moderation row */
  function moderationRow() {
    var row = el('div', 'row mt-8');
    row.setAttribute('role', 'group');
    row.setAttribute('aria-label', 'Instructor controls for this discussion');

    var lockedNow = threadLocked();
    var lockBtn = el('button', 'btn btn-sm');
    lockBtn.type = 'button';
    lockBtn.appendChild(icon('lock'));
    lockBtn.appendChild(el('span', null, lockedNow ? 'Unlock' : 'Lock'));
    lockBtn.title = lockedNow
      ? 'Let students reply and vote again'
      : 'Stop new replies and votes. The thread stays readable.';
    lockBtn.addEventListener('click', toggleLock);
    row.appendChild(lockBtn);

    var dupe = duplicateOf();
    var dupeBtn = el('button', 'btn btn-sm');
    dupeBtn.type = 'button';
    dupeBtn.appendChild(icon('copy'));
    dupeBtn.appendChild(el('span', null, dupe ? 'Clear duplicate' : 'Mark as duplicate…'));
    dupeBtn.title = dupe
      ? 'Put this back in the unanswered count and drop the "see the earlier question" link'
      : 'Point this at the earlier discussion it repeats';
    dupeBtn.addEventListener('click', function () {
      if (dupe) clearDuplicate(); else duplicateDialog(dupeBtn);
    });
    row.appendChild(dupeBtn);

    return row;
  }

  /* --------------------------------------------------------------- render */
  function threadHeader() {
    var t = model.thread;
    var wrap = el('div', 'thread-header');

    var back = el('a', 'field-hint mt-0 mb-8', '← Back to discussions');
    back.href = 'index.html';
    back.style.display = 'inline-block';
    wrap.appendChild(back);

    /* Above the title, because "this is locked / already asked / the board is
       closed" changes how you read everything below it. */
    wrap.appendChild(stateBanners());

    var h1 = el('h1', 'thread-title', t.title || '(untitled)');
    wrap.appendChild(h1);

    var sub = el('div', 'thread-sub');
    if (t.pinned) sub.appendChild(el('span', 'badge-pinned', 'Pinned'));
    sub.appendChild(answered()
      ? el('span', 'badge-answered', 'Answered')
      : el('span', 'badge', 'Open'));
    /* Outlined state badges, next to the existing status badge, so the state is
       still visible once the banner has been scrolled past. */
    if (threadLocked()) {
      var lbadge = el('span', 'badge-locked');
      lbadge.appendChild(icon('lock'));
      lbadge.appendChild(el('span', null, 'Locked'));
      sub.appendChild(lbadge);
    }
    if (duplicateOf()) {
      var dbadge = el('span', 'badge-duplicate');
      dbadge.appendChild(icon('copy'));
      dbadge.appendChild(el('span', null, 'Duplicate'));
      sub.appendChild(dbadge);
    }

    var a = normAuthor(t.author);
    sub.appendChild(avatar(a));
    var byline = el('span', null, a.display_name + ' asked ' + relTime(t.created_at));
    if (t.created_at) byline.title = fmtDateTime(t.created_at);
    sub.appendChild(byline);
    /* D9's second half: the thread-header byline, not only the comment header.
       The OP is ALSO drawn as the first .comment below, which badges itself. */
    if (isInstructorAuthor(a)) sub.appendChild(instructorBadge());

    /* SPEC §4 v2 "language boards": shown first, ahead of category — it is the
       primary nav dimension (which board this thread lives in), category and
       labels filter within it. Threads from before the column existed carry
       '' and render no pill at all, rather than an empty one. */
    if (t.language) {
      var lp = el('a', 'pill pill-category', t.language);
      lp.href = 'index.html?lang=' + encodeURIComponent(t.language);
      lp.title = 'See the ' + t.language + ' board';
      sub.appendChild(lp);
    }
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

    /* Instructor-only, and only while the admin flow actually knows the ops.
       A student never sees this row; the flow's chk_role gate is what enforces
       it, this is only so the page is not littered with buttons that refuse. */
    if (isInstructor() && modAvailable()) wrap.appendChild(moderationRow());

    return wrap;
  }

  /* Why the composer is closed right now, in the student's words, or '' when it
     is open. Archive wins over lock: if the whole board is read-only, saying
     "this thread is locked" would send them off to message the instructor about
     a thread they cannot be helped with either. */
  function closedReason() {
    if (archived()) {
      return 'The board is archived for the semester. It is read-only now — you can still ' +
             'read and search everything, but no new replies can be posted.';
    }
    if (threadLocked()) {
      return isInstructor()
        ? 'This discussion is locked, so nobody can reply — including you. Unlock it above if you ' +
          'want to add something.'
        : 'This discussion is locked, so replies are closed. Message the instructor or ' +
          'bring it to the clinic if you still need help with it.';
    }
    return '';
  }

  function composer() {
    var box = el('div', 'reply-box');
    box.id = 'composer-box';
    var closed = closedReason();

    var head = el('div', 'row');
    head.appendChild(el('h2', 'mb-0',
      closed ? 'Replies are closed' : (replyParent ? 'Write a reply' : 'Join the discussion')));
    if (replyParent && !closed) {
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
    /* Reflects the shared `busy` flag so a reply submission (or an in-flight
       accept-answer) keeps this button visibly disabled through every
       re-render triggered by the post-visibility confirmation retries below —
       otherwise a render mid-retry would hand back a fresh, clickable button
       and look like nothing is happening. */
    var send = el('button', 'btn btn-sm btn-primary', busy ? 'Posting…' : 'Comment');
    send.type = 'button';
    if (busy) send.disabled = true;
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

    /* Locked / archived. Everything here operates on the object buildEditor()
       RETURNED — the function itself and its MD_TOOLS block are duplicated
       verbatim in new.js and are not touched by either owner (§8.3 rule 1).
       .is-disabled is pointer-events:none, which anyone can defeat from
       devtools in four seconds; disabling the real controls is what makes it
       keyboard-correct, and the flow guard in §5.4 is the actual enforcement. */
    if (closed) {
      editor.root.classList.add('is-disabled');
      editor.textarea.disabled = true;
      editor.textarea.value = '';
      /* Every control inside, not just the textarea: pointer-events:none does
         nothing for a keyboard user, who would otherwise Tab into a live
         markdown toolbar attached to a dead box. NOT aria-hidden — hiding
         focusable children from the a11y tree is worse than leaving them
         announced as disabled. */
      var deadBtns = editor.root.querySelectorAll('button, textarea, input');
      for (var di = 0; di < deadBtns.length; di++) deadBtns[di].disabled = true;
      anonBox.disabled = true;
      send.disabled = true;
      box.appendChild(el('div', 'composer-locked-note', closed));
    } else {
      box.appendChild(el('div', 'field-hint', ANON_HINT));
    }

    /* --- v3 D11 wiring, the reply-side half. uploads.js is F5's module and
       §8.4 loads it on thread.html for exactly this; §10.4 says F6 and F7 each
       add ONE Clinic.uploads.attach() call site, outside buildEditor(). This is
       F7's, and it was missing — a student could attach a screenshot when
       ASKING but not when ANSWERING, which is where most error screenshots
       actually belong, and the .upload-note privacy line never appeared on the
       reply composer at all.
       Everything here is optional and quiet: no Clinic.uploads, no
       attachments_enabled, no MSG_URL, or an attach.create the flow has never
       heard of, and pasting an image is the browser no-op it always was.
       Skipped entirely when the composer is closed (locked/archived) — the
       textarea is disabled there and an upload could not be posted anyway.
       Unlike new.js we DO have a scope_id: this thread.

       TRAP, recorded because it is not obvious: composer() is rebuilt by every
       render(), so this runs again each time. The previous attach is torn down
       first — uploads.js's detach() sets its `detached` flag, so an upload that
       is still in flight resolves into a no-op instead of writing markdown into
       a textarea that is no longer on the page. The cost is that a render
       landing mid-upload leaves the "![uploading…]" placeholder in the draft
       text; that is strictly better than silently losing the student's reply
       into a detached node. */
    if (uploadDetach) {
      try { uploadDetach(); } catch (e) { /* nothing to undo */ }
      uploadDetach = null;
    }
    var upl = window.Clinic && window.Clinic.uploads;
    if (!closed && upl && typeof upl.attach === 'function') {
      var tray = el('div', 'upload-tray');
      tray.id = 'upload-tray';
      box.appendChild(tray);
      try {
        uploadDetach = upl.attach({
          textarea: editor.textarea,
          tray: tray,
          button: null,
          scope: 'thread',
          scopeId: threadId
        });
      } catch (e) { /* §10.10: quiet. Never a console error on this path. */ }
    }

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

    document.title = (t.title || 'Discussion') + ' · MScPHMxAI Coding Clinic';

    root.appendChild(threadHeader());

    /* Why votes are refused right now, or '' — the same sentence on the thread
       and on every post, so it never looks like one particular reply is odd. */
    var frozen = archived()
      ? 'The board is archived — voting is closed.'
      : (threadLocked() ? 'This discussion is locked — voting is closed.' : '');

    /* THE PENDING GATE, thread level. Only ever true on the stashed paint of a
       brand-new thread: the row is written but not readable, so votes.toggle
       (list_vt_thread -> chk_v_target) and posts.create (list_thread_p ->
       chk_p_thread) would both answer "That item no longer exists." */
    var threadFrozen = threadPending ? PENDING_THREAD_MSG : frozen;

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
      frozen: threadFrozen,
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

    var mayAccept = (isThreadAuthor() || isInstructor()) && canAccept();
    var mayEndorse = isInstructor() && modAvailable();
    var mayReply = canPost();

    function postEl(p, nested) {
      var accepted = !!(p.is_accepted || (t.accepted_post_id && t.accepted_post_id === p.post_id));
      /* truthy(), not !!: `endorsed` can arrive as the string 'TRUE'. */
      var endorsed = truthy(p.endorsed);
      /* THE PENDING GATE. `frozen` already means "voting is refused right now,
         and here is the sentence explaining why", so a pending row reuses it
         rather than inventing a second disabled state. Accept and Endorse are
         withheld outright: a button that is certain to fail is worse than no
         button, and armReconcile() brings them back on their own. */
      var stillSaving = !!p.pending;
      return commentEl({
        domId: p.post_id,
        author: p.author,
        created_at: p.created_at,
        body_md: p.body_md || '',
        deleted: !!p.deleted,
        accepted: accepted,
        endorsed: endorsed,
        nested: !!nested,
        opBadge: !!(t.author && p.author && p.author.user_id &&
                    p.author.user_id !== 'anon' && t.author.user_id === p.author.user_id),
        voteType: 'post',
        voteId: p.post_id,
        upvotes: p.upvotes,
        selfOwned: isMe(p.author),
        frozen: stillSaving ? PENDING_POST_MSG : frozen,
        canAccept: mayAccept && !nested && !p.deleted && !accepted && !stillSaving,
        onAccept: function (btn) { acceptPost(p.post_id, btn); },
        /* Nested replies can be endorsed too — a correction buried one level
           down is exactly the thing worth vouching for. Only accept is
           top-level-only, because the flow refuses a nested accept. */
        canEndorse: mayEndorse && !p.deleted && !stillSaving,
        onEndorse: function (btn) { toggleEndorse(p.post_id, btn); },
        /* Replying to a pending post IS safe and is deliberately left alone:
           posts.create's only read is list_thread_p against tbl_Threads, and it
           writes parent_post_id without validating that the parent exists, so a
           nested reply inside the window lands correctly. */
        canReply: !nested && !p.deleted && mayReply,
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
      timeline.appendChild(el('div', 'field-hint mt-0',
        mayReply ? 'No replies yet — be the first to help.' : 'No replies.'));
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

  /* Shown while a just-created thread (thread.html?...&new=1) 404s during the
     Excel Online write/read propagation window — never the normal not-found
     page, which would read as "your post was lost". */
  function publishingState() {
    var root = $('thread-root');
    if (!root) return;
    clear(root);
    var box = el('div', 'empty-state');
    box.appendChild(el('span', 'spinner'));
    box.appendChild(el('h3', null, 'Publishing your question…'));
    box.appendChild(el('p', null,
      'This can take a few seconds to show up — no need to post it again.'));
    root.appendChild(box);
  }

  /* Reached only once every propagation retry above has still 404d. */
  function notFoundAfterRetries() {
    var root = $('thread-root');
    if (!root) return;
    clear(root);
    var box = el('div', 'empty-state');
    box.appendChild(icon('comment-discussion'));
    box.appendChild(el('h3', null, 'Discussion not found'));
    box.appendChild(el('p', null, 'This discussion does not exist, or the instructor has removed it.'));
    box.appendChild(el('p', null,
      'If you just posted this, it can occasionally take longer than usual to save — ' +
      'it is safe to try again.'));
    var row = el('div', 'row mt-8');
    var retry = el('button', 'btn btn-primary btn-sm', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', function () { location.reload(); });
    var back = el('a', 'btn btn-sm', 'Back to discussions');
    back.href = 'index.html';
    row.appendChild(retry);
    row.appendChild(back);
    box.appendChild(row);
    root.appendChild(box);
  }

  /* SPEC §8 asks for the "Top contributor" badge in threads as well as on the
     home page, but threads.get carries no contrib data. Fetch the aggregate
     after the thread is on screen (never blocking it) and only re-render when
     somebody visible actually earns a badge. */
  function loadTopContributors() {
    API().call('threads.list', {}).then(function (res) {
      /* Kept for the duplicate picker (D13). Reusing this payload is why
         opening that dialog normally costs no extra Excel calls at all. */
      allThreads = (res && res.threads) || [];
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

  /* THE RECONCILIATION (PERF FIX 1). Every server payload goes through absorb(),
     so this is the ONE place a stashed reply can be merged or retired — which is
     what makes "never drawn twice" a property of the code rather than a hope.
     A stashed reply is appended only while the server has not returned its
     post_id; the instant it does, the server row wins and the stash entry is
     dropped. A stashed reply that never lands expires with the stash. */
  function mergePending() {
    if (!model.thread) return;
    var list = pendingFor(threadId);
    if (!list.length) return;
    var have = {};
    model.posts.forEach(function (p) { if (p && p.post_id) have[p.post_id] = true; });
    var landed = [];
    list.forEach(function (p) {
      if (!p || !p.post_id) return;
      if (have[p.post_id]) landed.push(p.post_id);
      else model.posts.push(p);
    });
    pendingDrop(threadId, landed);
  }

  function absorb(d) {
    model.thread = d && d.thread;
    model.posts = (d && d.posts) || [];
    voted = {};
    ((d && d.my_votes) || []).forEach(function (id) { voted[id] = true; });
    mergePending();
  }

  /* A cheap fingerprint of everything render() draws. Used only by the quiet
     background reconcile of a stashed new thread: re-rendering rebuilds the
     composer, which moves focus and loses the caret, so a reconcile that
     changes nothing visible must not re-render at all. */
  function whoSig() {
    return me ? (me.user_id + '/' + me.role) : '';
  }
  function modelSig() {
    var t = model.thread || {};
    var parts = [
      t.title, t.status, t.accepted_post_id, t.locked, t.duplicate_of,
      t.upvotes, t.pinned, t.category, t.language, t.mine,
      (t.body_md || '').length, labelsOf(t).join('|'),
      Object.keys(voted).sort().join(','),
      /* `pending` decides whether the accept / endorse / vote controls and the
         composer are drawn at all (see THE PENDING GATE), so it is part of what
         render() draws and MUST be in the fingerprint. Leaving it out was a bug
         in the first draft of this: the background reconcile would land, clear
         the gate, find the fingerprint unchanged, skip the re-render, and leave
         the buttons switched off until the next page load. */
      threadPending ? 'tp' : ''
    ];
    (model.posts || []).forEach(function (p) {
      parts.push(p.post_id + ':' + p.upvotes + ':' + p.is_accepted + ':' +
                 p.endorsed + ':' + p.deleted + ':' + (p.body_md || '').length +
                 ':' + (p.pending ? 'p' : ''));
    });
    return parts.join('~');
  }

  /* true once a post with this id shows up in the (re)loaded model — used to
     confirm a just-created reply has propagated, not just that posts.create
     itself returned ok. */
  function hasPost(id) {
    return !id || model.posts.some(function (p) { return p.post_id === id; });
  }

  function reload() {
    return API().call('threads.get', { thread_id: threadId }).then(function (d) {
      absorb(d);
      if (!model.thread) { notFound(); return; }
      render();
    });
  }

  /* Re-fetches, retrying while the post we just created has not shown up yet.
     A reload() hiccup here does not mean the reply failed — posts.create
     already succeeded — so an error is treated the same as "not visible
     yet" rather than surfaced as a failure. */
  function confirmReplyVisible(newId) {
    return retryWhile(function () {
      return reload();
    }, REPLY_CONFIRM_DELAYS_MS, function (err) {
      if (err) return true;
      return !hasPost(newId);
    });
  }

  /* Called only for thread.html?...&new=1 (new.js appends this right after a
     successful threads.create). A 'not_found' here is the expected shape of
     the Excel Online write/read propagation window, not a lost post — retry
     instead of showing the not-found page.

     PERF FIX 1: `showWaiting` is false when the thread is already on screen
     from the sessionStorage stash — the ladder still runs (the real row is
     still what we want in the end) but it runs quietly in the background, and
     must not replace a painted page with a spinner. */
  function loadJustCreatedThread(showWaiting) {
    if (showWaiting !== false) publishingState();
    return retryWhile(function () {
      return API().call('threads.get', { thread_id: threadId });
    }, NOT_FOUND_RETRY_DELAYS_MS, function (err) {
      return !!(err && err.code === 'not_found');
    });
  }

  /* Drops &new=1 once the thread has loaded, so a refresh does not re-enter
     the waiting state. Keeps any other query params and the hash intact. */
  function stripNewFlag() {
    try {
      var params = new URLSearchParams(location.search);
      params.delete('new');
      var qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
    } catch (e) { /* ignore */ }
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

    /* A bootstrap refresh can change two things this page draws from: who the
       viewer is, and whether the board has been archived since the page loaded
       (D14 says the banner appears "within one bootstrap refresh"). Re-render
       on either — archivedNow is read through the same absent-tolerant helper,
       so a backend with no archive_mode key never triggers it. */
    var archivedAtRender = archived();
    window.addEventListener('clinic:bootstrap', function (ev) {
      if (!model.thread) return;
      var fresh = ev && ev.detail && ev.detail.user;
      var changed = false;
      if (fresh && (!me || me.user_id !== fresh.user_id || me.role !== fresh.role)) {
        me = fresh;
        changed = true;
      }
      if (archived() !== archivedAtRender) { archivedAtRender = archived(); changed = true; }
      if (changed) render();
    });

    var bootP = (typeof api.bootstrap === 'function')
      ? api.bootstrap()
      : api.call('meta.bootstrap', {});

    /* new=1 (set by new.js right after a successful threads.create) means a
       'not_found' below is expected propagation lag, not a real 404 — see
       loadJustCreatedThread(). Without it, behaviour is exactly as before:
       a genuinely missing thread fails fast. */
    var isNewThread = new URLSearchParams(location.search).get('new') === '1';

    /* PERF FIX 1b — PAINT THE JUST-CREATED THREAD IMMEDIATELY.
       new.js stashes the thread it has just created; if it is here, this page
       has everything it needs to draw the question without waiting for a single
       Excel round trip. api.bootstrap() answers from localStorage and
       api.getUser() is a synchronous read, so `me` is right in the warm case —
       and the clinic:bootstrap listener above re-renders if the background
       refresh disagrees. Absent stash (direct link, another device, a refresh
       after the TTL, private mode) -> the retry ladder below, unchanged. */
    var stashed = isNewThread ? newThreadStash(threadId) : null;
    if (stashed) {
      try { me = (typeof api.getUser === 'function') ? api.getUser() : null; }
      catch (e0) { me = null; }
      /* THE PENDING GATE, thread level: this row is written but not readable,
         so voting on it and replying to it would both 404 until it propagates.
         Cleared below the moment threads.get actually returns it. */
      threadPending = true;
      absorb({ thread: stashed, posts: [], my_votes: [] });
      render();
      flashHash();
      /* NOT stripNewFlag() here. &new=1 is what tells a REFRESH inside the
         propagation window that a 'not_found' is lag rather than a dead link —
         dropping it at paint time would turn F5 five seconds after asking into
         "Discussion not found". It is dropped below, once the row is readable. */
    }

    var threadP = isNewThread
      ? loadJustCreatedThread(!stashed)
      : api.call('threads.get', { thread_id: threadId });

    Promise.all([bootP, threadP])
      .then(function (res) {
        var meSig = whoSig();
        me = currentUser(res[0]);

        /* The stashed paint is already on screen. Swap the server row in, but
           only re-render when it actually says something different — this can
           land 30 s later, mid-typing, and a needless re-render would rebuild
           the composer and take the caret with it. */
        if (stashed) {
          /* `me` is part of the fingerprint: the accept button, the booking
             link and the instructor moderation row are all drawn from it, and
             on a cold start it can arrive here rather than at paint time. */
          var before = modelSig() + '~me=' + meSig;
          absorb(res[1]);
          if (!model.thread) {
            model.thread = stashed;                      /* keep the paint */
            /* The ladder has run its full course (up to ~50 s) and the row is
               STILL not readable. Holding the pending gate any longer would
               leave the author unable to reply to their own question for the
               rest of the session, so drop it: posts.create does its own
               tbl_Threads check and will say so if the row really is missing.
               That is the pre-FIX-1 behaviour, i.e. no worse than before. */
            threadPending = false;
          } else {
            /* The row is readable now, so the stash has done its job, &new=1
               has nothing left to explain, and the pending gate lifts. */
            dropNewThreadStash(threadId);
            stripNewFlag();
            threadPending = false;
          }
          /* quietRender(), not render(): clearing the pending gate always moves
             the fingerprint, so this branch now always fires, and it fires ~30 s
             after the student pressed "Start discussion" — quite possibly with
             the caret already in the reply box. */
          if ((modelSig() + '~me=' + whoSig()) !== before) { quietRender(); flashHash(); }
          loadTopContributors();
          return;
        }

        absorb(res[1]);
        if (!model.thread) { notFound(); return; }
        if (isNewThread) stripNewFlag();
        render();
        flashHash();
        loadTopContributors();
      })['catch'](function (e) {
        if (e && e.code === 'unauthorized') return;      /* api.js already bounced */
        /* A stashed thread is already drawn and the row IS saved — threads.create
           resolved. Never replace it with an error page because the read has not
           caught up yet; keep what is on screen and stay quiet (§10.10). */
        if (stashed && model.thread) {
          /* Same reasoning as the exhausted-ladder branch above: the read never
             caught up, so stop withholding the composer. Re-render only if that
             actually changed something visible — this can land mid-typing. */
          if (threadPending) {
            var sigBefore = modelSig();
            threadPending = false;
            if (modelSig() !== sigBefore) quietRender();
          }
          loadTopContributors();
          return;
        }
        if (e && e.code === 'not_found') {
          if (isNewThread) notFoundAfterRetries(); else notFound();
          return;
        }
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
