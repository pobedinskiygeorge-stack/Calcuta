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
const CACHE = 'calcuta-shell-v1';
const SHELL = [
  './', './index.html', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png',
];

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
function put(req,res){
  if(res && (res.ok || res.type==='opaque')){
    const copy=res.clone(); caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});
  }
  return res;
}

self.addEventListener('fetch', e=>{
  const req=e.request;
  if(req.method!=='GET') return;                         // writes/API POSTs: untouched

  if(req.mode==='navigate'){                             // opening the app
    e.respondWith(
      fetch(req).then(res=>put(req,res))
        .catch(()=>caches.match(req).then(r=>r || caches.match('./index.html') || caches.match('./')))
    );
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
