// Multi-device sync simulator for Calcuta.
//
// Every "device" is a real Chromium profile (persistent context: its own
// localStorage, surviving a close/reopen like a laptop that was switched off)
// running the REAL index.html. The three Firebase compat bundles the app loads
// from gstatic are replaced by a small fake SDK whose Firestore talks to one
// shared in-Node server through an exposed binding, so the app's own boot,
// sign-in, listener, wake-up pull, transactional push, hard save and
// keepalive close-flush all run unmodified.
//
// The fake server models what matters for sync correctness:
//   - one document per user, versioned; transactions are optimistic (commit
//     fails if the version moved since the transaction read it, and the app's
//     callback is re-run, exactly like Firestore);
//   - live listeners that get pushed every committed version;
//   - the Firestore REST PATCH used by the close-flush (field masks, auth);
//   - per-device faults: offline, latency, a hung channel (requests that never
//     answer), a listener killed by an error, a stale IndexedDB cache.
// Per-device clock skew is applied by patching Date.now().
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// The fake compat SDK. Loaded in place of firebase-app-compat.js.
const FAKE_SDK = String.raw`(function(){
  var user={ uid:'u1', getIdToken:function(){ return Promise.resolve('tok-'+Date.now()); } };
  var authCbs=[];
  var authObj={
    currentUser:user,
    setPersistence:function(){ return Promise.resolve(); },
    onAuthStateChanged:function(cb){ authCbs.push(cb); setTimeout(function(){ cb(window.__fsSignedOut?null:user); },0); return function(){}; },
    getRedirectResult:function(){ return Promise.resolve(null); },
    signInWithPopup:function(){ return Promise.resolve(); },
    signInWithRedirect:function(){ return Promise.resolve(); },
    signOut:function(){ return Promise.resolve(); }
  };
  var listeners=[];
  var calls={ enablePersistence:0, clearPersistence:0 };
  var persistence=false;
  function snap(rec, fromCache){
    var doc=rec && rec.doc ? JSON.parse(JSON.stringify(rec.doc)) : null;
    return { exists:!!doc, data:function(){ return doc ? JSON.parse(JSON.stringify(doc)) : undefined; },
             metadata:{ fromCache:!!fromCache, hasPendingWrites:false } };
  }
  var ref={
    onSnapshot:function(opts,next,err){
      if(typeof opts==='function'){ err=next; next=opts; }
      var l={next:next, err:err, dead:false};
      listeners.push(l);
      window.__fsBridge('subscribe', persistence).then(function(r){
        if(l.dead) return;
        if(r && r.cache) next(snap(r.cache,true));          // stale IndexedDB cache first
        if(r && r.server) next(snap(r.server,false));
        else if(r && r.offline) next(snap(null,true));       // offline, nothing cached
      });
      return function(){ l.dead=true; listeners=listeners.filter(function(x){ return x!==l; }); };
    },
    get:function(opts){ return window.__fsBridge('get').then(function(rec){ return snap(rec,false); }); }
  };
  var db={
    enablePersistence:function(){ calls.enablePersistence++; persistence=true; return Promise.resolve(); },
    clearPersistence:function(){ calls.clearPersistence++; return window.__fsBridge('clearPersistence'); },
    collection:function(){ return { doc:function(){ return ref; } }; },
    runTransaction:function(cb){
      var attempt=0;
      function run(){
        return window.__fsBridge('get').then(function(rec){
          var write=null;
          var tx={ get:function(){ return Promise.resolve(snap(rec,false)); }, set:function(r,v){ write=JSON.parse(JSON.stringify(v)); } };
          return Promise.resolve(cb(tx)).then(function(){
            if(!write) return;
            return window.__fsBridge('commit', rec.version, write).then(function(ok){
              if(ok) return;
              if(++attempt>=5) throw Object.assign(new Error('aborted'),{code:'aborted'});
              return run();
            });
          });
        });
      }
      return run();
    }
  };
  window.__fs={ calls:calls, listeners:function(){ return listeners.length; } };
  window.__fsDeliver=function(rec){ listeners.slice().forEach(function(l){ if(!l.dead) l.next(snap(rec,false)); }); };
  window.__fsKill=function(code){ listeners.slice().forEach(function(l){ l.dead=true; if(l.err) l.err(Object.assign(new Error(code),{code:code})); }); listeners=[]; };
  window.firebase={
    initializeApp:function(){},
    auth:Object.assign(function(){ return authObj; },{ Auth:{Persistence:{LOCAL:'LOCAL'}}, GoogleAuthProvider:function(){} }),
    firestore:function(){ return db; }
  };
})();`;

