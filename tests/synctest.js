// Проверка движка слияния для сценария «печатал до того, как ответило облако».
// Гоняет реальный mergeStores() из приложения через ситуации, в которых
// правки теоретически могли бы потеряться.
//   node synctest.js ../index.html
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

  const res = await page.evaluate(() => {
    const K = window.__calcuta;
    const doc = (id, text, updated) => ({ id, name: id, text, lineColors: {}, updated });
    const store = (docs, extra) => Object.assign({ docs, tags: [], activeId: docs[0] && docs[0].id }, extra || {});
    const out = [];
    const check = (name, got, want) => out.push({ name, ok: got === want, got, want });

    const T = 1_700_000_000_000;

    // 1. Я печатаю до ответа облака; в облаке лежит СТАРАЯ версия того же документа.
    //    Моя правка новее по времени -> должна победить.
    let m = K.mergeStores(
      store([doc('a', 'МОЙ СВЕЖИЙ ТЕКСТ', T + 5000)]),
      store([doc('a', 'старое из облака', T)]));
    check('свежая локальная правка побеждает старое облако',
          m.docs.find(d => d.id === 'a').text, 'МОЙ СВЕЖИЙ ТЕКСТ');

    // 2. Обратное: на другом устройстве правили позже -> облако должно победить.
    m = K.mergeStores(
      store([doc('a', 'моё старое', T)]),
      store([doc('a', 'новое с телефона', T + 5000)]));
    check('более новая правка с другого устройства побеждает',
          m.docs.find(d => d.id === 'a').text, 'новое с телефона');

    // 3. Правки в РАЗНЫХ документах на разных устройствах -> выживают обе.
    m = K.mergeStores(
      store([doc('a', 'правил на ноуте', T + 100), doc('b', 'старое b', T)]),
      store([doc('a', 'старое a', T), doc('b', 'правил на телефоне', T + 100)]));
    check('правка в документе A сохранилась', m.docs.find(d => d.id === 'a').text, 'правил на ноуте');
    check('правка в документе B сохранилась', m.docs.find(d => d.id === 'b').text, 'правил на телефоне');

    // 4. Свежесозданное устройство (стоковые страницы, updated:0) не должно
    //    затирать реальные данные из облака.
    m = K.mergeStores(
      store([doc('stock-tasks', 'демо-текст из коробки', 0)]),
      store([doc('stock-tasks', 'МОИ НАСТОЯЩИЕ ЗАМЕТКИ', T)]));
    check('чистое устройство не затирает облако',
          m.docs.find(d => d.id === 'stock-tasks').text, 'МОИ НАСТОЯЩИЕ ЗАМЕТКИ');

    // 5. Слияние коммутативно: порядок аргументов не меняет результат
    //    (иначе два устройства разошлись бы навсегда).
    const L = store([doc('a', 'левое', T + 3), doc('c', 'только слева', T + 1)]);
    const R = store([doc('a', 'правое', T + 9), doc('d', 'только справа', T + 2)]);
    const lr = JSON.stringify(K.syncPayload(K.mergeStores(L, R)));
    const rl = JSON.stringify(K.syncPayload(K.mergeStores(R, L)));
    check('слияние коммутативно (устройства сходятся)', lr === rl, true);

    // 6. Логические часы: stamp() всегда обгоняет всё, что видел observeStore —
    //    даже если у другого устройства часы убежали вперёд.
    const skew = Date.now() + 60 * 60 * 1000;          // облако «из будущего» на час
    K.observeStore(store([doc('a', 'из будущего', skew)]));
    const nextLocal = K.stamp();
    check('правка после облака «из будущего» всё равно новее', nextLocal > skew, true);

    return out;
  });

  await browser.close();
  console.log('\n=== движок синхронизации ===');
  let bad = 0;
  for (const r of res) {
    if (!r.ok) bad++;
    console.log('  ' + (r.ok ? 'OK  ' : 'FAIL') + '  ' + r.name +
      (r.ok ? '' : '\n          получили: ' + JSON.stringify(r.got) + '\n          ожидали:  ' + JSON.stringify(r.want)));
  }
  if (errors.length) console.log('  ошибки страницы: ' + errors.join(' | '));
  console.log(bad ? '\n  ' + bad + ' проверок провалено' : '\n  все проверки пройдены ✓');
  console.log();
  process.exit(bad || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
