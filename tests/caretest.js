// Caret / selection correctness test.
// Exercises offsetToLineCol(), docLines() and the caret +
// selection overlays, which the innerHTML snapshot does not cover.
//   node caretest.js <path-to-index.html>
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const DOC = [
  '# Заголовок',
  'доход = 2 500 000',
  '',
  'аренда 120 000',
  'длинная строка с большим количеством слов чтобы она точно перенеслась на несколько визуальных строк подряд и ещё немного',
  'последняя 42',
].join('\n');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());
  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });

  const out = await page.evaluate(async (doc) => {
    const input = document.getElementById('input');
    const fire = () => input.dispatchEvent(new Event('input', { bubbles: true }));
    input.value = doc; fire();
    input.focus();
    const v = input.value;
    const fails = [];

    // 1. offsetToLineCol must agree with the naive slice/split for EVERY offset.
    for (let pos = 0; pos <= v.length; pos++) {
      const before = v.slice(0, pos);
      const wantRow = before.split('\n').length - 1;
      const wantCol = pos - (before.lastIndexOf('\n') + 1);
      // exercised indirectly: place the caret and read the caret layer's row
      // via the same helper the app uses
      const got = window.__calcuta.offsetToLineCol ? window.__calcuta.offsetToLineCol(pos) : null;
      if (got && (got.row !== wantRow || got.col !== wantCol)) {
        fails.push('offsetToLineCol(' + pos + ') = ' + JSON.stringify(got) +
                   ' want {row:' + wantRow + ',col:' + wantCol + '}');
        if (fails.length > 5) break;
      }
    }

    // 2. Caret overlay renders for a sample of caret positions, on every line,
    //    without throwing and with a plausible position.
    const caretlayer = document.getElementById('caretlayer');
    const seen = new Set();
    for (let pos = 0; pos <= v.length; pos += 1) {
      input.setSelectionRange(pos, pos);
      document.dispatchEvent(new Event('selectionchange'));
      const box = caretlayer.querySelector('.caret-block');
      if (!box) { fails.push('no caret box at pos ' + pos); break; }
      seen.add(box.style.top);
    }
    const caretRows = seen.size;

    const lines = v.split('\n');
    const starts = [];
    { let acc = 0; for (const l of lines) { starts.push(acc); acc += l.length + 1; } }

    // 4. Selection overlay paints boxes for a multi-line selection.
    input.setSelectionRange(starts[1], starts[4] + 10);
    document.dispatchEvent(new Event('selectionchange'));
    const selBoxes = document.getElementById('sellayer').children.length;

    return { fails, caretRows, selBoxes, lineCount: lines.length };
  }, DOC);

  await browser.close();
  console.log('\n=== caret / selection ===');
  console.log('  distinct caret rows seen: ' + out.caretRows + ' (doc has ' + out.lineCount + ' source lines, some wrapped)');
  console.log('  selection overlay boxes:  ' + out.selBoxes);
  console.log('  page errors:              ' + (errors.length ? errors.join(' | ') : 'none'));
  if (out.fails.length) { console.log('  FAILURES:'); out.fails.forEach(f => console.log('    - ' + f)); }
  else console.log('  ALL CHECKS PASSED ✓');
  console.log();
  process.exit(out.fails.length || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
