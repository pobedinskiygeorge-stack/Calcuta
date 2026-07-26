// Sequence test: drives the editor through an edit sequence that stresses the
// incremental renderer (typing, undo, mid-document insert/delete, whole-document
// swap, big grow/shrink) and dumps the layer HTML after each step.
//
// Run it against the current build AND against a known-good build, then diff:
//   node seqtest.js ../index.html > /tmp/new.json
//   node seqtest.js /path/to/old/index.html > /tmp/old.json
//   diff <(jq -S . /tmp/old.json) <(jq -S . /tmp/new.json)
//
// This is the honest way to check the reconciler: compare against the renderer
// that rebuilt everything from scratch, rather than trying to fake a full
// rebuild inside a single page (which perturbs the result-pill "changed"
// animation state and gives false mismatches).
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  for (const p of ['**://www.gstatic.com/**', '**://*.googleapis.com/**', '**://www.cbr-xml-daily.ru/**']) {
    await page.route(p, r => r.abort());
  }
  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });

  const steps = await page.evaluate(() => {
    const input = document.getElementById('input');
    const fire = () => input.dispatchEvent(new Event('input', { bubbles: true }));
    const IDS = ['highlight', 'gutter', 'results', 'hotspots'];
    const snap = (name) => {
      const o = { step: name, value: input.value };
      for (const id of IDS) o[id] = document.getElementById(id).innerHTML;
      return o;
    };
    const out = [];

    const A = '// Раздел\nдоход = 1000\nналог = доход * 13%\nsum\n[ ] задача';
    const B = '// Другой\nцена = 250\nитого = цена * 4\nдедлайн 15.09';

    input.value = A; fire(); out.push(snap('base'));

    for (const ch of ' 123') {
      input.value += ch;
      input.selectionStart = input.selectionEnd = input.value.length;
      fire();
      out.push(snap('type "' + ch + '"'));
    }

    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
      out.push(snap('undo ' + (i + 1)));
    }
    for (let i = 0; i < 2; i++) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
      out.push(snap('redo ' + (i + 1)));
    }

    let L = input.value.split('\n');
    L.splice(2, 0, 'вставка = 7'); input.value = L.join('\n'); fire();
    out.push(snap('mid insert'));
    L = input.value.split('\n');
    L.splice(2, 1); input.value = L.join('\n'); fire();
    out.push(snap('mid delete'));

    input.value = B; fire(); out.push(snap('whole swap'));

    input.value = Array.from({ length: 60 }, (_, i) => 'строка ' + i + ' = ' + i * 10).join('\n'); fire();
    out.push(snap('grow to 60'));
    input.value = 'одна строка 5'; fire(); out.push(snap('shrink to 1'));

    // checkbox toggle + line colour, which write classes/styles onto reused cells
    input.value = A; fire();
    const hit = document.querySelector('.cbox-hit');
    if (hit) hit.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    out.push(snap('checkbox toggle'));

    return out;
  });

  await browser.close();
  process.stdout.write(JSON.stringify({ steps, errors }, null, 1));
})().catch(e => { console.error(e); process.exit(1); });
