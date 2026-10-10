// caretlayout.js for WebKit (the Safari engine), where the hanging indent of
// wrapped rows is actually switched on: Chrome's <textarea> ignores
// `text-indent: each-line` after a newline, so there the app keeps it off and
// caretlayout.js covers the plain layout. Drives MiniBrowser through
// WebKitWebDriver (Linux: apt install webkit2gtk-driver xvfb):
//   xvfb-run -a WebKitWebDriver --port=4444 &
//   node webkitlayout.js <path-to-index.html>
// Checks, on a desktop and a phone-width window: the hanging indent is on; the
// invisible textarea text lies under the painted text pixel-for-pixel (so the
// native caret sits between the right glyphs); a wrapped line under a "#"
// continues at its indent column; section rails/dividers match the rows.
const path = require('path');
const os = require('os');

const BASE = 'http://127.0.0.1:' + (process.env.WD_PORT || 4444);
const BROWSER = process.env.WEBKIT_BROWSER || '/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/MiniBrowser';
const FILE = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));

const DOC = [
  '# Бюджет проекта 2026',
  'доход = 5 000 000',
  'налог = доход * 13%',
  '[ ] купить плитку ₽ € × ёЁщЩжЖ ' + 'слово '.repeat(12),
  '[x] замерить стены 12.05',
  '// заметка https://example.com/a?b=1 и !Личное',
  'очень длинная строка '.repeat(12) + 'конец',
  '\tтаб\tвнутри',
  '',
  '# Второй раздел который тоже очень длинный и переносится на другую строку',
  'итог = (1+2)*(3+4) /usd',
  'щваоц'.repeat(30),
].join('\n');

async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (j.value && j.value.error) throw new Error(j.value.error + ': ' + j.value.message);
  return j.value;
}
async function session(w, h) {
  const { sessionId: id } = await call('POST', '/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': { binary: BROWSER, args: ['--automation'] } } } });
  const s = {
    exec: (fn, ...args) => call('POST', `/session/${id}/execute/async`, { script: `const done=arguments[arguments.length-1]; Promise.resolve((${fn})(...Array.from(arguments).slice(0,-1))).then(done,e=>done({__err:String(e&&e.stack||e)}));`, args }),
    shot: () => call('GET', `/session/${id}/screenshot`),
    go: u => call('POST', `/session/${id}/url`, { url: u }),
    close: () => call('DELETE', `/session/${id}`),
  };
  try { await call('POST', `/session/${id}/window/rect`, { width: w, height: h }); } catch (e) {}
  return s;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let fails = 0;
  const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + m); if (!c) fails++; };
  for (const [name, w, h] of [['desktop', 1100, 1000], ['phone', 400, 1000]]) {
    const s = await session(w, h);
    try {
      await s.go('file://' + FILE);
      for (let i = 0; i < 50 && !(await s.exec(() => !!window.__calcuta)); i++) await sleep(200);
      const geo = await s.exec(async t => {
        const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; }
        const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(0, 0); el.blur();
        await document.fonts.ready; await new Promise(r => setTimeout(r, 600));
        const LH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lh'));
        const rows = [...document.querySelectorAll('#highlight .hl-line')];
        // the long line under the first heading: row 2 must start at its indent column
        const k = el.value.split('\n').findIndex(l => l.includes('очень длинная'));
        const tn = document.createTreeWalker(rows[k], NodeFilter.SHOW_TEXT); const nodes = []; while (tn.nextNode()) nodes.push(tn.currentNode);
        const rects = []; for (const n of nodes) for (let i = 0; i < n.length; i++) { if (/\s/.test(n.data[i])) continue; const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1); for (const b of r.getClientRects()) if (b.width > 1) rects.push(b); }   // per-fragment: a char right after a wrap also reports a sliver at the previous row's end
        const firstRowText = rects[0];                                   // first letter after the indent
        const secondRow = rects.find(b => b.top > rects[0].top + LH / 2);   // first letter of the first wrapped row
        // rails / dividers vs the rendered rows
        const st = document.getElementById('stack').getBoundingClientRect();
        const lastText = rows[rows.findIndex(r => r.textContent.includes('внутри'))].getBoundingClientRect();
        const rail = [...document.querySelectorAll('.sec-rail')][0]; const div = document.querySelector('.sec-divider');
        return { hang: window.__calcuta.hang(), textCol: firstRowText && Math.round(firstRowText.left), row2: secondRow && Math.round(secondRow.left),
                 railBottom: rail && Math.round(rail.getBoundingClientRect().bottom), lastTextBottom: Math.round(lastText.bottom),
                 divider: div && Math.round(div.getBoundingClientRect().top), nextHeadingTop: Math.round(rows[rows.findIndex(r => r.textContent.startsWith('# Второй'))].getBoundingClientRect().top) };
      }, DOC);
      if (geo.__err) throw new Error(geo.__err);
      ok(geo.hang, `${name}: hanging indent is on (the textarea indents every line)`);
      ok(geo.row2 === geo.textCol, `${name}: wrapped row continues at the indent column (row 2 at ${geo.row2}px, text at ${geo.textCol}px)`);
      ok(Math.abs(geo.railBottom - geo.lastTextBottom) <= 6, `${name}: section rail ends at its last text row (${geo.railBottom} vs ${geo.lastTextBottom})`);
      ok(geo.divider > geo.lastTextBottom && geo.divider < geo.nextHeadingTop, `${name}: divider sits between the sections (${geo.lastTextBottom} < ${geo.divider} < ${geo.nextHeadingTop})`);
      const common = '#sectionlayer,#caretlayer,.sec-rail,.sec-divider{display:none!important} #highlight *, #highlight{background:none!important;box-shadow:none!important;text-decoration:none!important;font-weight:400!important}';
      await s.exec(c => { const st = document.createElement('style'); st.id = 'cmp'; st.textContent = c + ' #highlight, #highlight *{color:#000!important} #input{color:transparent!important}'; document.head.appendChild(st); return 1; }, common);
      const painted = await s.shot();
      await s.exec(c => { document.getElementById('cmp').textContent = c + ' #highlight, #highlight *{color:transparent!important} #input{color:#000!important;-webkit-text-fill-color:#000!important}'; return 1; }, common);
      const native = await s.shot();
      const d = await s.exec(async (a, b) => {
        const load = src => new Promise(r => { const i = new Image(); i.onload = () => r(i); i.src = 'data:image/png;base64,' + src; });
        const A = await load(a), B = await load(b);
        const cv = document.createElement('canvas'); cv.width = A.width; cv.height = A.height; const x = cv.getContext('2d');
        x.drawImage(A, 0, 0); const da = x.getImageData(0, 0, A.width, A.height).data;
        x.clearRect(0, 0, A.width, A.height); x.drawImage(B, 0, 0); const db = x.getImageData(0, 0, A.width, A.height).data;
        let diff = 0, ink = 0; const bg = da[da.length - 4];
        for (let i = 0; i < da.length; i += 4) { if (da[i] !== db[i] || da[i + 1] !== db[i + 1] || da[i + 2] !== db[i + 2]) diff++; if (da[i] !== bg) ink++; }
        return { diff, ink };
      }, painted, native);
      if (d.__err) throw new Error(d.__err);
      ok(d.ink > 1000, `${name}: the painted text is actually on screen (${d.ink} px)`);
      ok(d.diff === 0, `${name}: the invisible textarea text lies under the painted text pixel-for-pixel (${d.diff} px differ)`);
    } finally { await s.close(); }
  }
  console.log(fails ? `\n${fails} FAILED` : '\nALL WEBKIT LAYOUT CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
