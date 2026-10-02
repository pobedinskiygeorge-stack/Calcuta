// App-update path: a device left running an OLD build (a PWA kept in memory
// for weeks, a launch served from cache) must end up on the new build by
// itself — an old build means old sync logic. Serves the app over http (a
// service worker needs a real origin), deploys "v2", and checks that the
// open page picks it up and reloads onto it at an unobtrusive moment (when
// hidden), not while the user is looking at it.
//   node updatetest.js <dir-with-index.html-and-sw.js>
const { chromium } = require('playwright-core');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const dir = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta'));
  const state = { build: 'v1' };
  const body = rel => {
    let t = fs.readFileSync(path.join(dir, rel), 'utf8');
    if (rel === '/sw.js') t = t.replace('__BUILD__', state.build);
    if (rel === '/index.html') t = t.replace('<head>', '<head><script>window.__build="' + state.build + '"</script>');
    return t;
  };
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const rel = url === '/' ? '/index.html' : url;
    if (!['/index.html', '/sw.js'].includes(rel)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': rel.endsWith('.js') ? 'text/javascript' : 'text/html', 'Cache-Control': 'max-age=600' });
    res.end(body(rel));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());
  let fails = 0;
  const check = (ok, name, detail) => { if (!ok) fails++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (!ok && detail ? '\n       ' + detail : '')); };

  await page.goto(origin + '/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await sleep(800);
  await page.reload();                                       // now controlled by the v1 worker
  await page.waitForFunction(() => window.__calcuta && navigator.serviceWorker.controller);
  check(await page.evaluate(() => window.__build) === 'v1', 'running v1, controlled by its service worker');

  state.build = 'v2';                                        // deploy
  await page.evaluate(() => window.__calcuta.__syncTest.checkAppUpdate(true));   // what wake / the hourly check does
  await page.waitForFunction(() => window.__calcuta.__syncTest.appUpdateReady(), null, { timeout: 15000 }).catch(() => {});
  check(await page.evaluate(() => window.__calcuta.__syncTest.appUpdateReady()), 'the new worker took over: an update is pending');
  await sleep(1500);
  check(await page.evaluate(() => window.__build) === 'v1', 'no reload while the user is looking at the page');

  const nav = page.waitForNavigation({ timeout: 15000 }).catch(() => null);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await nav;
  await page.waitForFunction(() => window.__calcuta, null, { timeout: 15000 }).catch(() => {});
  check(await page.evaluate(() => window.__build).catch(() => null) === 'v2', 'hidden → reloaded straight onto v2 (despite max-age=600 on the page)');
  await sleep(2500);
  check(await page.evaluate(() => window.__build).catch(() => null) === 'v2', 'no reload loop afterwards');
  // a plain launch right after the next deploy (not a reload: the browser's
  // HTTP cache would happily serve the page from 10 minutes ago)
  state.build = 'v3';
  // (no page.route here: request interception turns the HTTP cache off)
  const p2 = await ctx.newPage();
  await p2.goto(origin + '/');
  await p2.waitForFunction(() => window.__calcuta, null, { timeout: 15000 }).catch(() => {});
  check(await p2.evaluate(() => window.__build).catch(() => null) === 'v3', 'a fresh launch after a deploy gets the new page at once');
  if (errors.length) { fails++; console.log('  page errors: ' + errors.join(' | ')); }

  await browser.close(); server.close();
  console.log(fails ? `\n${fails} UPDATE CHECKS FAILED` : '\nALL UPDATE CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})();
