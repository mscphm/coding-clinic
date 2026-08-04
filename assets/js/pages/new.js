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

  var cfg = { categories: [], labels: [], notice_text: '' };
  var picked = {};                    /* label -> true */
  var editor = null;
  var anonBox = null;
  var submitBtn = null;
  var busy = false;

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

    var titleEl = $('title'), catEl = $('category');
    var title = (titleEl.value || '').trim();
    var category = (catEl.value || '').trim();
    var body = (editor ? editor.textarea.value : '').trim();
    var anon = !!(anonBox && anonBox.checked);

    if (!title) return setError('Give your discussion a title.', titleEl);
    if (title.length > MAX_TITLE) {
      return setError('Title must be ' + MAX_TITLE + ' characters or fewer.', titleEl);
    }
    if (!category) return setError('Choose a category.', catEl);
    if (!body) {
      return setError('Add a body: what you tried, the exact error, and minimal code.',
        editor && editor.textarea);
    }
    if (body.length > MAX_BODY) {
      return setError('Body is ' + body.length + ' characters — the limit is ' + MAX_BODY + '.',
        editor && editor.textarea);
    }
    setError('');

    busy = true;
    if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Posting…'; }

    API().call('threads.create', {
      title: title,
      body_md: body,
      category: category,
      labels: Object.keys(picked),
      is_anonymous: anon
    }).then(function (res) {
      var id = res && res.thread_id;
      if (!id) throw { code: 'bad_request', message: 'The discussion was created but no id came back.' };
      location.href = 'thread.html?id=' + encodeURIComponent(id);
    })['catch'](function (e) {
      busy = false;
      if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Start discussion'; }
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
    var bodyCount = $('body-count');
    if (bodyCount) {
      editor.textarea.addEventListener('input', function () {
        var n = editor.textarea.value.length;
        bodyCount.textContent = String(n);
        bodyCount.style.color = n > MAX_BODY ? 'var(--danger)' : '';
      });
    }

    var form = $('new-form');
    if (form) form.addEventListener('submit', submit);
    editor.textarea.addEventListener('keydown', function (ev) {
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') { ev.preventDefault(); submit(); }
    });

    renderGuidance();

    window.addEventListener('clinic:bootstrap', function (ev) {
      if (!ev || !ev.detail || !ev.detail.config) return;
      cfg = ev.detail.config;
      renderCategories(); renderLabels(); renderGuidance();
    });

    var p = (typeof api.bootstrap === 'function') ? api.bootstrap() : api.call('meta.bootstrap', {});
    p.then(function (b) {
      cfg = (b && b.config) || cfg;
      renderCategories();
      renderLabels();
      renderGuidance();
    })['catch'](function (e) {
      if (e && e.code === 'unauthorized') return;
      toast(errText(e), 'error');
      setError('Could not load categories and labels: ' + errText(e));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
