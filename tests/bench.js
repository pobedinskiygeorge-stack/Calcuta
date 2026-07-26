// Typing-latency benchmark for Calcuta.
//   node bench.js <path-to-index.html> [label]
// Measures the synchronous cost of one keystroke (the whole `input` handler
// chain: transforms -> applyMask -> analyze -> render) on documents of a few
// sizes, plus a mousemove hit-test pass.

const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = path.join(
  os.homedir(),
  'Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell'
);

// A realistic document: headings, variables, tagged lines, dates, currency,
// aggregation and plain prose, repeated to reach the target line count.
function makeDoc(lines) {
  const block = [
    '// Раздел {i}',
    'доход{i} = 2 500 000',
    'налог{i} = доход{i} * 13%',
    'чистыми{i} = доход{i} - налог{i}',
    'аренда 120 000 за офис',
    'зарплаты 480 000 всего',
    'прочие расходы 55 500',
    'sum',
    'дедлайн 15.09 важно',
    'заметка про (важное) 100 + 50',
    '[ ] согласовать смету {i}',
    'ссылка https://example.com/{i}',
    '',
  ];
  const out = [];
  for (let i = 0; out.length < lines; i++) {
    for (const l of block) out.push(l.replace(/\{i\}/g, i));
  }
  return out.slice(0, lines).join('\n');
}

(async () => {
  const file = path.resolve(process.argv[2] || path.join(os.homedir(), 'calcuta/index.html'));
  const label = process.argv[3] || path.basename(path.dirname(file));

  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('pageerror', e => console.error('PAGE ERROR:', String(e)));
  await page.route('**://www.gstatic.com/**', r => r.abort());
  await page.route('**://*.googleapis.com/**', r => r.abort());
  await page.route('**://www.cbr-xml-daily.ru/**', r => r.abort());

  await page.goto('file://' + file);
  await page.waitForFunction(() => typeof window.__calcuta !== 'undefined', { timeout: 15000 });

  const results = [];
  for (const n of [100, 300, 800]) {
    const doc = makeDoc(n);
    const r = await page.evaluate(({ doc, n }) => {
      const input = document.getElementById('input');
      const fire = () => input.dispatchEvent(new Event('input', { bubbles: true }));

      input.value = doc;
      fire();                              // settle: mask + first full render
      const settled = input.value;

      // Warm up so we measure steady state, not first-run compile.
      for (let i = 0; i < 5; i++) {
        input.value = settled + ' ';
        input.selectionStart = input.selectionEnd = input.value.length;
        fire();
      }

      // Case A ("append"): add a whole new line at the end. Worst case for a
      // line-diffing renderer — a new node plus a changed one every time.
      const N = 20;
      const samples = [];
      for (let i = 0; i < N; i++) {
        const v = settled + '\nитого ' + (1000 + i) + ' + ' + i;
        input.value = v;
        input.selectionStart = input.selectionEnd = v.length;
        const t0 = performance.now();
        fire();
        samples.push(performance.now() - t0);
      }
      samples.sort((a, b) => a - b);

      // Case B ("edit in place"): type a digit into a line in the middle of the
      // document. This is what ordinary typing actually looks like.
      const midLines = settled.split('\n');
      const midIdx = Math.floor(midLines.length / 2);
      const midOrig = midLines[midIdx];
      const prefixLen = midLines.slice(0, midIdx).join('\n').length + 1;
      const inplace = [];
      for (let i = 0; i < N; i++) {
        midLines[midIdx] = midOrig + ' ' + (100 + i);
        const v = midLines.join('\n');
        input.value = v;
        const caret = prefixLen + midLines[midIdx].length;
        input.selectionStart = input.selectionEnd = caret;
        const t0 = performance.now();
        fire();
        inplace.push(performance.now() - t0);
      }
      inplace.sort((a, b) => a - b);
      midLines[midIdx] = midOrig;
      input.value = settled; fire();

      // Isolate the pure-JS analysis cost (no DOM writes).
      const K = window.__calcuta;
      const t1 = performance.now();
      for (let i = 0; i < 10; i++) K.analyze(settled);
      const analyzeMs = (performance.now() - t1) / 10;

      // Isolate the live formatter.
      const t2 = performance.now();
      for (let i = 0; i < 10; i++) K.formatAll(settled, -1);
      const formatMs = (performance.now() - t2) / 10;

      // Mousemove hit-test cost (the separate 60Hz path).
      const stack = document.getElementById('stack');
      const box = stack.getBoundingClientRect();
      const t3 = performance.now();
      let moves = 0;
      for (let i = 0; i < 30; i++) {
        stack.dispatchEvent(new MouseEvent('mousemove', {
          bubbles: true,
          clientX: box.left + 60 + (i % 40) * 4,
          clientY: box.top + 40 + (i % 12) * 11,
        }));
        moves++;
      }
      const moveMs = (performance.now() - t3) / moves;

      return {
        n,
        chars: settled.length,
        keyMedian: samples[Math.floor(N / 2)],
        keyP90: samples[Math.floor(N * 0.9)],
        editMedian: inplace[Math.floor(N / 2)],
        editP90: inplace[Math.floor(N * 0.9)],
        analyzeMs, formatMs, moveMs,
      };
    }, { doc, n });
    results.push(r);
  }

  await browser.close();

  console.log('\n=== ' + label + ' ===');
  console.log('lines  chars   append(med)  append(p90)  edit(med)  edit(p90)  analyze  formatAll  mousemove');
  for (const r of results) {
    console.log(
      String(r.n).padEnd(7) +
      String(r.chars).padEnd(8) +
      (r.keyMedian.toFixed(2) + ' ms').padEnd(13) +
      (r.keyP90.toFixed(2) + ' ms').padEnd(13) +
      (r.editMedian.toFixed(2) + ' ms').padEnd(11) +
      (r.editP90.toFixed(2) + ' ms').padEnd(11) +
      (r.analyzeMs.toFixed(2) + ' ms').padEnd(9) +
      (r.formatMs.toFixed(2) + ' ms').padEnd(11) +
      (r.moveMs.toFixed(3) + ' ms')
    );
  }
  console.log();
})().catch(e => { console.error(e); process.exit(1); });
