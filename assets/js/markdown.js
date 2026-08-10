/*!
 * NUS Coding Clinic — markdown.js
 * The single sanctioned path from user-written markdown to the DOM (SPEC.md §3).
 *
 *   marked (GFM) -> DOMPurify -> [img src rewrite] -> highlight.js -> copy buttons
 *                -> KaTeX -> attachment resolution
 *
 * The last two passes run on the LIVE DOM, after the sanitizer, because that is the
 * only place they can run. See "the two post-sanitise passes" below.
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
 *   Clinic.md.mathAvailable()    -> bool          false when katex.min.js did not load.
 *   Clinic.md.renderMath(el)     -> el            v3 §10.4. Typesets $…$ / $$…$$ in place.
 *   Clinic.md.resolveImages(el)  -> el            v3 §10.4. Lazily fetches clinic-img/…
 *                                    placeholders through attach.get. Idempotent.
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
 *
 * ---------------------------------------------------------------------------
 * THE TWO POST-SANITISE PASSES (v3 §10.4) — read this before touching them.
 * ---------------------------------------------------------------------------
 *
 * 1. KaTeX. PURIFY_CONFIG below has `math` and `svg` in FORBID_TAGS, `style` in
 *    FORBID_ATTR and ALLOW_DATA_ATTR:false. KaTeX output is nothing BUT nested
 *    spans carrying inline `style` (verified: katex 0.18.1 `output:'html'` emits
 *    no <math> and no <svg>, but ~40 style attributes on a two-line formula).
 *    Wiring KaTeX in as a `marked` extension therefore produces silently mangled
 *    output — no exception, no console warning, just collapsed formulas. This
 *    has already bitten this project once. renderMath() runs on the LIVE DOM,
 *    after DOMPurify has finished, and the sanitizer allowlist is NOT widened to
 *    let raw math through — widening it would reopen an XSS hole for every post.
 *
 *    Math is never detected inside <pre>, <code>, <kbd>, <samp>, <var> or <a>,
 *    so a pasted `echo $PATH`, a `$5` price or a shell traceback survives intact.
 *    See MATH_SKIP and inlineAt() for the exact rules.
 *
 *    KNOWN AND DELIBERATE: `\(…\)` and `\[…\]` are supported by renderMath, but
 *    they cannot reach it through render()/renderInto(), because CommonMark
 *    treats `(`, `)`, `[` and `]` as escapable punctuation and marked strips the
 *    backslash before we ever see the text ("paren \(x^2\) end" arrives as
 *    "paren (x^2) end"). Through the markdown pipeline only `$…$` and `$$…$$`
 *    work. The two backslash forms are kept for enhance() calls over DOM that
 *    did not come from marked.
 *
 * 2. Attachment images. The site is public GitHub Pages and api.js authenticates
 *    with a session token in the POST body; an <img src> is a plain unauthenticated
 *    GET. So the browser must never fetch an attachment at all. rewriteImages()
 *    turns every <img> in the sanitised HTML STRING into a 1x1 transparent GIF
 *    before it is ever assigned, and resolveImages() then pulls the bytes through
 *    attach.get and assigns a data: URI. Rewriting the string (not a detached
 *    DOM node) is deliberate: assigning innerHTML on a detached <div> still starts
 *    the image load in Chrome, which is exactly what we are preventing.
 *
 *    The same pass blocks EVERY remote <img>. On a board built around anonymous
 *    posting a remote image is a tracking beacon: anyone can embed one and collect
 *    the IP, user-agent and read time of every viewer, including an anonymous
 *    author returning to their own thread (v3 R8 vector 7).
 *
 *    COST, stated honestly: each distinct image is one flow round-trip of 10–21 s
 *    and 3 Excel + 1 OneDrive call. Six screenshots in a thread is 18 Excel calls
 *    from one student opening one page. That is why resolveImages runs ONE
 *    attach.get at a time and only for images that have scrolled into view.
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

  /* ------------------------------------------------- img src rewrite (§10.4) */

  /* A 1x1 fully transparent GIF. Assigned to every <img> that leaves the
     sanitizer, so the browser issues no request for anything — not for
     clinic-img/… (which would 404 against GitHub Pages and leak attachment ids
     into its access log) and not for a remote beacon. */
  var PIXEL_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  /* Matches a whole <img …> tag in SERIALISED html. The alternation is not
     paranoia: HTML attribute serialisation escapes & and " but NOT >, so a post
     containing ![a > b](x) really does produce a tag with a bare > inside a
     quoted value, and a naive [^>]* would cut the tag in half. */
  var IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  var SRC_ATTR_RE = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  var ALT_ATTR_RE = /\salt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
  var TITLE_ATTR_RE = /\stitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

  /* §10.4 writes this as /^a_[A-Za-z0-9-]+$/, which is right for production
     ids (concat('a_', guid()) — hyphens only) but WRONG for the mock, whose
     hand-written seed ids include a_dm_trace. Found in the browser: the DM
     screenshot rendered as "External image blocked". Underscore is added.
     Still a strict allowlist — no slash, no dot, no colon — so nothing about
     the security of the rewrite changes. */
  var CLINIC_IMG_RE = /^clinic-img\/(a_[A-Za-z0-9_-]+)$/;
  /* data: images are local and inert — no host to phone home to — so they are
     the one non-attachment src that survives. Restricted to raster types:
     data:image/svg+xml is a document, and although scripts inside an <img> do
     not run, there is no reason for a markdown post to need one. */
  var DATA_IMG_RE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);/i;
  var HTTP_URL_RE = /^(?:https?:)?\/\//i;

  function attrOf(tag, re) {
    var m = re.exec(tag);
    if (!m) return '';
    return m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : '');
  }

  /* The value handed in is already HTML-escaped (it came out of a serialised
     attribute), so it can go straight back into a double-quoted attribute:
     serialisation escapes " as &quot;. Belt and braces on the quote anyway. */
  function attrSafe(v) {
    return String(v === null || v === undefined ? '' : v).replace(/"/g, '&quot;');
  }

  function rewriteImages(html) {
    if (!html || html.indexOf('<img') === -1) return html;
    return html.replace(IMG_TAG_RE, function (tag) {
      var src = attrOf(tag, SRC_ATTR_RE);
      var alt = attrOf(tag, ALT_ATTR_RE);
      var title = attrOf(tag, TITLE_ATTR_RE);
      var titleAttr = title ? ' title="' + attrSafe(title) + '"' : '';

      var m = CLINIC_IMG_RE.exec(src);
      if (m) {
        /* This is post-sanitise, so DOMPurify cannot strip the data-att we add
           (ALLOW_DATA_ATTR is false and stays false). .is-loading reserves the
           box — main.css gives .clinic-att a load-bearing min-height, because
           attach.get takes 10-21 s and the post would otherwise reflow under
           the reader as each image lands. */
        /* width/height are the RESERVED BOX, and they are load-bearing, not
           decoration. The placeholder is a 1x1 GIF, so without them the
           browser takes its 1:1 intrinsic ratio and (with .markdown-body img's
           `max-width:100%`) paints a full-width SQUARE — found in the browser:
           a 794px-wide post reserved a 794px-tall empty box for every image.
           They are dropped again in applyAtt() so the real image uses its own
           aspect ratio. */
        /* This used to carry an inline `style="max-width:420px"`, because §9.8's
           `.clinic-att { max-width:420px }` (0,1,0) LOST to main.css's
           `.markdown-body img { max-width:100% }` (0,1,1) and .clinic-att only
           ever appears inside .markdown-body — so the cap never applied and a
           320px screenshot painted 1136px wide, upscaled 3.5x, in a real thread.
           main.css §21 now states the rule at a specificity that wins, so the
           inline style is GONE and the number lives in exactly one file. Do not
           put it back; raise the CSS specificity instead. */
        return '<img class="clinic-att is-loading" data-att="' + attrSafe(m[1]) + '"' +
          ' src="' + PIXEL_GIF + '" alt="' + attrSafe(alt) + '"' + titleAttr +
          ' width="420" height="240" loading="lazy">';
      }

      if (DATA_IMG_RE.test(src)) return tag;      /* inert, local, no request */

      /* Everything else is remote and is replaced, not merely deferred. The
         visible link text is the original URL so the reader decides, having
         seen where it goes. DOMPurify has already rejected javascript: and
         friends, but only http(s) gets an anchor here regardless. */
      var shown = attrSafe(src);
      var link = HTTP_URL_RE.test(src)
        ? '<a href="' + shown + '" rel="noreferrer noopener nofollow ugc" target="_blank">' + shown + '</a>'
        : '<span>' + shown + '</span>';
      return '<img src="' + PIXEL_GIF + '" alt="' + attrSafe(alt) + '"' + titleAttr +
        ' width="1" height="1">' +
        '<span class="ext-img-blocked">External image blocked — ' + link + '</span>';
    });
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

  /* ------------------------------------------------------------ KaTeX (D8) */

  function mathAvailable() {
    return !!(window.katex && typeof window.katex.renderToString === 'function');
  }

  /* Never look for math inside these. PRE/CODE is what protects a pasted
     `echo $PATH`, a traceback full of `$` and a `$5` in a shell prompt; KBD /
     SAMP / VAR are the other code-ish tags the sanitizer allows; A is in the
     contract because a link's text is not prose the author is typesetting. */
  var MATH_SKIP = {
    PRE: 1, CODE: 1, KBD: 1, SAMP: 1, VAR: 1, A: 1,
    SCRIPT: 1, STYLE: 1, TEXTAREA: 1, BUTTON: 1
  };
  var MAX_INLINE_TEX = 400;
  var MAX_DISPLAY_TEX = 4000;

  function mathSkipped(node) {
    if (MATH_SKIP[node.nodeName]) return true;
    var cls = node.className;
    /* className is an SVGAnimatedString on svg, hence the typeof guard. Any
       already-rendered formula is skipped, which is what makes enhance()
       idempotent over math. */
    return typeof cls === 'string' && cls.indexOf('katex') !== -1;
  }

  /* `breaks:true` means a display formula written on three lines arrives as
     <p>$$<br>E = mc^2<br>$$</p> — the delimiters and the body are in DIFFERENT
     text nodes. So we do not scan text nodes one at a time; we scan each
     maximal contiguous run of text-and-<br> under one parent as a single
     string, with <br> standing in for "\n", and rebuild the run afterwards.
     Math that spans an inline element (`$a *b* c$`) is out of scope and stays
     as source, which is the safe direction to fail in. */
  function collectRuns(root, out) {
    var kids = root.childNodes, run = null, i, n;
    for (i = 0; i < kids.length; i++) {
      n = kids[i];
      if (n.nodeType === 3) { (run || (run = [])).push(n); continue; }
      if (n.nodeType === 1 && n.nodeName === 'BR') { (run || (run = [])).push(n); continue; }
      if (run) { out.push(run); run = null; }
      if (n.nodeType === 1 && !mathSkipped(n)) collectRuns(n, out);
    }
    if (run) out.push(run);
  }

  function runSource(run) {
    var text = '', br = {}, i;
    for (i = 0; i < run.length; i++) {
      if (run[i].nodeType === 3) text += run[i].data;
      else { br[text.length] = true; text += '\n'; }
    }
    return { text: text, br: br };
  }

  /* One inline `$…$` span starting at i, or null. The three rejection rules are
     what keep prose intact:
       - an opener followed by whitespace is prose ("cost $ 5")
       - a closer preceded by whitespace is prose ("$5 and $10")
       - a closer followed by a digit is prose ("US$5 … US$10")
     plus: inline math never spans a line break. Rejecting outright rather than
     hunting for a later closer is deliberate — eating a student's shell output
     is a much worse failure than leaving a formula unrendered. */
  function inlineAt(s, i) {
    var open = s.charAt(i + 1);
    if (!open || /\s/.test(open)) return null;
    var j = i + 1, c, prev, next;
    while (j < s.length) {
      c = s.charAt(j);
      if (c === '\\') { j += 2; continue; }
      if (c === '\n') return null;
      if (c === '$') {
        prev = s.charAt(j - 1);
        next = s.charAt(j + 1);
        if (/\s/.test(prev)) return null;
        if (next && /[0-9]/.test(next)) return null;
        var tex = s.slice(i + 1, j);
        if (!tex || tex.length > MAX_INLINE_TEX) return null;
        return { start: i, end: j + 1, tex: tex, display: false };
      }
      j++;
    }
    return null;
  }

  function findMath(s) {
    var out = [], i = 0, n = s.length, c, nx, e, tex, span;
    while (i < n) {
      c = s.charAt(i);
      if (c === '\\') {
        nx = s.charAt(i + 1);
        if (nx === '(') {
          e = s.indexOf('\\)', i + 2);
          if (e > i + 1) {
            tex = s.slice(i + 2, e);
            if (tex.length <= MAX_INLINE_TEX) {
              out.push({ start: i, end: e + 2, tex: tex, display: false });
              i = e + 2; continue;
            }
          }
        } else if (nx === '[') {
          e = s.indexOf('\\]', i + 2);
          if (e > i + 1) {
            tex = s.slice(i + 2, e);
            if (tex.length <= MAX_DISPLAY_TEX) {
              out.push({ start: i, end: e + 2, tex: tex, display: true });
              i = e + 2; continue;
            }
          }
        }
        i += 2;                                   /* an escaped char: skip both */
        continue;
      }
      if (c === '$') {
        if (s.charAt(i + 1) === '$') {
          e = s.indexOf('$$', i + 2);
          if (e > i + 1) {
            tex = s.slice(i + 2, e);
            if (tex.replace(/\s/g, '') && tex.length <= MAX_DISPLAY_TEX) {
              out.push({ start: i, end: e + 2, tex: tex, display: true });
              i = e + 2; continue;
            }
          }
          i += 2; continue;
        }
        span = inlineAt(s, i);
        if (span) { out.push(span); i = span.end; continue; }
      }
      i++;
    }
    return out;
  }

  function appendPlain(frag, info, from, to) {
    var buf = '', i;
    for (i = from; i < to; i++) {
      if (info.br[i]) {
        if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
        frag.appendChild(document.createElement('br'));
      } else {
        buf += info.text.charAt(i);
      }
    }
    if (buf) frag.appendChild(document.createTextNode(buf));
  }

  function mathNode(span) {
    var wrap = document.createElement('span');
    var raw = span.display ? '$$' + span.tex + '$$' : '$' + span.tex + '$';
    wrap.className = span.display ? 'katex-block' : 'katex-inline';
    wrap.setAttribute('role', 'math');
    /* aria-label carries the raw TeX. MathML is not an option here: <math> is
       in FORBID_TAGS and stays there. */
    wrap.setAttribute('aria-label', span.tex);
    var html;
    try {
      html = window.katex.renderToString(span.tex, {
        displayMode: !!span.display,
        throwOnError: false,          /* a typo renders as visible red source, never a blank post */
        output: 'html',               /* suppresses the <math> half the sanitizer forbids */
        trust: false,
        strict: 'ignore'
      });
    } catch (e) {
      wrap.className = 'katex-error';
      wrap.removeAttribute('role');
      wrap.removeAttribute('aria-label');
      wrap.textContent = raw;
      return wrap;
    }
    /* A DETACHED element, per §10.4 — never innerHTML over the live body. The
       string is KaTeX's own output for a TeX source with trust:false, not user
       HTML, and it contains no <img>, so nothing loads. */
    var holder = document.createElement('span');
    holder.innerHTML = html;
    while (holder.firstChild) wrap.appendChild(holder.firstChild);
    /* KaTeX writes color:#cc0000 inline on its error span, which is unreadable
       on the dark canvas. Drop it and let main.css's --danger do the work. */
    if (wrap.querySelectorAll) {
      var errs = wrap.querySelectorAll('.katex-error');
      for (var k = 0; k < errs.length; k++) errs[k].removeAttribute('style');
    }
    return wrap;
  }

  function renderMath(el) {
    if (!el) return el;
    /* THE degradation: no katex.min.js -> the $…$ source simply stays visible.
       No error, no half-rendered formula, no console noise. */
    if (!mathAvailable()) return el;
    var all = el.textContent || '';
    if (all.indexOf('$') === -1 && all.indexOf('\\(') === -1 && all.indexOf('\\[') === -1) return el;
    if (mathSkipped(el)) return el;

    var runs = [];
    collectRuns(el, runs);
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var info = runSource(run);
      if (info.text.indexOf('$') === -1 && info.text.indexOf('\\') === -1) continue;
      var spans = findMath(info.text);
      if (!spans.length) continue;
      var parent = run[0].parentNode;
      if (!parent) continue;
      var frag = document.createDocumentFragment();
      var pos = 0, k;
      for (k = 0; k < spans.length; k++) {
        appendPlain(frag, info, pos, spans[k].start);
        frag.appendChild(mathNode(spans[k]));
        pos = spans[k].end;
      }
      appendPlain(frag, info, pos, info.text.length);
      parent.insertBefore(frag, run[0]);
      for (k = 0; k < run.length; k++) {
        if (run[k].parentNode === parent) parent.removeChild(run[k]);
      }
    }
    return el;
  }

  /* --------------------------------------------- attachment images (D11) */

  /* Same ladder shape thread.js uses for the write-propagation race: an image
     posted seconds ago is not readable from Excel yet, and a broken picture is
     a worse answer than a placeholder that fills in. */
  var NOT_FOUND_RETRY_DELAYS_MS = [2000, 4000, 6000, 8000, 10000, 10000, 10000];

  /* Session cache. Deliberately module-level and deliberately NOT sessionStorage:
     base64 screenshots blow its ~5 MB quota, and the browser cannot HTTP-cache a
     data: URI assigned by JS. Re-opening the thread pays for the images again. */
  var attCache = {};
  var attQueue = [];
  var attBusy = false;
  var attObserver = null;                          /* null = untried, false = unavailable */

  function cached(id) {
    return Object.prototype.hasOwnProperty.call(attCache, id) ? attCache[id] : null;
  }

  function attCaption(img, message) {
    var next = img.nextSibling;
    if (next && next.nodeType === 1 && next.className === 'clinic-att-caption') {
      next.textContent = message;
      return;
    }
    var cap = document.createElement('span');
    cap.className = 'clinic-att-caption';
    cap.textContent = message;
    if (img.parentNode) img.parentNode.insertBefore(cap, img.nextSibling);
  }

  function applyAtt(img, rec) {
    img.src = 'data:' + rec.content_type + ';base64,' + rec.data_b64;
    if (img.classList) img.classList.remove('is-loading');
    img.removeAttribute('width');
    img.removeAttribute('height');
    img.setAttribute('data-att-state', 'done');
  }

  function failAtt(img, message) {
    if (img.classList) { img.classList.remove('is-loading'); img.classList.add('is-error'); }
    img.setAttribute('data-att-state', 'error');
    if (!img.getAttribute('alt')) img.setAttribute('alt', message);
    attCaption(img, message);
  }

  function attDone() { attBusy = false; attPump(); }

  function attPump() {
    if (attBusy) return;
    var img = attQueue.shift();
    while (img && !img.parentNode) img = attQueue.shift();   /* the post was re-rendered */
    if (!img) return;
    attBusy = true;
    /* The ladder position lives on the node, so a re-queued image resumes where
       it left off instead of starting the ladder over. */
    attFetch(img, parseInt(img.getAttribute('data-att-attempt'), 10) || 0);
  }

  /* ONE attach.get in flight at a time, for the whole page. Six screenshots on
     one thread is 18 Excel calls; firing them together collides with
     meta.bootstrap and threads.get on the same paint and, at N=60, starves
     sign-in. The placeholder is already visible, so serialising costs the
     reader nothing but the tail image arriving later. */
  function attFetch(img, attempt) {
    var id = img.getAttribute('data-att');
    var hit = cached(id);
    if (hit) { applyAtt(img, hit); attDone(); return; }
    var api = window.Clinic && window.Clinic.api;
    if (!api || !api.call) { failAtt(img, 'Image could not be loaded.'); attDone(); return; }
    api.call('attach.get', { attachment_id: id }).then(function (resp) {
      var rec = {
        content_type: (resp && resp.content_type) || 'image/png',
        data_b64: (resp && resp.data_b64) || ''
      };
      if (!rec.data_b64) { failAtt(img, 'Image could not be loaded.'); attDone(); return; }
      attCache[id] = rec;
      applyAtt(img, rec);
      attDone();
    }, function (err) {
      var code = (err && err.code) || '';
      if (code === 'not_found' && attempt < NOT_FOUND_RETRY_DELAYS_MS.length) {
        /* Release the slot while we wait, so one just-posted image does not
           hold up five old ones behind it for the length of the ladder. */
        attDone();
        window.setTimeout(function () {
          if (!img.parentNode) return;
          img.setAttribute('data-att-attempt', String(attempt + 1));
          img.setAttribute('data-att-state', 'queued');
          attQueue.push(img);
          attPump();
        }, NOT_FOUND_RETRY_DELAYS_MS[attempt]);
        return;
      }
      failAtt(img, code === 'forbidden'
        ? 'This image is part of a private conversation.'
        : 'Image could not be loaded.');
      attDone();
    });
  }

  function enqueueAtt(img) {
    var state = img.getAttribute('data-att-state');
    if (state === 'queued' || state === 'done' || state === 'error') return;
    img.setAttribute('data-att-state', 'queued');
    attQueue.push(img);
    attPump();
  }

  function getObserver() {
    if (attObserver !== null) return attObserver;
    if (!window.IntersectionObserver) { attObserver = false; return attObserver; }
    attObserver = new window.IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isIntersecting) {
          attObserver.unobserve(entries[i].target);
          enqueueAtt(entries[i].target);
        }
      }
    }, { rootMargin: '200px' });
    return attObserver;
  }

  function resolveImages(root) {
    if (!root || !root.querySelectorAll) return root;
    var imgs = root.querySelectorAll('img.clinic-att[data-att]');
    if (!imgs.length) return root;
    var obs = getObserver();
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      var state = img.getAttribute('data-att-state');
      if (state) continue;                        /* watch | queued | done | error */
      var hit = cached(img.getAttribute('data-att'));
      if (hit) { applyAtt(img, hit); continue; }  /* free: already in this session */
      if (obs) {
        img.setAttribute('data-att-state', 'watch');
        obs.observe(img);
      } else {
        enqueueAtt(img);                          /* eager, but still serial */
      }
    }
    return root;
  }

  /* ------------------------------------------------------------- rendering */

  /* Order matters. Highlighting and copy buttons restructure <pre>, so they run
     first; renderMath must never see a code block that has not been wrapped
     yet (it skips PRE/CODE either way, but the invariant is cheap to keep);
     resolveImages is last because it is the only pass that touches the network. */
  function enhance(el) {
    if (!el) return el;
    highlightIn(el);
    addCopyButtons(el);
    renderMath(el);
    resolveImages(el);
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
    html = rewriteImages(html);                        /* §10.4, BEFORE assignment */
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
    /* html() gets the same img rewrite. A consumer who inserts this string and
       then calls enhance() gets the full behaviour; one who does not gets an
       unresolved placeholder — which is strictly better than a live tracking
       beacon rendering in a post. */
    html: function (mdText) {
      var html = sanitizedHtml(mdText);
      return html === null ? '' : rewriteImages(html);
    },
    enhance: enhance,
    strip: strip,
    available: haveLibs,
    mathAvailable: mathAvailable,
    renderMath: renderMath,
    resolveImages: resolveImages
  };

})(window, document);
