// Multi-device sync scenarios: what happens to a device that was asleep /
// switched off / offline for a long time, and to everyone else's data when it
// comes back. Each scenario runs in a fresh simulated world (devicesim.js:
// real index.html in real Chromium profiles, fake Firebase SDK, one shared
// server). The invariants checked everywhere:
//   1. no edit made on any device is lost (unless a later edit removed it);
//   2. an old copy never overwrites newer content - on a device or the server;
//   3. every device ends up with exactly the server's (newest) version.
//   node devicetest.js <path-to-index.html> [scenario-name-regex]
const path = require('path');
const os = require('os');
const { Sim, sleep } = require('./devicesim.js');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const FILE = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
const ONLY = process.argv[3] || '';

const BASE = 'строка 1\nстрока 2\nстрока 3';
const has = (t, ...parts) => typeof t === 'string' && parts.every(p => t.includes(p));

// Two devices that start fully in sync on BASE in the "Задачи" doc.
async function pair(sim, optsB) {
  const A = await sim.device('A');
  await sleep(1200);
  await A.edit('stock-tasks', BASE);
  await sleep(1500);
  const B = await sim.device('B', optsB);
  await sleep(1500);
  if (!await sim.converge([A, B], 15000)) throw new Error('setup did not converge');
  return { A, B };
}
// edit one line of BASE-like text (line index i) by appending a marker
const mark = (t, i, m) => t.split('\n').map((l, k) => (k === i ? l + m : l)).join('\n');

