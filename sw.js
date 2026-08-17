/*!
 * MScPHMxAI Coding Clinic — sw.js
 * The service worker. Its ONLY job is to stop this browser re-downloading the
 * same ~600 KB of JavaScript, CSS and vendor bundles on every cold visit.
 *
 * IT MUST NEVER TOUCH AN API CALL. Everything the flows serve is a POST to the
 * Power Platform host, and both are excluded twice over (method and origin)
 * because getting this wrong would serve a student a cached answer to a live
 * question — stale board rows, a stale slot grid, someone else's session. The
 * caches this site relies on for freshness all live in api.js and the page
 * scripts, and they are careful in ways a URL-keyed HTTP cache cannot be.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE MODE THIS FILE IS WRITTEN AGAINST
 * A bad service worker does not degrade a site, it strands it: every visitor
 * keeps being served the broken copy, from their own disk, with no way to ask
 * for a new one. That is materially worse than the problem it solves. Three
 * rules follow, and none of them is optional.
 *
 *   1. HTML AND config.js ARE NETWORK-FIRST. config.js carries the four flow
 *      URLs, and those get rotated — a cache-first copy would point a whole
 *      cohort at a dead endpoint until they cleared their browser data. The
 *      HTML files name the scripts, so a stale one pins a stale dependency
 *      graph. Both fall back to cache only when the network genuinely fails,
 *      which is the offline case and is worth having.
 *   2. skipWaiting + clients.claim. A new worker takes over on the next load,
 *      not "eventually, after every tab is closed". Combined with rule 1 this
 *      bounds how long a mistake can live to a single page load.
 *   3. ANY error falls through to the network. A cache miss, a quota failure, a
 *      malformed response — all end in fetch(). The worker can make the site
 *      faster; it is written so that it cannot make the site not work.
 *
 * BUMP CACHE_VERSION ON EVERY DEPLOY that changes a file under assets/. The
 * activate handler deletes every cache that is not the current one, so a bump
 * is also the eviction. Forgetting it is not fatal — assets are revalidated in
 * the background on each use (stale-while-revalidate below) so a stale copy
 * lasts exactly one page load — but bumping makes the change immediate.
 * ---------------------------------------------------------------------------
 */

var CACHE_VERSION = 'clinic-v3.4-2026-08-17';

/* Same-origin only, and even then only the static shell. Anything not matched
   here is passed straight through to the network untouched. */
var ASSET_RE = /\/assets\/(css|js|vendor)\//;

/* Never served from cache while the network is reachable. config.js is in the
   assets tree but is configuration, not code, and must not be pinned. */
var NETWORK_FIRST_RE = /(\.html$|\/$|\/assets\/js\/config\.js$)/;

/* The one file that must never be cached in any form: caching a service worker
   with a service worker is how a bad deploy becomes permanent. */
var SELF_RE = /\/sw\.js$/;

self.addEventListener('install', function (e) {
  /* Deliberately NO precache list. Naming files here means this worker owns a
     manifest that has to be kept in step with nine HTML files by hand, and a
     single wrong path fails the whole install. Everything warms on first use
     instead, which costs one ordinary visit and cannot go out of date. */
  self.skipWaiting();
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        return k === CACHE_VERSION ? null : caches['delete'](k);
      }));
    }).then(function () {
      return self.clients.claim();
    })['catch'](function () { /* never block activation on cleanup */ })
  );
});

/* Only 200/basic responses are stored. An opaque or partial response cached
   here would be replayed forever as a broken asset. */
function cacheable(res) {
  return !!res && res.status === 200 && res.type === 'basic';
}

function putSafe(key, res) {
  try {
    var copy = res.clone();
    caches.open(CACHE_VERSION).then(function (c) {
      try { c.put(key, copy); } catch (e) { /* quota */ }
    })['catch'](function () { /* storage unavailable */ });
  } catch (e) { /* clone failed; not worth failing the request over */ }
}

/* THE CACHE KEY FOR AN HTML PAGE IS ITS PATH, NOT ITS URL.
   CacheStorage keys on the full URL including the query string, and every
   thread on this site is thread.html?id=<something>. Keyed naively, one student
   reading forty threads over a semester stores forty byte-identical copies of
   thread.html — unbounded growth in exchange for nothing, since the query is
   read by page JavaScript and never changes the document the server returns.
   Found by inspecting the live cache after a browsing session, not by reading
   this code: three /thread.html entries for three different ids.

   Only the shell is normalised. Asset URLs are kept whole, because a query
   string there would be a cache-buster and collapsing it is exactly wrong. */
function shellKey(url) {
  return new Request(url.origin + url.pathname);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;

  /* GET only. Every flow call is a POST, so this single line already excludes
     the entire API surface; the origin test below is the belt to its braces. */
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (err) { return; }

  if (url.origin !== self.location.origin) return;   /* the flow host, fonts, anything else */
  if (SELF_RE.test(url.pathname)) return;

  var isShell = NETWORK_FIRST_RE.test(url.pathname);
  var isAsset = ASSET_RE.test(url.pathname);
  if (!isShell && !isAsset) return;                  /* not ours; leave it alone */

  if (isShell) {
    /* NETWORK-FIRST. The cache is a lifeboat for the offline case only. */
    var key = shellKey(url);
    e.respondWith(
      fetch(req).then(function (res) {
        if (cacheable(res)) putSafe(key, res);
        return res;
      })['catch'](function () {
        return caches.match(key).then(function (hit) {
          return hit || Promise.reject(new Error('offline and uncached'));
        });
      })
    );
    return;
  }

  /* STALE-WHILE-REVALIDATE for the static shell. The cached copy is returned
     immediately — this is the whole speed-up — and a fresh one is fetched in
     the background for the NEXT load. One page load of staleness is the
     deliberate price, and it is why CACHE_VERSION exists for the deploys where
     that is not acceptable. */
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (cacheable(res)) putSafe(req, res);
        return res;
      })['catch'](function (err) {
        if (hit) return hit;                         /* offline, but we have it */
        throw err;
      });
      return hit || net;
    })['catch'](function () { return fetch(req); })  /* CacheStorage itself failed */
  );
});
