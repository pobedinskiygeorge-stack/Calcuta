// Startup / time-to-editable test.
//   node startup.js <path-to-index.html> [label]
//
// Covers the four states that matter, with gstatic deliberately throttled to
// 3 seconds so the difference between "waits for Firebase" and "doesn't" is
// unmissable:
//   1. returning signed-in user with notes   -> editor must be live at once
//   2. returning signed-in user, offline     -> same
//   3. fresh profile, nothing stored         -> gate must appear, once
//   4. shared-link (#doc=) path              -> never touches Firebase
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

const NOTES = '// Мои заметки\nдоход = 2 500 000\nналог = доход * 13%\n[ ] проверить смету';

function seedStore(notes) {
  return {
    docs: [
      { id: 'stock-tasks', name: 'Задачи', text: notes, lineColors: {}, updated: 111, protected: true },
      { id: 'stock-personal', name: 'Личное', text: '', lineColors: {}, updated: 111, protected: true },
    ],
    activeId: 'stock-tasks', tags: [], resultsWidth: 150,
  };
}

async function scenario(file, name, { signedIn, notes, offline, hash }) {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // Make the Firebase CDN pathologically slow, so any dependency on it shows up.
  let gstaticHits = 0;
  await page.route('**://www.gstatic.com/**', async r => {
    gstaticHits++;
    if (offline) return r.abort();
    await new Promise(res => setTimeout(res, 3000));
    r.abort();
  });
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());

  // Seed localStorage before the app's own scripts run.
  await page.addInitScript(({ signedIn, store }) => {
    try {
      if (store) localStorage.setItem('calcuta.v2', JSON.stringify(store));
      if (signedIn) localStorage.setItem('calcuta.signedIn', '1');
    } catch (e) {}
  }, { signedIn, store: notes === null ? null : seedStore(notes) });

  const t0 = Date.now();
  await page.goto('file://' + file + (hash || ''), { waitUntil: 'commit' });

  // "Editable" = the textarea exists, holds the stored text, and no opaque
  // gate is covering it.
  let editableMs = null;
  try {
    await page.waitForFunction(() => {
      const ta = document.getElementById('input');
      const gate = document.getElementById('authgate');
      if (!ta) return false;
      const covered = gate && getComputedStyle(gate).display !== 'none';
      return !covered && ta.value.length > 0;
    }, { timeout: 8000 });
    editableMs = Date.now() - t0;
  } catch (e) { /* stayed gated */ }

  const state = await page.evaluate(() => {
    const gate = document.getElementById('authgate');
    return {
      gateVisible: gate ? getComputedStyle(gate).display !== 'none' : null,
      textLen: (document.getElementById('input') || {}).value?.length ?? 0,
      firebaseLoaded: typeof window.firebase !== 'undefined',
    };
  });

  await browser.close();
  return { name, editableMs, gstaticHits, errors, ...state };
}

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const label = process.argv[3] || 'app';

  const cases = [
    ['returning user, slow network', { signedIn: true, notes: NOTES }],
    ['returning user, offline',      { signedIn: true, notes: NOTES, offline: true }],
    ['fresh profile (no data)',      { signedIn: false, notes: null }],
    ['shared link #doc=',            { signedIn: false, notes: null, hash: '#doc=xxx' }],
  ];

  console.log('\n=== startup: ' + label + ' (gstatic throttled to 3000ms) ===');
  for (const [name, opts] of cases) {
    const r = await scenario(file, name, opts);
    const t = r.editableMs === null ? 'NEVER (still gated)' : r.editableMs + ' ms';
    console.log(
      '  ' + name.padEnd(30) +
      'editable: ' + t.padEnd(22) +
      'gate:' + String(r.gateVisible).padEnd(7) +
      'chars:' + String(r.textLen).padEnd(6) +
      (r.errors.length ? '  ERRORS: ' + r.errors.join(' | ') : '')
    );
  }
  console.log();
})().catch(e => { console.error(e); process.exit(1); });
