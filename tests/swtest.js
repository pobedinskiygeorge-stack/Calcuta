// Service-worker behaviour test. Needs a real http origin (SW won't register
// on file://), so it serves the app from a throwaway local server.
//   node swtest.js <dir> [label]
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png',
                '.webmanifest': 'application/manifest+json' };

function serve(dir, state) {
  return http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const rel = url === '/' ? '/index.html' : url;
    const file = path.join(dir, rel);
    const send = () => {
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('nope'); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
                           'Cache-Control': 'no-cache' });
      res.end(fs.readFileSync(file));
    };
    if (state.hang && (rel === '/index.html')) return;      // never respond: simulate lie-fi
    if (state.stallMs) return setTimeout(send, state.stallMs);
    send();
  });
}

(async () => {
  const dir = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta'));
  const label = process.argv[3] || 'app';
  const state = { hang: false, stallMs: 0 };
  const server = serve(dir, state);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());

  console.log('\n=== service worker: ' + label + ' ===');

  // 1. register + precache
  await page.goto(origin + '/');
  const reg = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.ready.catch(() => null);
    return r ? { scope: r.scope, active: !!r.active } : null;
  }).catch(() => null);
  console.log('  registered:            ' + (reg && reg.active ? 'yes' : 'NO'));

  await page.waitForTimeout(1200);
  const caches1 = await page.evaluate(async () => {
    const keys = await caches.keys();
    const out = {};
    for (const k of keys) out[k] = (await (await caches.open(k)).keys()).map(r => new URL(r.url).pathname);
    return out;
  });
  const cacheName = Object.keys(caches1)[0];
  console.log('  cache key:             ' + cacheName);
  console.log('  precached entries:     ' + (caches1[cacheName] || []).length);

  // 2. lie-fi: server accepts the connection but never answers. The old SW
  //    only fell back to cache when fetch() REJECTED, so this hung.
  state.hang = true;
  const t0 = Date.now();
  let ok = false;
  try {
    await page.goto(origin + '/', { timeout: 12000 });
    ok = await page.evaluate(() => !!document.getElementById('input'));
  } catch (e) { ok = false; }
  const lieFiMs = Date.now() - t0;
  console.log('  lie-fi launch:         ' + (ok ? 'served from cache in ' + lieFiMs + ' ms' : 'FAILED after ' + lieFiMs + ' ms'));
  state.hang = false;

  // 3. fully offline
  await ctx.setOffline(true);
  let offlineOk = false;
  try {
    await page.goto(origin + '/', { timeout: 12000 });
    offlineOk = await page.evaluate(() => !!document.getElementById('input'));
  } catch (e) {}
  console.log('  offline launch:        ' + (offlineOk ? 'ok' : 'FAILED'));
  await ctx.setOffline(false);

  if (errors.length) console.log('  page errors:           ' + errors.join(' | '));
  console.log();

  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });
