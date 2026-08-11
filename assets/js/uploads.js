/*!
 * MScPHMxAI Coding Clinic — uploads.js
 * Screenshot paste / drop / pick, for the thread composer and the DM composer
 * (v3 §10.4, deliverable D11).
 *
 * CONTRACT
 *
 *   Clinic.uploads.available()               -> 'unknown' | 'yes' | 'no'
 *   Clinic.uploads.attach(opts)              -> function   call it to detach
 *      opts { textarea, tray:Element, button:Element|null,
 *             scope:'thread'|'dm', scopeId:''|function, maxBytes:1572864,
 *             onInsert:fn }
 *   Clinic.uploads.upload(file, onProgress[, opts]) -> Promise<{attachment_id,
 *                              markdown, file_name, size_bytes}>
 *
 * `scopeId` may be a string or a zero-argument function. The function form is
 * for the DM composer, where the open conversation changes under a composer
 * that is wired up once — see the deviation note at the end of this header.
 *
 * WHY EVERY UPLOAD GOES THROUGH A CANVAS, AND WHY IT FAILS CLOSED
 * --------------------------------------------------------------
 * There is no path in here that sends the raw File bytes. Not for a small PNG,
 * not as a fallback when the canvas is unavailable. Two reasons, both real:
 *
 *  1. SIZE. base64 inflates by 33%, so an un-downscaled 4K screenshot is ~5.5 MB
 *     of text in a text/plain POST body, which Power Automate then keeps in run
 *     history for ~28 days. The 1600 px cap is load-bearing, not polish.
 *  2. EXIF. Re-encoding through a canvas drops EXIF and GPS as a side effect.
 *     The student most likely to be hurt by this non-adversarially is one who
 *     photographs an error on a screen with a phone and posts it ANONYMOUSLY —
 *     the file otherwise carries a home address into a workbook the instructor
 *     may later share (R8 vector 5).
 *
 * SAY THIS HONESTLY AND DO NOT OVERSELL IT: the EXIF strip is best-effort and
 * client-side only. `attach.create` writes whatever `data_b64` it is handed
 * straight to OneDrive, and a Power Automate flow cannot inspect image bytes,
 * so there is NO server-side enforcement and none is possible. Anyone using
 * devtools or curl stores original bytes with GPS intact. PRIVACY.md says the
 * same thing in the same words.
 *
 * DEGRADATION (§10.10)
 * --------------------
 * The backend may not be re-imported. `attach.create` may not exist; the
 * `attachments_enabled` config key may be absent. In every one of those cases
 * pasting an image does NOTHING visible except one toast, once per session, and
 * the student's typed text is never touched. Never a console error, never a
 * spinner that spins forever. The action is called at most once before the
 * feature is marked off for the session.
 *
 * DELIBERATE DEVIATIONS from the §10.4 sketch, both additive:
 *  * `upload(file, onProgress, opts)` takes a third argument. The pinned
 *    two-argument signature has nowhere to carry `scope`/`scope_id`, and
 *    `scope_id` is MANDATORY for a DM (§4.3). The two-argument form still works
 *    and defaults to scope 'thread'.
 *  * `opts.scopeId` accepts a function as well as a string.
 */
