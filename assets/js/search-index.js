/* ============================================================================
 * search-index.js — Clinic.searchIndex (contract §10.1, owner F3)
 *
 * A client-side inverted index over the threads.list payload the site already
 * fetches. Two consumers:
 *
 *   pages/search.js  (F3) — the dedicated search page
 *   pages/new.js     (F6) — the "similar threads" panel under the composer
 *
 * WHY THIS EXISTS AT ALL, AND WHY IT IS HONEST ABOUT ITS LIMITS
 * ------------------------------------------------------------
 * Every backend call on this platform is an Excel read behind Power Automate:
 * 10-21 SECONDS. A server-side search would be unusable, and it would cost a
 * flow run per keystroke. So search is entirely client-side, built from ONE
 * response — `threads.list` — which index.html already asks for at boot, which
 * api.js single-flights through its DEDUPE map, and which api.js also keeps in
 * localStorage for up to 12 h. Since v3.3 this file reads that cache and
 * listens for api.js's 'clinic:threads' event instead of fetching its own copy,
 * so a search that follows a visit to the board costs ZERO extra Excel
 * round-trips — it rides along with what the board already paid for.
 *
 * The board is refreshed ONLY by the pages that render it (index.js, thread.js,
 * booking.js). The two pages that use this index — search.html and new.html —
 * never touch it, so on exactly those pages nothing revalidates that cache and
 * the 'clinic:threads' event never fires. The stored board is therefore trusted
 * only while it is younger than the caller's maxAgeMs; past that we spend a run
 * of our own rather than search a board nobody has refreshed for hours.
 *
 * That one response is also the anonymity guarantee: everything in here has
 * already passed through the flow's PublicAuthor masking Select, so an
 * anonymous thread is anonymous in the index too. There is no path by which
 * indexing can leak an author the server chose to mask.
 *
 * What it indexes: title, labels, category, language, author display name and
 * the ~220-character `excerpt`. What it does NOT index: full post bodies and
 * replies (threads.list does not carry them, and asking for them would be a
 * second payload). It finds NEAR-DUPLICATE TITLES. It is not semantic: "df has
 * NaN" will not surface "handling missing values in a dataframe". No stemming,
 * no synonyms, no spelling correction. The page MUST say so — see the
 * `.field-hint` in pages/search.js — because a search box that quietly
 * under-delivers teaches students that searching is pointless, which is the
 * exact opposite of "find before you ask".
 *
 * `excerpt` is documented as an EXTENSION beyond SPEC §5 (mock-data.js:2089).
 * If a flow change ever drops it, the index silently narrows to titles, labels,
 * category and author with no error and no visible symptom (risk R20). That is
 * why stats().hasExcerpt exists and why the search page surfaces it.
 *
 * PUBLIC SURFACE (contract §10.1, exact)
 *   load(opts)           -> Promise<index>   opts {force:false, maxAgeMs:90000}
 *   build(threads[,src]) -> index            synchronous, for a caller holding a payload
 *   ready()              -> bool
 *   search(query, opts)  -> [{thread, score, hits:{title:[[s,e]…], excerpt:[[s,e]…]}}]
 *   suggest(title, opts) -> [{thread, score, reason:'title'|'tokens'}]
 *   filterOnly(filters)  -> [thread]
 *   highlight(text, q)   -> DocumentFragment
 *   invalidate()         -> void
 *   stats()              -> {docs, tokens, builtAt, source, hasExcerpt, stale}
 *
 * `load()` rejects with the ApiError from api.call. EVERY other method is
 * synchronous and returns [] (never throws) when !ready(), so a caller that
 * renders before the payload lands degrades to an empty panel rather than a
 * console error.
 *
 * House style: ES5 only. var, function declarations, no template literals, no
 * arrow functions, no Promise.finally, every storage access in try/catch.
 * ==========================================================================*/
