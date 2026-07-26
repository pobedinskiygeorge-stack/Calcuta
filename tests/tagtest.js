// Tag painting + tag/date spotlight + currency coverage.
// The main snapshot runs with an empty store.tags, so the memoized
// wordBoundRe()/slashTrigRe() paths and the per-line tag loops are never
// touched there. This exercises them, and pins the FX fetch policy.
//   node tagtest.js <path-to-index.html> > tags.json
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const DOC = [
  '// Проект',
  'срочно закупить плитку 1200 * 8',
  'важно согласовать смету',
  'обычная строка без тэгов 100 + 50',
  'срочно и важно вместе 42',
  'СРОЧНО заглавными буквами',
  'срочность не должна совпадать как тэг',
  'пресрочно тоже не должна',
  '',
  '// Даты',
  'дедлайн 15.09 сдать',
  'другая дата 16.09',
  'ещё раз 15.09 тут',
  '',
  '// Валюта',
  '/usd',
  'курс евро /euro сегодня',
].join('\n');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // Count how many times the app reaches for the FX feed.
  let fxHits = 0;
  await page.route('**://www.cbr-xml-daily.ru/**', r => { fxHits++; r.abort(); });
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());

  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });

  const snap = await page.evaluate((doc) => {
    const K = window.__calcuta;
    const input = document.getElementById('input');
    const fire = () => input.dispatchEvent(new Event('input', { bubbles: true }));
    const out = {};

    K.addTag('срочно', '#ff5555');
    K.addTag('важно', '#55aaff');

    const set = (t) => { input.value = t; fire(); };
    set(doc);
    out.plain = document.getElementById('highlight').innerHTML;

    // Turn the "/срочно" spotlight on, then off again.
    set(doc + '\n/срочно');
    out.spotlightOn = document.getElementById('highlight').innerHTML;
    set(doc);
    out.spotlightOff = document.getElementById('highlight').innerHTML;

    // Date spotlight.
    set(doc + '\n/15.09');
    out.dateSpotlight = document.getElementById('highlight').innerHTML;
    set(doc);

    // Rename a tag: the memo cache is keyed by label, so a rename must simply
    // produce a different key rather than serve a stale regex.
    K.addTag('плитку', '#00ff00');
    set(doc);
    out.afterThirdTag = document.getElementById('highlight').innerHTML;

    // Same paint reached twice must be byte-identical (cache soundness).
    set(doc + ' ');
    set(doc);
    out.repeat = document.getElementById('highlight').innerHTML;
    out.repeatMatchesThird = out.repeat === out.afterThirdTag;

    return out;
  }, DOC);

  // Let any lazily-triggered FX fetch happen.
  await page.waitForTimeout(1500);
  snap.__fxHits = fxHits;
  snap.__pageErrors = errors;

  await browser.close();
  process.stdout.write(JSON.stringify(snap, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
