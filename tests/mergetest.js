// Three-way merge engine: fixed cases + randomized property checks, run
// against the real functions inside index.html (window.__calcuta.__syncTest).
//   node mergetest.js <path-to-index.html>
// Properties checked on thousands of random edit pairs:
//   - merge3(b, x, x) = x, merge3(b, b, x) = x, merge3(b, x, b) = x;
//   - edits to lines far apart from each other merge to exactly "both applied";
//   - for arbitrary concurrent edits (insertions, rewrites, deletions of lines)
//     every unique word either side ADDED survives the merge — nothing typed
//     is ever lost, whatever the overlap;
//   - mapOffset keeps a position on an untouched line on the same character.
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell');
const FILE = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));

const CASES = [
  // [name, base, local, remote, localNewer, expected]
  ['different lines', 'a\nb\nc', 'a1\nb\nc', 'a\nb\nc1', true, 'a1\nb\nc1'],
  ['adjacent lines', 'a\nb', 'a1\nb', 'a\nb2', false, 'a1\nb2'],
  ['same line, different spots', 'Купить молоко сегодня', 'Срочно купить молоко сегодня', 'Купить молоко сегодня!', true, 'Срочно купить молоко сегодня!'],
  ['same spot, both appended (older first)', 'молоко', 'молоко, хлеб', 'молоко и яйца', false, 'молоко, хлеб и яйца'],
  ['same spot, newer local', 'молоко', 'молоко, хлеб', 'молоко и яйца', true, 'молоко и яйца, хлеб'],
  ['inline append vs new line after', 'молоко', 'молоко\nхлеб', 'молоко и яйца', true, 'молоко и яйца\nхлеб'],
  ['new line above vs text at line start', 'молоко', 'сыр\nмолоко', '- молоко', false, 'сыр\n- молоко'],
  ['real conflict keeps both lines', 'x = 1', 'x = 2', 'x = 3', false, 'x = 2\nx = 3'],
  ['real conflict, local newer', 'x = 1', 'x = 2', 'x = 3', true, 'x = 3\nx = 2'],
  ['delete line vs edit elsewhere', 'a\nb\nc', 'a\nc', 'a\nb\nc!', true, 'a\nc!'],
  ['delete line vs edit of that line keeps the edit', 'a\nb\nc', 'a\nc', 'a\nb!\nc', true, 'a\nb!\nc'],
  ['delete line vs edit of that line (remote deletes)', 'a\nb\nc', 'a\nb!\nc', 'a\nc', false, 'a\nb!\nc'],
  ['both append different lines', 'a', 'a\nx', 'a\ny', false, 'a\nx\ny'],
  ['identical change', 'a', 'ab', 'ab', true, 'ab'],
  ['one side typed on past the other', 'a', 'ab', 'abc', true, 'abc'],
  ['one side typed on past the other (reverse)', 'a', 'abc', 'ab', false, 'abc'],
  ['emoji safe', 'a', 'a😀', 'b\na', true, 'b\na😀'],
  ['empty base, both typed', '', 'hello', 'world', false, 'helloworld'],
  ['local cleared doc vs remote edit keeps the edit', 'a\nb', '', 'a\nb\nc', true, 'c'],
  ['deleted line next to edits on both sides (slider)', 'строка 1\nстрока 2\nстрока 3', 'строка 1\nстрока 3 (B)', 'строка 1 (A)\nстрока 2\nстрока 3\nновая (A)', false, 'строка 1 (A)\nстрока 3 (B)\nновая (A)'],
  ['inserted line next to edits on both sides (slider)', 'строка 1\nстрока 3', 'строка 1\nстрока 2\nстрока 3 x', 'строка 1 y\nстрока 3', false, 'строка 1 y\nстрока 2\nстрока 3 x'],
  ['appends at the same line end whose last char repeats (no false clash)', 'L3 T22B T24A', 'L3 T22B T24A T30A', 'L3 T22B T24A T28B', true, 'L3 T22B T24A T28B T30A'],
  ['appends ending in the same char as the line', 'x = 5', 'x = 5 + 5', 'x = 5 * 5', false, 'x = 5 + 5 * 5'],
  ['checkbox toggle vs text edit on another line', '[ ] купить\nзаметка', '[x] купить\nзаметка', '[ ] купить\nзаметка 2', false, '[x] купить\nзаметка 2'],
];