class Server {
  constructor() { this.doc = null; this.version = 0; this.devices = new Set(); this.writes = []; }
  rec() { return { doc: clone(this.doc), version: this.version }; }
  commit(version, doc, who) {
    if (version !== this.version) return false;
    this.doc = clone(doc); this.version++; this.writes.push({ who, via: 'tx', version: this.version });
    this.broadcast();
    return true;
  }
  // Firestore REST PATCH with updateMask.fieldPaths (the keepalive close-flush)
  restPatch(paths, fields, who) {
    const doc = clone(this.doc) || {};
    const val = f => (f.stringValue !== undefined ? f.stringValue
      : f.integerValue !== undefined ? Number(f.integerValue)
      : f.mapValue ? Object.fromEntries(Object.entries(f.mapValue.fields || {}).map(([k, v]) => [k, val(v)])) : null);
    for (const p of paths) {
      const parts = p.split('.').map(s => s.replace(/^`|`$/g, ''));
      let src = fields, dst = doc;
      for (let i = 0; i < parts.length; i++) {
        const f = src && src[parts[i]];
        if (i === parts.length - 1) { if (f === undefined) delete dst[parts[i]]; else dst[parts[i]] = val(f); }
        else { dst[parts[i]] = dst[parts[i]] || {}; dst = dst[parts[i]]; src = f && f.mapValue ? f.mapValue.fields : null; }
      }
    }
    this.doc = doc; this.version++; this.writes.push({ who, via: 'rest', version: this.version, paths });
    this.broadcast();
  }
  broadcast() { for (const d of this.devices) d.deliverSoon(); }
  store() { return this.doc && this.doc.data ? JSON.parse(this.doc.data) : null; }
  text(id) { const s = this.store(); const d = s && s.docs.find(x => x.id === id); return d ? d.text : undefined; }
}