(function (window, document) {
  'use strict';

  window.Clinic = window.Clinic || {};
  var Clinic = window.Clinic;

  /* ----------------------------------------------------------- constants */

  var DEFAULT_MAX_BYTES = 1536 * 1024;          /* attachment_max_kb default */
  var MAX_EDGE_PX = 1600;
  var JPEG_QUALITY = 0.82;

  var PROCESS_FAIL = 'That image could not be processed — try saving it as a PNG first.';
  var INERT_TOAST = 'Screenshot upload is not switched on yet — describe the error in text, ' +
    'or bring it to the clinic';
  var UPLOAD_NOTE = 'Screenshots are stored in the instructor’s OneDrive, never in the public repo.';
  var TOAST_KEY = 'clinic_upload_toast';
  var FEATURE = 'uploads';

  var pendingSeq = 0;

  /* -------------------------------------------------------------- shims */

  function UI() { return (window.Clinic && window.Clinic.ui) || {}; }
  function API() { return (window.Clinic && window.Clinic.api) || {}; }

  function str(v) { return v === null || v === undefined ? '' : String(v); }

  function truthy(v) {
    var ui = UI();
    if (ui.truthy) return ui.truthy(v);
    if (v === true || v === 1) return true;
    var s = str(v).trim().toLowerCase();
    return s === 'true' || s === '1';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== null && text !== undefined) n.textContent = String(text);
    return n;
  }

  function bootConfig() {
    var ui = UI();
    return (ui.bootstrapConfig && ui.bootstrapConfig()) || null;
  }

  function has(obj, key) {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
  }

  /* Mirrors new.js's edFire(): the existing #body-count listener and the live
     preview both hang off a bubbling 'input', and a programmatic value
     assignment does not fire one. */
  function fire(ta) {
    var ev;
    try { ev = new Event('input', { bubbles: true }); }
    catch (e) { ev = document.createEvent('Event'); ev.initEvent('input', true, false); }
    ta.dispatchEvent(ev);
  }

  function toast(message, kind) {
    var ui = UI();
    if (ui.toast) ui.toast(message, kind || 'info');
  }

  /* One toast per session, not per paste. A student who pastes four screenshots
     into a backend that has not been re-imported gets told once. */
  function toastInert() {
    try {
      if (window.sessionStorage && window.sessionStorage.getItem(TOAST_KEY)) return;
      if (window.sessionStorage) window.sessionStorage.setItem(TOAST_KEY, '1');
    } catch (e) { /* private mode: toast every time rather than not at all */ }
    toast(INERT_TOAST, 'info');
  }

  function uploadError(message) {
    return { code: 'bad_request', message: message, friendly: true };
  }

  /* ------------------------------------------------------- availability */

  function maxBytes() {
    var cfg = bootConfig();
    var kb = cfg && parseInt(cfg.attachment_max_kb, 10);
    if (kb && kb > 0) return kb * 1024;
    return DEFAULT_MAX_BYTES;
  }

  /* 'unknown' is not a failure state — it is "we have not asked yet", and it
     lets the first paste act as the one-shot §10.10 probe. A pre-v3 bootstrap
     has no attachments_enabled key at all, which is exactly that case. */
  function available() {
    var ui = UI();
    if (ui.featureState && ui.featureState(FEATURE) === 'off') return 'no';

    /* THE GATE THIS MODULE WAS MISSING, and the reason it BROKE rather than
       degraded in the configuration the site actually ships in today.
       attach.create is routed by api.js's endpointFor() to MSG_URL. In waves
       0-2 (§12) MSG_URL is still the literal string "PASTE_MSG_URL_HERE" —
       truthy, so the routing happens, and netCall then rejects with
       code:'network' and api.js's MSG_UNCONFIGURED text before any fetch
       leaves the browser. Without this gate, available() returned 'unknown',
       offer() accepted the paste, a placeholder token went into the student's
       question, a tile appeared, and handleFailure() fell through to a RED
       toast reading "This site has not been connected to its backend yet. The
       flow URLs in assets/js/config.js are still placeholders." — developer
       copy, shown to a student, on every single paste, forever, because
       markOff() was never reached.
       hasMsgUrl() is true in MOCK and true the moment the URL is pasted, so
       this costs nothing once chat is live. unread.js already had this gate
       (unread.js:286, :373); this module was the one that skipped it. §10.10. */
    var api = API();
    if (typeof api.hasMsgUrl === 'function' && !api.hasMsgUrl()) return 'no';

    var cfg = bootConfig();
    if (!cfg) return 'unknown';
    if (has(cfg, 'archive_mode') && truthy(cfg.archive_mode)) return 'no';
    if (!has(cfg, 'attachments_enabled')) return 'unknown';
    return truthy(cfg.attachments_enabled) ? 'yes' : 'no';
  }

  function markOff() {
    var ui = UI();
    if (ui.featureOff) ui.featureOff(FEATURE);
  }

  /* ------------------------------------------------- canvas re-encode */

  function canCanvas() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext && c.getContext('2d') && c.toDataURL && window.FileReader);
    } catch (e) { return false; }
  }

  function b64Of(dataUrl) {
    var i = str(dataUrl).indexOf('base64,');
    return i === -1 ? '' : dataUrl.slice(i + 7);
  }

  function typeOf(dataUrl) {
    var m = /^data:([^;,]+)[;,]/.exec(str(dataUrl));
    return m ? m[1].toLowerCase() : '';
  }

  /* Decoded bytes, matching what the flow measures:
     lessOrEquals(div(mul(length(data_b64), 3), 4), max_kb * 1024). */
  function decodedBytes(b64) {
    return Math.floor(str(b64).length * 3 / 4);
  }

  function extFor(contentType) {
    return contentType === 'image/jpeg' ? 'jpg' : 'png';
  }

  function renameTo(fileName, contentType) {
    var base = str(fileName).replace(/^.*[\\/]/, '').replace(/\.[A-Za-z0-9]+$/, '');
    base = base.replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 60) || 'screenshot';
    return base + '.' + extFor(contentType);
  }

  function drawAndEncode(img, file, limit) {
    var w = img.naturalWidth || img.width;
    var h = img.naturalHeight || img.height;
    if (!w || !h) throw uploadError(PROCESS_FAIL);

    var scale = Math.min(1, MAX_EDGE_PX / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * scale));
    var ch = Math.max(1, Math.round(h * scale));

    var canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    var ctx = canvas.getContext('2d');
    if (!ctx) throw uploadError(PROCESS_FAIL);
    ctx.drawImage(img, 0, 0, cw, ch);

    /* PNG first: these are screenshots of TEXT, and JPEG turns 12px code into
       mush. Only fall to JPEG when the PNG will not fit. */
    var url = canvas.toDataURL('image/png');
    var ct = typeOf(url);
    var b64 = b64Of(url);
    if (!b64 || ct.indexOf('image/') !== 0) throw uploadError(PROCESS_FAIL);

    if (decodedBytes(b64) > limit) {
      /* A transparent PNG re-encoded to JPEG goes black without a matte, and a
         dark screenshot with a transparent margin is exactly what a student
         pastes from a snipping tool. */
      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      url = canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      ct = typeOf(url);
      b64 = b64Of(url);
      if (!b64 || ct !== 'image/jpeg') throw uploadError(PROCESS_FAIL);
    }

    var bytes = decodedBytes(b64);
    if (bytes > limit) {
      throw uploadError('That screenshot is still too large after resizing (limit ' +
        Math.round(limit / 1024) + ' KB). Crop it to the part that matters and paste again.');
    }

    return {
      data_b64: b64,
      content_type: ct,
      file_name: renameTo((file && file.name) || 'screenshot', ct),
      size_bytes: bytes,
      preview: url
    };
  }

  function progress(fn, value) {
    if (typeof fn === 'function') {
      try { fn(value); } catch (e) { /* a broken caller must not fail the upload */ }
    }
  }

  function reencode(file, limit, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(uploadError('There was nothing to upload.')); return; }
      if (!canCanvas()) { reject(uploadError(PROCESS_FAIL)); return; }

      var reader;
      try { reader = new FileReader(); } catch (e) { reject(uploadError(PROCESS_FAIL)); return; }
      reader.onerror = function () { reject(uploadError(PROCESS_FAIL)); };
      reader.onload = function () {
        progress(onProgress, 0.25);
        var img = new window.Image();
        img.onerror = function () { reject(uploadError(PROCESS_FAIL)); };
        img.onload = function () {
          try {
            resolve(drawAndEncode(img, file, limit));
          } catch (e) {
            reject(e && e.friendly ? e : uploadError(PROCESS_FAIL));
          }
        };
        /* A data: URL, so the canvas is same-origin and never tainted. */
        img.src = reader.result;
      };
      progress(onProgress, 0.08);
      try { reader.readAsDataURL(file); }
      catch (e) { reject(uploadError(PROCESS_FAIL)); }
    });
  }

  /* ------------------------------------------------------------- upload */

  function upload(file, onProgress, opts) {
    opts = opts || {};
    var scope = opts.scope === 'dm' ? 'dm' : 'thread';
    var scopeId = str(opts.scopeId);
    var limit = opts.maxBytes || maxBytes();

    if (scope === 'dm' && !scopeId) {
      /* §4.3: scope_id is MANDATORY for a DM and is known at paste time. Fail
         here rather than burning a flow run on a request the server rejects. */
      return Promise.reject(uploadError('Open a conversation before pasting an image.'));
    }

    return reencode(file, limit, onProgress).then(function (enc) {
      progress(onProgress, 0.55);
      var api = API();
      if (!api.call) return Promise.reject(uploadError(PROCESS_FAIL));
      var slow1 = window.setTimeout(function () { progress(onProgress, 0.8); }, 1500);
      var slow2 = window.setTimeout(function () { progress(onProgress, 0.92); }, 6000);
      var body = {
        scope: scope,
        file_name: enc.file_name,
        content_type: enc.content_type,
        data_b64: enc.data_b64
      };
      if (scope === 'dm' || scopeId) body.scope_id = scopeId;

      function stopCreep() {
        window.clearTimeout(slow1);
        window.clearTimeout(slow2);
      }
      return api.call('attach.create', body).then(function (resp) {
        stopCreep();
        progress(onProgress, 1);
        return {
          attachment_id: resp && resp.attachment_id,
          markdown: (resp && resp.markdown) || '',
          file_name: (resp && resp.file_name) || enc.file_name,
          size_bytes: (resp && resp.size_bytes) || enc.size_bytes,
          preview: enc.preview
        };
      }, function (err) {
        stopCreep();
        return Promise.reject(err);
      });
    });
  }

  /* -------------------------------------------------- textarea plumbing */

  function insertAtCaret(ta, text) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    if (typeof s !== 'number') { s = e = v.length; }
    var before = v.slice(0, s);
    var after = v.slice(e);
    var lead = (before && before.charAt(before.length - 1) !== '\n') ? '\n' : '';
    var tail = (after && after.charAt(0) !== '\n') ? '\n' : '';
    var chunk = lead + text + tail;
    ta.value = before + chunk + after;
    var caret = s + chunk.length;
    try { ta.selectionStart = ta.selectionEnd = caret; } catch (e2) { /* detached */ }
    fire(ta);
  }

  /* Rewrite in place, preserving the caret. The student keeps typing while the
     upload is in flight — 10-21 s is a long time to be told to wait — so the
     placeholder is almost never at the caret when the call comes back. */
  function replaceInTextarea(ta, needle, replacement) {
    var idx = ta.value.indexOf(needle);
    if (idx === -1) return false;
    var caret = ta.selectionStart;
    var delta = replacement.length - needle.length;
    ta.value = ta.value.slice(0, idx) + replacement + ta.value.slice(idx + needle.length);
    if (typeof caret === 'number') {
      if (caret > idx + needle.length) caret += delta;
      else if (caret > idx) caret = idx + replacement.length;
      try { ta.selectionStart = ta.selectionEnd = caret; } catch (e) { /* detached */ }
    }
    fire(ta);
    return true;
  }

  function removeFromTextarea(ta, needle) {
    /* Take the ONE newline insertAtCaret may have added with it, so a failed
       upload does not leave a blank line in the middle of the question. Exactly
       one: taking both the leading and the trailing newline welds the two
       surrounding lines together, which is what the first version of this did. */
    var idx = ta.value.indexOf(needle);
    if (idx === -1) return false;
    var end = idx + needle.length;
    var start = idx;
    if (ta.value.charAt(end) === '\n') end += 1;
    else if (start > 0 && ta.value.charAt(start - 1) === '\n') start -= 1;
    var caret = ta.selectionStart;
    var cut = end - start;
    ta.value = ta.value.slice(0, start) + ta.value.slice(end);
    if (typeof caret === 'number') {
      if (caret >= end) caret -= cut;
      else if (caret > start) caret = start;
      try { ta.selectionStart = ta.selectionEnd = caret; } catch (e) { /* detached */ }
    }
    fire(ta);
    return true;
  }

  /* Selects the alt text inside an inserted ![alt](clinic-img/a_…) so the
     "Describe this image" affordance actually lands the caret on the thing the
     student is being asked to replace (§10.9). */
  function selectAlt(ta, markdown) {
    var idx = ta.value.indexOf(markdown);
    if (idx === -1) return false;
    var close = markdown.indexOf('](');
    if (markdown.charAt(0) !== '!' || markdown.charAt(1) !== '[' || close < 2) return false;
    ta.focus();
    try {
      ta.selectionStart = idx + 2;
      ta.selectionEnd = idx + close;
    } catch (e) { return false; }
    return true;
  }

  /* --------------------------------------------------- files from events */

  function imageFilesFrom(dt) {
    var out = [], i, it, f;
    if (!dt) return out;
    if (dt.items && dt.items.length) {
      for (i = 0; i < dt.items.length; i++) {
        it = dt.items[i];
        if (it && it.kind === 'file' && str(it.type).indexOf('image/') === 0) {
          f = it.getAsFile && it.getAsFile();
          if (f) out.push(f);
        }
      }
      if (out.length) return out;
    }
    if (dt.files && dt.files.length) {
      for (i = 0; i < dt.files.length; i++) {
        f = dt.files[i];
        if (f && str(f.type).indexOf('image/') === 0) out.push(f);
      }
    }
    return out;
  }

  /* --------------------------------------------------------- attach() */

  function attach(opts) {
    opts = opts || {};
    var ta = opts.textarea;
    if (!ta) return function () { /* nothing wired */ };

    var tray = opts.tray || null;
    var scope = opts.scope === 'dm' ? 'dm' : 'thread';
    var limit = opts.maxBytes || 0;
    var onInsert = typeof opts.onInsert === 'function' ? opts.onInsert : null;

    function currentScopeId() {
      var v = opts.scopeId;
      if (typeof v === 'function') { try { return str(v()); } catch (e) { return ''; } }
      return str(v);
    }

    if (tray) {
      /* §10.9: the tray announces progress. Set it only if the owner of the
         markup has not already. */
      if (!tray.getAttribute('role')) tray.setAttribute('role', 'status');
      if (!tray.getAttribute('aria-live')) tray.setAttribute('aria-live', 'polite');
    }

    /* The dropzone is the .composer the textarea lives in — main.css keys
       .upload-dropzone.is-dragover off that element. */
    var zone = (ta.closest && ta.closest('.composer')) || ta.parentNode || ta;
    if (zone && zone.classList) zone.classList.add('upload-dropzone');

    ensureNote(tray, zone);

    /* A visible button that answers every click with the same apology is worse
       than no button at all, so the caller's control is hidden outright once we
       KNOW attachments are off (§10.10 — feature marked off, chat flow not
       wired, archive mode, attachments_enabled FALSE). 'unknown' leaves it
       showing on purpose: that state means "we have not asked yet", and the
       first click is the one-shot probe that answers it. */
    function syncButtonVisible() {
      if (!opts.button) return;
      var off = available() === 'no';
      opts.button.hidden = off;
      if (off) opts.button.setAttribute('aria-hidden', 'true');
      else opts.button.removeAttribute('aria-hidden');
    }

    var picker = null;
    if (opts.button) {
      picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.multiple = true;
      picker.style.position = 'fixed';
      picker.style.left = '-10000px';
      picker.style.width = '1px';
      picker.style.height = '1px';
      picker.setAttribute('tabindex', '-1');
      picker.setAttribute('aria-hidden', 'true');
      document.body.appendChild(picker);
    }

    var items = [];          /* live tray items, newest last */
    var queue = [];
    var busy = false;
    var dragDepth = 0;
    var detached = false;

    /* ------------------------------------------------------- tray items */

    function makeItem(file) {
      if (!tray) return null;
      var item = el('div', 'upload-item');
      item.setAttribute('role', 'group');
      item.setAttribute('aria-label', 'Screenshot ' + ((file && file.name) || 'upload'));

      var thumb = el('img', 'upload-thumb');
      thumb.alt = '';
      item.appendChild(thumb);

      var remove = el('button', 'upload-remove');
      remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove this screenshot');
      var ui = UI();
      if (ui.icon) {
        var ic = ui.icon('x') || ui.icon('close');
        if (ic && ic.nodeType) remove.appendChild(ic);
        else remove.textContent = '×';
      } else {
        remove.textContent = '×';
      }
      item.appendChild(remove);

      var track = el('span', 'upload-progress');
      var fill = el('span', 'upload-progress-fill');
      track.appendChild(fill);
      item.appendChild(track);

      tray.appendChild(item);

      var rec = { el: item, thumb: thumb, track: track, fill: fill, markdown: '', token: '' };
      items.push(rec);

      remove.addEventListener('click', function (ev) {
        ev.preventDefault();
        dropItem(rec);
      }, false);

      return rec;
    }

    function setProgress(rec, value) {
      if (!rec || !rec.fill) return;
      var pct = Math.max(0, Math.min(1, value || 0)) * 100;
      rec.fill.style.width = pct.toFixed(0) + '%';
    }

    function markItemError(rec, message) {
      if (!rec || !rec.el) return;
      if (rec.el.classList) rec.el.classList.add('is-error');
      if (rec.track && rec.track.parentNode) rec.track.parentNode.removeChild(rec.track);
      var err = el('span', 'upload-error', message);
      rec.el.appendChild(err);
      rec.el.setAttribute('title', message);
    }

    function dropItem(rec) {
      if (!rec) return;
      /* Removing the tile removes the markdown too — a thumbnail that is gone
         but a reference that is still in the post is the worst of both. */
      if (rec.markdown) removeFromTextarea(ta, rec.markdown);
      else if (rec.token) removeFromTextarea(ta, rec.token);
      if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      for (var i = 0; i < items.length; i++) {
        if (items[i] === rec) { items.splice(i, 1); break; }
      }
      syncDescribe();
    }

    /* One shared "Describe this image" control rather than one per 72px tile.
       It selects the alt text of the most recent successful insert, so pressing
       it and typing replaces the placeholder alt in place. */
    var describeBtn = null;
    function syncDescribe() {
      if (!tray) return;
      var newest = null, i;
      for (i = items.length - 1; i >= 0; i--) {
        if (items[i].markdown) { newest = items[i]; break; }
      }
      if (!newest) {
        if (describeBtn && describeBtn.parentNode) describeBtn.parentNode.removeChild(describeBtn);
        describeBtn = null;
        return;
      }
      if (!describeBtn) {
        describeBtn = el('button', 'btn btn-invisible btn-sm', 'Describe this image');
        describeBtn.type = 'button';
        describeBtn.addEventListener('click', function (ev) {
          ev.preventDefault();
          var target = null;
          for (var k = items.length - 1; k >= 0; k--) {
            if (items[k].markdown) { target = items[k]; break; }
          }
          if (target) selectAlt(ta, target.markdown);
        }, false);
      }
      tray.appendChild(describeBtn);      /* keep it last in the flex row */
    }

    /* ---------------------------------------------------------- pipeline */

    function pump() {
      if (busy || detached) return;
      var next = queue.shift();
      if (!next) return;
      busy = true;
      runOne(next);
    }

    function runOne(file) {
      var rec = makeItem(file);
      var token = '![uploading…](clinic-img/pending_' + (++pendingSeq) + ')';
      if (rec) rec.token = token;
      insertAtCaret(ta, token);
      setProgress(rec, 0.05);

      upload(file, function (v) {
        setProgress(rec, v);
      }, {
        scope: scope,
        scopeId: currentScopeId(),
        maxBytes: limit
      }).then(function (result) {
        busy = false;
        if (detached) { pump(); return; }
        var md = result.markdown;
        if (!md) {
          if (rec) markItemError(rec, 'Upload failed');
          removeFromTextarea(ta, token);
          pump();
          return;
        }
        if (rec) {
          rec.markdown = md;
          rec.token = '';
          if (result.preview) rec.thumb.src = result.preview;
          rec.thumb.alt = result.file_name || '';
          setProgress(rec, 1);
          if (rec.track && rec.track.parentNode) rec.track.parentNode.removeChild(rec.track);
        }
        /* We downscaled and re-encoded these bytes ourselves a moment ago, so
           markdown.js never has to spend an attach.get (10-21 s, plus the
           not-found ladder against a OneDrive row that is not readable yet) to
           display an image this tab is already holding. This is what makes a
           pasted screenshot show up instantly in a live preview and, right
           after posting, on the thread. Best-effort: if it fails, the image
           still resolves the slow way. */
        try {
          var mdMod = window.Clinic && window.Clinic.md;
          if (mdMod && typeof mdMod.primeAttachment === 'function' &&
              result.attachment_id && result.preview) {
            mdMod.primeAttachment(result.attachment_id,
              typeOf(result.preview), b64Of(result.preview));
          }
        } catch (e) { /* never let a cache hint break an upload */ }

        if (!replaceInTextarea(ta, token, md)) {
          /* The student deleted the placeholder while we were waiting. Respect
             that: do not shove the image back in, and drop the tile. */
          if (rec) dropItem(rec);
        } else {
          syncDescribe();
          if (onInsert) {
            try { onInsert(result); } catch (e) { /* caller's problem, not ours */ }
          }
        }
        pump();
      }, function (err) {
        busy = false;
        /* The typed text is never collateral damage: the placeholder goes, the
           question stays. */
        removeFromTextarea(ta, token);
        handleFailure(err, rec);
        pump();
      });
    }

    function handleFailure(err, rec) {
      var api = API();
      var code = (err && err.code) || '';
      var message = (err && err.message) || 'That upload did not go through.';

      /* §10.10: one probe, then inert for the session. Never console.error. */
      if (api.isUnknownAction && api.isUnknownAction(err)) {
        markOff();
        syncButtonVisible();
        if (rec) dropItem(rec);
        toastInert();
        return;
      }
      if (code === 'forbidden') {
        markOff();
        syncButtonVisible();
        if (rec) dropItem(rec);
        toast(message, 'info');
        return;
      }
      /* Defence in depth for the window available()'s hasMsgUrl() gate cannot
         cover: attachments_enabled is TRUE (wave 1/2 workbook migrated) but the
         msg flow is not imported yet, or is simply down/throttled. §10.10 calls
         a first 'network' inert-but-retryable, so: drop the tile, do NOT
         markOff() (the flow may come back in a minute and this is not a
         permanent capability answer), and say the friendly thing once.
         `message` here is api.js's MSG_UNCONFIGURED — developer-facing copy
         naming a source file. NO user-visible path may ever surface it. */
      if (code === 'network') {
        if (rec) dropItem(rec);
        toastInert();
        return;
      }
      if (rec) markItemError(rec, shortError(code, message));
      if (code === 'unauthorized') return;      /* api.js is already redirecting */
      toast(message, 'error');
    }

    function shortError(code, message) {
      if (code === 'conflict') return 'Daily limit';
      if (code === 'network') return 'No connection';
      if (/too large/i.test(message)) return 'Too large';
      return 'Failed';
    }

    function offer(files) {
      var state = available();
      if (state === 'no') { toastInert(); return false; }
      for (var i = 0; i < files.length; i++) queue.push(files[i]);
      pump();
      return true;
    }

    /* ---------------------------------------------------------- handlers */

    function onPaste(ev) {
      var files = imageFilesFrom(ev.clipboardData || window.clipboardData);
      if (!files.length) return;                /* a normal text paste: hands off */
      if (available() === 'no') {
        /* Do NOT preventDefault: pasting an image into a textarea is a browser
           no-op anyway, so the least surprising thing is to change nothing. */
        toastInert();
        return;
      }
      ev.preventDefault();
      offer(files);
    }

    function onDragOver(ev) {
      if (!ev.dataTransfer) return;
      var types = ev.dataTransfer.types;
      var hasFiles = false, i;
      if (types) {
        for (i = 0; i < types.length; i++) if (types[i] === 'Files') hasFiles = true;
      }
      if (!hasFiles) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    }

    function onDragEnter(ev) {
      if (!ev.dataTransfer) return;
      dragDepth++;
      if (zone && zone.classList) zone.classList.add('is-dragover');
    }

    function onDragLeave() {
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth && zone && zone.classList) zone.classList.remove('is-dragover');
    }

    function onDrop(ev) {
      dragDepth = 0;
      if (zone && zone.classList) zone.classList.remove('is-dragover');
      var files = imageFilesFrom(ev.dataTransfer);
      if (!files.length) return;
      /* Always preventDefault once we know it is an image: otherwise the
         browser navigates away from the half-written post to display it. */
      ev.preventDefault();
      if (available() === 'no') { toastInert(); return; }
      offer(files);
    }

    function onButton(ev) {
      ev.preventDefault();
      if (available() === 'no') { syncButtonVisible(); toastInert(); return; }
      if (picker) picker.click();
    }

    function onPicked() {
      var files = imageFilesFrom(picker);
      if (files.length) offer(files);
      picker.value = '';
    }

    ta.addEventListener('paste', onPaste, false);
    if (zone) {
      zone.addEventListener('dragover', onDragOver, false);
      zone.addEventListener('dragenter', onDragEnter, false);
      zone.addEventListener('dragleave', onDragLeave, false);
      zone.addEventListener('drop', onDrop, false);
    }
    if (opts.button) opts.button.addEventListener('click', onButton, false);
    if (picker) picker.addEventListener('change', onPicked, false);

    syncButtonVisible();
    /* attachments_enabled arrives with the bootstrap, which on a cold cache
       lands AFTER the composer is built. Without this, the button on a
       chat-less deployment would be visible for one paint and then stay
       visible until the next navigation. */
    window.addEventListener('clinic:bootstrap', syncButtonVisible);

    return function detach() {
      detached = true;
      queue.length = 0;
      window.removeEventListener('clinic:bootstrap', syncButtonVisible);
      ta.removeEventListener('paste', onPaste, false);
      if (zone) {
        zone.removeEventListener('dragover', onDragOver, false);
        zone.removeEventListener('dragenter', onDragEnter, false);
        zone.removeEventListener('dragleave', onDragLeave, false);
        zone.removeEventListener('drop', onDrop, false);
        if (zone.classList) zone.classList.remove('is-dragover');
      }
      if (opts.button) opts.button.removeEventListener('click', onButton, false);
      if (picker) {
        picker.removeEventListener('change', onPicked, false);
        if (picker.parentNode) picker.parentNode.removeChild(picker);
      }
    };
  }

  /* The §9.8 promise to the student, next to the thing it is about. Added here
     rather than in the page markup because F5 owns no HTML, and it is skipped
     when the page owner has already put one there. */
  function ensureNote(tray, zone) {
    var host = tray || zone;
    if (!host || !host.parentNode) return;
    var scope = host.parentNode;
    if (scope.querySelector && scope.querySelector('.upload-note')) return;
    var note = el('p', 'upload-note', UPLOAD_NOTE);
    if (tray && tray.nextSibling) scope.insertBefore(note, tray.nextSibling);
    else scope.appendChild(note);
  }

  Clinic.uploads = {
    available: available,
    attach: attach,
    upload: upload,
    maxBytes: maxBytes
  };

})(window, document);
