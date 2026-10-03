// The sync scenarios that matter most, run with the REAL Firebase Firestore
// SDK (compat 10.12.2, from the npm package) against the REAL Firestore
// emulator — so the assumptions baked into devicesim.js's fake SDK (snapshot
// metadata, transactions, clearPersistence ordering, REST PATCH with a
// nested field mask, offline behaviour) are checked against the real thing.
// Only Google sign-in is replaced (a stub that reports user "u1"); Firestore
// then talks to the emulator unauthenticated, under rules this script sets.
//
//   1. java -jar cloud-firestore-emulator.jar --host=127.0.0.1 --port=8085
//      (https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.19.7.jar)
//   2. npm pack firebase@10.12.2 && tar xzf firebase-10.12.2.tgz   (-> package/*.js)
//   3. FB_DIR=<…/package> EMU=127.0.0.1:8085 node realsdk.js ../index.html [filter] [OLD_BUILD=…]
const { chromium } = require('playwright-core');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const FILE = path.resolve(process.argv[2] || '../index.html');
const ONLY = process.argv[3] || '';
const FB_DIR = path.resolve(process.env.FB_DIR || 'package');
const [EMU_HOST, EMU_PORT] = (process.env.EMU || '127.0.0.1:8085').split(':');
const EMU = 'http://' + EMU_HOST + ':' + EMU_PORT;
const PROJECT = 'calcuta-35';
const DOC_URL = EMU + '/v1/projects/' + PROJECT + '/databases/(default)/documents/users/u1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const has = (t, ...p) => typeof t === 'string' && p.every(x => t.includes(x));

// Google sign-in stand-in. Also points the real Firestore at the emulator
// right after initializeApp (before the app's first use of it).
const AUTH_SHIM = `(function(){
  var user={ uid:'u1', getIdToken:function(){ return Promise.resolve('tok-'+Date.now()); } };
  var authObj={ currentUser:user, setPersistence:function(){ return Promise.resolve(); },
    onAuthStateChanged:function(cb){ setTimeout(function(){ cb(user); },0); return function(){}; },
    getRedirectResult:function(){ return Promise.resolve(null); },
    signInWithPopup:function(){ return Promise.resolve(); }, signInWithRedirect:function(){ return Promise.resolve(); },
    signOut:function(){ return Promise.resolve(); } };
  firebase.auth=Object.assign(function(){ return authObj; },{ Auth:{Persistence:{LOCAL:'LOCAL'}}, GoogleAuthProvider:function(){} });
  var init=firebase.initializeApp;
  firebase.initializeApp=function(){ var app=init.apply(this, arguments);
    firebase.firestore().useEmulator('${EMU_HOST}', ${EMU_PORT}); return app; };
})();`;

