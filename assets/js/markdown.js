/*!
 * NUS Coding Clinic — markdown.js
 * The single sanctioned path from user-written markdown to the DOM (SPEC.md §3).
 *
 *   marked (GFM) -> DOMPurify -> highlight.js -> copy buttons
 *
 * CONTRACT — note the return type:
 *
 *   Clinic.md.render(mdText)      -> HTMLElement   <div class="markdown-body">…</div>
 *                                    Ready to append. It is NOT an HTML string.
 *   Clinic.md.renderInto(el, md)  -> HTMLElement   empties `el`, adds .markdown-body
 *                                    to it, fills it in, returns `el`.
 *   Clinic.md.html(mdText)        -> string        sanitized HTML, no highlighting and
 *                                    no copy buttons. Escape hatch; prefer render().
 *   Clinic.md.enhance(el)         -> el            re-run highlighting + copy buttons
 *                                    over an element you built yourself. Idempotent.
 *   Clinic.md.strip(mdText, max)  -> string        plain-text excerpt, for previews,
 *                                    search and <title>. Never touches the DOM.
 *   Clinic.md.available()         -> bool          false when the vendor libs missing.
 *
 * Typical use:
 *   commentBodyEl.appendChild(Clinic.md.render(post.body_md));
 *   Clinic.md.renderInto(previewEl, textarea.value);          // composer preview
 *
 * DOM produced for a fenced code block:
 *   <div class="code-block">
 *     <pre><code class="hljs language-python">…</code></pre>
 *     <button class="code-copy">Copy</button>
 *   </div>
 * i.e. the button is a SIBLING of <pre> inside a .code-block wrapper — which is
 * the shape main.css already anticipates (`.code-block { position: relative }`,
 * `.code-block:hover .code-copy { opacity: 1 }`, `.code-copy.is-copied`).
 *
 * Safety: raw HTML in a post is parsed by marked and then removed by DOMPurify —
 * script/style/iframe/form/object and every on* handler are stripped, `style`
 * attributes are stripped, and only http/https/mailto/relative links survive. Links
 * get target="_blank" rel="noopener noreferrer". If any vendor library failed to
 * load, render() falls back to the source text inside an escaped <pre>, so a broken
 * or blocked CDN copy can never inject markup and never blanks a page.
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  var COPY_LABEL = 'Copy';
  var COPIED_LABEL = '\u2713';      /* a tick */
  var COPIED_MS = 1400;

  /* ------------------------------------------------------------- sanitizer */

  var PURIFY_CONFIG = {
    ALLOWED_TAGS: [
      'p', 'br', 'hr', 'span', 'div',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'strong', 'b', 'em', 'i', 'u', 'del', 's', 'mark', 'small', 'sub', 'sup', 'kbd',
      'a', 'img',
      'ul', 'ol', 'li',
      'blockquote',
      'pre', 'code', 'samp', 'var',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
      'dl', 'dt', 'dd',
      'details', 'summary',
      'input'                            /* GFM task lists: disabled checkboxes only */
    ],
    ALLOWED_ATTR: [
      'href', 'title', 'alt', 'src', 'class', 'id', 'lang', 'dir',
      'align', 'colspan', 'rowspan', 'span', 'start', 'reversed', 'value',
      'width', 'height', 'loading',
      'type', 'checked', 'disabled', 'open'
    ],
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'button',
      'link', 'meta', 'base', 'svg', 'math', 'template', 'noscript'],
    FORBID_ATTR: ['style', 'srcset', 'formaction', 'target', 'ping'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    KEEP_CONTENT: true
    /* Deliberately no USE_PROFILES: setting it makes DOMPurify discard the
       ALLOWED_TAGS/ALLOWED_ATTR lists above and fall back to its whole HTML
       profile, which is far wider than markdown ever needs. */
  };

  var hooksInstalled = false;
  function installHooks() {
    if (hooksInstalled || !window.DOMPurify || !window.DOMPurify.addHook) return;
    hooksInstalled = true;
    window.DOMPurify.addHook('afterSanitizeAttributes', function (node) {
      if (node.tagName === 'A' && node.getAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer nofollow ugc');
      }
      /* Task-list checkboxes are the only <input> markdown can produce. Anything
         else that slipped through gets neutered rather than trusted. */
      if (node.tagName === 'INPUT') {
        var type = (node.getAttribute('type') || '').toLowerCase();
        if (type !== 'checkbox') { if (node.parentNode) node.parentNode.removeChild(node); return; }
        node.setAttribute('disabled', 'disabled');
      }
      if (node.tagName === 'IMG') {
        node.setAttribute('loading', 'lazy');
        if (!node.getAttribute('alt')) node.setAttribute('alt', '');
      }
    });
  }

  function haveLibs() {
    return !!(window.marked && (window.marked.parse || typeof window.marked === 'function') &&
      window.DOMPurify && window.DOMPurify.sanitize);
  }

  var markedReady = false;
  function parseMarkdown(src) {
    var m = window.marked;
    if (!markedReady && m && m.setOptions) {
      /* gfm gives tables, strikethrough, task lists and autolinks; breaks makes a
         single newline a <br>, which is what people typing in a textarea expect. */
      m.setOptions({ gfm: true, breaks: true });
      markedReady = true;
    }
    if (m.parse) return m.parse(src, { gfm: true, breaks: true });
    return m(src);                                    /* very old marked builds */
  }

  function sanitizedHtml(mdText) {
    var src = (mdText === null || mdText === undefined) ? '' : String(mdText);
    if (!src) return '';
    if (!haveLibs()) return null;
    installHooks();
    try {
      return window.DOMPurify.sanitize(parseMarkdown(src), PURIFY_CONFIG);
    } catch (e) {
      return null;
    }
  }

  /* -------------------------------------------------------- highlighting */

  var hljsReady = false;
  function configureHljs() {
    if (hljsReady || !window.hljs || !window.hljs.configure) return;
    hljsReady = true;
    /* We hand hljs already-sanitized markup; its unescaped-HTML warning would
       otherwise fire on every code block containing entities. */
    window.hljs.configure({ ignoreUnescapedHTML: true, cssSelector: '.markdown-body pre code' });
  }

  function languageOf(codeEl) {
    var cls = codeEl.className || '';
    var m = /(?:^|\s)(?:language|lang)-([A-Za-z0-9_+#.-]+)/.exec(cls);
    return m ? { name: m[1].toLowerCase(), token: m[0] } : null;
  }

  function highlightIn(root) {
    var hljs = window.hljs;
    if (!hljs || !hljs.highlightElement) return;
    configureHljs();
    var blocks = root.querySelectorAll('pre > code');
    for (var i = 0; i < blocks.length; i++) {
      var code = blocks[i];
      if (code.getAttribute('data-highlighted') === 'yes') continue;
      var lang = languageOf(code);
      if (lang && hljs.getLanguage && !hljs.getLanguage(lang.name)) {
        /* Unknown fence language (```pseudocode). Drop the class so hljs
           auto-detects quietly instead of logging a warning at the student. */
        code.className = (code.className || '').replace(lang.token, ' ');
      }
      try {
        hljs.highlightElement(code);        /* no language class -> auto-detect */
      } catch (e) {
        code.className += ' hljs';          /* leave the text alone, keep the styling hook */
      }
    }
  }

  /* --------------------------------------------------------- copy buttons */

  function codeTextOf(block) {
    var pre = block.tagName === 'PRE' ? block : block.querySelector('pre');
    if (!pre) return '';
    var code = pre.querySelector('code');
    if (code) return code.textContent || '';
    var copy = pre.cloneNode(true);
    var btns = copy.querySelectorAll('.code-copy');
    for (var i = 0; i < btns.length; i++) btns[i].parentNode.removeChild(btns[i]);
    return copy.textContent || '';
  }

  /* Each <pre> gets wrapped in <div class="code-block"> with the button as a
     sibling of the <pre>, not a child of it. main.css positions the button
     against .code-block, so it stays pinned to the corner while a wide
     traceback scrolls underneath instead of sliding away with the text. */
  function addCopyButtons(root) {
    var pres = root.querySelectorAll('pre');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      var parent = pre.parentNode;
      if (!parent) continue;
      var wrap;
      if (parent.classList && parent.classList.contains('code-block')) {
        wrap = parent;
      } else {
        wrap = document.createElement('div');
        wrap.className = 'code-block';
        parent.insertBefore(wrap, pre);
        wrap.appendChild(pre);
      }
      if (wrap.querySelector('.code-copy')) continue;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'code-copy';
      btn.textContent = COPY_LABEL;
      btn.setAttribute('aria-label', 'Copy code to clipboard');
      wrap.appendChild(btn);
    }
  }

  function copyText(text) {
    if (window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText) {
      return window.navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) resolve(); else reject(new Error('copy failed'));
    });
  }

  function flash(btn, label) {
    btn.textContent = label;
    btn.classList.add('is-copied');          /* main.css keys off .is-copied */
    btn.classList.add('copied');
    window.setTimeout(function () {
      btn.textContent = COPY_LABEL;
      btn.classList.remove('is-copied');
      btn.classList.remove('copied');
    }, COPIED_MS);
  }

  /* One delegated listener for the whole document — no per-button closures, so
     rendered markdown can be thrown away and rebuilt without leaking handlers. */
  document.addEventListener('click', function (ev) {
    var el = ev.target;
    if (!el || !el.closest) return;
    var btn = el.closest('.code-copy');
    if (!btn) return;
    ev.preventDefault();
    var block = btn.closest('.code-block') || btn.closest('pre');
    if (!block) return;
    copyText(codeTextOf(block)).then(function () {
      flash(btn, COPIED_LABEL);
    }, function () {
      flash(btn, 'Press Ctrl+C');
    });
  }, false);

  /* ------------------------------------------------------------- rendering */

  function enhance(el) {
    if (!el) return el;
    highlightIn(el);
    addCopyButtons(el);
    return el;
  }

  function fillFallback(el, src) {
    var pre = document.createElement('pre');
    pre.className = 'md-fallback';
    pre.textContent = src;                    /* textContent = escaped by definition */
    el.appendChild(pre);
    return el;
  }

  function renderInto(el, mdText) {
    if (!el) return el;
    var src = (mdText === null || mdText === undefined) ? '' : String(mdText);
    while (el.firstChild) el.removeChild(el.firstChild);
    if (el.classList && !el.classList.contains('markdown-body')) {
      el.classList.add('markdown-body');
    }
    if (!src) return el;
    var html = sanitizedHtml(src);
    if (html === null) return fillFallback(el, src);   /* vendor libs unavailable */
    el.innerHTML = html;                               /* sanitized above */
    return enhance(el);
  }

  function render(mdText) {
    var el = document.createElement('div');
    el.className = 'markdown-body';
    return renderInto(el, mdText);
  }

  /* Plain-text excerpt. Deliberately crude and DOM-free: it is for search
     matching, list previews and document titles, not for display fidelity. */
  function strip(mdText, max) {
    var s = (mdText === null || mdText === undefined) ? '' : String(mdText);
    s = s.replace(/```[\s\S]*?```/g, ' ')          // fenced code
      .replace(/~~~[\s\S]*?~~~/g, ' ')
      .replace(/`([^`]*)`/g, '$1')                 // inline code
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')    // images
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')     // links
      .replace(/^\s{0,3}>+\s?/gm, '')              // blockquotes
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // headings
      .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, ' ')   // rules
      .replace(/^\s{0,3}[-*+]\s+/gm, '')           // bullets
      .replace(/^\s{0,3}\d+[.)]\s+/gm, '')         // numbered lists
      .replace(/[*_~]{1,3}/g, '')                  // emphasis marks
      .replace(/<[^>]*>/g, ' ')                    // stray html
      .replace(/\s+/g, ' ')
      .trim();
    var limit = max || 0;
    if (limit > 0 && s.length > limit) {
      s = s.slice(0, limit).replace(/\s+\S*$/, '') + '\u2026';
    }
    return s;
  }

  Clinic.md = {
    render: render,
    renderInto: renderInto,
    html: function (mdText) {
      var html = sanitizedHtml(mdText);
      return html === null ? '' : html;
    },
    enhance: enhance,
    strip: strip,
    available: haveLibs
  };

})(window, document);