const scenarios = {
  async 'wake: a sleeping device pulls the newest version'(sim) {
    const { A, B } = await pair(sim);
    await B.sleep();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(1500);
    await B.wake();
    const ok = await sim.converge([A, B], 15000);
    const t = await B.editorText();
    return { ok: ok && has(t, '(A)'), detail: JSON.stringify(t) };
  },

  async 'wake: typing before the pull lands keeps BOTH edits (stale editor)'(sim) {
    const { A, B } = await pair(sim);
    await B.sleep();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(1500);
    B.latency = 1500;                                  // slow network right after wake
    await B.wake();
    await B.type('stock-tasks', ' (B)');               // user types immediately at the end (line 3)
    B.latency = 0;
    await sleep(6000);
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(A)', '(B)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'offline edits + newer remote edit of the same doc: both survive'(sim) {
    const { A, B } = await pair(sim);
    await B.goOffline();
    await B.edit('stock-tasks', mark(BASE, 2, ' (B offline)'));
    await sleep(800);
    await A.edit('stock-tasks', mark(BASE, 0, ' (A later)'));
    await sleep(1500);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(B offline)', '(A later)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'powered off with unsynced edits, booted days later: edits merge in, newer remote kept'(sim) {
    const { A, B } = await pair(sim);
    await B.goOffline();
    await B.edit('stock-tasks', mark(BASE, 2, ' (B before off)'));
    await sleep(600);
    await B.powerOff();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A while B off)'));
    await sleep(1500);
    await B.boot();
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(B before off)', '(A while B off)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'switched on WITHOUT network after days off, edited, then network: both edits kept'(sim) {
    const { A, B } = await pair(sim);
    await B.powerOff();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A while B off)'));
    await sleep(1500);
    await B.boot({ offline: true });
    await sleep(2500);
    await B.edit('stock-tasks', mark(await B.editorText(), 2, ' (B offline after boot)'));
    await sleep(800);
    const offlineSrv = sim.server.text('stock-tasks');
    await B.goOnline();
    const ok = await sim.converge([A, B], 25000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && !has(offlineSrv, '(B offline') && s === 'строка 1 (A while B off)\nстрока 2\nстрока 3 (B offline after boot)',
             detail: 'server: ' + JSON.stringify(s) };
  },

  async 'clock 1 day BEHIND: its edit is not lost to an older remote one'(sim) {
    const { A, B } = await pair(sim, { skew: -86400000 });
    await B.goOffline();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(1500);
    await B.edit('stock-tasks', mark(BASE, 2, ' (B slow clock)'));   // made LATER in real time
    await sleep(600);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(A)', '(B slow clock)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'clock 1 day AHEAD on one device does not freeze others out'(sim) {
    const { A, B } = await pair(sim, { skew: 86400000 });
    await B.edit('stock-tasks', mark(BASE, 0, ' (B fast clock)'));
    await sleep(1500);
    await A.goOffline();
    await A.edit('stock-tasks', mark(mark(BASE, 0, ' (B fast clock)'), 2, ' (A after)'));
    await sleep(600);
    await A.goOnline();
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(B fast clock)', '(A after)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'listener killed by an error: device still receives later edits'(sim) {
    const { A, B } = await pair(sim);
    await B.killListener('permission-denied');
    await sleep(500);
    await A.edit('stock-tasks', mark(BASE, 1, ' (A after B lost its listener)'));
    const ok = await sim.converge([A, B], 30000);
    return { ok: ok && has(await B.text('stock-tasks'), '(A after B lost'), detail: JSON.stringify(await B.text('stock-tasks')) };
  },

  async 'wedged channel on wake (pull never answers), then recovers: device catches up'(sim) {
    const { A, B } = await pair(sim);
    await B.sleep();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(1500);
    B.hang.get = true; B.hang.deliver = true;          // wake into a dead channel
    await B.wake();
    await sleep(2000);
    B.hang.get = false; B.hang.deliver = false;        // channel recovers silently (no events)
    const ok = await sim.converge([A, B], 40000);
    return { ok: ok && has(await B.text('stock-tasks'), '(A)'), detail: JSON.stringify(await B.text('stock-tasks')) };
  },

  async 'wedged push (commit never answers), then recovers: later edits still upload'(sim) {
    const { A, B } = await pair(sim);
    B.hang.commit = true;
    await B.edit('stock-tasks', mark(BASE, 0, ' (B1)'));
    await sleep(2500);
    B.hang.commit = false;
    await B.edit('stock-tasks', mark(mark(BASE, 0, ' (B1)'), 1, ' (B2)'));
    const ok = await sim.converge([A, B], 40000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(B1)', '(B2)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'closing a long-asleep device with fresh edits still gets them to the server'(sim) {
    const { A, B } = await pair(sim);
    await B.eval(() => window.__calcuta.__syncTest.setServerSeenAt(Date.now() - 6 * 3600e3));   // last server contact: 6h ago
    B.hang.commit = true;                                                // its normal push can't finish before the close
    await B.edit('stock-tasks', mark(BASE, 2, ' (B last words)'));
    await sleep(200);
    await B.quit();
    await sleep(1500);
    const s = sim.server.text('stock-tasks');
    const okSrv = has(JSON.stringify(sim.server.doc), 'B last words');
    await sleep(1500);
    const okA = has(await A.text('stock-tasks'), '(B last words)');
    return { ok: okSrv && okA, detail: 'server data: ' + JSON.stringify(s) + ' | A: ' + JSON.stringify(await A.text('stock-tasks')) };
  },

  async 'close-flush never reverts a newer edit it has not seen yet'(sim) {
    const { A, B } = await pair(sim, { listenerLatency: 5000 });   // B hears about others slowly
    const yId = await A.createDoc('Y', 'Y v1');
    const ok0 = await sim.converge([A, B], 20000);
    await A.edit(yId, 'Y v2 (A, newest)');
    await sleep(1200);                                             // server has v2, B has not heard yet
    await B.edit('stock-tasks', mark(BASE, 0, ' (B)'));
    await sleep(100);
    B.hang.commit = true;
    await B.quit();                                                // close-flush while B still holds Y v1
    await sleep(1500);
    const C = await sim.device('C'); await sleep(2500);
    const yC = await C.text(yId), yS = sim.server.text(yId);
    return { ok: ok0 && yS === 'Y v2 (A, newest)' && yC === 'Y v2 (A, newest)' && has(sim.server.text('stock-tasks'), '(B)'),
             detail: 'server Y: ' + JSON.stringify(yS) + ' C Y: ' + JSON.stringify(yC) + ' server tasks: ' + JSON.stringify(sim.server.text('stock-tasks')) };
  },

  async 'two tabs on one device: a stale tab does not erase the other tab\'s offline edit'(sim) {
    const { A, B } = await pair(sim);
    const tab2 = await B.ctx.newPage(); await tab2.goto('file://' + FILE); await tab2.waitForFunction(() => window.__calcuta);
    await sleep(2000);
    await B.goOffline();
    await tab2.evaluate(() => { const K = window.__calcuta; K.setActive('stock-personal'); const el = document.getElementById('input'); el.focus(); el.value = 'личное из вкладки 2'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '2', bubbles: true })); });
    await sleep(800);
    await tab2.close();
    await B.edit('stock-tasks', mark(BASE, 0, ' (tab1)'));
    await sleep(800);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    return { ok: ok && sim.server.text('stock-personal') === 'личное из вкладки 2' && has(sim.server.text('stock-tasks'), '(tab1)'),
             detail: 'server personal: ' + JSON.stringify(sim.server.text('stock-personal')) };
  },

  async 'Ctrl+Z after switching documents never writes one doc\'s text into another'(sim) {
    const { A, B } = await pair(sim);
    await A.type('stock-tasks', '\nправка в задачах');
    await sleep(800);
    await A.eval(() => window.__calcuta.setActive('stock-personal'));
    await A.page.keyboard.press('Control+z');
    await sleep(1500);
    const p = sim.server.text('stock-personal');
    return { ok: !has(p || '', 'строка 1'), detail: 'server personal: ' + JSON.stringify(p) };
  },

  async 'Ctrl+Z after a remote update does not roll the remote edit back'(sim) {
    const { A, B } = await pair(sim);
    await B.type('stock-tasks', ' (B own)');
    await sleep(1500);
    await A.edit('stock-tasks', mark(mark(BASE, 2, ' (B own)'), 0, ' (A remote)'));
    await sleep(2000);
    await B.page.keyboard.press('Control+z');                        // user means: undo MY last typing
    await sleep(2000);
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(A remote)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'deleted elsewhere while asleep: the stale copy does not come back'(sim) {
    const { A, B } = await pair(sim);
    const w = await A.createDoc('W', 'to be deleted');
    await sim.converge([A, B], 20000);
    await B.sleep();
    await A.eval(id => window.__calcuta.deleteDoc(id), w);
    await sleep(1500);
    await B.wake();
    const ok = await sim.converge([A, B], 20000);
    const st = await B.store();
    return { ok: ok && !st.docs.some(d => d.id === w), detail: 'B docs: ' + st.docs.map(d => d.name).join(',') };
  },

  async 'hard save elsewhere does not discard edits made after it'(sim) {
    const { A, B } = await pair(sim);
    await A.eval(() => window.__calcuta.__syncTest.hardSave());
    await sleep(1500);
    await B.goOffline();
    await B.edit('stock-tasks', mark(BASE, 1, ' (B after hard save)'));
    await sleep(600);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    return { ok: ok && has(sim.server.text('stock-tasks'), '(B after hard save)'), detail: 'server: ' + JSON.stringify(sim.server.text('stock-tasks')) };
  },

  async 'old IndexedDB write queue / stale cache cannot replay into the cloud'(sim) {
    const A = await sim.device('A'); await sleep(1500);
    const calls = await A.eval(() => window.__fs.calls);
    return { ok: calls.enablePersistence === 0, detail: JSON.stringify(calls) + ' (persistence enabled = cached snapshots + replay of old queued writes)' };
  },

  // ---------- harder cases ----------
  async 'opening a shared link never writes its text into your own documents'(sim) {
    const { A, B } = await pair(sim);
    const enc = encodeURIComponent('r' + Buffer.from(JSON.stringify({ n: 'Чужой', t: 'ЧУЖОЙ ТЕКСТ', m: 3 })).toString('base64'));
    await B.page.evaluate(h => { location.hash = h; location.reload(); }, '#doc=' + enc);
    await sleep(1500);
    await B.page.waitForFunction(() => window.__calcuta);
    const shown = await B.editorText();
    await B.page.evaluate(() => { const el = document.getElementById('input'); el.focus(); el.blur(); });
    await B.hide(); await sleep(500); await B.show();
    await B.page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    await sleep(500);
    await B.page.goto('file://' + FILE);                                 // back to the normal app: sync runs
    await B.page.waitForFunction(() => window.__calcuta);
    await B.page.evaluate(() => { const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; } });
    await sleep(2500);
    const ok = await sim.converge([A, B], 15000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && shown === 'ЧУЖОЙ ТЕКСТ' && s === BASE && !has(JSON.stringify(sim.server.doc), 'ЧУЖОЙ'),
             detail: 'shown: ' + JSON.stringify(shown) + ' server tasks: ' + JSON.stringify(s) };
  },

  async 'idle devices never ping-pong writes; one edit costs one upload'(sim) {
    const { A, B } = await pair(sim);
    await sleep(3000);
    const w0 = sim.server.writes.length;
    await sleep(12000);
    const idle = sim.server.writes.length - w0;
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(8000);
    const after = sim.server.writes.slice(w0);
    const ok = await sim.converge([A, B], 10000);
    return { ok: ok && idle === 0 && after.length <= 2,
             detail: 'idle writes: ' + idle + ', writes for one edit: ' + JSON.stringify(after) };
  },

  async 'idle across the 60s heartbeat re-read: reads only, zero writes'(sim) {
    const { A, B } = await pair(sim);
    await A.edit('stock-tasks', 'итого = 1000 + 2500\n# Заголовок\nзадача под заголовком');   // text the editor formats
    await sim.converge([A, B], 15000);
    await sleep(2000);
    const w0 = sim.server.writes.length;
    const g0 = await B.eval(() => window.__calcuta.__syncTest.state().serverSeenAt);
    await sleep(72000);
    const g1 = await B.eval(() => window.__calcuta.__syncTest.state().serverSeenAt);
    const writes = sim.server.writes.slice(w0);
    return { ok: writes.length === 0 && g1 > g0, detail: 'writes while idle: ' + JSON.stringify(writes) + ' re-read happened: ' + (g1 > g0) };
  },

  async 'typing on two devices at once (different lines): every keystroke lands in place'(sim) {
    const { A, B } = await pair(sim);
    await Promise.all([
      A.type('stock-tasks', ' alpha beta gamma delta', { line: 0 }, 70),
      B.type('stock-tasks', ' one two three four', { line: 2 }, 70),
    ]);
    const ok = await sim.converge([A, B], 20000);
    const want = 'строка 1 alpha beta gamma delta\nстрока 2\nстрока 3 one two three four';
    const s = sim.server.text('stock-tasks');
    return { ok: ok && s === want, detail: 'server: ' + JSON.stringify(s) };
  },

  async 'a remote edit landing mid-word in the same line keeps the typed text contiguous'(sim) {
    const { A, B } = await pair(sim);
    const typing = B.type('stock-tasks', ' hello world', { line: 1 }, 120);
    await sleep(500);
    await A.edit('stock-tasks', 'строка 1\nA: строка 2\nстрока 3');
    await typing;
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && s === 'строка 1\nA: строка 2 hello world\nстрока 3', detail: 'server: ' + JSON.stringify(s) };
  },

  async 'heavy offline edits on both sides (incl. a deleted line) merge exactly'(sim) {
    const { A, B } = await pair(sim);
    await B.goOffline();
    await B.edit('stock-tasks', 'строка 1\nстрока 3 (B)');                     // deletes line 2, appends to line 3
    await sleep(600);
    await A.edit('stock-tasks', 'строка 1 (A)\nстрока 2\nстрока 3\nновая (A)'); // edits line 1, adds a line
    await sleep(1500);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && s === 'строка 1 (A)\nстрока 3 (B)\nновая (A)', detail: 'server: ' + JSON.stringify(s) };
  },

  async 'deleted on one device while edited later offline on another: the edit is not lost'(sim) {
    const { A, B } = await pair(sim);
    const w = await A.createDoc('W', 'w text');
    await sim.converge([A, B], 20000);
    await B.goOffline();
    await A.eval(id => window.__calcuta.deleteDoc(id), w);
    await sleep(1500);
    await B.edit(w, 'w text + B edit after the delete');
    await sleep(600);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    return { ok: ok && sim.server.text(w) === 'w text + B edit after the delete' && await A.text(w) === 'w text + B edit after the delete',
             detail: 'server W: ' + JSON.stringify(sim.server.text(w)) };
  },

  async 'deleted elsewhere, edited offline on a device whose clock is a day behind: the edit still wins'(sim) {
    const { A, B } = await pair(sim, { skew: -86400000 });
    const w = await A.createDoc('W', 'w text');
    await sim.converge([A, B], 20000);
    await B.goOffline();
    await A.eval(id => window.__calcuta.deleteDoc(id), w);
    await sleep(1500);
    await B.edit(w, 'w text + B edit (slow clock)');
    await sleep(600);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    return { ok: ok && sim.server.text(w) === 'w text + B edit (slow clock)', detail: 'server W: ' + JSON.stringify(sim.server.text(w)) };
  },

  async 'rename on one device + text edit on another: both kept'(sim) {
    const { A, B } = await pair(sim);
    const x = await A.createDoc('X', 'x1\nx2');
    await sim.converge([A, B], 20000);
    await B.goOffline();
    await B.edit(x, 'x1\nx2 (B)');
    await A.eval(id => { const K = window.__calcuta; const d = K.getStore().docs.find(d => d.id === id); d.name = 'X переименован'; d.updated = K.stamp(); K.__syncTest.flushSync(); }, x);
    await sleep(1500);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    const d = sim.server.store().docs.find(d => d.id === x);
    return { ok: ok && d.name === 'X переименован' && d.text === 'x1\nx2 (B)', detail: JSON.stringify(d) };
  },

  async 'hard save elsewhere, then an offline edit made after it: the edit survives'(sim) {
    const { A, B } = await pair(sim);
    await B.goOffline();
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(800);
    await A.eval(() => window.__calcuta.__syncTest.hardSave());
    await sleep(1500);
    await B.edit('stock-tasks', mark(BASE, 2, ' (B after the hard save)'));
    await sleep(600);
    await B.goOnline();
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && has(s, '(A)', '(B after the hard save)'), detail: 'server: ' + JSON.stringify(s) };
  },

  async 'an old snapshot delivered late never rolls a device back'(sim) {
    const { A, B } = await pair(sim);
    await A.edit('stock-tasks', mark(BASE, 0, ' v1'));
    await sim.converge([A, B], 15000);
    const old = sim.server.rec();
    await A.edit('stock-tasks', mark(BASE, 0, ' v2'));
    await sim.converge([A, B], 15000);
    await B.eval(r => window.__fsDeliver(r), old);                    // a stale delivery arrives after the newer one
    await sleep(2500);
    const ok = await sim.converge([A, B], 15000);
    const s = sim.server.text('stock-tasks'), b = await B.text('stock-tasks');
    return { ok: ok && has(s, ' v2') && !has(s, ' v1') && has(b, ' v2'), detail: 'server: ' + JSON.stringify(s) + ' B: ' + JSON.stringify(b) };
  },

  async 'two devices closed with unsynced edits: both close-flushes are merged'(sim) {
    const { A, B } = await pair(sim);
    A.hang.commit = true; B.hang.commit = true;
    await A.edit('stock-tasks', mark(BASE, 0, ' (A last)'));
    await B.edit('stock-tasks', mark(BASE, 2, ' (B last)'));
    await sleep(400);
    await A.quit(); await B.quit();
    await sleep(800);
    const C = await sim.device('C'); await sleep(2500);
    const ok = await sim.converge([C], 15000);
    const s = sim.server.text('stock-tasks');
    const raw = sim.server.doc;
    return { ok: ok && has(s, '(A last)', '(B last)') && !(raw.pending && Object.keys(raw.pending).length),
             detail: 'server: ' + JSON.stringify(s) + ' pending left: ' + JSON.stringify(raw.pending || null) };
  },

  async 'IME composition: a remote edit waits for the composition, then lands'(sim) {
    const { A, B } = await pair(sim);
    await B.eval(() => { const el = document.getElementById('input'); el.focus(); el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new CompositionEvent('compositionstart', { data: '' })); el.value += ' набираю'; });
    await A.edit('stock-tasks', mark(BASE, 0, ' (A)'));
    await sleep(1500);
    const during = await B.editorText();
    await B.eval(() => { const el = document.getElementById('input'); el.dispatchEvent(new CompositionEvent('compositionend', { data: 'набираю' })); });
    const ok = await sim.converge([A, B], 20000);
    const s = sim.server.text('stock-tasks');
    return { ok: ok && !has(during, '(A)') && s === 'строка 1 (A)\nстрока 2\nстрока 3 набираю',
             detail: 'during: ' + JSON.stringify(during) + ' server: ' + JSON.stringify(s) };
  },

  async 'two live tabs editing different docs at once: both reach the server'(sim) {
    const { A, B } = await pair(sim);
    const tab2 = await B.ctx.newPage(); await tab2.goto('file://' + FILE); await tab2.waitForFunction(() => window.__calcuta);
    await sleep(2500);
    await tab2.evaluate(() => { const K = window.__calcuta; K.setActive('stock-personal'); const el = document.getElementById('input'); el.focus();
      el.value = 'вкладка 2'; el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '2', bubbles: true })); });
    await B.edit('stock-tasks', mark(BASE, 1, ' (вкладка 1)'));
    await sleep(3000);
    const ok = await sim.converge([A, B], 20000);
    const t2 = await tab2.evaluate(() => window.__calcuta.syncPayload(window.__calcuta.getStore()));
    const sp = await sim.serverPayload(A);
    await tab2.close();
    return { ok: ok && sim.server.text('stock-personal') === 'вкладка 2' && has(sim.server.text('stock-tasks'), '(вкладка 1)') && t2 === sp,
             detail: 'personal: ' + JSON.stringify(sim.server.text('stock-personal')) + ' tasks: ' + JSON.stringify(sim.server.text('stock-tasks')) + ' tab2 converged: ' + (t2 === sp) };
  },

  async 'fuzz: 3 devices, random sleep/offline/power-off/close + edits — nothing lost, all converge'(sim) {
    const N = 6;
    const A = await sim.device('A'); await sleep(1200);
    await A.edit('stock-tasks', Array.from({ length: N }, (_, i) => 'L' + i).join('\n'));
    await sleep(1500);
    const B = await sim.device('B'); const C = await sim.device('C', { skew: -2 * 3600e3 });
    await sleep(2000);
    if (!await sim.converge([A, B, C], 20000)) throw new Error('setup did not converge');
    const devs = [A, B, C], state = new Map(devs.map(d => [d, 'up']));
    const tokens = []; let newLines = 0;
    let seed = +(process.env.FUZZ_SEED || 2024); const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ri = n => Math.floor(rnd() * n);
    const trace = [], lastEdit = new Map();
    for (let step = 0; step < 70; step++) {
      const d = devs[ri(3)], st = state.get(d), act = ri(10);
      trace.push(step + ':' + d.name + ':' + st + ':' + act);
      if (st === 'off') { if (act < 4) { await d.boot(); state.set(d, 'up'); await sleep(800); } continue; }
      if (act <= 4) {                                     // edit (works asleep/offline too: local first)
        if (st === 'asleep') { await d.wake(); state.set(d, 'up'); }
        const t = 'T' + step + d.name; tokens.push(t);
        const how = ri(4);
        if (how === 0) {                                  // real key presses at the end of a line
          const n = (await d.editorText()).split('\n').length;
          await d.type('stock-tasks', ' ' + t, { line: ri(n) }, 15);
        } else if (how === 1) {                           // a new line of its own
          newLines++;
          await d.eval(([w, k]) => { const K = window.__calcuta; if (K.getStore().activeId !== 'stock-tasks') K.setActive('stock-tasks');
            const el = document.getElementById('input'); el.focus(); const L = el.value.split('\n'); L.splice(k % (L.length + 1), 0, 'N ' + w);
            el.value = L.join('\n'); el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true })); }, [t, ri(N + 2)]);
        } else await d.appendToLine('stock-tasks', ri(N), t);
        lastEdit.set(d, Date.now());
      } else if (act === 5) { if (st === 'up') { await d.goOffline(); state.set(d, 'offline'); } else { await d.goOnline(); if (st === 'asleep') await d.wake(); state.set(d, 'up'); } }
      else if (act === 6) { if (st === 'up') { await d.sleep(); state.set(d, 'asleep'); } }
      else if (act === 7) { if (st !== 'asleep') {
        // a sudden power loss: what was typed in the last ~0.3s (before the
        // debounced local save) is gone with the RAM — that is not sync
        const since = Date.now() - (lastEdit.get(d) || 0); if (since < 400) await sleep(400 - since);
        await d.powerOff(); state.set(d, 'off'); } }
      else if (act === 8) { if (st === 'up') { await d.quit(); state.set(d, 'off'); } }
      else { await sleep(300 + ri(1200)); }
      await sleep(150 + ri(500));
    }
    for (const d of devs) {
      const st = state.get(d);
      if (st === 'off') await d.boot();
      else if (st === 'asleep') await d.wake();
      else if (st === 'offline') await d.goOnline();
    }
    const ok = await sim.converge(devs, 60000);
    const s = sim.server.text('stock-tasks') || '';
    const lost = tokens.filter(t => !s.split(/\s+/).includes(t));
    const lines = s.split('\n').length;
    if (lines !== N + newLines) console.log('merge log:\n' + sim.mergeLog.join('\n'));
    if (!ok || lost.length || lines !== N + newLines) console.log('trace: ' + trace.join(' '));
    return { ok: ok && !lost.length && lines === N + newLines,
             detail: 'seed=' + (process.env.FUZZ_SEED || 2024) + ' converged=' + ok + ' lost=' + JSON.stringify(lost) + ' lines=' + lines + '/' + (N + newLines) + ' server: ' + JSON.stringify(s) };
  },
};

