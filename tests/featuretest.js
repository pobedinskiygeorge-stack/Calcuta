// Feature-interplay test: every editing helper the app has ("/текст" tasks,
// "#" headings, "//" notes, checkboxes, auto-closing pairs, the "()" round
// marker, digit grouping, managed indent, smart Backspace/Delete, paste,
// undo, hotkeys) is driven with REAL key events, alone and in combination,
// and the resulting text / caret / computed results are checked. Its job is
// to catch one feature stepping on another. Prints PASS/FAIL per case.
//   node featuretest.js <path-to-index.html>
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  for (const u of ['**://www.gstatic.com/**', '**://*.googleapis.com/**', '**://www.cbr-xml-daily.ru/**']) await page.route(u, r => r.abort());
  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });
  await page.evaluate(() => {
    const g = document.getElementById('authgate'); if (g) { g.classList.remove('show'); g.style.display = 'none'; }
    window.__calcuta.setFx && window.__calcuta.setFx({ RUB: 1, USD: 90, EUR: 100, CNY: 12.5 }, { date: '2026-01-01', fetchedAt: 0, source: 'test', ok: true });
    document.getElementById('tag-name').value = 'работа'; window.__calcuta.addTag();
  });

  let fails = 0, n = 0;
  const ok = (c, m) => { n++; console.log((c ? '  ok  ' : '  FAIL') + ' ' + m); if (!c) fails++; };
  const ui = page.keyboard;
  // set text (programmatic, then let the 600 ms undo burst close), caret = offset or marker string ("|" in pre)
  const set = async (pre) => {
    const caret = pre.indexOf('|'); const text = pre.replace('|', '');
    await page.evaluate(([t, c]) => { const el = document.getElementById('input'); el.focus(); el.value = t; el.setSelectionRange(t.length, t.length);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (c >= 0) { // map the offset in the raw text to the formatted text by counting non-grouping chars
        const v = el.value; let k = 0, cnt = 0; while (k < v.length && cnt < c) { if (v[k] !== ' ') cnt++; k++; } el.setSelectionRange(k, k); } }, [text, caret]);
    await page.waitForTimeout(650);
  };
  const state = () => page.evaluate(() => { const el = document.getElementById('input'); const v = el.value, c = el.selectionStart;
    const strip = x => x.replace(/ /g, ''); return { v: strip(v), c: strip(v.slice(0, c)).length, raw: v,
      pills: Object.fromEntries([...document.querySelectorAll('#results .result-line')].map(e => [e.dataset.i, (e.querySelector('.pill') || {}).textContent])),
      r: window.__calcuta.analyze(v).lines.map(l => l.result), kinds: window.__calcuta.analyze(v).lines.map(l => l.cls.kind) }; });
  const show = s => JSON.stringify(s.v.slice(0, s.c) + '|' + s.v.slice(s.c));
  const paste = (t) => page.evaluate(t => { const dt = new DataTransfer(); dt.setData('text/plain', t);
    document.getElementById('input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }, t);
  // run: actions are strings: "type:..." "press:..." "paste:..." "wait"
  const run = async (name, pre, actions, want, extra) => {
    await set(pre);
    for (const a of actions) {
      if (a.startsWith('type:')) await ui.type(a.slice(5));
      else if (a.startsWith('press:')) await ui.press(a.slice(6));
      else if (a.startsWith('paste:')) await paste(a.slice(6));
      else if (a === 'wait') await page.waitForTimeout(650);
      else if (a === 'tick') await page.waitForTimeout(50);   // let async selectionchange land
    }
    const s = await state();
    const wantV = want.replace('|', ''), wantC = want.indexOf('|');
    let good = s.v === wantV && (wantC < 0 || s.c === wantC) && !s.raw.includes(' ');
    let note = '';
    if (extra) { const e = extra(s); good = good && e.ok; note = ' ' + e.note; }
    ok(good, `${name}: ${show(s)}${good ? '' : '   want ' + JSON.stringify(want)}${note}`);
  };
  // what the results column actually SHOWS for a line (render() knows the caret; a bare analyze() does not)
  const shown = (line, txt) => s => ({ ok: s.pills[line] === txt, note: `[shown on line ${line}: ${s.pills[line]}]` });
  const res = (line, val) => s => ({ ok: s.r[line] === val, note: `[line ${line} = ${s.r[line]}]` });
  const kind = (line, k) => s => ({ ok: s.kinds[line] === k, note: `[line ${line} kind ${s.kinds[line]}]` });

  console.log('— "/текст" tasks —');
  await run('word + space', '|', ['type:/купить хлеб'], '[ ] купить хлеб|');
  await run('word + Enter', '|', ['type:/позвонить', 'press:Enter'], '[ ] позвонить\n|');
  await run('unfinished word waits', '|', ['type:/купи'], '/купи|');
  await run('"/(текст)" with auto-closed ")"', '|', ['type:/(текст)'], '[ ] (текст)|');
  await run('"/(текст) дальше"', '|', ['type:/(текст) дальше'], '[ ] (текст) дальше|');
  await run('still inside "/(тек|)" waits', '|', ['type:/(тек'], '/(тек|)');
  await run('"/«текст»"', '|', ['type:/«текст»'], '[ ] «текст»|');
  await run('\'/"текст"\'', '|', ['type:/"текст"'], '[ ] "текст"|');
  await run('"/[текст]"', '|', ['type:/[текст]'], '[ ] [текст]|');
  await run('"/" typed before "(текст) ещё"', '|(текст) ещё', ['type:/'], '[ ] |(текст) ещё');
  await run('"/" typed before "купить хлеб"', '|купить хлеб', ['type:/'], '[ ] |купить хлеб');
  await run('"/(курс)" divides by a variable', 'курс = 4\nитого = 1000\n|', ['type:/(курс)', 'press:Enter'], 'курс = 4\nитого = 1000\n/(курс)\n|', res(1, 250));
  await run('"/(курс+1)" divides', 'курс = 4\nитого = 1000\n|', ['type:/(курс+1)', 'press:Enter'], 'курс = 4\nитого = 1000\n/(курс+1)\n|', res(1, 200));
  await run('"/курс" divides', 'курс = 4\nитого = 1000\n|', ['type:/курс', 'press:Enter'], 'курс = 4\nитого = 1000\n/курс\n|', res(1, 250));
  await run('"/(2+3)" divides', 'итого = 1000\n|', ['type:/(2+3)', 'press:Enter'], 'итого = 1000\n/(2+3)\n|', res(0, 200));
  await run('multi-word variable "/(личный бюджет)"', 'личный бюджет = 500\nитого = 1000\n|', ['type:/(личный бюджет)', 'press:Enter'], 'личный бюджет = 500\nитого = 1000\n/(личный бюджет)\n|', res(1, 2));
  await run('"/usd" stays a command', '|', ['type:/usd', 'press:Enter'], '/usd\n|');
  await run('"/работа" tag trigger stays', '|', ['type:/работа '], '/работа |');
  await run('"/12.05" date trigger stays', '|', ['type:/12.05', 'press:Enter'], '/12.05\n|');
  await run('"/a/b" path stays', '|', ['type:/home/user', 'press:Enter'], '/home/user\n|');
  await run('"/ текст" stays', '|', ['type:/ текст'], '/ текст|');
  await run('"//" is a note', '|', ['type://заметка'], '// заметка|', kind(0, 'header'));
  await run('paste "/a\\n/b\\nтекст" converts pasted lines', '|', ['paste:/купить\n/(позвонить)\nтекст'], '[ ] купить\n[ ] (позвонить)\nтекст|');
  await run('paste a single "(" is not paired', '|', ['paste:('], '(|');
  await run('Ctrl+Z after "/купить " conversion', '|', ['type:/купить', 'wait', 'type: ', 'wait', 'press:Control+z'], '/купить|');
  await run('task inside a "#" section is indented', '# Дела\n|', ['type:/купить хлеб'], '# Дела\n   [ ] купить хлеб|');

  console.log('— "#" headings, "//" notes, checkboxes —');
  await run('"#" gets its space', '|', ['type:#Бюджет'], '# Бюджет|', kind(0, 'super'));
  await run('"#" then "(" pairs after the space', '|', ['type:#('], '# (|)');
  await run('Backspace x2 removes "# "', '# |', ['press:Backspace', 'press:Backspace'], '|');
  await run('"/" before a heading does not make a task', '|# A', ['type:/', 'press:Enter'], '/\n|# A');
  await run('note tail keeps the math', '|', ['type:x = 100 // коммент 5+5'], 'x = 100 // коммент 5+5|', res(0, 100));
  await run('"// x = 5" defines nothing', '|', ['type:// x = 5'], '// x = 5|', s => ({ ok: s.r[0] === null, note: '[no result]' }));
  await run('checkbox with a note tail', '|', ['type:/купить // срочно'], '[ ] купить // срочно|', kind(0, 'checkbox'));
  await run('URL is not a note', '|', ['type:https://a.ru/b // заметка'], 'https://a.ru/b // заметка|');
  await run('hand-typed "[ ] x" via auto-pairs', '|', ['type:[ ] купить'], '[ ] купить|', kind(0, 'checkbox'));
  await run('"хх"/"++" do nothing', '|', ['type:дело хх ++'], 'дело хх ++|', kind(0, 'text'));
  await run('checkbox computes its math', '|', ['type:/купить 100+50'], '[ ] купить 100+50|', res(0, 150));
  await run('Backspace at an indented task start merges up', '# A\n   |[ ] x', ['press:Backspace'], '# A|[ ] x');
  await run('Delete at heading end joins without indent', '# A|\n   [ ] x', ['press:Delete'], '# A|[ ] x');

  console.log('— pairs, round marker, math —');
  await run('typing into "1343(|)" does not round meanwhile', '|', ['type:1343('], '1343(|)', shown(0, '1 343'));
  await run('...leaving the empty "()" makes it the marker', '|', ['type:1343(', 'press:ArrowRight', 'tick'], '1343()|', shown(0, '1 350'));
  await run('"1343()" round marker, no padding', '|', ['type:1343()'], '1343()|', res(0, 1350));
  await run('"500/3()"', '|', ['type:500/3()'], '500/3()|', res(0, 170));
  await run('"(2+3)*4" typed naturally', '|', ['type:(2+3)*4'], '(2+3)*4|', res(0, 20));
  await run('nested "2*((1+2)*3)"', '|', ['type:2*((1+2)*3)'], '2*((1+2)*3)|', res(0, 18));
  await run('"(" in front of a word stays single', '|слово', ['type:('], '(|слово');
  await run('Backspace in "(|)"', '|', ['type:(', 'press:Backspace'], '|');
  await run('Enter before the line\'s auto-closer jumps out', '|', ['type:(2+3', 'press:Enter'], '(2+3)\n|', res(0, 5));
  await run('"/(позвонить маме" + Enter keeps ")" on the task line', '|', ['type:/(позвонить маме', 'press:Enter'], '[ ] (позвонить маме)\n|');
  await run('Enter inside quotes jumps out', '|', ['type:x "цитата', 'press:Enter'], 'x "цитата"\n|');
  await run('assignment keeps the split: multi-line "(1000 +" ↵ "500)*2"', '|', ['type:итого = (1000 +', 'press:Enter', 'type:500)*2'], 'итого = (1000 +\n500)*2|', res(0, 3000));
  await run('Enter in the middle of a line still splits', 'ab|cd', ['press:Enter'], 'ab\n|cd');
  await run('apostrophe not paired', '|', ['type:don\'t'], 'don\'t|');
  await run('assignment with brackets', '|', ['type:итого = (1000+500)*2'], 'итого = (1000+500)*2|', res(0, 3000));

  console.log('— selection —');
  await set('итого 100 + 50'); await page.evaluate(() => document.getElementById('input').setSelectionRange(6, 14)); await ui.type('(');
  let sel = await page.evaluate(() => { const el = document.getElementById('input'); return [el.value, el.value.slice(el.selectionStart, el.selectionEnd)]; });
  ok(sel[0] === 'итого (100 + 50)' && sel[1] === '100 + 50', 'one-line selection + "(" wraps it, stays selected: ' + JSON.stringify(sel));
  await set('строка один\nстрока два'); await ui.press('Control+a'); await ui.type('(');
  sel = await state(); ok(sel.v === '(', 'Ctrl+A + "(" replaces everything instead of wrapping: ' + JSON.stringify(sel.v));

  console.log('— separators, deletion, undo —');
  await run('Delete before grouping', '12|345', ['press:Delete'], '12|45');
  await run('Backspace after grouping', '12|345', ['press:Backspace'], '1|345');
  await run('Ctrl+Backspace on a number', 'сумма 12345|', ['press:Control+Backspace'], 'сумма |');
  await run('Ctrl+Backspace right after "[ ] " removes the marker whole', '[ ] |купить', ['press:Control+Backspace'], '|купить');
  await run('Ctrl+Backspace after "# " removes "# "', '# |Бюджет', ['press:Control+Backspace'], '|Бюджет');
  await run('Mac Cmd+Backspace deletes to the line start (keeps the section)', '# A\n   [ ] купить хлеб|', ['press:Meta+Backspace'], '# A\n|');
  await run('Mac Cmd+Delete deletes to the line end', 'купить |хлеб и молоко', ['press:Meta+Delete'], 'купить |');
  await run('Alt+Delete deletes a grouped number as one word', 'сумма |12345 руб', ['press:Alt+Delete'], 'сумма | руб');
  await run('Ctrl+Delete deletes the next word (a line never starts with a stray space)', '|слово дальше', ['press:Control+Delete'], '|дальше');
  await run('Ctrl+Delete mid-line keeps the space', 'x |слово дальше', ['press:Control+Delete'], 'x | дальше');
  await run('Ctrl+Delete at a line end joins (indent dropped)', '# A|\n   x', ['press:Control+Delete'], '# A|x');
  await run('typing digits keeps caret through regrouping', '|', ['type:1234567'], '1234567|');
  await run('Ctrl+Z undoes "(" pair in one step', '|', ['wait', 'type:(', 'wait', 'press:Control+z'], '|');
  await run('Ctrl+Z undoes "#" space', '|', ['wait', 'type:#', 'wait', 'press:Control+z'], '|');
  await run('Ctrl+B does nothing (bold removed)', 'сл|ово', ['press:Control+b', 'type:x'], 'слx|ово');

  await run('Ctrl+Z after a paste undoes only the paste', '|', ['type:набрано', 'wait', 'paste: /купить', 'wait', 'press:Control+z'], 'набрано|');
  await run('...and Ctrl+Shift+Z brings it back', '|', ['type:набрано', 'wait', 'paste:\n/купить', 'wait', 'press:Control+z', 'press:Control+Shift+z'], 'набрано\n[ ] купить|');

  console.log('— Ctrl+F sees through digit grouping —');
  await set('итого 1000 и 25000|'); await ui.press('Control+f'); await ui.type('1000'); await page.waitForTimeout(200);
  let fc = await page.evaluate(() => document.getElementById('find-count').textContent); ok(/^1 \/ 1/.test(fc), '"1000" finds "1 000": ' + fc);
  await page.evaluate(() => { const f = document.getElementById('find-input'); f.value = '25 000'; f.dispatchEvent(new Event('input', { bubbles: true })); });
  fc = await page.evaluate(() => document.getElementById('find-count').textContent); ok(/^1 \/ 1/.test(fc), '"25 000" (plain space) finds "25 000": ' + fc);
  await ui.press('Escape');

  console.log('— checkbox tap is the only way to complete a task —');
  await set('[ ] купить хлеб|');
  await ui.type(' хх'); await ui.type(' xx'); await ui.press('Enter');
  let st = await state(); ok(/^\[ \]/.test(st.v), 'typing "хх"/"xx" never checks: ' + JSON.stringify(st.v));
  await page.locator('.cbox-hit').first().click(); st = await state(); ok(/^\[x\]/.test(st.v), 'tap checks: ' + JSON.stringify(st.v.split('\n')[0]));
  await page.locator('.cbox-hit').first().click(); st = await state(); ok(/^\[ \]/.test(st.v), 'tap again unchecks: ' + JSON.stringify(st.v.split('\n')[0]));

  console.log('— stored-data upgrades —');
  const up = await page.evaluate(() => { const K = window.__calcuta;
    const s = { docs: [ { id: 'v2', text: '[ ] Сухарева **дернуть** по заявке\n****', updated: 1, markup: 2 },
                        { id: 'v1', text: '// Заг\nважно: **x** # c', updated: 1 },
                        { id: 'v3', text: 'литерально **так**', updated: 1, markup: 3 } ] };
    K.normalizeStoreDocs(s); return s.docs.map(d => [d.text, d.markup]); });
  ok(up[0][0] === '[ ] Сухарева дернуть по заявке\n' && up[0][1] === 3, 'v2 doc: Ctrl+B markers stripped once -> ' + JSON.stringify(up[0][0]));
  ok(up[1][0] === '# Заг\nважно: **x** // c', 'v1 doc: swapped, hand-typed "**" kept -> ' + JSON.stringify(up[1][0]));
  ok(up[2][0] === 'литерально **так**', 'v3 doc untouched -> ' + JSON.stringify(up[2][0]));

  ok(!errors.length, 'no page errors ' + (errors.length ? JSON.stringify(errors) : ''));
  await browser.close();
  console.log(fails ? `\n${fails} of ${n} FAILED` : `\nALL ${n} INTERPLAY CHECKS PASSED`);
  process.exit(fails ? 1 : 0);
})();