async function emu(method, url, body) {
  const r = await fetch(url, { method, headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); return { status: r.status, json: t ? JSON.parse(t) : null };
}
async function serverDoc() { const r = await emu('GET', DOC_URL); return r.status === 200 ? r.json : null; }
async function serverStore() { const d = await serverDoc(); return d && d.fields && d.fields.data ? JSON.parse(d.fields.data.stringValue) : null; }
async function serverText(id) { const s = await serverStore(); const d = s && s.docs.find(x => x.id === id); return d ? d.text : undefined; }
async function resetEmulator() { await emu('DELETE', EMU + '/emulator/v1/projects/' + PROJECT + '/databases/(default)/documents'); }
async function setRules(src) { return emu('PUT', EMU + '/emulator/v1/projects/' + PROJECT + ':securityRules', { rules: { files: [{ content: src }] } }); }
const OPEN_RULES = "rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /{document=**} { allow read, write: if true; } } }";

class Device {
  constructor(world, name, opts = {}) {
    this.world = world; this.name = name; this.file = opts.file || FILE;
    this.dir = fs.mkdtempSync(path.join(world.tmp, name + '-'));
    this.online = true; this.hangCommit = false; this.errors = [];
  }
  async open() {
    const ctx = this.ctx = await chromium.launchPersistentContext(this.dir, { executablePath: EXE, viewport: { width: 1000, height: 700 } });
    await ctx.route('**/firebasejs/**', r => {
      const f = r.request().url().split('/').pop();
      if (f === 'firebase-auth-compat.js') return r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: AUTH_SHIM });
      return r.fulfill({ status: 200, contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(path.join(FB_DIR, f), 'utf8') });
    });
    // the SDK's own traffic to the emulator: cut it while "offline", stall commits on demand
    await ctx.route(EMU + '/**', r => {
      if (!this.online) return r.abort();
      if (this.hangCommit && /:commit\b/.test(r.request().url())) return new Promise(() => {});
      return r.continue();
    });
    // the app's keepalive close-flush goes to the production REST host: send it to the emulator
    await ctx.route('**://firestore.googleapis.com/**', async r => {
      const req = r.request();
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PATCH, OPTIONS', 'access-control-allow-headers': 'content-type, authorization' };
      if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
      if (!this.online) return r.abort();
      const u = new URL(req.url());
      const res = await fetch(EMU + u.pathname + u.search, { method: req.method(), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer owner' }, body: req.postData() });
      this.world.restCalls.push({ who: this.name, status: res.status, url: u.search });
      return r.fulfill({ status: res.status, headers: cors, contentType: 'application/json', body: await res.text() });
    });
    await ctx.route('**://*.googleapis.com/**', r => r.request().url().includes('firestore.googleapis.com') ? r.fallback() : r.abort());
    await ctx.route('**://www.cbr-xml-daily.ru/**', r => r.abort());
    this.page = ctx.pages()[0] || await ctx.newPage();
    this.page.on('pageerror', e => this.errors.push(String(e)));
    await this.page.goto('file://' + this.file);
    await this.page.waitForFunction(() => window.__calcuta, null, { timeout: 15000 });
    await this.page.evaluate(() => { const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; } });
  }
  async goOffline() { this.online = false; await this.page.evaluate(() => window.dispatchEvent(new Event('offline'))); }
  async goOnline() { this.online = true; await this.page.evaluate(() => window.dispatchEvent(new Event('online'))); }
  async quit() { await this.page.evaluate(() => window.dispatchEvent(new Event('pagehide'))); await sleep(500); await this.ctx.close(); this.page = null; }
  async powerOff() { await this.ctx.close(); this.page = null; }
  async boot() { this.online = true; await this.open(); }
  async edit(id, text) {
    await this.page.evaluate(([id, t]) => { const K = window.__calcuta; K.setActive(id); const el = document.getElementById('input'); el.focus();
      el.value = t; el.setSelectionRange(t.length, t.length); el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true })); }, [id, text]);
  }
  async text(id) { return this.page.evaluate(i => { const d = window.__calcuta.getStore().docs.find(x => x.id === i); return d ? d.text : undefined; }, id); }
  async payload() { return this.page.evaluate(() => window.__calcuta.syncPayload(window.__calcuta.getStore())); }
}

class World {
  constructor() { this.tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'calcuta-real-')); this.devices = []; this.restCalls = []; }
  async device(name, opts) { const d = new Device(this, name, opts); this.devices.push(d); await d.open(); return d; }
  async close() { for (const d of this.devices) if (d.ctx) await d.ctx.close().catch(() => {}); fs.rmSync(this.tmp, { recursive: true, force: true }); }
  async converge(devs, timeout = 30000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const s = await serverStore();
      if (s) {
        const sp = await devs[0].page.evaluate(x => window.__calcuta.syncPayload(x), s);
        const ps = await Promise.all(devs.map(d => d.payload()));
        if (ps.every(p => p === sp)) return true;
      }
      await sleep(400);
    }
    return false;
  }
}

const BASE = 'строка 1\nстрока 2\nстрока 3';
const mark = (t, i, m) => t.split('\n').map((l, k) => (k === i ? l + m : l)).join('\n');
async function pair(w) {
  const A = await w.device('A'); await sleep(2500);
  await A.edit('stock-tasks', BASE); await sleep(2500);
  const B = await w.device('B'); await sleep(3000);
  if (!await w.converge([A, B], 30000)) throw new Error('setup did not converge');
  return { A, B };
}

