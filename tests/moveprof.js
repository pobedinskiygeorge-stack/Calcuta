// CPU profile of the hover/hit-test path (mousemove), which is independent of
// the typing path. Uses long lines with variables, which is where
// charColInLine()'s per-character getBoundingClientRect() loop bites.
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

function makeDoc(lines) {
  const block = [
    '// Раздел {i}',
    'оченьдлинноеимяпеременной{i} = 2 500 000',
    'втораяпеременная{i} = оченьдлинноеимяпеременной{i} * 13% + 1000 - 250 / 5',
    'третья{i} = оченьдлинноеимяпеременной{i} + втораяпеременная{i} * 2 - 500 + 125',
    'длинная строка текста с числами 120 000 и 480 000 и ещё 55 500 и датой 15.09 и словами',
  ];
  const out = [];
  for (let i = 0; out.length < lines; i++) for (const l of block) out.push(l.replace(/\{i\}/g, i));
  return out.slice(0, lines).join('\n');
}

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => console.error('PAGE ERROR:', String(e)));
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());
  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });

  await page.evaluate((doc) => {
    const input = document.getElementById('input');
    input.value = doc;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, makeDoc(300));

  const MOVES = 400;
  const timing = await page.evaluate((MOVES) => {
    const stack = document.getElementById('stack');
    const box = stack.getBoundingClientRect();
    // sweep horizontally across the variable-dense lines
    const t = performance.now();
    for (let i = 0; i < MOVES; i++) {
      stack.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: box.left + 40 + (i * 7) % 700,
        clientY: box.top + 30 + ((i * 13) % 20) * 24,
      }));
    }
    return (performance.now() - t) / MOVES;
  }, MOVES);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 50 });
  await cdp.send('Profiler.start');
  await page.evaluate((MOVES) => {
    const stack = document.getElementById('stack');
    const box = stack.getBoundingClientRect();
    for (let i = 0; i < MOVES; i++) {
      stack.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true,
        clientX: box.left + 40 + (i * 7) % 700,
        clientY: box.top + 30 + ((i * 13) % 20) * 24,
      }));
    }
  }, MOVES);
  const { profile } = await cdp.send('Profiler.stop');
  await browser.close();

  const byId = new Map(profile.nodes.map(n => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const n = byId.get(profile.samples[i]); if (!n) continue;
    const f = n.callFrame;
    const name = (f.functionName || '(anon)') + (f.url && f.url.startsWith('file') ? ':' + (f.lineNumber + 1) : ' [native]');
    self.set(name, (self.get(name) || 0) + (dt[i] || 0));
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
  const grand = rows.reduce((s, r) => s + r[1], 0);
  console.log('\n=== mousemove profile, 300 lines, ' + MOVES + ' moves ===');
  console.log('wall clock: ' + timing.toFixed(3) + ' ms per mousemove');
  console.log('sampled:    ' + (grand / 1000 / MOVES).toFixed(3) + ' ms per mousemove\n');
  console.log('  per-move   %     function');
  for (const [name, us] of rows.slice(0, 14)) {
    const per = us / 1000 / MOVES;
    if (per < 0.002) break;
    console.log('  ' + per.toFixed(3).padStart(8) + '  ' + ((us / grand) * 100).toFixed(1).padStart(4) + '%  ' + name);
  }
  console.log();
})().catch(e => { console.error(e); process.exit(1); });
