// Does the app hit the ЦБ РФ feed when nothing on screen needs a rate?
const { chromium } = require('playwright-core');
const path = require('path'); const os = require('os');
const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
(async () => {
  const file = path.resolve(process.argv[2]), label = process.argv[3] || '';
  for (const [name, doc] of [['no currency in doc','заметка 100 + 50\nитого 42'],
                             ['/usd in doc','курс /usd сегодня']]) {
    const browser = await chromium.launch({ executablePath: EXE });
    const page = await browser.newPage();
    let hits = 0;
    await page.route('**://www.cbr-xml-daily.ru/**', r => { hits++; r.abort(); });
    await page.route('**://www.gstatic.com/**', r => r.abort());
    await page.route('**://*.googleapis.com/**', r => r.abort());
    await page.goto('file://' + file);
    await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });
    await page.evaluate(d => { const i = document.getElementById('input'); i.value = d;
      i.dispatchEvent(new Event('input', { bubbles: true })); }, doc);
    await page.waitForTimeout(1500);
    console.log('  ' + label.padEnd(10) + name.padEnd(22) + 'ЦБ РФ requests: ' + hits);
    await browser.close();
  }
})().catch(e => { console.error(e); process.exit(1); });