// Rollout: one device still runs the previous build (cached), then updates.
// Needs the previous build's index.html: OLD_BUILD=<path> (skipped without).
if (process.env.OLD_BUILD) scenarios['rollout: a device on the OLD build next to a new one, then it updates — nothing lost'] = async sim => {
  const A = await sim.device('A'); await sleep(1200);
  await A.edit('stock-tasks', BASE); await sleep(1500);
  const B = await sim.device('B', { file: path.resolve(process.env.OLD_BUILD) }); await sleep(2500);
  if (!await sim.converge([A, B], 20000)) throw new Error('setup did not converge');
  await A.edit('stock-tasks', mark(BASE, 0, ' (A new build)'));
  await sleep(2000);
  await B.edit('stock-personal', 'личное со старой сборки');
  await sleep(2500);
  const ok1 = await sim.converge([A, B], 20000);
  await B.goOffline();
  await B.edit('stock-tasks', mark(await B.text('stock-tasks'), 2, ' (B offline, old build)'));
  await sleep(800);
  await B.upgrade();                                       // the device picks up the new build
  await B.goOnline();
  await sleep(2000);
  const ok = await sim.converge([A, B], 25000);
  const t = sim.server.text('stock-tasks'), p = sim.server.text('stock-personal');
  // the OLD build's close-flush fetch() had no .catch: leaving it while offline
  // logs an unhandled "Failed to fetch" from the old page — not this build's
  B.errors = B.errors.filter(e => !/Failed to fetch/.test(e));
  return { ok: ok1 && ok && has(t, '(A new build)', '(B offline, old build)') && p === 'личное со старой сборки',
           detail: 'converged=' + ok1 + '/' + ok + ' tasks: ' + JSON.stringify(t) + ' personal: ' + JSON.stringify(p) };
};