class Device {
  constructor(sim, name, opts = {}) {
    this.sim = sim; this.name = name; this.server = sim.server;
    this.dir = fs.mkdtempSync(path.join(sim.tmp, name + '-'));
    this.online = true; this.latency = opts.latency || 0; this.listenerLatency = opts.listenerLatency || 0;
    this.skew = opts.skew || 0; this.hang = {}; this.cache = null; this.subscribed = false;
    this.errors = []; this.file = opts.file || null;
    this.sdkDown = !!opts.sdkDown;                       // the Firebase bundles cannot be fetched (network not up yet)    // opts.file: run another build of the app on this device
  }
  async open() {
    const ctx = this.ctx = await chromium.launchPersistentContext(this.dir, {
      executablePath: this.sim.exe, viewport: { width: 1000, height: 700 },
    });
    await ctx.addInitScript(skew => { const real = Date.now.bind(Date); window.__skew = skew; Date.now = () => real() + window.__skew; }, this.skew);
    await ctx.addInitScript(() => { window.__calcutaMergeLog = e => console.log('MERGELOG ' + JSON.stringify(e)); });
    if (process.env.SYNC_TRACE) await ctx.addInitScript(() => { window.__calcutaSyncLog = (ev, d) => console.log('SYNCLOG ' + Date.now() + ' ' + ev + ' ' + JSON.stringify(d)); });
    await ctx.route('**/firebasejs/**', r => this.sdkDown ? r.abort() : r.fulfill({ status: 200, contentType: 'application/javascript',
      headers: { 'access-control-allow-origin': '*' },
      body: r.request().url().includes('firebase-app-compat') ? FAKE_SDK : '/* stub */' }));
    await ctx.route('**://firestore.googleapis.com/**', r => this.rest(r));
    await ctx.route('**://www.cbr-xml-daily.ru/**', r => r.abort());
    await ctx.route('**://*.googleapis.com/**', r => r.request().url().includes('firestore.googleapis.com') ? r.fallback() : r.abort());
    await ctx.exposeFunction('__fsBridge', (op, ...a) => this.bridge(op, a));
    this.page = ctx.pages()[0] || await ctx.newPage();
    this.page.on('pageerror', e => this.errors.push(String(e)));
    this.page.on('console', m => { const t = m.text();
      if (t.startsWith('MERGELOG ')) this.sim.mergeLog.push(this.name + ' ' + t.slice(9));
      if (t.startsWith('SYNCLOG ')) this.sim.mergeLog.push(this.name + ' ' + t.slice(8)); });
    this.server.devices.add(this);
    this.subscribed = false;
    await this.page.goto('file://' + (this.file || this.sim.file));
    await this.page.waitForFunction(() => window.__calcuta, null, { timeout: 15000 });
    await this.page.evaluate(() => { const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; } });
  }
  async bridge(op, a) {
    if (op === 'clearPersistence') { this.cache = null; return; }
    if (this.hang[op]) return new Promise(() => {});          // a wedged channel: never answers
    if (this.latency) await sleep(this.latency);
    if (op === 'subscribe') {
      this.subscribed = true; this.persistence = !!a[0];
      const r = {};
      if (this.persistence && this.cache) r.cache = clone(this.cache);
      if (this.online && !this.hang.deliver) { r.server = this.server.rec(); if (this.persistence) this.cache = clone(r.server); }
      else r.offline = true;
      return r;
    }
    if (!this.online) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    if (op === 'get') { const rec = this.server.rec(); if (this.persistence) this.cache = clone(rec); return rec; }
    if (op === 'commit') return this.server.commit(a[0], a[1], this.name);
    throw new Error('unknown op ' + op);
  }
  async rest(route) {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PATCH, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (!this.online) return route.abort();
    if (!/^Bearer tok/.test(req.headers()['authorization'] || '')) return route.fulfill({ status: 401, headers: cors, body: '{}' });
    const url = new URL(req.url());
    const paths = url.searchParams.getAll('updateMask.fieldPaths');
    const body = JSON.parse(req.postData() || '{}');
    this.server.restPatch(paths, body.fields || {}, this.name);
    this.sim.restCalls.push({ who: this.name, paths });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: '{}' });
  }
  deliverSoon() {
    if (!this.page || !this.subscribed || !this.online || this.hang.deliver) return;
    const rec = this.server.rec();
    if (this.persistence) this.cache = clone(rec);
    setTimeout(() => { if (this.page && this.online && !this.hang.deliver) this.page.evaluate(r => window.__fsDeliver && window.__fsDeliver(r), rec).catch(() => {}); }, this.listenerLatency + 5);
  }
  // --- device lifecycle ---
  async goOffline() { this.online = false; await this.page.evaluate(() => { window.dispatchEvent(new Event('offline')); }).catch(() => {}); }
  async goOnline() {
    this.online = true;
    await this.page.evaluate(() => { window.dispatchEvent(new Event('online')); }).catch(() => {});
    this.deliverSoon();                                      // the push channel reconnects and catches up
  }
  async hide() { await this.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }); }
  async show() { await this.page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }); }
  async sleep() { await this.hide(); this.online = false; }           // laptop lid closed / phone app in background
  async wake() { this.online = true; await this.show(); await this.page.evaluate(() => window.dispatchEvent(new Event('online'))).catch(() => {}); this.deliverSoon(); }
  async killListener(code = 'permission-denied') { await this.page.evaluate(c => window.__fsKill(c), code); }
  async powerOff() { this.server.devices.delete(this); this.online = false; await this.ctx.close(); this.page = null; }   // no unload events
  async quit() {                                                    // user closes the browser normally
    await this.page.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
    await sleep(300);
    this.server.devices.delete(this); await this.ctx.close(); this.page = null;
  }
  async boot(opts = {}) { this.online = !opts.offline; await this.open(); }
  // the app gets updated on this device (same profile, same localStorage)
  async upgrade(file) {
    this.file = file || null; this.subscribed = false;
    await this.page.goto('file://' + (this.file || this.sim.file));
    await this.page.waitForFunction(() => window.__calcuta, null, { timeout: 15000 });
    await this.page.evaluate(() => { const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; } });
  }
  // --- editing & inspection ---
  async edit(docId, text) {                                         // replace a doc's text by typing-like input
    await this.page.evaluate(([id, t]) => {
      const K = window.__calcuta; K.setActive(id);
      const el = document.getElementById('input'); el.focus(); el.value = t; el.setSelectionRange(t.length, t.length);
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: t.slice(-1), bubbles: true }));
    }, [docId, text]);
  }
  // real key presses into a doc; where = 'end' | 'start' | {line:N} (end of line N)
  async type(docId, s, where = 'end', delay = 0) {
    await this.page.evaluate(([id, w]) => { const K = window.__calcuta; if (K.getStore().activeId !== id) K.setActive(id);
      const el = document.getElementById('input'); el.focus();
      let p = w === 'start' ? 0 : el.value.length;
      if (w && typeof w === 'object') { const L = el.value.split('\n'); p = 0; for (let k = 0; k <= Math.min(w.line, L.length - 1); k++) p += L[k].length + (k ? 1 : 0); }
      el.setSelectionRange(p, p); }, [docId, where]);
    await this.page.keyboard.type(s, { delay });
  }
  // what a user does: change the CURRENT text of a doc on this device (not a
  // text computed elsewhere) — here, append a word to line i
  async appendToLine(docId, i, word) {
    return this.page.evaluate(([id, i, w]) => {
      const K = window.__calcuta; if (K.getStore().activeId !== id) K.setActive(id);
      const el = document.getElementById('input'); el.focus();
      const L = el.value.split('\n'); const k = i % L.length; L[k] = L[k] + ' ' + w;
      const t = L.join('\n'); el.value = t;
      let p = 0; for (let j = 0; j <= k; j++) p += L[j].length + (j ? 1 : 0);
      el.setSelectionRange(p, p);
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: w.slice(-1), bubbles: true }));
      return k;
    }, [docId, i, word]);
  }
  async createDoc(name, text) {
    return this.page.evaluate(([n, t]) => { const K = window.__calcuta; K.createDoc(); const s = K.getStore(); const d = s.docs[s.docs.length - 1];
      d.name = n; const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true })); return d.id; }, [name, text]);
  }
  async store() { return this.page.evaluate(() => JSON.parse(JSON.stringify(window.__calcuta.getStore()))); }
  async text(id) { const s = await this.store(); const d = s.docs.find(x => x.id === id); return d ? d.text : undefined; }
  async editorText() { return this.page.evaluate(() => document.getElementById('input').value); }
  async payload() { return this.page.evaluate(() => window.__calcuta.syncPayload(window.__calcuta.getStore())); }
  async local() { return this.page.evaluate(() => JSON.parse(localStorage.getItem('calcuta.v2') || 'null')); }
  async eval(fn, arg) { return this.page.evaluate(fn, arg); }
}

class Sim {
  constructor(file, exe) {
    this.file = path.resolve(file); this.exe = exe; this.server = new Server(); this.restCalls = []; this.mergeLog = [];
    this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calcuta-sim-'));
    this.devices = [];
  }
  async device(name, opts) { const d = new Device(this, name, opts); this.devices.push(d); await d.open(); return d; }
  async close() { for (const d of this.devices) { if (d.ctx) await d.ctx.close().catch(() => {}); } fs.rmSync(this.tmp, { recursive: true, force: true }); }
  // payload of the server store in the app's own canonical form (computed by a live device)
  async serverPayload(dev) { const s = this.server.store(); return s ? dev.eval(x => window.__calcuta.syncPayload(x), s) : null; }
  // wait until every listed device and the server agree on content
  async converge(devs, timeout = 20000) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < timeout) {
      const sp = await this.serverPayload(devs[0]);
      const ps = await Promise.all(devs.map(d => d.payload()));
      last = { sp, ps };
      if (sp && ps.every(p => p === sp)) return true;
      await sleep(250);
    }
    return false;
  }
}

module.exports = { Sim, Server, Device, sleep, clone };
