/* ============================================================================
 * new.js — New discussion composer (agent A2)
 * Title + category + label chips + markdown editor + anonymous option.
 * ==========================================================================*/
(function () {
  'use strict';

  var MAX_TITLE = 120;
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
  function toast(msg, type) { try { UI().toast(msg, type); } catch (e) {} }
  function errText(e) {
    return (e && (e.message || e.error)) || 'Something went wrong. Please try again.';
  }
  /* ui.icon() may hand back an element or a static SVG string. Both are
     author-controlled chrome, never user content — same shim index.js uses. */
  function toNode(x) {
    if (x && x.nodeType) return x;
    var s = document.createElement('span');
    if (typeof x === 'string') s.innerHTML = x;
    return s;
  }
  function icon(name) { try { return toNode(UI().icon(name)); } catch (e) { return el('span'); } }
  function relTime(iso) { try { return UI().relTime(iso) || ''; } catch (e) { return ''; } }
  /* Spinner-in-the-button. Falls back to the old label swap against a ui.js
     that predates ui.busy(), so this page never depends on the newer file. */
  function busyBtn(btn, label) {
    if (!btn) return function () {};
    var ui = UI();
    if (typeof ui.busy === 'function') { try { return ui.busy(btn, label); } catch (e) {} }
    var was = btn.textContent;
    btn.disabled = true; btn.textContent = label;
    return function () { btn.disabled = false; btn.textContent = was; };
  }

  /* ==========================================================================
   * HAND-OFF STASH TO thread.html  (PERF FIX 1b)
   * ---------------------------------------------------------------------------
   * threads.create resolving means the row was written — but the Excel
   * write/read propagation window means threads.get cannot see it for ~30 s, so
   * thread.js used to sit on a retry ladder of up to FIFTY SECONDS staring at
   * "Publishing your question…" for a question it already had in hand.
   *
   * We have every field thread.html needs right here, so hand it over: it
   * paints instantly and reconciles with the server row in the background.
   * This is moving the cost off the critical path, not pretending the lag is
   * gone — thread.js keeps its retry ladder for every case where this stash is
   * absent (direct link, another device, a refresh after the TTL, private
   * mode), and reconciles on thread_id so nothing is ever drawn twice.
   *
   * Best-effort throughout: sessionStorage throws outright in some privacy
   * modes and can be over quota. A failure here must never cost the student
   * the post they just made, so nothing below can reject or block the redirect.
   * KEEP THE KEY AND SHAPE IN STEP WITH thread.js's newThreadStash().
   * ========================================================================*/
  var STASH_NEW_THREAD = 'clinic_new_thread_v1';

  function stashNewThread(id, thread) {
    try {
      window.sessionStorage.setItem(STASH_NEW_THREAD, JSON.stringify({
        thread_id: id, at: Date.now(), thread: thread
      }));
    } catch (e) { /* private mode / quota — thread.js falls back to its ladder */ }
  }

  /* The ThreadFull shape of SPEC §5, built from what we just posted. It has to
     BE that shape, not merely resemble it: thread.js renders it through the
     same path as a server payload, so a missing key would show up as a missing
     badge or a dead link rather than as an error. */
  function createdThreadShape(id, fields) {
    var me = null;
    try { me = (typeof API().getUser === 'function') ? API().getUser() : null; }
    catch (e) { me = null; }
    var author = (fields.anon || !me || !me.user_id)
      ? { user_id: 'anon', display_name: 'Anonymous' }
      : { user_id: me.user_id, display_name: me.display_name || 'Unknown' };
    return {
      thread_id: id,
      title: fields.title,
      body_md: fields.body,
      category: fields.category,
      language: fields.language,
      labels: fields.labels.slice(),
      author: author,
      status: 'open',
      pinned: false,
      created_at: new Date().toISOString(),
      reply_count: 0,
      upvotes: 0,
      accepted: false,
      accepted_post_id: '',
      resolved_via: '',
      /* `mine` is what keeps the accept control and the "Book a clinic slot"
         link on the author's own ANONYMOUS thread without unmasking them —
         author stays {user_id:'anon'} above. */
      mine: true,
      /* v3 keys, all in their "off" state: a brand-new thread cannot be locked,
         a duplicate, replied to, or endorsed. */
      locked: false,
      duplicate_of: '',
      instructor_replied: false,
      has_endorsed: false
    };
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
  /* ---- live side-by-side preview (shared with thread.js) -------------------
     The Write/Preview tabs are a mode switch: to check whether a code fence is
     closed you had to leave the box you were typing in, look, and come back.
     For a first-year writing their first fenced block that is the difference
     between "I can see it working" and "I hope this is right".

     So there is a third state — SPLIT — where the preview sits beside the
     textarea and re-renders as you type. It is a TOGGLE, not a replacement: the
     tabs still work exactly as they did, split is off until asked for, and the
     choice is remembered per browser.

     WHY IT IS DEBOUNCED AND DIFFED. renderInto() is marked -> DOMPurify ->
     highlight.js -> KaTeX -> attachment rewrite. Running that on every keystroke
     of a 10 000-character body is real work, and re-rendering also rebuilds any
     <img class="clinic-att">, which re-queues an attach.get (10-21 s) for an
     image whose bytes are not in markdown.js's session cache yet. So: 200 ms
     after the last keystroke, and never for text we have already rendered.
     uploads.js additionally primes that cache with the bytes it just uploaded,
     so the common case — you paste a screenshot and keep typing — costs nothing.

     Below MD_SPLIT_MIN_PX the columns stack instead (main.css §12), because two
     35-character columns are worse than either one alone. */
  var LS_SPLIT = 'clinic_split_preview';
  var SPLIT_DEBOUNCE_MS = 200;

  function splitPref() {
    try { return window.localStorage.getItem(LS_SPLIT) === '1'; } catch (e) { return false; }
  }
  function saveSplitPref(on) {
    try { window.localStorage.setItem(LS_SPLIT, on ? '1' : '0'); } catch (e) { /* private mode */ }
  }

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

    tabs.appendChild(el('span', 'grow'));

    /* The split toggle. aria-pressed (not aria-selected) because it is a
       two-state switch sitting beside a two-item tablist, and conflating the
       two would tell a screen reader there are three tabs. */
    var tSplit = el('button', 'tab md-split-toggle');
    tSplit.type = 'button';
    tSplit.appendChild(icon('columns'));
    tSplit.appendChild(el('span', null, 'Live preview'));
    tSplit.title = 'Show the formatted version beside what you type, updating live';
    tSplit.setAttribute('aria-pressed', 'false');
    tabs.appendChild(tSplit);

    var bar = el('div', 'md-toolbar');

    /* The two panes live in a wrapper so split mode is one class on one node
       rather than a pile of inline styles that have to be undone. */
    var panes = el('div', 'md-panes');

    var ta = el('textarea', 'textarea');
    ta.rows = opts.rows || 10;
    ta.placeholder = opts.placeholder || '';
    if (opts.id) ta.id = opts.id;
    if (opts.maxlength) ta.maxLength = opts.maxlength;
    ta.setAttribute('aria-label', opts.label || 'Markdown editor');

    var prev = el('div', 'md-preview');
    prev.hidden = true;
    prev.setAttribute('aria-live', 'off');   /* it mirrors the box they are in */

    panes.appendChild(ta);
    panes.appendChild(prev);

    MD_TOOLS.forEach(function (t) {
      if (t.sep) { bar.appendChild(el('span', 'md-tool-sep')); return; }
      var b = el('button', null, t.label);
      b.type = 'button';
      b.title = t.title;
      b.setAttribute('aria-label', t.title);
      b.addEventListener('click', function () { showWrite(); t.fn(ta); });
      bar.appendChild(b);
    });

    /* D11's "or click a button" half. uploads.js owns the file input, the
       progress tiles and every failure path; this is only the affordance, and
       it is handed over in attach()'s `button` option below. The toolbar is
       where someone looks for it — beside bold, italic and code. */
    bar.appendChild(el('span', 'md-tool-sep'));
    var imgBtn = el('button', 'md-tool-image');
    imgBtn.type = 'button';
    imgBtn.title = 'Add an image — or just paste or drop one into the box';
    imgBtn.setAttribute('aria-label', 'Add an image');
    imgBtn.appendChild(icon('image'));
    imgBtn.appendChild(el('span', null, 'Image'));
    bar.appendChild(imgBtn);

    var split = false;
    var renderTimer = null;
    var lastRendered = null;

    function paintPreview() {
      var value = ta.value;
      if (value === lastRendered) return;
      lastRendered = value;
      var md = MD();
      if (md && typeof md.renderInto === 'function') md.renderInto(prev, value);
      else { clear(prev); prev.appendChild(el('pre', null, value)); }
    }

    function schedulePreview() {
      if (!split) return;
      if (renderTimer) window.clearTimeout(renderTimer);
      renderTimer = window.setTimeout(function () {
        renderTimer = null;
        paintPreview();
      }, SPLIT_DEBOUNCE_MS);
    }

    function applySplit(on) {
      split = !!on;
      wrap.classList[split ? 'add' : 'remove']('is-split');
      tSplit.classList[split ? 'add' : 'remove']('active');
      tSplit.setAttribute('aria-pressed', split ? 'true' : 'false');
      if (split) {
        /* Split wins over whichever tab was showing: both panes are visible, so
           "which tab is selected" stops meaning anything until it is off again. */
        tWrite.classList.add('active'); tPrev.classList.remove('active');
        tWrite.setAttribute('aria-selected', 'true');
        tPrev.setAttribute('aria-selected', 'false');
        ta.hidden = false; bar.hidden = false; prev.hidden = false;
        lastRendered = null;
        paintPreview();
      } else {
        if (renderTimer) { window.clearTimeout(renderTimer); renderTimer = null; }
        showWrite();
      }
    }

    function showWrite() {
      if (split) return;                 /* the tabs are inert while split is on */
      tWrite.classList.add('active'); tPrev.classList.remove('active');
      tWrite.setAttribute('aria-selected', 'true'); tPrev.setAttribute('aria-selected', 'false');
      ta.hidden = false; bar.hidden = false; prev.hidden = true;
    }
    function showPreview() {
      if (split) return;
      tPrev.classList.add('active'); tWrite.classList.remove('active');
      tPrev.setAttribute('aria-selected', 'true'); tWrite.setAttribute('aria-selected', 'false');
      ta.hidden = true; bar.hidden = true; prev.hidden = false;
      lastRendered = null;
      paintPreview();
    }
    tWrite.addEventListener('click', showWrite);
    tPrev.addEventListener('click', showPreview);
    tSplit.addEventListener('click', function () {
      applySplit(!split);
      saveSplitPref(split);
      if (split) ta.focus();
    });

    ta.addEventListener('input', schedulePreview);

    ta.addEventListener('keydown', function (ev) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      var k = String(ev.key || '').toLowerCase();
      if (k === 'b') { ev.preventDefault(); edSurround(ta, '**', '**', 'bold text'); }
      else if (k === 'i') { ev.preventDefault(); edSurround(ta, '_', '_', 'italic text'); }
    });

    wrap.appendChild(tabs);
    wrap.appendChild(bar);
    wrap.appendChild(panes);
    if (opts.footer) wrap.appendChild(opts.footer);

    if (splitPref()) applySplit(true);

    return {
      root: wrap, textarea: ta, preview: prev, showWrite: showWrite,
      imageButton: imgBtn,
      /* uploads.js inserts markdown straight into the textarea's value, which
         fires no `input` event — so it calls this to keep a live preview
         honest. */
      refreshPreview: schedulePreview
    };
  }
  /* ==================================================== end shared editor === */

  var LANG_KEY = 'clinic_language';

  var cfg = { categories: [], labels: [], languages: [], notice_text: '' };
  var picked = {};                    /* label -> true */
  var editor = null;
  var anonBox = null;
  var submitBtn = null;
  var languageSel = null;
  var busy = false;

  /* v3 D7 — per-category ask templates (contract §10.5).
     `applied` is the category whose template is currently believed to be in
     the box; `dismissed` goes true when the student removes one, and stops
     us from putting another back under them on the next category change. */
  var tplBar = null;
  var tplState = { applied: '', dismissed: false, timer: null };

  /* v3 D2 — the similar-threads panel (contract §10.1, §9.8).
     `failed` is sticky on purpose: if Clinic.searchIndex.load() rejects once
     (no network, an older backend, a throttled flow) we do not retry on every
     keystroke and turn a quiet degradation into a request storm. */
  var simPanel = null, simList = null, simCount = null;
  var simState = { dismissed: false, timer: null, loading: false, failed: false };
  /* §10.1's numbers. search-index.js exports them (SUGGEST_MIN_CHARS,
     SUGGEST_MIN_TOKENS, SUGGEST_DEBOUNCE_MS) precisely so the two consumers do
     not drift apart; these literals are the fallback for when the module is
     not loaded at all, in which case nothing uses them anyway. */
  var SIM_MIN_CHARS = 8;                 /* §10.1: 8 chars AND >= 2 tokens */
  var SIM_MIN_TOKENS = 2;
  var SIM_DEBOUNCE_MS = 350;             /* §10.1 */
  var SIM_LIMIT = 4;

  var HOW_TO_ASK = [
    'Say what you already tried, and what you expected to happen instead.',
    'Paste the exact error — the full message and traceback, not a paraphrase.',
    'Show the smallest piece of code that still reproduces the problem.',
    'Mention your setup when it matters: Python version, packages, notebook or script.',
    'Ask one question per thread. Easier to answer, easier to find later.'
  ];

  /* ------------------------------------------------------------- rendering */
  function renderGuidance() {
    var ul = $('how-to-ask');
    if (ul) {
      clear(ul);
      HOW_TO_ASK.forEach(function (s) { ul.appendChild(el('li', null, s)); });
    }
    var notice = $('notice-box');
    if (notice) {
      clear(notice);
      notice.appendChild(el('p', 'mb-0', cfg.notice_text || ''));
    }
    var hint = $('anon-hint');
    if (hint) hint.textContent = ANON_HINT;
  }

  function renderCategories() {
    var sel = $('category');
    if (!sel) return;
    var keep = sel.value;
    clear(sel);
    var ph = el('option', null, 'Choose a category…');
    ph.value = '';
    sel.appendChild(ph);
    (cfg.categories || []).forEach(function (c) {
      var o = el('option', null, c);
      o.value = c;
      sel.appendChild(o);
    });
    var pre = new URLSearchParams(location.search).get('category');
    if (keep) sel.value = keep;
    else if (pre && (cfg.categories || []).indexOf(pre) !== -1) sel.value = pre;
  }

  /* SPEC §4 v2 "language boards": required, styled exactly like Category —
     new.html (owned by A2's sibling page but not this file) has no markup for
     it, so the field is built here, once, and inserted right after Category. */
  function buildLanguageField() {
    var catSel = $('category');
    if (!catSel || !catSel.parentNode || !catSel.parentNode.parentNode) return null;
    var catField = catSel.parentNode;

    var field = el('div', 'field');
    var label = el('label', 'field-label', 'Language board ');
    label.setAttribute('for', 'language');
    label.appendChild(el('span', 'req', '*'));
    field.appendChild(label);

    var sel = el('select', 'select');
    sel.id = 'language';
    sel.name = 'language';
    field.appendChild(sel);

    catField.parentNode.insertBefore(field, catField.nextSibling);
    return sel;
  }

  /* Pre-selects, in order: whatever is already chosen > ?lang= (arrived via a
     board link) > the stored clinic_language preference (arrived from the
     switcher on index.html) — same precedence as index.js, so the composer
     never contradicts the board a student was just looking at. */
  function renderLanguages() {
    var sel = languageSel;
    if (!sel) return;
    var known = cfg.languages || [];
    var keep = sel.value;
    clear(sel);
    var ph = el('option', null, 'Choose a language…');
    ph.value = '';
    sel.appendChild(ph);
    known.forEach(function (l) {
      var o = el('option', null, l);
      o.value = l;
      sel.appendChild(o);
    });
    if (keep && known.indexOf(keep) !== -1) { sel.value = keep; return; }
    var pre = new URLSearchParams(location.search).get('lang');
    if (pre && known.indexOf(pre) !== -1) { sel.value = pre; return; }
    var stored = null;
    try { stored = window.localStorage.getItem(LANG_KEY); } catch (e) { /* ignore */ }
    if (stored && known.indexOf(stored) !== -1) sel.value = stored;
  }

  function renderLabels() {
    var box = $('labels');
    if (!box) return;
    clear(box);
    if (!(cfg.labels || []).length) {
      box.appendChild(el('span', 'field-hint mt-0', 'No labels configured.'));
      return;
    }
    cfg.labels.forEach(function (l) {
      var on = !!picked[l];
      var b = el('button', 'chip' + (on ? ' selected' : ''), l);
      b.type = 'button';
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.addEventListener('click', function () {
        if (picked[l]) delete picked[l]; else picked[l] = true;
        renderLabels();
      });
      box.appendChild(b);
    });
  }

  function buildFooter() {
    var foot = el('div', 'composer-footer');

    var row = el('div', 'checkbox-row');
    anonBox = el('input');
    anonBox.type = 'checkbox';
    anonBox.id = 'anon';
    var lab = el('label', null, 'Post anonymously');
    lab.setAttribute('for', 'anon');
    row.appendChild(anonBox);
    row.appendChild(lab);
    foot.appendChild(row);

    foot.appendChild(el('span', 'grow'));

    var cancel = el('a', 'btn btn-sm', 'Cancel');
    cancel.href = 'index.html';
    foot.appendChild(cancel);

    submitBtn = el('button', 'btn btn-sm btn-primary', 'Start discussion');
    submitBtn.type = 'submit';
    submitBtn.id = 'submit';
    foot.appendChild(submitBtn);

    return foot;
  }

  /* ==========================================================================
   * D7 — PER-CATEGORY ASK TEMPLATES
   * --------------------------------------------------------------------------
   * Everything here lives OUTSIDE buildEditor() and only ever touches the
   * returned editor.textarea (contract §8.3 rule 1: the editor block is
   * duplicated verbatim into thread.js and neither owner may touch it).
   *
   * THE RULE THAT MATTERS: never destroy typed text. Clinic.templates.apply()
   * refuses to write over anything it did not itself produce, and it is that
   * refusal — not a check here — that is the safety property. When it refuses,
   * this file offers the two honest alternatives (insert below / replace after
   * an explicit confirm) instead of silently doing nothing.
   *
   * A student who loses half a written question does not come back to ask the
   * next one. That is the whole reason this is written the careful way round.
   * ========================================================================*/

  function TPL() { return (window.Clinic && window.Clinic.templates) || null; }

  function currentCategory() {
    var s = $('category');
    return (s && s.value) || '';
  }
  function currentLanguage() {
    return (languageSel && languageSel.value) || '';
  }
  function bodyText() {
    return (editor && editor.textarea && editor.textarea.value) || '';
  }
  function bodyIsBlank() { return bodyText().replace(/\s+/g, '') === ''; }

  /* Built once, inserted directly above the editor inside the Body field.
     new.html (F1's file) has no markup for it, exactly as it has none for the
     language select — page regions on this site are built by the page. */
  function buildTemplateBar() {
    var slot = $('editor-slot');
    if (!slot || !slot.parentNode) return null;
    var bar = el('div', 'template-bar');
    bar.id = 'template-bar';
    bar.hidden = true;
    slot.parentNode.insertBefore(bar, slot);
    return bar;
  }

  function applyTemplate(tpl, focus) {
    var t = TPL();
    if (!t || !editor || !tpl) return false;
    var ok = t.apply(editor.textarea, tpl, { focus: !!focus });
    if (ok) { tplState.applied = tpl.category; tplState.dismissed = false; }
    renderTemplateBar();
    return ok;
  }

  function appendTemplate(tpl) {
    var t = TPL();
    if (!t || !editor || !tpl) return;
    t.appendTo(editor.textarea, tpl, { focus: true });
    /* Deliberately NOT recorded as `applied`: the box now holds the student's
       text plus a template, which isTemplate() correctly does not recognise,
       so the next category change must not quietly overwrite it. */
    renderTemplateBar();
  }

  /* The only path that can cost a student text, and it is behind an explicit
     modal with a non-default "Keep what I typed". */
  function replaceWithTemplate(tpl) {
    if (!tpl || !editor) return;
    var msg = 'This replaces everything in the body with the ' + tpl.label +
      ' template. What you have already typed will be lost.';
    var ui = UI();
    if (!ui || typeof ui.confirmModal !== 'function') {
      if (!window.confirm(msg)) return;
      editor.textarea.value = '';
      applyTemplate(tpl, true);
      return;
    }
    ui.confirmModal(msg, {
      title: 'Replace your draft?',
      confirmText: 'Replace',
      cancelText: 'Keep what I typed',
      danger: true
    }).then(function (ok) {
      if (!ok) return;
      editor.textarea.value = '';
      applyTemplate(tpl, true);
    });
  }

  function removeTemplate() {
    var t = TPL();
    if (!t || !editor) return;
    /* clear() itself refuses when the box no longer holds an untouched
       template, so a mis-click here can never cost work either. */
    if (t.clear(editor.textarea, { focus: true })) {
      tplState.applied = '';
      tplState.dismissed = true;      /* do not put it back on the next change */
    }
    renderTemplateBar();
  }

  function tplChip(label, selected, onClick) {
    var b = el('button', 'chip' + (selected ? ' selected' : ''), label);
    b.type = 'button';
    b.setAttribute('aria-pressed', selected ? 'true' : 'false');
    b.addEventListener('click', onClick);
    return b;
  }

  function renderTemplateBar() {
    var t = TPL();
    if (!tplBar) return;
    if (!t || !editor) { tplBar.hidden = true; return; }

    var tpl = t.forCategory(currentCategory(), currentLanguage());
    if (!tpl) { tplBar.hidden = true; clear(tplBar); return; }

    clear(tplBar);
    tplBar.hidden = false;

    var isTpl = t.isTemplate(bodyText());
    var blank = bodyIsBlank();

    if (isTpl) {
      tplBar.appendChild(tplChip(tpl.label + ' template', true, function () {
        applyTemplate(tpl, true);
      }));
      var rm = el('button', 'btn btn-sm btn-invisible template-reset', 'Remove template');
      rm.type = 'button';
      rm.title = 'Empties the body. Only possible while the template is untouched.';
      rm.addEventListener('click', removeTemplate);
      tplBar.appendChild(rm);
      tplBar.appendChild(el('div', 'template-hint',
        'Replace each _italic prompt_ with your own words, and delete any section ' +
        'that does not apply. The four headings are what make a question answerable ' +
        'the same day.'));
      return;
    }

    if (blank) {
      tplBar.appendChild(tplChip('Insert the ' + tpl.label + ' template', false, function () {
        applyTemplate(tpl, true);
      }));
      tplBar.appendChild(el('div', 'template-hint',
        'A ready-made skeleton for a ' + tpl.label.toLowerCase() + ' question.'));
      return;
    }

    /* The student has typed something of their own. Nothing is touched. */
    tplBar.appendChild(tplChip('Insert ' + tpl.label + ' template below', false, function () {
      appendTemplate(tpl);
    }));
    tplBar.appendChild(tplChip('Replace what I typed', false, function () {
      replaceWithTemplate(tpl);
    }));
    tplBar.appendChild(el('div', 'template-hint',
      'Your draft is safe — the ' + tpl.label + ' template was not inserted over it.'));
  }

  /* Fires on a real category change, and once after bootstrap so that arriving
     with ?category=Debugging pre-selected still gets the skeleton. */
  function onCategoryChanged() {
    var t = TPL();
    if (!t || !editor) { renderTemplateBar(); return; }

    var cat = currentCategory();
    if (!cat) { tplState.applied = ''; renderTemplateBar(); return; }
    if (cat === tplState.applied && t.isTemplate(bodyText())) { renderTemplateBar(); return; }

    var tpl = t.forCategory(cat, currentLanguage());
    if (tpl && !tplState.dismissed) {
      /* apply() returns false (and touches nothing) when the box holds the
         student's own text — renderTemplateBar() then offers insert/replace. */
      if (t.apply(editor.textarea, tpl)) tplState.applied = cat;
    }
    renderTemplateBar();
  }

  /* Picking the R board after the template landed should turn ```python into
     ```r. Only ever done while the body is still an untouched template. */
  function onLanguageChangedForTemplate() {
    var t = TPL();
    if (!t || !editor) return;
    if (!t.isTemplate(bodyText())) { renderTemplateBar(); return; }
    var tpl = t.forCategory(currentCategory(), currentLanguage());
    if (tpl) t.apply(editor.textarea, tpl);
    renderTemplateBar();
  }

  /* ==========================================================================
   * D2 — SIMILAR THREADS ("possibly related")
   * --------------------------------------------------------------------------
   * Driven entirely by F3's Clinic.searchIndex (§10.1). There is deliberately
   * no matcher in this file: two independent notions of "similar" on one site
   * is how the search page and the composer end up disagreeing in front of a
   * cohort.
   *
   * FRAMING IS THE FEATURE. This panel is one wrong word away from telling a
   * student their question is a duplicate and shaming them out of asking. A
   * duplicate thread costs the instructor thirty seconds; a student who does
   * not ask costs them the semester. So: "Possibly related", results open in a
   * NEW TAB so the half-written draft is never lost, an explicit "post it
   * anyway if yours is different", and a stated limitation.
   *
   * DEGRADATION: if search-index.js is not loaded (F3 not landed, a 404, an
   * older deploy) the panel is never built and nothing is logged. §10.1 also
   * promises every method except load() is synchronous and returns [] rather
   * than throwing, but this is wrapped anyway — a broken suggestion box must
   * never be able to stop someone posting.
   * ========================================================================*/

  function SIDX() { return (window.Clinic && window.Clinic.searchIndex) || null; }

  /* Prefer the module's own constant over our fallback, always. If F3 ever
     retunes the suggestion thresholds, this panel follows without an edit. */
  function simNum(key, dflt) {
    var idx = SIDX();
    var v = idx && idx[key];
    return typeof v === 'number' && isFinite(v) ? v : dflt;
  }

  var SIM_LIMITS_NOTE =
    'Yours may still be different — post it anyway if it is. This matches titles, ' +
    'labels, categories and a short excerpt only, not the replies, and it will not ' +
    'spot a question worded differently.';

  function buildSimilarPanel() {
    if (!SIDX()) return null;              /* feature absent: build nothing */
    var titleInput = $('title');
    if (!titleInput || !titleInput.parentNode) return null;

    var panel = el('div', 'similar-panel');
    panel.id = 'similar-panel';
    /* §10.9: role=status/aria-live so the count is announced without stealing
       focus from the title the student is still typing. */
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');
    panel.hidden = true;                   /* the global [hidden] rule, §9.8 */

    var head = el('div', 'similar-title');
    head.id = 'similar-panel-title';
    head.appendChild(icon('search'));
    head.appendChild(el('span', null, 'Possibly related'));
    simCount = el('span', 'counter', '0');
    simCount.setAttribute('aria-hidden', 'true');
    head.appendChild(simCount);
    panel.appendChild(head);

    simList = el('ul', 'similar-list');
    panel.appendChild(simList);

    panel.appendChild(el('div', 'field-hint', SIM_LIMITS_NOTE));

    var dismiss = el('button', 'btn btn-sm btn-invisible similar-dismiss', 'Not what I mean');
    dismiss.type = 'button';
    dismiss.addEventListener('click', function () {
      simState.dismissed = true;
      hideSimilar();
      try { titleInput.focus(); } catch (e) { /* ignore */ }
    });
    panel.appendChild(dismiss);

    titleInput.parentNode.appendChild(panel);
    return panel;
  }

  function hideSimilar() {
    if (!simPanel) return;
    simPanel.hidden = true;
    simPanel.classList.remove('is-loading');
    clear(simList);
    var titleInput = $('title');
    /* aria-describedby is added and removed with the panel: a description
       pointing at a display:none node is a description a screen reader
       silently drops, and leaving it there is worse than not setting it. */
    if (titleInput) titleInput.removeAttribute('aria-describedby');
  }

  /* §10.1 exports isAnswered so "answered" means one thing across the site;
     the inline copy is only the no-module fallback. */
  function isAnsweredThread(t) {
    var idx = SIDX();
    if (idx && typeof idx.isAnswered === 'function') {
      try { return !!idx.isAnswered(t); } catch (e) { /* fall through */ }
    }
    return !!t && (t.status === 'answered' || t.accepted === true);
  }

  function renderSimilar(results) {
    var titleInput = $('title');
    if (!simPanel || !simList) return;
    clear(simList);

    var shown = 0;
    results.forEach(function (r) {
      if (shown >= SIM_LIMIT) return;
      var t = (r && r.thread) || r;
      if (!t || !t.thread_id) return;
      shown++;

      var answered = isAnsweredThread(t);
      var li = el('li', 'similar-item' + (answered ? ' is-answered' : ''));

      var ic = el('span', 'similar-icon');
      ic.appendChild(icon(answered ? 'check-circle' : 'comment-discussion'));
      li.appendChild(ic);

      var box = el('div');
      var a = el('a', null, t.title || '(untitled)');
      a.href = 'thread.html?id=' + encodeURIComponent(t.thread_id);
      /* New tab, always. Navigating away from a half-written question to check
         a maybe-duplicate and losing it is the single worst outcome here. */
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = 'Opens in a new tab — what you have typed here stays put';
      box.appendChild(a);

      var bits = [];
      if (answered) bits.push('Answered');
      var n = Number(t.reply_count) || 0;
      bits.push(n === 1 ? '1 reply' : n + ' replies');
      var rel = relTime(t.created_at);
      if (rel) bits.push('asked ' + rel);
      /* All four v3 card fields may be absent — falsy reads, no marker. */
      if (t.duplicate_of) bits.push('marked a duplicate');
      box.appendChild(el('div', 'similar-meta', bits.join(' · ')));

      li.appendChild(box);
      simList.appendChild(li);
    });

    if (!shown) { hideSimilar(); return; }

    if (simCount) simCount.textContent = String(shown);
    simPanel.classList.remove('is-loading');
    simPanel.hidden = false;
    if (titleInput) titleInput.setAttribute('aria-describedby', 'similar-panel-title');
  }

  function runSuggest() {
    var idx = SIDX(), titleInput = $('title');
    if (!idx || !simPanel || !titleInput || simState.dismissed) return;

    var q = (titleInput.value || '').trim();
    var tokens = q ? q.split(/\s+/) : [];
    if (q.length < simNum('SUGGEST_MIN_CHARS', SIM_MIN_CHARS) ||
        tokens.length < simNum('SUGGEST_MIN_TOKENS', SIM_MIN_TOKENS)) {
      hideSimilar();
      return;
    }

    if (typeof idx.ready === 'function' && !idx.ready()) {
      if (simState.loading || simState.failed) return;
      if (typeof idx.load !== 'function') { simState.failed = true; return; }
      simState.loading = true;
      /* The panel stays HIDDEN while the index loads. In live mode load() is a
         real threads.list round trip (10-21 s), and a "checking…" box that
         appears under the title and then vanishes on every single new thread
         is noise. It shows up when — and only when — there is something to
         show. */
      idx.load().then(function () {
        simState.loading = false;
        runSuggest();
      })['catch'](function () {
        /* Quiet, per §10.10: never console.error, never a toast. Search is a
           convenience; posting is the job. */
        simState.loading = false;
        simState.failed = true;
        hideSimilar();
      });
      return;
    }

    var res = [];
    try {
      res = (typeof idx.suggest === 'function' && idx.suggest(q, { limit: SIM_LIMIT, minScore: 4 })) || [];
    } catch (e) {
      simState.failed = true;
      hideSimilar();
      return;
    }
    if (!res.length) { hideSimilar(); return; }
    renderSimilar(res);
  }

  function scheduleSuggest() {
    if (!simPanel) return;
    if (simState.timer) clearTimeout(simState.timer);
    simState.timer = setTimeout(runSuggest, simNum('SUGGEST_DEBOUNCE_MS', SIM_DEBOUNCE_MS));
  }

  /* ------------------------------------------------------------ validation */
  function setError(msg, focusEl) {
    var box = $('form-error');
    if (box) {
      clear(box);
      if (msg) {
        box.appendChild(el('span', null, msg));
        box.removeAttribute('hidden');
      } else {
        box.setAttribute('hidden', 'hidden');
      }
    }
    if (msg && focusEl && focusEl.focus) focusEl.focus();
  }

  function submit(ev) {
    if (ev) ev.preventDefault();
    if (busy) return;

    var titleEl = $('title'), catEl = $('category'), langEl = $('language');
    var title = (titleEl.value || '').trim();
    var category = (catEl.value || '').trim();
    var language = ((langEl && langEl.value) || '').trim();
    var body = (editor ? editor.textarea.value : '').trim();
    var anon = !!(anonBox && anonBox.checked);

    if (!title) return setError('Give your discussion a title.', titleEl);
    if (title.length > MAX_TITLE) {
      return setError('Title must be ' + MAX_TITLE + ' characters or fewer.', titleEl);
    }
    if (!category) return setError('Choose a category.', catEl);
    /* SPEC §4/§5 v2 "language boards": required exactly like category, and the
       backend (live flow and mock alike) rejects a missing one with bad_request. */
    if (!language) return setError('Choose a language board for this question.', langEl);
    if (!body) {
      return setError('Add a body: what you tried, the exact error, and minimal code.',
        editor && editor.textarea);
    }
    if (body.length > MAX_BODY) {
      return setError('Body is ' + body.length + ' characters — the limit is ' + MAX_BODY + '.',
        editor && editor.textarea);
    }
    /* An untouched template is not a question. Posting the skeleton verbatim
       is worse than posting nothing: it reads as a real thread, so people open
       it, and there is nothing in it to answer. Same isTemplate() the composer
       uses to decide it is safe to overwrite, so the two can never disagree. */
    var tplMod = TPL();
    if (tplMod && tplMod.isTemplate(body)) {
      return setError('The body is still the blank template. Replace the italic prompts ' +
        'with your own words — what you are trying to do, the exact error, and the ' +
        'smallest code that shows it.', editor && editor.textarea);
    }
    setError('');

    busy = true;
    /* "Posting…" with nothing moving beside it is the exact reading this whole
       release is fixing. ui.busy() puts a spinner in the button, disables it,
       and hands back the function that restores the real label. */
    var restoreBtn = busyBtn(submitBtn, 'Posting…');

    API().call('threads.create', {
      title: title,
      body_md: body,
      category: category,
      language: language,
      labels: Object.keys(picked),
      is_anonymous: anon
    }).then(function (res) {
      var id = res && res.thread_id;
      if (!id) throw { code: 'bad_request', message: 'The discussion was created but no id came back.' };
      /* §10.1: the search cache is a 90 s sessionStorage snapshot of
         threads.list. We have just changed that list, so drop it — otherwise
         the thread the student just wrote is invisible to search, and to this
         very panel, for up to a minute and a half. */
      try {
        var sidx = SIDX();
        if (sidx && typeof sidx.invalidate === 'function') sidx.invalidate();
      } catch (e2) { /* never let a cache hint break a successful post */ }
      /* PERF FIX 1b: hand the thread itself over so thread.html can paint it
         without waiting out the propagation window. Wrapped, because losing the
         stash costs a spinner and losing the redirect costs the student's post. */
      try {
        var shape = createdThreadShape(id, {
          title: title, body: body, category: category, language: language,
          labels: Object.keys(picked), anon: anon
        });
        stashNewThread(id, shape);
        /* And the same hand-off for the BOARD. Without this, going back to
           index.html inside the propagation window shows a list with the
           question missing — which reads as "it did not post", which is the
           bug report that produced this line. api.js keeps it until
           threads.list returns the id, then drops it; see addPendingThread(). */
        var api2 = API();
        if (typeof api2.addPendingThread === 'function') api2.addPendingThread(shape);
      } catch (e3) { /* thread.js falls back to its retry ladder */ }
      /* &new=1 tells thread.js this thread was JUST created, so a 'not_found'
         on the very next load is the Excel Online write/read propagation
         window (see SPEC/bug ticket), not a lost post — thread.js paints from
         the stash above and, when that is absent, retries instead of showing
         "not found". */
      location.href = 'thread.html?id=' + encodeURIComponent(id) + '&new=1';
    })['catch'](function (e) {
      busy = false;
      restoreBtn();
      if (e && e.code === 'unauthorized') return;      /* api.js already bounced */
      setError(errText(e));
      toast(errText(e), 'error');
    });
  }

  /* ------------------------------------------------------------------ boot */
  function boot() {
    var api = API();
    if (!api || typeof api.call !== 'function') return;
    try {
      if (api.requireLogin && api.requireLogin() === false) return;
    } catch (e) { return; }

    try { if (UI().renderHeader) UI().renderHeader('discussions'); } catch (e) {}

    setError('');

    editor = buildEditor({
      id: 'body',
      rows: 12,
      label: 'Body',
      maxlength: MAX_BODY,
      footer: buildFooter(),
      placeholder: 'What are you trying to do, what did you try, and what exactly happened?\n\n' +
                   'Paste the full error in a code block:\n\n```python\n# your code\n```'
    });
    var slot = $('editor-slot');
    if (slot) slot.appendChild(editor.root);

    var titleInput = $('title'), titleCount = $('title-count');
    if (titleInput && titleCount) {
      titleInput.addEventListener('input', function () {
        titleCount.textContent = String(titleInput.value.length);
      });
    }

    /* --- v3 D2, the other half of "find before you ask". search.html's empty
       state links here as new.html?title=<query>&category=<c>&lang=<l>, and
       renderCategories()/renderLanguages() already honour the last two. ?title
       was being dropped, so the one click the whole flow depends on threw away
       the words the student had just typed and made them retype. Found in the
       browser.
       Rules, in order:
         * an existing value ALWAYS wins — a browser form restore or a back
           navigation is the student's own text and must not be overwritten;
         * trimmed, and clipped to MAX_TITLE so a hand-edited URL cannot put the
           box into a state submit() will only reject;
         * the counter is updated by hand because setting .value fires no
           `input` event, and scheduleSuggest() below then runs against it, so
           arriving from search lands straight on the similar-threads panel. */
    if (titleInput && !titleInput.value) {
      var preTitle = '';
      try {
        preTitle = new URLSearchParams(location.search).get('title') || '';
      } catch (e) { preTitle = ''; }
      preTitle = preTitle.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
      if (preTitle) {
        titleInput.value = preTitle.slice(0, MAX_TITLE);
        if (titleCount) titleCount.textContent = String(titleInput.value.length);
      }
    }
    var bodyCount = $('body-count');
    if (bodyCount) {
      editor.textarea.addEventListener('input', function () {
        var n = editor.textarea.value.length;
        bodyCount.textContent = String(n);
        bodyCount.style.color = n > MAX_BODY ? 'var(--danger)' : '';
      });
    }

    /* --- v3 D7: template bar. Mounted above the editor, listening on the
       textarea so the chips always describe what is actually in the box.
       Debounced because renderTemplateBar() runs isTemplate() (eight string
       comparisons) and a fast typist fires input ~15 times a second. --- */
    tplBar = buildTemplateBar();
    editor.textarea.addEventListener('input', function () {
      if (tplState.timer) clearTimeout(tplState.timer);
      tplState.timer = setTimeout(renderTemplateBar, 200);
    });
    var catSel = $('category');
    if (catSel) catSel.addEventListener('change', onCategoryChanged);

    /* --- v3 D11 wiring. uploads.js is F5's module, but §8.4 loads it on
       new.html and only the page owner can hand it a textarea — so the call
       lives here, outside buildEditor(), operating on editor.textarea exactly
       like everything else in this section. Everything about it is optional:
       no Clinic.uploads (F5 not deployed), no attachments_enabled, or an
       attach.create the flow does not know yet, and pasting an image is the
       browser no-op it always was, with the typed text untouched. --- */
    var upl = window.Clinic && window.Clinic.uploads;
    if (upl && typeof upl.attach === 'function' && slot && slot.parentNode) {
      var tray = el('div', 'upload-tray');
      tray.id = 'upload-tray';
      slot.parentNode.insertBefore(tray, slot.nextSibling);
      try {
        upl.attach({
          textarea: editor.textarea,
          tray: tray,
          /* The toolbar's "Image" button. Paste and drop already worked; a
             control you can SEE is what makes the feature discoverable to
             someone who has never pasted an image into a web page. uploads.js
             hides it by itself when attachments are unavailable. */
          button: editor.imageButton,
          scope: 'thread',      /* a new thread has no id yet; scope_id is not
                                   required for 'thread' scope (§4.3) */
          /* Inserting markdown sets textarea.value directly, which fires no
             `input` event — so a live preview would sit there missing the
             screenshot that just landed. */
          onInsert: editor.refreshPreview
        });
      } catch (e) { /* §10.10: quiet. Never a console error on this path. */ }
    }

    /* --- v3 D2: similar threads under the title. Built only when F3's
       search-index.js is present; otherwise the composer is exactly what it
       was before, with no gap and nothing logged. --- */
    simPanel = buildSimilarPanel();
    if (simPanel && titleInput) {
      titleInput.addEventListener('input', scheduleSuggest);
      /* Arriving with a title already in the box (browser restore, a back
         navigation) should still get a look. */
      scheduleSuggest();
    }

    var form = $('new-form');
    if (form) form.addEventListener('submit', submit);
    editor.textarea.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });

    languageSel = buildLanguageField();
    if (languageSel) languageSel.addEventListener('change', onLanguageChangedForTemplate);

    renderGuidance();

    window.addEventListener('clinic:bootstrap', function (ev) {
      if (!ev || !ev.detail || !ev.detail.config) return;
      cfg = ev.detail.config;
      renderCategories(); renderLanguages(); renderLabels(); renderGuidance();
      /* A background bootstrap refresh can change the category list under us.
         onCategoryChanged() is a no-op when the selection has not moved, so
         this cannot re-insert a template over anything. */
      onCategoryChanged();
    });

    var p = (typeof api.bootstrap === 'function') ? api.bootstrap() : api.call('meta.bootstrap', {});
    p.then(function (b) {
      cfg = (b && b.config) || cfg;
      renderCategories();
      renderLanguages();
      renderLabels();
      renderGuidance();
      /* Now that the <select> actually has options, honour a ?category= deep
         link (a link from a category pill, or the "ask in this category"
         route) exactly as if the student had picked it by hand. */
      onCategoryChanged();
    })['catch'](function (e) {
      if (e && e.code === 'unauthorized') return;
      toast(errText(e), 'error');
      setError('Could not load categories, languages and labels: ' + errText(e));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