// Second fuzz: many documents — created on different devices, edited and
// renamed everywhere while devices sleep, go offline and get switched off.
scenarios['fuzz: documents created/renamed/edited across 3 devices — every doc and word survives'] = async sim => {
  const A = await sim.device('A'); await sleep(1200);
  const B = await sim.device('B', { skew: 3 * 3600e3 }); const C = await sim.device('C', { skew: -3600e3 });
  await sleep(2000);
  const devs = [A, B, C], state = new Map(devs.map(d => [d, 'up'])), lastEdit = new Map();
  const docs = [];            // {id, words:[], name}
  let seed = +(process.env.FUZZ_SEED || 77); const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const ri = n => Math.floor(rnd() * n);
  const trace = [];
  for (let step = 0; step < 60; step++) {
    const d = devs[ri(3)], st = state.get(d), act = ri(10);
    trace.push(step + ':' + d.name + ':' + st + ':' + act);
    if (st === 'off') { if (act < 5) { await d.boot(); state.set(d, 'up'); await sleep(800); } continue; }
    if (st === 'asleep' && act < 8) { await d.wake(); state.set(d, 'up'); }
    if (act <= 1 || !docs.length) {                     // create a doc (only where it is visible: this device's list)
      const w = 'W' + step + d.name, name = 'Doc' + step + d.name;
      const id = await d.createDoc(name, w);
      docs.push({ id, words: [w], name, by: d });
      lastEdit.set(d, Date.now());
    } else if (act <= 5) {                              // edit a doc this device knows
      const known = (await d.store()).docs.map(x => x.id);
      const cand = docs.filter(x => known.includes(x.id));
      if (cand.length) {
        const doc = cand[ri(cand.length)], w = 'W' + step + d.name;
        doc.words.push(w);
        await d.eval(([id, w]) => { const K = window.__calcuta; K.setActive(id); const el = document.getElementById('input'); el.focus();
          el.value = el.value + (el.value ? ' ' : '') + w; el.setSelectionRange(el.value.length, el.value.length);
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true })); }, [doc.id, w]);
        lastEdit.set(d, Date.now());
      }
    } else if (act === 6) {                             // rename a doc this device knows
      const known = (await d.store()).docs.map(x => x.id);
      const cand = docs.filter(x => known.includes(x.id));
      if (cand.length) {
        const doc = cand[ri(cand.length)]; doc.name = 'R' + step + d.name;
        await d.eval(([id, n]) => { const K = window.__calcuta; const x = K.getStore().docs.find(y => y.id === id); x.name = n; x.updated = K.stamp(); K.__syncTest.flushSync(); }, [doc.id, doc.name]);
        doc.renamedAt = step;
      }
    } else if (act === 7) { if (st === 'up') { await d.goOffline(); state.set(d, 'offline'); } else { await d.goOnline(); state.set(d, 'up'); } }
    else if (act === 8) { if (st === 'up') { await d.sleep(); state.set(d, 'asleep'); } }
    else {
      const since = Date.now() - (lastEdit.get(d) || 0); if (since < 400) await sleep(400 - since);
      if (st !== 'asleep') { await d.powerOff(); state.set(d, 'off'); }
    }
    await sleep(150 + ri(450));
  }
  for (const d of devs) { const st = state.get(d); if (st === 'off') await d.boot(); else if (st === 'asleep') await d.wake(); else if (st === 'offline') await d.goOnline(); }
  const ok = await sim.converge(devs, 60000);
  const srv = sim.server.store() || { docs: [] };
  const problems = [];
  for (const doc of docs) {
    const x = srv.docs.find(y => y.id === doc.id);
    if (!x) { problems.push('missing ' + doc.id); continue; }
    const lost = doc.words.filter(w => !(x.text || '').split(/\s+/).includes(w));
    if (lost.length) problems.push(doc.id + ' lost ' + lost.join(','));
    if ((x.text || '').split(/\s+/).filter(Boolean).length !== doc.words.length) problems.push(doc.id + ' word count ' + JSON.stringify(x.text));
  }
  if (!ok || problems.length) console.log('trace: ' + trace.join(' '));
  return { ok: ok && !problems.length, detail: 'seed=' + (process.env.FUZZ_SEED || 77) + ' converged=' + ok + ' ' + problems.join(' | ') };
};

(async () => {
  let fails = 0, n = 0;
  for (const [name, fn] of Object.entries(scenarios)) {
    if (ONLY && !new RegExp(ONLY).test(name)) continue;
    n++;
    const sim = new Sim(FILE, EXE);
    let r;
    try { r = await fn(sim); }
    catch (e) { r = { ok: false, detail: 'threw: ' + (e && e.message) }; }
    const errs = sim.devices.flatMap(d => d.errors);
    if (errs.length) { r.ok = false; r.detail += ' | page errors: ' + errs.join('; '); }
    console.log((r.ok ? '  ok  ' : '  FAIL') + ' ' + name + (r.ok ? '' : '\n         ' + r.detail));
    if (!r.ok) fails++;
    await sim.close();
  }
  console.log(fails ? `\n${fails} of ${n} FAILED` : `\nALL ${n} DEVICE SCENARIOS PASSED`);
  process.exit(fails ? 1 : 0);
})();