(async () => {
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage();
  await page.route('**/*', r => (r.request().url().startsWith('file:') ? r.continue() : r.abort()));
  await page.goto('file://' + FILE);
  await page.waitForFunction(() => window.__calcuta && window.__calcuta.__syncTest);
  let fails = 0, checks = 0;
  const check = (ok, name, detail) => { checks++; if (!ok) fails++; console.log((ok ? '  ok   ' : '  FAIL ') + name + (!ok && detail ? '\n       ' + detail : '')); };

  // ---- fixed cases ----
  const got = await page.evaluate(cases => cases.map(([, b, l, r, ln]) => window.__calcuta.__syncTest.merge3(b, l, r, ln)), CASES);
  CASES.forEach(([name, , , , , exp], i) => check(got[i] === exp, 'merge3: ' + name, 'got ' + JSON.stringify(got[i]) + ' want ' + JSON.stringify(exp)));

  // ---- randomized properties (run in the page; seeded, reproducible) ----
  const total = { idem: 0, idemFail: [], far: 0, farFail: [], keep: 0, keepFail: [], map: 0, mapFail: [], intact: 0, intactFail: [], ins: 0, insFail: [] };
  for (const SEED of [12345, 777, 99991, 4242]) {
  const res = await page.evaluate(SEED => {
    const T = window.__calcuta.__syncTest;
    let seed = SEED;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    const ri = n => Math.floor(rnd() * n);
    const WORDS = ['купить', 'молоко', 'x', '=', '12', '+', '(', ')', 'итого', '#', 'заметка', '//', '[ ]', 'дом', '', ' '];
    const line = () => { const n = ri(5); const w = []; for (let i = 0; i < n; i++) w.push(WORDS[ri(WORDS.length)]); return w.join(' '); };
    let uid = 0;
    const tok = side => side + (++uid) + 'q';
    // apply random edits; returns {text, added:[tokens]}
    const edit = (base, side, nEdits) => {
      const L = base.split('\n'); const added = [];
      for (let e = 0; e < nEdits; e++) {
        const k = ri(6), i = ri(L.length);
        if (k === 0) { const t = tok(side); L.splice(i, 0, t); added.push(t); }                      // new line
        else if (k === 1) { const t = tok(side); L[i] = L[i] + ' ' + t; added.push(t); }             // append
        else if (k === 2) { const t = tok(side); L[i] = t + ' ' + L[i]; added.push(t); }             // prepend
        else if (k === 3) { const t = tok(side); const p = ri(L[i].length + 1); L[i] = L[i].slice(0, p) + t + L[i].slice(p); added.push(t); }  // mid-line
        else if (k === 4) { if (L.length > 1) L.splice(i, 1); }                                         // delete line
        else { const t = tok(side); L[i] = t; added.push(t); }                                          // rewrite line
      }
      return { text: L.join('\n'), added };
    };
    const out = { idem: 0, idemFail: [], far: 0, farFail: [], keep: 0, keepFail: [], map: 0, mapFail: [], intact: 0, intactFail: [], ins: 0, insFail: [] };
    for (let n = 0; n < 2500; n++) {
      const lines = []; const nl = 1 + ri(12); for (let i = 0; i < nl; i++) lines.push(line() + ' b' + n + '_' + i);
      const base = lines.join('\n');
      const a = edit(base, 'L', 1 + ri(4)), b = edit(base, 'R', 1 + ri(4));
      const ln = rnd() < 0.5;
      // identities
      out.idem++;
      if (T.merge3(base, a.text, a.text, ln) !== a.text || T.merge3(base, base, a.text, ln) !== a.text || T.merge3(base, a.text, base, ln) !== a.text) out.idemFail.push(n);
      // nothing added is lost
      const m = T.merge3(base, a.text, b.text, ln);
      out.keep++;
      // (a token a side added and then deleted again is not part of its edit)
      const lost = a.added.filter(t => a.text.includes(t)).concat(b.added.filter(t => b.text.includes(t))).filter(t => !m.includes(t));
      if (lost.length && out.keepFail.length < 5) out.keepFail.push({ base, l: a.text, r: b.text, m, lost });
      // a line neither side touched comes through intact, exactly once
      const al = a.text.split('\n'), bl = b.text.split('\n'), ml = m.split('\n');
      for (const x of lines) {
        if (!al.includes(x) || !bl.includes(x)) continue;
        out.intact++;
        if (ml.filter(y => y === x).length !== 1 && out.intactFail.length < 5) out.intactFail.push({ base, l: a.text, r: b.text, m, line: x });
      }
      // far-apart edits: local edits only lines [0, k), remote only lines [k+1, n)
      if (nl >= 3) {
        const k = 1 + ri(nl - 2);
        const A = lines.slice(), B = lines.slice();
        A[ri(k)] += ' FA' + n; B[k + 1 + ri(nl - k - 1)] += ' FB' + n;
        const both = A.map((x, i) => (B[i] !== lines[i] ? B[i] : x)).join('\n');
        const mm = T.merge3(base, A.join('\n'), B.join('\n'), ln);
        out.far++;
        if (mm !== both && out.farFail.length < 5) out.farFail.push({ base, a: A.join('\n'), b: B.join('\n'), mm, both });
        // a position on an untouched line keeps its character
        const untouched = lines.findIndex((x, i) => A[i] === x && B[i] === x);
        if (untouched >= 0) {
          const off = lines.slice(0, untouched).reduce((s, x) => s + x.length + 1, 0) + ri(lines[untouched].length + 1);
          const ch = base.slice(off, off + 3);
          const mo = T.mapOffset(base, mm, off);
          out.map++;
          if (mm.slice(mo, mo + 3) !== ch && out.mapFail.length < 5) out.mapFail.push({ base, mm, off, mo });
        }
      }
    }
    // insert-only concurrent edits (append / prepend / new line / between
    // words): the merge has exactly base + new lines, each base line once
    const ins = (base, side) => {
      const L = base.split('\n'); const added = []; let nl = 0;
      for (let e = 0, n = 1 + ri(5); e < n; e++) {
        const k = ri(5), i = ri(L.length), t = tok(side);
        added.push(t);
        if (k === 0) L[i] = L[i] + ' ' + t;
        else if (k === 1) L[i] = t + ' ' + L[i];
        else if (k === 2) { L.splice(ri(L.length + 1), 0, 'N ' + t); nl++; }
        else if (k === 3) { const w = L[i].split(' '); w.splice(ri(w.length + 1), 0, t); L[i] = w.join(' '); }
        else { const p = ri(L[i].length + 1); L[i] = L[i].slice(0, p) + t + L[i].slice(p); }   // anywhere, even inside a word
      }
      return { text: L.join('\n'), added, nl };
    };
    for (let n = 0; n < 2500; n++) {
      const lines = []; const nl = 1 + ri(10); for (let i = 0; i < nl; i++) lines.push('id' + n + '_' + i + (ri(3) ? ' ' + line() : ''));
      const base = lines.join('\n');
      const a = ins(base, 'L'), b = ins(base, 'R');
      const m = T.merge3(base, a.text, b.text, rnd() < 0.5);
      const ml = m.split('\n');
      out.ins++;
      const lost = a.added.filter(t => a.text.includes(t)).concat(b.added.filter(t => b.text.includes(t))).filter(t => !m.includes(t));
      const strip = y => { let z; while ((z = y.replace(/[LR]\d+q/g, '')) !== y) y = z; return y; };
      const bare = ml.map(strip);                                 // a token may have landed inside an id (or a token)
      const dup = lines.map((x, i) => 'id' + n + '_' + i).filter(id => bare.filter(y => y.split(' ').includes(id)).length !== 1);
      if ((lost.length || dup.length || ml.length !== nl + a.nl + b.nl) && out.insFail.length < 5)
        out.insFail.push({ base, l: a.text, r: b.text, m, lost, dup, want: nl + a.nl + b.nl, got: ml.length });
    }
    return out;
  }, SEED);
  for (const k in total) total[k] = Array.isArray(total[k]) ? total[k].concat(res[k]) : total[k] + res[k];
  }
  const res = total;
  check(!res.idemFail.length, `merge3 identities (${res.idem} random cases)`, JSON.stringify(res.idemFail.slice(0, 5)));
  check(!res.keepFail.length, `no added word is ever lost (${res.keep} random concurrent edit pairs)`, JSON.stringify(res.keepFail[0]));
  check(!res.farFail.length, `far-apart edits merge exactly (${res.far} cases)`, JSON.stringify(res.farFail[0]));
  check(!res.mapFail.length, `mapOffset keeps the caret on untouched text (${res.map} cases)`, JSON.stringify(res.mapFail[0]));
  check(!res.intactFail.length, `lines neither side touched survive intact, once (${res.intact} lines)`, JSON.stringify(res.intactFail[0]));
  check(!res.insFail.length, `insert-only concurrent edits: no line duplicated or lost, nothing typed lost (${res.ins} cases)`, JSON.stringify(res.insFail[0]) + ' (' + res.insFail.length + '+ failures)');

  // ---- a big document, edits near both ends on one side, middle on the other ----
  const big = await page.evaluate(() => {
    const T = window.__calcuta.__syncTest, N = 3000;
    const base = Array.from({ length: N }, (_, i) => 'строка номер ' + i + ' = ' + (i * 7 % 13)).join('\n');
    const L = base.split('\n'); L[0] += ' (A0)'; L.splice(N - 1, 0, 'новая строка A'); L.splice(2000, 1);
    const R = base.split('\n'); R[1500] += ' (B mid)'; R.splice(10, 1); R.push('конец B');
    const want = base.split('\n'); want[0] += ' (A0)'; want[1500] += ' (B mid)'; want.splice(N - 1, 0, 'новая строка A'); want.splice(2000, 1); want.splice(10, 1); want.push('конец B');
    const t0 = performance.now(); const m = T.merge3(base, L.join('\n'), R.join('\n'), true); const ms = performance.now() - t0;
    return { exact: m === want.join('\n'), ms: Math.round(ms) };
  });
  check(big.exact && big.ms < 1500, `3000-line document, edits at both ends vs middle: exact merge (${big.ms} ms)`, JSON.stringify(big));

  // ---- mapOffset: caret while a remote edit lands ----
  const mo = await page.evaluate(() => {
    const T = window.__calcuta.__syncTest;
    return [
      T.mapOffset('abc\ndef', 'XXabc\ndef', 5),        // edit above: caret moves with its text
      T.mapOffset('abc\ndef', 'abc\ndef!', 5),         // edit after: caret stays
      T.mapOffset('abc\ndef\nghi', 'abc!\ndef\nghi!', 6), // edits around: same char
      T.mapOffset('hello world', 'hello big world', 11), // end of a line whose middle changed
    ];
  });
  check(mo[0] === 7 && mo[1] === 5 && mo[2] === 7 && mo[3] === 15, 'mapOffset fixed cases', JSON.stringify(mo));

  // ---- mergeStores: three-way per doc, LWW without bases ----
  const ms = await page.evaluate(() => {
    const K = window.__calcuta, T = K.__syncTest;
    const base = { text: 'a\nb\nc', name: 'D', updated: 100 };
    const L = { docs: [{ id: 'x', name: 'D', text: 'a\nb\nc (local)', updated: 50 }] };   // slow clock: older stamp
    const R = { docs: [{ id: 'x', name: 'D', text: 'a (remote)\nb\nc', updated: 200 }] };
    const three = K.mergeStores(L, R, { x: base }).docs[0];
    const lww = K.mergeStores(L, R).docs[0];
    const stale = K.mergeStores({ docs: [{ id: 'x', name: 'D', text: 'new', updated: 300 }] },
                                { docs: [{ id: 'x', name: 'D', text: 'old', updated: 90 }] }, { x: { text: 'new', name: 'D', updated: 300 } }).docs[0];
    const rename = K.mergeStores({ docs: [{ id: 'x', name: 'Новое имя', text: 'a\nb\nc', updated: 150 }] }, R, { x: base }).docs[0];
    return { three: three.text, threeNewer: three.updated > 200, lww: lww.text, stale: stale.text, rename: [rename.name, rename.text] };
  });
  check(ms.three === 'a (remote)\nb\nc (local)' && ms.threeNewer, 'mergeStores: both edits kept, result stamped newest', JSON.stringify(ms));
  check(ms.lww === 'a (remote)\nb\nc', 'mergeStores without bases: last-writer-wins (unchanged behaviour)', JSON.stringify(ms));
  check(ms.stale === 'new', 'mergeStores: a late, older server copy is not taken as news', JSON.stringify(ms));
  check(ms.rename[0] === 'Новое имя' && ms.rename[1] === 'a (remote)\nb\nc', 'mergeStores: rename on one device + edit on another', JSON.stringify(ms));

  await browser.close();
  console.log(fails ? `\n${fails} of ${checks} merge checks FAILED` : `\nALL ${checks} MERGE CHECKS PASSED`);
  process.exit(fails ? 1 : 0);
})();
