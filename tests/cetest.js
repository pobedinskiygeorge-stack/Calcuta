// The contenteditable editing surface (Chrome's, see chooseEditSurface in
// index.html) must behave exactly like the <textarea> it replaces. Two pages
// run side by side - one forced to the textarea, one to the contenteditable
// twin - and get the same real keystrokes, pastes, cuts, IME compositions,
// clicks and programmatic calls; after every step the value and the selection
// must match (one accepted exception: Ctrl+Arrow word jumps across a line
// break, see below). Lines are kept short, so the hanging indent (on only for the
// twin in Chrome 146+) never changes where a row wraps.
//   node cetest.js <path-to-index.html> [steps-per-seed]
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const FILE = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
const STEPS = +process.argv[3] || 220;
const SEEDS = (process.env.CE_SEEDS || '1,2,3').split(',').map(Number);

const START = ['# Ремонт', 'плитка 1200*8', '[ ] купить клей', '', '# Бюджет', 'итого = 5 000 + 250', 'x = итого / 2'].join('\n');

function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  let fails = 0;
  const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL') + ' ' + m); if (!c) fails++; };

  async function open(mode, phone) {
    const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(m => { try { localStorage.setItem('calcuta.editor', m); } catch (e) {} }, mode);
    const page = await ctx.newPage();
    page.errors = []; page.on('pageerror', e => page.errors.push(String(e)));
    for (const u of ['**://www.gstatic.com/**', '**://*.googleapis.com/**', '**://www.cbr-xml-daily.ru/**']) await page.route(u, r => r.abort());
    await page.goto('file://' + FILE); await page.waitForFunction(() => window.__calcuta);
    await page.evaluate(t => {
      const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; }
      const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true }));
      el.setSelectionRange(0, 0);
    }, START);
    page.cdp = await ctx.newCDPSession(page);
    return page;
  }
  const state = p => p.evaluate(() => { const el = document.getElementById('input'); return { v: el.value, s: el.selectionStart, e: el.selectionEnd, f: document.activeElement === el }; });

  const ta = await open('textarea'), ce = await open('contenteditable');
  ok(await ta.evaluate(() => window.__calcuta.editSurface()) === 'textarea' && await ce.evaluate(() => window.__calcuta.editSurface()) === 'contenteditable',
     'pages run on a textarea and on the contenteditable twin');
  ok(await ce.evaluate(() => document.getElementById('input').isContentEditable), 'the twin is editable');

  // ---- programmatic API, focus and blur ----
  const api = async p => p.evaluate(async () => {
    const el = document.getElementById('input'), out = [];
    el.blur(); el.setSelectionRange(5, 9);
    out.push(document.activeElement === el);                                   // setSelectionRange never focuses
    out.push([el.selectionStart, el.selectionEnd]);
    el.focus(); await new Promise(r => setTimeout(r, 30));
    out.push([el.selectionStart, el.selectionEnd]);                            // focus() brings the selection back
    el.setSelectionRange(9, 3); out.push([el.selectionStart, el.selectionEnd]); // end < start collapses to end
    el.setSelectionRange(2, 99999); out.push([el.selectionStart, el.selectionEnd]);
    el.blur(); el.value = el.value + '\nхвост'; out.push([el.selectionStart, el.selectionEnd]); // new value: caret to the end
    el.value = el.value; out.push([el.selectionStart, el.selectionEnd]);
    el.value = 'a\r\nb'; out.push(JSON.stringify(el.value));
    el.value = ''; out.push(JSON.stringify(el.value), [el.selectionStart, el.selectionEnd]);
    el.value = 'строка\n'; out.push(JSON.stringify(el.value), [el.selectionStart, el.selectionEnd]);
    el.readOnly = true; out.push(el.readOnly); el.readOnly = false;
    return JSON.stringify(out);
  });
  const apiTa = await api(ta), apiCe = await api(ce);
  ok(apiTa === apiCe, 'value / selection API: ' + (apiTa === apiCe ? apiCe : 'textarea ' + apiTa + ' vs twin ' + apiCe));
  for (const p of [ta, ce]) await p.evaluate(t => { const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(0, 0); }, START);

  // ---- clicks land on the same offset ----
  const clickAt = async (p, line, col) => {
    const xy = await p.evaluate(([line, col]) => { const c = window.__calcuta.caretCell(window.__calcuta.getStore() && 0) && null; const row = document.querySelectorAll('#highlight .hl-line')[line];
      const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); let n, k = col; while ((n = tw.nextNode())) { if (k <= n.length) break; k -= n.length; }
      const r = document.createRange(); r.setStart(n, Math.min(k, n.length)); r.setEnd(n, Math.min(k + 1, n.length)); const b = r.getClientRects()[0] || r.getBoundingClientRect();
      return [b.left + 1, b.top + b.height / 2]; }, [line, col]);
    await p.mouse.click(xy[0], xy[1]); await p.waitForTimeout(60);
  };
  for (const [line, col] of [[1, 5], [5, 9], [2, 7], [0, 3]]) {
    await clickAt(ta, line, col); await clickAt(ce, line, col);
    const a = await state(ta), b = await state(ce);
    ok(a.s === b.s && a.e === b.e && b.f, `click on line ${line} col ${col} puts the caret at ${a.s} (twin ${b.s})`);
  }

  // ---- IME composition (what phone keyboards and CJK input send) ----
  for (const p of [ta, ce]) {
    await p.evaluate(() => { const el = document.getElementById('input'); el.focus(); const v = el.value; el.setSelectionRange(v.indexOf('клей') + 4, v.indexOf('клей') + 4); });
    await p.keyboard.type(' ');
    await p.cdp.send('Input.imeSetComposition', { text: 'п', selectionStart: 1, selectionEnd: 1 });
    await p.cdp.send('Input.imeSetComposition', { text: 'при', selectionStart: 3, selectionEnd: 3 });
    await p.cdp.send('Input.imeSetComposition', { text: 'привет', selectionStart: 6, selectionEnd: 6 });
    await p.cdp.send('Input.insertText', { text: 'привет' });
    await p.waitForTimeout(80);
  }
  { const a = await state(ta), b = await state(ce); ok(a.v === b.v && a.s === b.s && a.v.includes('клей привет'), 'IME composition commits the same text and caret' + (a.v === b.v ? '' : ': ' + JSON.stringify([a.v, b.v]))); }

  // ---- clipboard: paste (multi-line), copy, cut ----
  const clip = (p, type, text) => p.evaluate(([type, text]) => {
    const el = document.getElementById('input'), dt = new DataTransfer(); if (text != null) dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent(type, { clipboardData: dt, bubbles: true, cancelable: true }));
    return dt.getData('text/plain');
  }, [type, text]);
  for (const p of [ta, ce]) { await p.evaluate(() => { const el = document.getElementById('input'); el.focus(); const v = el.value; el.setSelectionRange(v.indexOf('итого'), v.indexOf('итого')); }); await clip(p, 'paste', 'вставка 1000\nвторая 2,5\n'); await p.waitForTimeout(50); }
  { const a = await state(ta), b = await state(ce); ok(a.v === b.v && a.s === b.s, 'multi-line paste gives the same text and caret' + (a.v === b.v ? '' : ': ' + JSON.stringify([a.v, b.v]))); }
  const copied = [];
  for (const p of [ta, ce]) { await p.evaluate(() => { const el = document.getElementById('input'); el.focus(); const v = el.value; el.setSelectionRange(v.indexOf('плитка'), v.indexOf('плитка') + 13); }); copied.push(await clip(p, 'copy')); copied.push(await clip(p, 'cut')); }
  { const a = await state(ta), b = await state(ce); ok(copied[0] === copied[2] && copied[1] === copied[3] && a.v === b.v && a.s === b.s, 'copy and cut: same clipboard text, same result (' + JSON.stringify(copied[0]) + ')'); }

  // ---- random keyboard sessions, step by step ----
  const KEYS = ['a', 'б', 'в', '1', '2', '0', ' ', ' ', '+', '*', '=', '(', ')', '"', '#', '/', '[', ']', '-', '.', ','];
  const MOVES = ['Enter', 'Enter', 'Backspace', 'Backspace', 'Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End',
    'Shift+ArrowLeft', 'Shift+ArrowRight', 'Shift+ArrowUp', 'Control+Backspace', 'Control+Delete', 'Control+ArrowLeft', 'Control+ArrowRight', 'Control+End', 'Control+Home'];
  for (const seed of SEEDS) {
    const R = rng(seed), log = []; let wordJumps = 0;
    for (const p of [ta, ce]) await p.evaluate(t => { const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); el.setSelectionRange(t.length, t.length); }, START);
    let bad = null;
    for (let i = 0; i < STEPS && !bad; i++) {
      const st = await state(ta);
      const lineLen = (() => { const ls = st.v.lastIndexOf('\n', st.s - 1) + 1; let le = st.v.indexOf('\n', st.s); if (le < 0) le = st.v.length; return le - ls; })();
      const r = R();
      let step;
      if (lineLen > 50) step = { key: 'Enter' };
      else if (r < 0.45) step = { type: KEYS[Math.floor(R() * KEYS.length)] };
      else if (r < 0.88) step = { key: MOVES[Math.floor(R() * MOVES.length)] };
      else if (r < 0.92) step = { undo: R() < 0.7 };
      else if (r < 0.95) step = { paste: R() < 0.5 ? 'клей 300' : 'строка 12\nещё 4' };
      else if (r < 0.98) step = { all: true };
      else step = { blurFocus: true };
      log.push(JSON.stringify(step));
      for (const p of [ta, ce]) {
        if (step.type) await p.keyboard.type(step.type);
        else if (step.key) await p.keyboard.press(step.key);
        else if (step.undo != null) { await p.waitForTimeout(650); await p.keyboard.press(step.undo ? 'Control+z' : 'Control+y'); }
        else if (step.paste) await clip(p, 'paste', step.paste);
        else if (step.all) { await p.keyboard.press('Control+a'); await p.keyboard.type('z'); }
        else if (step.blurFocus) await p.evaluate(async () => { const el = document.getElementById('input'); el.blur(); await new Promise(r => setTimeout(r, 20)); el.focus(); });
      }
      await ta.waitForTimeout(15);
      const a = await state(ta), b = await state(ce);
      if (process.env.CE_TRACE && i >= +process.env.CE_TRACE) console.log('    #' + i + ' ' + JSON.stringify(step) + '  ta ' + JSON.stringify([a.s, a.e, a.v.length]) + '  ce ' + JSON.stringify([b.s, b.e, b.v.length]) + '  ' + JSON.stringify(a.v.slice(Math.max(0, a.s - 12), a.s) + '|' + a.v.slice(a.s, a.s + 8)));
      // Known and accepted: Ctrl+Arrow word jumps that cross a line break.
      // Chrome's contenteditable steps over the newline (Ctrl+Left at a line
      // start goes to the end of the line above); its textarea stays put
      // there, or stops right at the newline. Same text either way - count it,
      // realign the twin's caret and go on.
      if (a.v === b.v && (a.s !== b.s || a.e !== b.e) && /^Control\+Arrow(Left|Right)$/.test(step.key || '')) {
        wordJumps++;
        await ce.evaluate(([s, e]) => document.getElementById('input').setSelectionRange(s, e), [a.s, a.e]);
        continue;
      }
      if (a.v !== b.v || a.s !== b.s || a.e !== b.e) bad = { step: i, a, b };
    }
    if (bad) { console.log('    last steps: ' + log.slice(-8).join(' ')); console.log('    textarea: ' + JSON.stringify(bad.a)); console.log('    twin:     ' + JSON.stringify(bad.b)); }
    ok(!bad, `seed ${seed}: ${STEPS} random editing steps - textarea and twin agree after every one` + (bad ? ` (diverged at step ${bad.step})` : '') + (wordJumps ? ` (${wordJumps} Ctrl+Arrow jump(s) across a line break landed differently - accepted)` : ''));
    const dom = await ce.evaluate(() => { const el = document.getElementById('input'); return [...el.childNodes].map(n => n.nodeType === 3 ? 'T' : n.nodeName).join(','); });
    ok(dom === 'T', `seed ${seed}: the twin's DOM is folded back into one text node (${dom})`);
  }
  // ---- phone: taps on glyphs (rows wrap differently with the hanging indent,
  // so each page taps the same CHARACTER), and word-by-word composition typing
  // the way soft keyboards (Gboard) send it, with backspaces inside and
  // outside a word ----
  const pta = await open('textarea', true), pce = await open('contenteditable', true);
  const tapChar = async (p, off) => {
    const xy = await p.evaluate(off => { const c = window.__calcuta.caretCell(off); return [c.left + Math.max(2, c.width / 2), c.top + c.height / 2]; }, off);
    await p.touchscreen.tap(xy[0], xy[1]); await p.waitForTimeout(120);
  };
  const LONG = 'очень длинная строка про ремонт кухни и ванной комнаты в этом году';
  for (const p of [pta, pce]) await p.evaluate(t => { const el = document.getElementById('input'); el.focus(); el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); }, '# Ремонт\n' + LONG + '\nитого = 12 000');
  const base = (await state(pta)).v.indexOf('очень');
  for (const k of [3, 20, 41, 58]) {
    await tapChar(pta, base + k); await tapChar(pce, base + k);
    const a = await state(pta), b = await state(pce);
    ok(Math.abs(a.s - (base + k)) <= 1 && a.s === b.s && b.f, `phone: tap on character ${k} of a wrapped line puts the caret at ${a.s} (twin ${b.s})`);
  }
  const compose = async (p, word) => { for (let i = 1; i <= word.length; i++) await p.cdp.send('Input.imeSetComposition', { text: word.slice(0, i), selectionStart: i, selectionEnd: i }); };
  for (const p of [pta, pce]) {
    await p.evaluate(() => { const el = document.getElementById('input'); el.focus(); el.setSelectionRange(el.value.length, el.value.length); });
    await p.cdp.send('Input.insertText', { text: '\n' });
    for (const w of ['купить', 'плитку', '300']) { await compose(p, w); await p.cdp.send('Input.insertText', { text: w }); await p.cdp.send('Input.insertText', { text: ' ' }); }
    await compose(p, 'клеей'); await p.cdp.send('Input.imeSetComposition', { text: 'клей', selectionStart: 4, selectionEnd: 4 }); await p.cdp.send('Input.insertText', { text: 'клей' });
    await p.keyboard.press('Backspace'); await p.keyboard.press('Backspace');
    await p.cdp.send('Input.insertText', { text: 'ей' });
    await p.waitForTimeout(150);
  }
  { const a = await state(pta), b = await state(pce); ok(a.v === b.v && a.s === b.s && /купить плитку 300 клей$/.test(a.v), 'phone: composition typing with backspaces gives the same text and caret' + (a.v === b.v ? '' : ': ' + JSON.stringify([a.v.slice(-40), b.v.slice(-40)]))); }
  ok(!ta.errors.length && !ce.errors.length && !pta.errors.length && !pce.errors.length, 'no page errors ' + ta.errors.concat(ce.errors, pta.errors, pce.errors).join(' | '));
  await browser.close();
  console.log(fails ? `\n${fails} FAILED` : '\nALL CONTENTEDITABLE CHECKS PASSED');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
