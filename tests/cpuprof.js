// V8 CPU profile of the typing hot path — exact self-time per function.
//   node cpuprof.js <path-to-index.html> [lines]
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

function makeDoc(lines) {
  const block = [
    '// Раздел {i}', 'доход{i} = 2 500 000', 'налог{i} = доход{i} * 13%',
    'чистыми{i} = доход{i} - налог{i}', 'аренда 120 000 за офис',
    'зарплаты 480 000 всего', 'прочие расходы 55 500', 'sum',
    'дедлайн 15.09 важно', 'заметка про (важное) 100 + 50',
    '[ ] согласовать смету {i}', 'ссылка https://example.com/{i}', '',
  ];
  const out = [];
  for (let i = 0; out.length < lines; i++) for (const l of block) out.push(l.replace(/\{i\}/g, i));
  return out.slice(0, lines).join('\n');
}

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const nLines = +(process.argv[3] || 800);
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
    window.__settled = input.value;
  }, makeDoc(nLines));

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 50 }); // 50µs
  await cdp.send('Profiler.start');

  await page.evaluate(() => {
    const input = document.getElementById('input');
    const settled = window.__settled;
    for (let i = 0; i < 60; i++) {
      const v = settled + '\nитого ' + (1000 + i) + ' + ' + i;
      input.value = v;
      input.selectionStart = input.selectionEnd = v.length;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  const { profile } = await cdp.send('Profiler.stop');
  await browser.close();

  // Aggregate self time per function.
  const byId = new Map();
  for (const node of profile.nodes) byId.set(node.id, node);
  const self = new Map();
  const total = profile.samples.length;
  const dt = profile.timeDeltas;
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const f = node.callFrame;
    const name = (f.functionName || '(anonymous)') +
      (f.url && f.url.startsWith('file') ? ':' + (f.lineNumber + 1) : ' [' + (f.url || 'native') + ']');
    self.set(name, (self.get(name) || 0) + (dt[i] || 0));
  }
  const rows = [...self.entries()].sort((a, b) => b[1] - a[1]);
  const grand = rows.reduce((s, r) => s + r[1], 0);
  console.log('\n=== CPU profile, ' + nLines + ' lines, 60 keystrokes ===');
  console.log('total sampled: ' + (grand / 1000).toFixed(1) + ' ms  (' +
              (grand / 1000 / 60).toFixed(2) + ' ms/keystroke)\n');
  console.log('  self ms   per-key   %     function');
  for (const [name, us] of rows.slice(0, 28)) {
    const ms = us / 1000;
    if (ms < 0.5) break;
    console.log('  ' + ms.toFixed(1).padStart(7) + '  ' +
      (ms / 60).toFixed(2).padStart(7) + '  ' +
      ((us / grand) * 100).toFixed(1).padStart(4) + '%  ' + name);
  }
  console.log();
})().catch(e => { console.error(e); process.exit(1); });