const scenarios = {
  async 'real SDK: live edit reaches the other device, IndexedDB persistence never enabled'(w) {
    const { A, B } = await pair(w);
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    const ok = await w.converge([A, B], 20000);
    const idb = await B.page.evaluate(async () => (indexedDB.databases ? (await indexedDB.databases()).map(d => d.name) : []));
    return { ok: ok && has(await B.text('stock-tasks'), '(A)') && !idb.some(n => /firestore/i.test(n || '') && /main/i.test(n || '')),
             detail: 'B: ' + JSON.stringify(await B.text('stock-tasks')) + ' idb: ' + JSON.stringify(idb) };
  },

  async 'real SDK: offline edits + newer edit elsewhere — three-way merge through a real transaction'(w) {
    const { A, B } = await pair(w);
    await B.goOffline();
    await B.edit('stock-tasks', mark(BASE, 2, ' (B offline)'));
    await sleep(1000);
    await A.edit('stock-tasks', mark(BASE, 0, ' (A later)'));
    await sleep(2500);
    await B.goOnline();
    const ok = await w.converge([A, B], 40000);
    const s = await serverText('stock-tasks');
    return { ok: ok && s === 'строка 1 (A later)\nстрока 2\nстрока 3 (B offline)', detail: 'server: ' + JSON.stringify(s) };
  },

  async 'real SDK: device switched off with unsynced edits, booted later — merged'(w) {
    const { A, B } = await pair(w);
    await B.goOffline();
    await B.edit('stock-tasks', mark(BASE, 2, ' (B before off)'));
    await sleep(800);
    await B.powerOff();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A while B off)'));
    await sleep(2500);
    await B.boot();
    const ok = await w.converge([A, B], 40000);
    const s = await serverText('stock-tasks');
    return { ok: ok && s === 'строка 1 (A while B off)\nстрока 2\nстрока 3 (B before off)', detail: 'server: ' + JSON.stringify(s) };
  },

  async 'real SDK + REST: close-flush with a stalled commit lands as pending, is folded and cleared'(w) {
    const { A, B } = await pair(w);
    B.hangCommit = true;
    await B.edit('stock-tasks', mark(BASE, 1, ' (B last words)'));
    await sleep(300);
    await B.quit();
    await sleep(1500);
    const raw = await serverDoc();
    const hadPending = !!(raw && raw.fields && raw.fields.pending);
    const ok = await w.converge([A], 30000);
    const after = await serverDoc();
    const s = await serverText('stock-tasks');
    // (the other device may fold and clear the entry before we look: the REST write itself is the proof)
    const patched = w.restCalls.some(c => c.who === 'B' && c.status === 200 && /fieldPaths=pending\./.test(c.url));
    return { ok: patched && ok && has(s, '(B last words)') && !(after.fields && after.fields.pending && Object.keys(after.fields.pending.mapValue.fields || {}).length),
             detail: 'REST: ' + JSON.stringify(w.restCalls) + ' pending seen: ' + hadPending + ' server: ' + JSON.stringify(s) };
  },

  async 'real SDK: booted with the server unreachable, edited, then reachable — merged, nothing seeded over the cloud'(w) {
    const { A, B } = await pair(w);
    await B.powerOff();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(2500);
    B.online = false;                                     // emulator unreachable at boot (SDK starts offline)
    await B.open();
    await sleep(4000);
    const during = await serverText('stock-tasks');
    await B.edit('stock-tasks', mark(await B.text('stock-tasks'), 2, ' (B offline boot)'));
    await sleep(1000);
    await B.goOnline();
    const ok = await w.converge([A, B], 45000);
    const s = await serverText('stock-tasks');
    return { ok: during === mark(BASE, 0, ' (A)') && ok && s === 'строка 1 (A)\nстрока 2\nстрока 3 (B offline boot)', detail: 'server: ' + JSON.stringify(s) + ' during: ' + JSON.stringify(during) };
  },

  async 'real SDK: two devices commit at the same moment (transaction contention) — both edits kept'(w) {
    const { A, B } = await pair(w);
    for (let round = 0; round < 3; round++) {
      await Promise.all([A.edit('stock-tasks', mark(await A.text('stock-tasks'), 0, ' a' + round)),
                         B.edit('stock-tasks', mark(await B.text('stock-tasks'), 2, ' b' + round))]);
      await Promise.all([A.page.evaluate(() => window.__calcuta.__syncTest.flushSync()), B.page.evaluate(() => window.__calcuta.__syncTest.flushSync())]);
      await sleep(300);
    }
    const ok = await w.converge([A, B], 40000);
    const s = await serverText('stock-tasks');
    return { ok: ok && s === 'строка 1 a0 a1 a2\nстрока 2\nстрока 3 b0 b1 b2', detail: 'server: ' + JSON.stringify(s) };
  },

  async 'real SDK: hard save on one device is adopted by the other'(w) {
    const { A, B } = await pair(w);
    await A.edit('stock-tasks', mark(BASE, 1, ' (hard)'));
    await A.page.evaluate(() => window.__calcuta.__syncTest.hardSave());
    const ok = await w.converge([A, B], 30000);
    const fe = (await serverStore()).forceEpoch || 0;
    const feB = await B.page.evaluate(() => window.__calcuta.getStore().forceEpoch || 0);
    return { ok: ok && fe > 0 && feB === fe && has(await B.text('stock-tasks'), '(hard)'), detail: 'epoch server/B: ' + fe + '/' + feB };
  },

  async 'real SDK: network cut and restored with no online/offline events — catches up by itself'(w) {
    const { A, B } = await pair(w);
    B.online = false;                                     // silently: no events at all
    await A.edit('stock-tasks', mark(BASE, 0, ' (A during the cut)'));
    await sleep(4000);
    B.online = true;
    const t0 = Date.now(); let got = false;
    while (Date.now() - t0 < 90000) { if (has(await B.text('stock-tasks'), '(A during the cut)')) { got = true; break; } await sleep(1000); }
    return { ok: got, detail: 'caught up after ' + (Date.now() - t0) + 'ms' };
  },

  async 'real SDK: recommended rules accept this build and refuse a build without proto'(w) {
    const r = await setRules("rules_version = '2';\nservice cloud.firestore { match /databases/{database}/documents { match /users/{uid} {\n" +
      "  allow read, delete: if true;\n  allow create, update: if request.resource.data.get('proto', 0) >= 2; } } }");
    if (r.status !== 200) return { ok: false, detail: 'rules rejected by the emulator: ' + JSON.stringify(r.json) };
    try {
      const A = await w.device('A'); await sleep(2500);
      await A.edit('stock-tasks', BASE + ' (new build)');
      await sleep(3000);
      const okNew = has(await serverText('stock-tasks'), '(new build)');
      let okOld = true, detailOld = 'skipped (set OLD_BUILD)';
      if (process.env.OLD_BUILD) {
        const O = await w.device('O', { file: path.resolve(process.env.OLD_BUILD) }); await sleep(3000);
        await O.edit('stock-personal', 'со старой сборки');
        await sleep(3000);
        const p = await serverText('stock-personal');
        okOld = !has(p || '', 'со старой сборки'); detailOld = 'old build wrote personal: ' + JSON.stringify(p);
      }
      return { ok: okNew && okOld, detail: 'new build wrote: ' + okNew + '; ' + detailOld };
    } finally { await setRules(OPEN_RULES); }
  },
};

(async () => {
  let fails = 0, n = 0;
  await setRules(OPEN_RULES);
  for (const [name, fn] of Object.entries(scenarios)) {
    if (ONLY && !new RegExp(ONLY).test(name)) continue;
    n++;
    await resetEmulator();
    const w = new World();
    let r;
    try { r = await fn(w); } catch (e) { r = { ok: false, detail: 'threw: ' + (e && e.message) }; }
    const errs = w.devices.flatMap(d => d.errors).filter(e => !/Failed to fetch/.test(e));
    if (errs.length) { r.ok = false; r.detail += ' | page errors: ' + errs.join('; '); }
    console.log((r.ok ? '  ok   ' : '  FAIL ') + name + (r.ok ? '' : '\n         ' + r.detail));
    if (!r.ok) fails++;
    await w.close();
  }
  console.log(fails ? `\n${fails} of ${n} REAL-SDK SCENARIOS FAILED` : `\nALL ${n} REAL-SDK SCENARIOS PASSED`);
  process.exit(fails ? 1 : 0);
})();
