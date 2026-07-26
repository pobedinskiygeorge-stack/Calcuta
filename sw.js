/* Calcuta service worker — offline app shell + fast launch.
   Strategy:
   - navigations (opening the app): network-first so an online launch always gets
     the latest index.html, with the cached copy as the offline fallback;
   - static assets (same-origin files + the Firebase SDK on gstatic): cache-first
     with a background refresh, so repeat launches are instant and work offline;
   - everything else — crucially all Firebase Auth / Firestore API traffic — is
     NOT intercepted at all, so real-time sync and sign-in behave exactly as before.
   The app's own Firestore offline persistence still handles data offline; this SW
   only makes the app itself (and its code) load without a network. */
/* __BUILD__ is replaced with the commit SHA by the "Prepare site" step of
   .github/workflows/deploy-pages.yml. It only ever touches this file, never
   index.html, so the app stays a single self-contained file that works when
   opened straight from disk. The literal is a valid cache name on its own, so
   a missed substitution degrades to the old fixed-key behaviour rather than
   breaking. Before this, the key was a hardcoded 'calcuta-shell-v1' that was
   never bumped — so a redeploy left the previous index.html and icons cached
   indefinitely, and only the network-first navigation hid the staleness.
   Keep this ONE literal — do not build it by concatenation. The workflow
   asserts the stamped name is present with `grep -q "calcuta-shell-$SHA"`,
   and a name glued together at runtime never appears in the file, so that
   check would fail the build even though the substitution worked. */
const CACHE = 'calcuta-shell-__BUILD__';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];
// How long a navigation waits for the network before falling back to cache.
const NAV_TIMEOUT_MS = 2500;

self.addEventListener('install', e=>{
  e.waitUntil(
    caches.open(CACHE)
      .then(c=>Promise.allSettled(SHELL.map(u=>c.add(u))))   // allSettled: one 404 can't break install
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(()=>self.clients.claim())
  );
});

// Only the app shell and the Firebase SDK bundle are cacheable. Auth/Firestore
// API calls (and anything else) fall through to the network untouched.
function cacheable(url){
  try{
    const u=new URL(url);
    if(u.origin===self.location.origin) return true;
    if(u.hostname==='www.gstatic.com' && u.pathname.indexOf('/firebasejs/')!==-1) return true;
    return false;
  }catch(e){ return false; }
}
/* Only store responses we can actually verify. index.html now injects the
   Firebase SDK with crossorigin="anonymous", and gstatic answers with
   `access-control-allow-origin: *`, so those are ordinary CORS responses with
   a meaningful res.ok. Previously they were opaque: status unreadable (a
   truncated or error body would be cached and served back indefinitely) and
   charged against origin quota with multi-megabyte padding. */
function put(req,res){
  if(res && res.ok){
    const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
  }
  return res;
}

self.addEventListener('fetch', e=>{
  const req=e.request;
  if(req.method!=='GET') return;                         // writes/API POSTs: untouched

  if(req.mode==='navigate'){                             // opening the app
    /* Network-first, but with a deadline. The old version only reached for the
       cache when fetch() *rejected*, so on lie-fi — a captive portal, a dead
       VPN, a phone holding one bar — the launch hung for the browser's full
       network timeout while a perfectly good copy sat in Cache Storage. That
       was the worst cold-start in the app. Now the cache wins after 2.5 s and
       the network response is still cached in the background, so the next
       launch is current either way.
       (The previous fallback chain also had a dead branch: in
       `r || caches.match('./index.html') || caches.match('./')` the middle
       operand is a Promise, hence always truthy, so `'./'` was unreachable.) */
    e.respondWith((async ()=>{
      const cachedP = caches.match(req)
        .then(r=>r || caches.match('./index.html'))
        .then(r=>r || caches.match('./'));
      const netP = fetch(req).then(res=>put(req,res));
      const TIMEOUT = Symbol('timeout'), FAILED = Symbol('failed');
      const first = await Promise.race([
        netP.catch(()=>FAILED),
        new Promise(r=>setTimeout(()=>r(TIMEOUT), NAV_TIMEOUT_MS)),
      ]);
      if(first !== TIMEOUT && first !== FAILED) return first;
      const cached = await cachedP;
      if(cached){ e.waitUntil(netP.catch(()=>{})); return cached; }
      return netP;                                       // nothing cached: keep waiting
    })());
    return;
  }

  if(!cacheable(req.url)) return;                        // Firebase Auth/Firestore etc: untouched

  e.respondWith(
    caches.match(req).then(cached=>{
      const network=fetch(req).then(res=>put(req,res)).catch(()=>cached);
      return cached || network;                          // cache-first, refresh in background
    })
  );
});