(function (window, document) {
  'use strict';

  var Clinic = window.Clinic = window.Clinic || {};

  /* =========================================================== TUNING ===== */

  /* The RAW threads.list payload is cached, not the index. Rebuilding the
     inverted index from ~20-200 cards is sub-millisecond; re-fetching it is
     10-21 seconds. sessionStorage deliberately, NOT localStorage:
       - localStorage would outlive the tab and go stale silently, and
       - api.js owns the localStorage namespace (session, bootstrap cache).
     The one exception is DIRTY_KEY below, which is a cross-tab signal and has
     to live in localStorage because sessionStorage is per-tab by definition. */
  var CACHE_KEY = 'clinic_search_cache';
  var DIRTY_KEY = 'clinic_search_dirty';
  var TTL_MS = 90000;

  /* Field weights, contract §10.1. Title dominates because this index finds
     near-duplicate QUESTIONS; an excerpt hit is a weak signal by comparison. */
  var W = { title: 6, labels: 3, category: 2, language: 2, author: 1, excerpt: 1 };
  var FIELDS = ['title', 'labels', 'category', 'language', 'author', 'excerpt'];
  var PHRASE_BONUS = 8;

  /* Suggestions (F6's composer panel) are a different problem from search:
     the input is a whole draft title, and the useful answer is "you are about
     to ask something already asked". Hence trigram similarity on the title,
     and a bonus for threads that already have an answer. */
  var SUGGEST_TRIGRAM_WEIGHT = 12;
  var SUGGEST_ANSWERED_BONUS = 2;
  var SUGGEST_MIN_SCORE = 4;
  var SUGGEST_LIMIT = 5;

  /* Exported so nobody re-invents them (F6 needs the suggestion pair). */
  var DEBOUNCE_MS = 180;         /* search page: keystroke -> re-rank          */
  var MIN_QUERY = 2;             /* below this, callers use filterOnly()       */
  var SUGGEST_DEBOUNCE_MS = 350; /* composer: slower, the input is a sentence  */
  var SUGGEST_MIN_CHARS = 8;
  var SUGGEST_MIN_TOKENS = 2;

  var PREFIX_CANDIDATE_CAP = 400;  /* guard on the last-token prefix scan */

  /* 30-word stoplist, contract §10.1. Kept deliberately short: an aggressive
     stoplist on a corpus this small removes more signal than noise. Note the
     consequence, which D2 calls out as expected behaviour: ?q=the returns
     NOTHING here while index.html's raw substring match returns rows. */
  var STOP = {};
  (function () {
    var words = ('the a an and or of to in on for is are was were be been it its ' +
                 'this that with as at by from not no if then than').split(' ');
    for (var i = 0; i < words.length; i++) STOP[words[i]] = 1;
  })();

  /* ===================================================== TOKENISATION ===== */

  /* ASCII punctuation + general punctuation + CJK punctuation -> space.
     Letters (including accented ones) and digits survive untouched.

     THIS IS THE RULE THAT MAKES CODE-ISH QUERIES WORK, and it is the whole
     reason the tokeniser is not just /\W+/:
       "KeyError:"  -> keyerror        (one token, matches a title's KeyError)
       "df.loc"     -> df, loc         (both required, so it matches df.loc[…]
                                        and also df .loc written apart)
       "pip install"-> pip, install
     A student types the error text they are staring at. Punctuation is noise
     in that text, not meaning. */
  var PUNCT = /[!-\/:-@\[-`{-~\u00a0\u2000-\u206f\u3001-\u303f]+/g;

  /* Han, Hiragana, Katakana, Hangul. CJK has no spaces, so whitespace
     splitting alone yields one enormous useless token. */
  var CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/;

  function str(v) { return v == null ? '' : String(v); }
  function trim(s) { return str(s).replace(/^\s+|\s+$/g, ''); }

  function normalise(text) {
    return str(text).toLowerCase().replace(PUNCT, ' ').replace(/\s+/g, ' ');
  }

  function isCjkChar(ch) { return CJK_RE.test(ch); }

  /* One whitespace-delimited chunk -> zero or more tokens. */
  function pushChunk(chunk, out) {
    if (!chunk) return;

    if (!CJK_RE.test(chunk)) {
      /* Plain latin/digit run. >=2 chars, not a stopword.
         The 1-character rule is why "R" as a query finds nothing here while
         index.html matches it — documented in D2 as an accepted subset gap. */
      if (chunk.length >= 2 && !STOP[chunk]) out.push(chunk);
      return;
    }

    /* Mixed or CJK run: walk it, emitting latin runs as words and CJK runs as
       single characters PLUS adjacent bigrams. Bigrams are what make a
       two-character Chinese word rank above two unrelated characters. */
    var latin = '';
    var cjk = '';
    function flushLatin() {
      if (latin.length >= 2 && !STOP[latin]) out.push(latin);
      latin = '';
    }
    function flushCjk() {
      var k;
      for (k = 0; k < cjk.length; k++) out.push(cjk.charAt(k));
      for (k = 0; k + 1 < cjk.length; k++) out.push(cjk.substr(k, 2));
      cjk = '';
    }
    for (var i = 0; i < chunk.length; i++) {
      var ch = chunk.charAt(i);
      if (isCjkChar(ch)) { flushLatin(); cjk += ch; }
      else { flushCjk(); latin += ch; }
    }
    flushLatin();
    flushCjk();
  }

  function tokenise(text) {
    var norm = normalise(text);
    if (!norm) return [];
    var parts = norm.split(' ');
    var out = [];
    for (var i = 0; i < parts.length; i++) pushChunk(parts[i], out);
    return out;
  }

  /* ------------------------------------------------------------ trigrams */
  /* Near-duplicate detection for suggest(). Character 3-grams over the
     normalised title, compared with Dice. Catches "ModuleNotFoundError: no
     module named pandas" vs "ModuleNotFoundError no module named pandas!!"
     which share no useful token weighting difference but are the same
     question. */
  function trigramsOf(text) {
    var s = normalise(text);
    var set = {}, n = 0;
    if (!s) return { set: set, count: 0 };
    if (s.length < 3) { set[s] = 1; return { set: set, count: 1 }; }
    for (var i = 0; i + 3 <= s.length; i++) {
      var g = s.substr(i, 3);
      if (!set[g]) { set[g] = 1; n++; }
    }
    return { set: set, count: n };
  }

  function dice(a, b) {
    if (!a.count || !b.count) return 0;
    var shared = 0;
    var small = a.count <= b.count ? a : b;
    var large = small === a ? b : a;
    for (var g in small.set) {
      if (Object.prototype.hasOwnProperty.call(small.set, g) && large.set[g]) shared++;
    }
    return (2 * shared) / (a.count + b.count);
  }

  /* ========================================================= INDEX STATE == */

  var docs = [];          /* [{id, idx, thread, titleLower, tf, fieldTf, len, tri}] */
  var inverted = {};      /* token -> [docIdx, …]  (kept for prefix + future use) */
  var allTokens = [];     /* Object.keys(inverted), scanned for prefix matches   */
  var builtAt = 0;
  var source = 'network';
  var hasExcerpt = false;
  var built = false;
  var stale = false;      /* invalidate() sets this; the in-memory index stays  */
  var lastUsers = [];
  var inFlight = null;

  function labelsOf(t) {
    if (Array.isArray(t.labels)) return t.labels;
    return t.labels ? str(t.labels).split(',') : [];
  }
  function authorName(t) { return (t.author && t.author.display_name) || ''; }

  /* The DERIVED answered state — identical to index.js's isAnswered(). Kept
     separate from the raw `status` column on purpose (contract §8.5): they are
     two different dimensions and collapsing them is a named build failure. */
  function isAnswered(t) { return t.status === 'answered' || t.accepted === true; }

  function newDoc(t, i) {
    var d = {
      id: t.thread_id,
      idx: i,
      thread: t,
      titleLower: str(t.title).toLowerCase(),
      tf: {},
      fieldTf: {},
      len: 0,
      tri: null,
      answered: isAnswered(t),
      created: str(t.created_at)
    };
    for (var f = 0; f < FIELDS.length; f++) d.fieldTf[FIELDS[f]] = {};
    return d;
  }

  function addField(doc, field, text) {
    var toks = tokenise(text);
    var ft = doc.fieldTf[field];
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i];
      ft[t] = (ft[t] || 0) + 1;
      doc.tf[t] = (doc.tf[t] || 0) + 1;
      doc.len++;
    }
  }

  function build(threads, src) {
    var list = threads || [];
    docs = [];
    inverted = {};
    hasExcerpt = false;

    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t || t.deleted) continue;            /* mirrors index.js's filter */
      var d = newDoc(t, docs.length);
      addField(d, 'title', t.title);
      addField(d, 'category', t.category);
      addField(d, 'language', t.language);
      addField(d, 'labels', labelsOf(t).join(' '));
      addField(d, 'author', authorName(t));
      if (trim(t.excerpt)) hasExcerpt = true;
      addField(d, 'excerpt', t.excerpt);
      d.tri = trigramsOf(t.title);
      docs.push(d);
    }

    for (var k = 0; k < docs.length; k++) {
      var tf = docs[k].tf;
      for (var tok in tf) {
        if (!Object.prototype.hasOwnProperty.call(tf, tok)) continue;
        if (!inverted[tok]) inverted[tok] = [];
        inverted[tok].push(k);
      }
    }
    allTokens = [];
    for (var tk in inverted) {
      if (Object.prototype.hasOwnProperty.call(inverted, tk)) allTokens.push(tk);
    }

    builtAt = Date.now();
    source = src === 'cache' ? 'cache' : 'network';
    built = true;
    stale = false;
    return module;
  }

  function ready() { return built; }

  function stats() {
    return {
      docs: docs.length,
      tokens: allTokens.length,
      builtAt: builtAt,
      source: source,
      hasExcerpt: hasExcerpt,
      stale: stale
    };
  }

  /* ============================================================ CACHE ===== */

  function readCache(maxAgeMs) {
    var raw = null;
    try { raw = window.sessionStorage.getItem(CACHE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    var obj = null;
    try { obj = JSON.parse(raw); } catch (e) { return null; }
    if (!obj || !obj.threads || !obj.fetched_at) return null;
    if (Date.now() - obj.fetched_at > maxAgeMs) return null;
    return obj;
  }

  /* `fetched_at` means WHEN THE SERVER ANSWERED, not when we happened to copy
     the payload, which is why callers may pass it in. The board branch in
     load() hands us a blob api.js fetched some time ago; stamping that with
     Date.now() would let a board accepted at the very edge of maxAgeMs go on
     being served from our own cache for a further maxAgeMs. A caller holding a
     response it just received omits the argument. */
  function writeCache(threads, users, fetchedAt) {
    try {
      window.sessionStorage.setItem(CACHE_KEY, JSON.stringify({
        fetched_at: fetchedAt || Date.now(), threads: threads || [], users: users || []
      }));
    } catch (e) { /* private mode or quota: the index still works, just per-page */ }
  }

  /* invalidate() does NOT drop the in-memory index. F6/F7 call it right after a
     write, and a `storage` event can fire it while somebody is mid-scroll on
     the search page — blanking the results under them would be worse than
     showing 90-second-old data. It clears the cache and marks the index stale,
     so the NEXT load() re-fetches even inside the TTL. stats().stale exposes
     it, and the search page shows a "results may be out of date" affordance. */
  function invalidate() {
    try { window.sessionStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
    stale = true;
    /* Cross-tab signal. sessionStorage is per-tab, so a second tab's write can
       only reach us through localStorage. One tiny key, written in try/catch,
       never read for content — the value is a timestamp purely to guarantee the
       event fires. (api.js owns the localStorage namespace for real data; this
       is a doorbell, not data.) */
    try { window.localStorage.setItem(DIRTY_KEY, String(Date.now())); } catch (e) { /* ignore */ }
  }

  /* A write in ANOTHER tab rings the doorbell here. e.key === null means the
     whole store was cleared (e.g. sign-out), which invalidates us too. */
  if (window.addEventListener) {
    window.addEventListener('storage', function (ev) {
      if (!ev) return;
      if (ev.key === null || ev.key === DIRTY_KEY) {
        try { window.sessionStorage.removeItem(CACHE_KEY); } catch (e) { /* ignore */ }
        stale = true;
      }
    });
  }

  /* ====================================================== THE BOARD CACHE == */

  /* api.js keeps the last threads.list payload in localStorage (uid-namespaced,
     12 h max age), written by whichever page last rendered the board. Until
     v3.3 this file ignored all of that and called threads.list itself, which
     meant a visit to search.html past our own 90 s TTL bought a second ~11 s
     flow run — and ~7 requests off the cohort's shared daily allocation — for a
     payload api.js was already holding, sometimes seconds old. Nothing about an
     inverted index needs a private copy of the board.

     PENDING ROWS ARE DROPPED HERE, AND THAT IS DELIBERATE. api.js merges this
     browser's just-posted, not-yet-readable threads into everything it hands
     out, flagged `_pending` (api.js's withPending). That is right for the BOARD
     — "Posting…" beats a row that appears to have vanished — and wrong for
     SEARCH: the server cannot resolve the id for another ~30 s, so a search hit
     would lead to a thread page that 404s. A post that is simply not findable
     for a minute is the smaller failure, and the one the student can make sense
     of. */
  function serverRows(payload) {
    var rows = (payload && payload.threads) || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i]._pending !== true) out.push(rows[i]);
    }
    return out;
  }

  /* Reads localStorage through api.js; never touches the network, never throws.
     Returns null for anything it does not recognise, which puts load() straight
     back on the path it took before this existed. */
  function boardPayload() {
    var api = Clinic.api;
    if (!api || typeof api.cachedThreads !== 'function') return null;
    var payload = null;
    try { payload = api.cachedThreads(); } catch (e) { return null; }
    if (!payload || !Array.isArray(payload.threads)) return null;
    return payload;
  }

  /* How old api.js's stored board is, in ms — the piece cachedThreads() cannot
     tell us, because the pending merge makes "how old is the server's answer"
     ambiguous the moment one of this browser's own posts is in the payload.

     Infinity whenever we cannot get a straight answer: an api.js built before
     cachedThreadsAgeMs() was exported, a throw, a value that is not a sane
     number. Every caller compares this against a maximum age, so Infinity sends
     them to the network. That is the right direction to fail in. Failing the
     other way — treating an unknown age as young — is the whole defect this
     guard exists for: an index built from an ancient board answers "No
     questions match", and the student posts the duplicate. */
  function boardAgeMs() {
    var api = Clinic.api;
    if (!api || typeof api.cachedThreadsAgeMs !== 'function') return Infinity;
    var age;
    try { age = api.cachedThreadsAgeMs(); } catch (e) { return Infinity; }
    if (typeof age !== 'number' || isNaN(age) || age < 0) return Infinity;
    return age;
  }

  /* api.js fires 'clinic:threads' with the merged payload every time a
     threads.list refresh LANDS — index.html's boot fetch, its background
     revalidation, any page that calls refreshThreads(). Riding along means the
     index tracks the board for free and never needs a run of its own.

     It matters most on index.html, which loads this file but never calls
     load(): browsing the board leaves a warm cache behind, so a visit to
     search.html or the composer's similar-threads panel that follows soon
     enough after costs nothing at all. It is only "soon enough" that this buys,
     though — load() still gates on age, because search.html and new.html never
     refresh the board and so never receive this event. Rebuilding over 20-200
     cards is sub-millisecond, so it is not worth gating on which page is
     listening.

     Everything is inside one try/catch: a malformed payload must cost us the
     rebuild, never the page. */
  if (window.addEventListener) {
    window.addEventListener('clinic:threads', function (ev) {
      try {
        var payload = ev && ev.detail;
        if (!payload || !Array.isArray(payload.threads)) return;
        var rows = serverRows(payload);
        var wasStale = stale;
        if (Array.isArray(payload.users)) lastUsers = payload.users;
        /* DO NOT re-persist while we are invalidated. invalidate() deletes the
           sessionStorage copy precisely so that the next load() — including the
           one on the NEXT page in this tab, where the in-memory `stale` flag
           does not survive the navigation — goes back to the server. Writing
           the cache again from a board event undoes that cross-page signal, and
           does it with a payload that may well predate the write which rang the
           doorbell: Excel needs 26-54 s before a write reads back. Rebuilding
           the in-memory index is still worth doing — it is sub-millisecond, and
           this payload is strictly newer than the one we were holding. */
        if (!wasStale) writeCache(rows, lastUsers);
        build(rows, 'network');
        /* build() clears `stale`, and only a load() that actually went to the
           server has earned that. invalidate() is rung by every write path —
           replies, accepts, moderation, another tab's doorbell — and for all of
           those except a brand-new thread there is nothing pending to look for,
           so the conservative reading of a landed refresh is that it may have
           been issued before the write it is supposed to reflect. Keep whatever
           the flag was; the search page's "Someone posted — refresh" button,
           which loads with force:true, is what clears it. */
        stale = wasStale;
      } catch (e) { /* keep whatever index we had; this path is a bonus, not a duty */ }
    });
  }

  function load(opts) {
    opts = opts || {};
    var force = !!opts.force;
    var maxAge = opts.maxAgeMs == null ? TTL_MS : opts.maxAgeMs;

    if (!force && built && !stale && (Date.now() - builtAt) < maxAge) {
      return Promise.resolve(module);
    }
    if (!force && !stale) {
      var cached = readCache(maxAge);
      if (cached) {
        lastUsers = cached.users || [];
        build(cached.threads, 'cache');
        return Promise.resolve(module);
      }
      /* Nothing of ours inside the TTL — but api.js may still be holding the
         very payload we are about to spend 10-21 s on. Take it and write our
         own cache from it, so the next load() in this tab is a sessionStorage
         read again.

         ONLY WHILE THAT BOARD IS ITSELF INSIDE maxAge. api.js caps the blob at
         12 h, and neither page that calls load() — search.html, new.html —
         ever refreshes the board, so on exactly the pages that use this index
         nothing revalidates it and 'clinic:threads' never fires. Without the
         age gate this branch would happily build the index, and the composer's
         duplicate check with it, from a board fetched hours ago and report it
         as fresh. That is the failure this whole file exists to prevent: a
         student searches at 15:30 against a 14:05 board, is told "No questions
         match", and posts a duplicate of a thread that is already there.
         boardAgeMs() answers Infinity when api.js is too old to export the
         helper, which sends that build to the NETWORK rather than to a board of
         unknown age — the cost of being wrong here is a duplicate thread, so we
         degrade towards freshness, not towards speed.

         Guarded by the same !force && !stale as the read above, and for the
         same reasons: `force` is the search page's "Someone posted — refresh"
         button and has to reach the network, and a stale index is stale
         because of a write that this payload — a snapshot of the same server
         state our own cache held — cannot contain either. */
      var boardAge = boardAgeMs();
      var board = boardAge <= maxAge ? boardPayload() : null;
      if (board) {
        var rows = serverRows(board);
        if (Array.isArray(board.users)) lastUsers = board.users;
        /* Cached under the board's OWN fetch time, not ours, so that accepting
           an 80 s board does not silently buy it another 90 s of life here. */
        writeCache(rows, lastUsers, Date.now() - boardAge);
        build(rows, 'cache');
        return Promise.resolve(module);
      }
    }
    /* Our own single-flight on top of api.js's DEDUPE: two callers on the same
       paint (index.js's own threads.list and a similar-threads panel) must not
       both queue a rebuild. */
    if (inFlight) return inFlight;

    var api = Clinic.api;
    if (!api || typeof api.call !== 'function') {
      return Promise.reject({ code: 'network', message: 'API is not loaded.' });
    }

    inFlight = api.call('threads.list', {}).then(function (res) {
      /* The raw call returns the SERVER payload, so there is nothing pending in
         it to drop — serverRows() is used anyway so that every path into
         build() filters identically and a later switch to one of api.js's
         merged helpers cannot quietly reintroduce unresolvable ids. */
      var threads = serverRows(res);
      lastUsers = (res && res.users) || [];
      writeCache(threads, lastUsers);
      build(threads, 'network');
      inFlight = null;
      return module;
    }, function (err) {
      inFlight = null;
      throw err;                       /* the ApiError, per §10.1 */
    });
    return inFlight;
  }

  /* =========================================================== FILTERS ==== */

  /* Filter key names ARE the §8.5 URL parameter names. `language` is canonical
     (index.html's `lang` is the same dimension under a legacy name), and
     `status` (raw tbl_Threads column) and `answered` (derived view state) are
     TWO DIFFERENT DIMENSIONS. Do not collapse them. */

  function sgDateStr(iso) {
    /* Nobody writes a new date formatter (§8.3 rule 6): ui.js's parseIso and
       sgParts are the SGT-fixed pair. Fall back to the raw ISO date only if
       ui.js somehow is not loaded — wrong by up to 8 hours, but never a crash. */
    var ui = Clinic.ui;
    if (ui && ui.parseIso && ui.sgParts) {
      var d = ui.parseIso(iso);
      if (!d) return '';
      var p = ui.sgParts(d);
      var m = p.month + 1;
      return p.year + '-' + (m < 10 ? '0' : '') + m + '-' + (p.day < 10 ? '0' : '') + p.day;
    }
    return str(iso).slice(0, 10);
  }

  function matchesFilters(t, f) {
    if (!f) return true;

    if (f.category && str(t.category) !== f.category) return false;
    if (f.language && str(t.language) !== f.language) return false;
    if (f.label) {
      var ls = labelsOf(t), hit = false;
      for (var i = 0; i < ls.length; i++) { if (trim(ls[i]) === f.label) { hit = true; break; } }
      if (!hit) return false;
    }
    /* RAW status column, exact string match. Not the derived state. */
    if (f.status && str(t.status) !== f.status) return false;

    if (f.answered === 'answered' && !isAnswered(t)) return false;
    if (f.answered === 'unanswered') {
      if (isAnswered(t)) return false;
      /* Contract §5.2: a thread is excluded from the unanswered filter and the
         unanswered COUNT iff duplicate_of is non-empty — never by inspecting
         status. This mirrors E3/E4's flow-side Query exactly, which is why the
         duplicate ops deliberately leave status alone. */
      if (trim(t.duplicate_of)) return false;
    }

    if (f.author) {
      var want = String(f.author).toLowerCase();
      var uid = (t.author && t.author.user_id) || '';
      var nm = authorName(t).toLowerCase();
      if (uid !== f.author && nm.indexOf(want) === -1) return false;
    }

    if (f.from || f.to) {
      var day = sgDateStr(t.created_at);
      if (f.from && day && day < f.from) return false;
      if (f.to && day && day > f.to) return false;
    }

    if (f.hideLocked && t.locked) return false;
    if (f.hideDuplicates && trim(t.duplicate_of)) return false;

    return true;
  }

  /* No query path, so filters alone work at query length 0. */
  function filterOnly(filters) {
    if (!built) return [];
    var out = [];
    for (var i = 0; i < docs.length; i++) {
      if (matchesFilters(docs[i].thread, filters)) out.push(docs[i].thread);
    }
    out.sort(byRecency);
    return out;
  }

  function byRecency(a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  }

  /* ========================================================== SCORING ===== */

  function tokenScore(doc, tok) {
    var s = 0;
    for (var i = 0; i < FIELDS.length; i++) {
      var f = FIELDS[i];
      var n = doc.fieldTf[f][tok];
      if (n) s += W[f] * n;
    }
    return s;
  }

  function prefixCandidates(prefix) {
    var out = [];
    for (var i = 0; i < allTokens.length; i++) {
      var t = allTokens[i];
      if (t.length >= prefix.length && t.lastIndexOf(prefix, 0) === 0) {
        out.push(t);
        if (out.length >= PREFIX_CANDIDATE_CAP) break;
      }
    }
    return out;
  }

  /* Best single completion wins, rather than the sum: "pa" completing to both
     "pandas" and "path" in one document should not out-rank a document that
     actually says "pandas" three times. */
  function bestPrefixScore(doc, cands) {
    var best = 0;
    for (var i = 0; i < cands.length; i++) {
      var s = tokenScore(doc, cands[i]);
      if (s > best) best = s;
    }
    return best;
  }

  /* --------------------------------------------------------- hit ranges */
  /* Ranges are offsets into the ORIGINAL text so the page can highlight the
     user's own casing. toLowerCase() is length-preserving for every character
     this corpus will realistically contain. */
  function rangesFor(text, needles) {
    var src = str(text);
    if (!src || !needles.length) return [];
    var low = src.toLowerCase();
    var raw = [];
    for (var i = 0; i < needles.length; i++) {
      var n = needles[i];
      if (!n) continue;
      var at = low.indexOf(n);
      while (at !== -1) {
        raw.push([at, at + n.length]);
        at = low.indexOf(n, at + n.length);
      }
    }
    if (!raw.length) return [];
    raw.sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    var merged = [raw[0].slice()];
    for (var k = 1; k < raw.length; k++) {
      var last = merged[merged.length - 1];
      if (raw[k][0] <= last[1]) { if (raw[k][1] > last[1]) last[1] = raw[k][1]; }
      else merged.push(raw[k].slice());
    }
    return merged;
  }

  /* The strings we look for when highlighting: the query tokens, plus the raw
     query itself when it is a phrase (so "key error" highlights as typed). */
  function needlesFor(query) {
    var q = trim(query).toLowerCase();
    if (!q) return [];
    var toks = tokenise(q);
    var out = [];
    for (var i = 0; i < toks.length; i++) if (toks[i].length >= 2) out.push(toks[i]);
    if (q.length >= MIN_QUERY && out.indexOf(q) === -1 && /\s/.test(q)) out.push(q);
    /* Single CJK characters are legitimate needles even though they are 1 char. */
    for (var j = 0; j < toks.length; j++) {
      if (toks[j].length === 1 && CJK_RE.test(toks[j]) && out.indexOf(toks[j]) === -1) out.push(toks[j]);
    }
    return out;
  }

  /* highlight() returns a DocumentFragment — NEVER an HTML string. The corpus
     is user-authored text; building markup out of it and assigning innerHTML
     is precisely how a search page becomes an XSS hole. */
  function highlight(text, query) {
    var frag = document.createDocumentFragment();
    var src = str(text);
    var ranges = rangesFor(src, needlesFor(query));
    if (!ranges.length) {
      frag.appendChild(document.createTextNode(src));
      return frag;
    }
    var cursor = 0;
    for (var i = 0; i < ranges.length; i++) {
      var s = ranges[i][0], e = ranges[i][1];
      if (s > cursor) frag.appendChild(document.createTextNode(src.slice(cursor, s)));
      var mark = document.createElement('span');
      mark.className = 'search-hit';
      mark.appendChild(document.createTextNode(src.slice(s, e)));
      frag.appendChild(mark);
      cursor = e;
    }
    if (cursor < src.length) frag.appendChild(document.createTextNode(src.slice(cursor)));
    return frag;
  }

  /* ============================================================ SEARCH ==== */

  function search(query, opts) {
    if (!built) return [];
    opts = opts || {};
    var limit = opts.limit == null ? 50 : opts.limit;
    var filters = opts.filters || null;

    var q = trim(query);
    if (q.length < MIN_QUERY) return [];      /* callers use filterOnly() here */

    var toks = tokenise(q);
    if (!toks.length) return [];              /* e.g. ?q=the — legitimately nothing */

    /* The last token matches as a prefix only while the user is mid-word: a
       trailing space or punctuation means they finished typing it. */
    var midWord = !/[\s!-\/:-@\[-`{-~]$/.test(str(query));
    var exact = toks.slice(0, midWord ? toks.length - 1 : toks.length);
    var prefixTok = midWord ? toks[toks.length - 1] : null;
    var cands = prefixTok ? prefixCandidates(prefixTok) : null;

    var qLower = q.toLowerCase();
    var out = [];

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      if (filters && !matchesFilters(doc.thread, filters)) continue;   /* filters BEFORE scoring */

      var total = 0, ok = true, j, s;
      for (j = 0; j < exact.length; j++) {
        s = tokenScore(doc, exact[j]);
        if (!s) { ok = false; break; }        /* AND, matching index.js */
        total += s;
      }
      if (!ok) continue;
      if (prefixTok) {
        s = bestPrefixScore(doc, cands);
        if (!s) continue;
        total += s;
      }
      if (doc.titleLower.indexOf(qLower) !== -1) total += PHRASE_BONUS;
      out.push({ doc: doc, score: total });
    }

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var c = String(b.doc.created || '').localeCompare(String(a.doc.created || ''));
      if (c) return c;                        /* recent first on a score tie   */
      return (b.doc.answered ? 1 : 0) - (a.doc.answered ? 1 : 0);  /* then answered */
    });

    if (limit > 0 && out.length > limit) out = out.slice(0, limit);

    /* Hits are computed only for the rows that survive, not for the corpus. */
    var needles = needlesFor(q);
    if (prefixTok && needles.indexOf(prefixTok) === -1) needles.push(prefixTok);
    var results = [];
    for (var k = 0; k < out.length; k++) {
      var t = out[k].doc.thread;
      results.push({
        thread: t,
        score: out[k].score,
        hits: {
          title: rangesFor(t.title, needles),
          excerpt: rangesFor(t.excerpt, needles)
        }
      });
    }
    return results;
  }

  /* ======================================================== SUGGESTIONS === */

  /* Called with a DRAFT TITLE, not a query. Deliberately OR-scored (unlike
     search's AND): a student typing a sentence will include words no existing
     thread has, and demanding all of them would return nothing every time. */
  function suggest(title, opts) {
    if (!built) return [];
    opts = opts || {};
    var limit = opts.limit == null ? SUGGEST_LIMIT : opts.limit;
    var minScore = opts.minScore == null ? SUGGEST_MIN_SCORE : opts.minScore;

    var raw = trim(title);
    if (raw.length < SUGGEST_MIN_CHARS) return [];
    var toks = tokenise(raw);
    if (toks.length < SUGGEST_MIN_TOKENS) return [];

    var tri = trigramsOf(raw);
    var out = [];

    for (var i = 0; i < docs.length; i++) {
      var doc = docs[i];
      /* A thread already marked duplicate is the wrong thing to point someone
         at — the moderator has said the canonical question is elsewhere. */
      if (trim(doc.thread.duplicate_of)) continue;
      if (opts.filters && !matchesFilters(doc.thread, opts.filters)) continue;

      var tokScore = 0;
      for (var j = 0; j < toks.length; j++) tokScore += tokenScore(doc, toks[j]);
      var triScore = SUGGEST_TRIGRAM_WEIGHT * dice(tri, doc.tri);

      var reason = triScore >= tokScore ? 'title' : 'tokens';
      var score = Math.max(tokScore, triScore);
      if (doc.answered) score += SUGGEST_ANSWERED_BONUS;   /* answered is the useful one */
      if (score < minScore) continue;
      out.push({ thread: doc.thread, score: score, reason: reason, _c: doc.created, _a: doc.answered });
    }

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      var c = String(b._c || '').localeCompare(String(a._c || ''));
      if (c) return c;
      return (b._a ? 1 : 0) - (a._a ? 1 : 0);
    });
    if (limit > 0 && out.length > limit) out = out.slice(0, limit);
    for (var k = 0; k < out.length; k++) { delete out[k]._c; delete out[k]._a; }
    return out;
  }

  /* ============================================================ EXPORT ==== */

  var module = {
    load: load,
    build: build,
    ready: ready,
    search: search,
    suggest: suggest,
    filterOnly: filterOnly,
    highlight: highlight,
    invalidate: invalidate,
    stats: stats,

    /* Exported so the two consumers do not invent two different answers.
       §10.1 fixes these numbers; they are not page-local preferences. */
    DEBOUNCE_MS: DEBOUNCE_MS,
    MIN_QUERY: MIN_QUERY,
    SUGGEST_DEBOUNCE_MS: SUGGEST_DEBOUNCE_MS,
    SUGGEST_MIN_CHARS: SUGGEST_MIN_CHARS,
    SUGGEST_MIN_TOKENS: SUGGEST_MIN_TOKENS,
    TTL_MS: TTL_MS,

    /* Small helpers the search page and the composer panel both need, kept
       here so "answered" means exactly one thing across the codebase. */
    isAnswered: isAnswered,
    tokenise: tokenise,
    users: function () { return lastUsers.slice(); }
  };

  Clinic.searchIndex = module;

})(window, document);
