// Stage 0 regression harness for Calcuta.
// Loads the real index.html in headless chromium, drives the app through the
// documented `window.__calcuta` seam plus the live DOM layers, and dumps a
// golden snapshot to stdout as JSON.
//
//   node harness.js <path-to-index.html> > snapshot.json
//
// Every optimization stage must produce a byte-identical snapshot (stages that
// are allowed to differ are called out in the plan).

const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

// The corpus exercises every cross-line behaviour the engine has: section
// scoping, multi-line assignment folding, aggregation contiguity, round
// markers, dates, spotlights, currency, links, doclinks, labels, brackets,
// checkboxes, thousands grouping and k/M suffixes.
const CORPUS = [
  '// Бюджет проекта',
  'доход = 2 500 000',
  'налог = доход * 13%',
  'чистыми = доход - налог',
  'резерв () = чистыми / 3',
  '',
  'аренда 120 000',
  'зарплаты 480 000',
  'прочее 55 500',
  'sum',
  'avg',
  'prev',
  '',
  '// Многострочное',
  'итого =',
  '  доход',
  '  + 100k',
  '  - 50 000',
  '',
  '# это комментарий, он прозрачен для sum',
  '10 + 10',
  '# ещё комментарий',
  '20 + 20',
  'сумм',
  '',
  '// Даты и теги',
  'дедлайн 15.09',
  'спринт 21.08 - 25.08',
  'релиз 25.12 - 05.01',
  '/15.09',
  '',
  '// Валюта',
  '/usd',
  '/euro',
  '/yuan',
  '1000 /budget',
  '1000/usd',
  '',
  '// Скобки и приоритеты',
  '(2 + 3) * (4 - 1)',
  '((10 + 5) * 2) / 3',
  'заметка (важно) 100 + 50',
  '2+2',
  '100 + 25%',
  '25% of 100',
  '1343 ()',
  '500 / 3 ()',
  '',
  '// Числа',
  '3.14',
  '1234.56',
  '12,5',
  '2500000',
  '1.5k',
  '2M',
  '12.05',
  '12.5',
  '',
  '// Списки',
  '[ ] согласовать смету',
  '[x] отправить отчёт 15.09',
  '',
  '// Ссылки и метки',
  'https://example.com/path?a=1&b=2',
  'www.example.org',
  'Название: 500 + 500',
  '"цитата" 42',
  '',
  '// Второй раздел, то же имя переменной',
  'доход = 999',
  'проверка = доход * 2',
].join('\n');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // Block the network so Firebase / the FX feed can never make a run
  // non-deterministic. The app is designed to work fully offline.
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());

  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });

  // Pin the FX rates so the currency lines render deterministically regardless
  // of whether the feed was reachable.
  await page.evaluate(() => {
    if (window.__calcuta.setFx) {
      window.__calcuta.setFx({ RUB: 1, USD: 90, EUR: 100, CNY: 12.5 },
                             { date: '2026-01-01', fetchedAt: 0, source: 'test', ok: true });
    }
  });

  const snap = await page.evaluate((corpus) => {
    const K = window.__calcuta;
    const out = {};

    // ---- engine level: pure functions, no DOM ----
    const A = K.analyze(corpus);
    out.analyze = A.lines.map(l => [
      l.result, l.error, l.assignedName, l.calcRange,
      l.dateCount, l.section, l.contLine || false, l.currency || null,
    ]);
    out.formatAll = K.formatAll ? K.formatAll(corpus, -1) : null;
    out.regroup = K.regroupText ? K.regroupText(corpus) : null;

    // fmt / plain / parseNum round-trips
    const nums = [0, 1, -1, 0.5, 12.5, 1234.56, 2500000, 1e9, 0.001, 1 / 3, -1234.56];
    out.fmt = nums.map(n => K.fmt(n));

    // ---- DOM level: drive the real editor ----
    const input = document.getElementById('input');
    const setText = (t) => {
      input.value = t;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setText(corpus);

    out.highlight = document.getElementById('highlight').innerHTML;
    out.gutter = document.getElementById('gutter').innerHTML;
    out.results = document.getElementById('results').innerHTML;
    out.hotspots = document.getElementById('hotspots').innerHTML;
    // The value after the live formatter has run over it (mask + op spacing).
    out.maskedValue = input.value;

    // ---- editing operations that stress cross-line state ----
    const ops = {};
    const capture = (name) => {
      ops[name] = {
        value: input.value,
        hl: document.getElementById('highlight').innerHTML,
        gut: document.getElementById('gutter').innerHTML,
        res: document.getElementById('results').innerHTML,
      };
    };

    // 1. type a character inside an early line -> must change results far below
    setText(corpus.replace('доход = 2 500 000', 'доход = 2 500 001'));
    capture('editEarlyLine');

    // 2. insert a line in the middle
    const lines = corpus.split('\n');
    lines.splice(5, 0, 'вставка = 42');
    setText(lines.join('\n'));
    capture('insertMidDoc');

    // 3. delete a line
    const lines2 = corpus.split('\n');
    lines2.splice(2, 1);
    setText(lines2.join('\n'));
    capture('deleteLine');

    // 4. spotlight toggled off (removes the /15.09 trigger line)
    setText(corpus.replace('/15.09', ''));
    capture('spotlightOff');

    // 5. back to the original
    setText(corpus);
    capture('restored');

    out.ops = ops;
    return out;
  }, CORPUS);

  snap.__pageErrors = errors;
  await browser.close();
  process.stdout.write(JSON.stringify(snap, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
