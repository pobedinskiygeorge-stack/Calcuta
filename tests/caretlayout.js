// Native caret alignment. The editor is an invisible <textarea> under a painted
// layer (#highlight); the caret the user sees is the textarea's own, so it is
// only in the right place if the textarea's invisible text lies exactly under
// the painted glyphs. This renders both in one color (painted layer only, then
// textarea text only) and requires the screenshots to be pixel-identical, on a
// desktop and a phone viewport: headings, indents, tabs, digit grouping, pills,
// links, checkboxes, wrapped lines, Cyrillic and ₽ € ×.
//   node caretlayout.js <path-to-index.html>
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const FILE = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));

const DOC = [
  '# Бюджет проекта 2026',
  'доход = 5 000 000',
  'налог = доход * 13%',
  'чистыми = доход - налог',
  '[ ] купить плитку ₽ € × ёЁщЩжЖ',
  '[x] замерить стены 12.05',
  '// заметка https://example.com/a?b=1 и !Личное',
  'очень длинная строка '.repeat(12) + 'конец',
  '\tтаб\tвнутри',
  '',
  '# Второй раздел',
  'итог = (1+2)*(3+4) /usd',
].join('\n');

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  let fails = 0;
  const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + m); if (!c) fails++; };
  for (const [name, viewport, mobile] of [['desktop', { width: 1100, height: 900 }, false], ['phone', { width: 390, height: 900 }, true]]) {
    const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    for (const u of ['**://www.gstatic.com/**', '**://*.googleapis.com/**', '**://www.cbr-xml-daily.ru/**']) await page.route(u, r => r.abort());
    await page.goto('file://' + FILE); await page.waitForFunction(() => window.__calcuta);
    await page.evaluate(async t => {
      const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; }
      const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(0, 0); el.blur();
      await document.fonts.ready; await new Promise(r => setTimeout(r, 400));
      const st = document.createElement('style'); st.id = 'cmp'; document.head.appendChild(st);
    }, DOC);
    const clip = await page.evaluate(() => { const r = document.getElementById('stack').getBoundingClientRect(); return { x: r.left, y: r.top, width: Math.min(r.width, 1100), height: Math.min(r.height, 880 - r.top) }; });
    // weight 400 everywhere: bold "#" headings keep the same advance, only the strokes differ
    const common = '#sectionlayer,#caretlayer,.sec-rail,.sec-divider{display:none!important} #highlight *, #highlight{background:none!important;box-shadow:none!important;text-decoration:none!important;font-weight:400!important}';
    await page.evaluate(c => { document.getElementById('cmp').textContent = c + ' #highlight, #highlight *{color:#000!important} #input{color:transparent!important}'; }, common);
    const painted = await page.screenshot({ clip });
    await page.evaluate(c => { document.getElementById('cmp').textContent = c + ' #highlight, #highlight *{color:transparent!important} #input{color:#000!important;-webkit-text-fill-color:#000!important}'; }, common);
    const native = await page.screenshot({ clip });
    const d = await page.evaluate(async ([a, b]) => {
      const load = s => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + s; });
      const A = await load(a), B = await load(b);
      const cv = document.createElement('canvas'); cv.width = A.width; cv.height = A.height; const x = cv.getContext('2d');
      x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, A.width, A.height).data;
      x.clearRect(0, 0, A.width, A.height); x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, A.width, A.height).data;
      let diff = 0, inkA = 0; const bg = da[0];
      for (let i = 0; i < da.length; i += 4) { if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) diff++; if (da[i] !== bg) inkA++; }
      return { diff, inkA };
    }, [painted.toString('base64'), native.toString('base64')]);
    ok(d.inkA > 1000, `${name}: the painted text is actually on screen (${d.inkA} px)`);
    ok(d.diff === 0, `${name}: the invisible textarea text lies under the painted text pixel-for-pixel (${d.diff} px differ)`);
    const caret = await page.evaluate(() => getComputedStyle(document.getElementById('input')).caretColor);
    ok(caret !== 'rgba(0, 0, 0, 0)' && caret !== 'transparent', `${name}: native caret is visible (${caret})`);
    ok(!errors.length, `${name}: no page errors ${errors.join(' | ')}`);
    await ctx.close();
  }
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL CARET LAYOUT CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
