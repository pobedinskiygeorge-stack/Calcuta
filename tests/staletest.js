// Регрессия сценария «отставшее устройство»: правил на работе, приехал домой,
// а домашний Мак со старой копией перезаписал всё новое в облаке.
// Гоняет НАСТОЯЩИЕ пути записи в облако (pushCloudNow / flushSync /
// keepaliveFlush / hardSave / refreshFromServer) через шов __calcuta.__syncTest
// против фейкового Firestore. Гарантия, которую фиксирует этот тест:
// запись с устройства, не видевшего свежую версию облака, ФИЗИЧЕСКИ не может
// стереть данные, которых оно не видело, — а его собственная правка при этом
// тоже не теряется (трёхстороннее слияние с «базой» — последней версией с
// сервера, которую устройство видело).
//   node staletest.js ../index.html
const { chromium } = require('playwright-core');
const path = require('path');
const os = require('os');

const EXE = process.env.CALCUTA_CHROME || path.join(os.homedir(),
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

  const res = await page.evaluate(async () => {
    const K = window.__calcuta, S = K.__syncTest;
    const out = [];
    const check = (name, ok, extra) => out.push({ name, ok, extra: ok ? '' : String(extra || '') });

    const T_OLD = Date.now() - 86400000;   // вчера: дом последний раз синхронизировался
    const T_WORK = Date.now() - 3600000;   // час назад: правки с работы

    const docObj = (id, name, text, updated, prot) => {
      const d = { id, name, text, lineColors: {}, updated };
      if (prot) d.protected = prot;
      return d;
    };

    // ---- фейковый Firestore: один документ на сервере + транзакции ----
    const server = { doc: null };
    const snapOf = () => ({ exists: !!server.doc, data: () => server.doc, metadata: { fromCache: false, hasPendingWrites: false } });
    let online = true;
    const fakeDb = {
      runTransaction: async (cb) => {
        if (!online) throw new Error('unavailable');
        await cb({ get: async () => snapOf(), set: (ref, v) => { server.doc = v; } });
      },
    };
    const fakeRef = {
      get: async () => { if (!online) throw new Error('unavailable'); return snapOf(); },
      set: async (v) => { server.doc = v; },
      onSnapshot: () => () => {},
    };
    const fakeUser = { uid: 'u1', getIdToken: async () => 'tok' };

    const realFetch = window.fetch;
    let fetchCalls = 0, lastFetch = null;
    window.fetch = (...a) => { fetchCalls++; lastFetch = a; return Promise.resolve({ ok: true }); };

    const cloudPayload = s => ({ data: JSON.stringify(s), updated: Date.now() });
    const freshHome = () => {
      S.inject(fakeDb, fakeRef, fakeUser);
      S.setStore({
        docs: [docObj('stock-tasks', 'Задачи', 'старые задачи (дом, вчера)', T_OLD, 'tasks'),
               docObj('stock-personal', 'Личное', 'старое личное', T_OLD, 'personal')],
        activeId: 'stock-tasks', tags: [], tagsUpdated: 0, deletedDocs: {}, deletedTags: {}, pinned: [],
      });
      S.setSynced(K.syncPayload(K.getStore()));       // дом был полностью синхронизирован перед сном
      S.setBases({ 'stock-tasks': { text: 'старые задачи (дом, вчера)', name: 'Задачи', updated: T_OLD },
                   'stock-personal': { text: 'старое личное', name: 'Личное', updated: T_OLD } });
      S.setServerSeenAt(Date.now() - 8 * 3600 * 1000); // последняя сверка с сервером: 8 часов назад
      fetchCalls = 0; online = true;
    };
    const workCloud = () => {
      server.doc = cloudPayload({
        docs: [docObj('stock-tasks', 'Задачи', 'РАБОЧИЕ ЗАДАЧИ (новые)', T_WORK, 'tasks'),
               docObj('stock-personal', 'Личное', 'старое личное', T_OLD, 'personal'),
               docObj('workdoc', 'Отчёт', 'новый документ с работы', T_WORK)],
        tags: [], tagsUpdated: 0, deletedDocs: {}, deletedTags: {},
      });
    };
    const cloudTasks = () => JSON.parse(server.doc.data).docs.find(x => x.id === 'stock-tasks').text;
    const cloudHasWorkdoc = () => JSON.parse(server.doc.data).docs.some(x => x.id === 'workdoc');
    // правка как у пользователя: через редактор (input-событие), а не мимо него
    const editTasks = (text) => {
      if (K.getStore().activeId !== 'stock-tasks') K.setActive('stock-tasks');
      const el = document.getElementById('input');
      el.value = text;
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: 'x', bubbles: true }));
    };
    const pause = ms => new Promise(r => setTimeout(r, ms));

    // 1. Спящая вкладка без новых правок сворачивается/закрывается — облако не трогаем.
    freshHome(); workCloud();
    const before = server.doc.data;
    S.flushSync(); S.keepaliveFlush();
    await pause(50);
    check('спящая вкладка при hide/close не перезаписывает облако',
          server.doc.data === before && fetchCalls === 0,
          'fetches=' + fetchCalls + ' changed=' + (server.doc.data !== before));

    // 2. Отставший дом правит «Задачи» до всякой сверки — пуш сливает, не затирает.
    freshHome(); workCloud();
    editTasks('домашняя правка задач');
    S.pushCloudNow(); await pause(100);
    check('пуш с отставшего устройства сохранил рабочий документ', cloudHasWorkdoc());
    check('домашняя правка «Задач» слита с рабочей: обе на месте',
          cloudTasks().includes('домашняя правка задач') && cloudTasks().includes('РАБОЧИЕ ЗАДАЧИ (новые)'), cloudTasks());
    check('локальный стор после пуша подтянул рабочий документ',
          K.getStore().docs.some(x => x.id === 'workdoc'));

    // 3. Пробуждение вкладки: refreshFromServer сразу подтягивает рабочую версию.
    freshHome(); workCloud();
    S.refreshFromServer(); await pause(100);
    check('после пробуждения «Задачи» актуальные',
          K.getStore().docs.find(x => x.id === 'stock-tasks').text === 'РАБОЧИЕ ЗАДАЧИ (новые)',
          K.getStore().docs.find(x => x.id === 'stock-tasks').text);
    check('после пробуждения serverSeenAt свежий', Date.now() - S.state().serverSeenAt < 2000);

    // 4. keepalive при закрытии: пишет ТОЛЬКО в свою запись pending.<ключ>, никогда
    //    не в data, — даже после долгого сна (раньше: запрет после 3 минут без
    //    сервера, и последняя правка терялась).
    editTasks('правка после пробуждения');
    S.setServerSeenAt(Date.now() - 8 * 3600 * 1000);
    S.keepaliveFlush(); await pause(50);
    const kaUrl = lastFetch && String(lastFetch[0]), kaBody = lastFetch && JSON.parse(lastFetch[1].body);
    check('keepalive пишет правку и после долгого сна', fetchCalls === 1, 'fetches=' + fetchCalls);
    check('keepalive пишет только pending.<ключ>, не data',
          !!kaUrl && kaUrl.includes('updateMask.fieldPaths=pending.' + S.PENDING_KEY) && !kaUrl.includes('fieldPaths=data') && !kaBody.fields.data,
          kaUrl);
    const entry = kaBody && JSON.parse(kaBody.fields.pending.mapValue.fields[S.PENDING_KEY].stringValue);
    check('в pending только несинхронизированный документ и его база',
          entry && entry.docs.length === 1 && entry.docs[0].text === 'правка после пробуждения' && entry.bases['stock-tasks'],
          JSON.stringify(entry));
    // ...а следующий, кто читает облако, вливает её трёхсторонне и чистит pending
    server.doc = Object.assign({}, server.doc, { pending: { [S.PENDING_KEY]: kaBody.fields.pending.mapValue.fields[S.PENDING_KEY].stringValue } });
    const folded = S.parseRemote(server.doc);
    check('pending вливается при чтении облака', folded && folded.__pending &&
          folded.docs.find(x => x.id === 'stock-tasks').text.includes('правка после пробуждения'),
          folded && folded.docs.find(x => x.id === 'stock-tasks').text);
    S.pushCloudNow(); await pause(100);
    check('после пуша pending очищен, правка в data', !server.doc.pending && cloudTasks().includes('правка после пробуждения'), JSON.stringify(server.doc.pending || null));

    // 5. «Сохранить на всех устройствах» на отставшем устройстве: merge, не откат.
    freshHome(); workCloud();
    S.hardSave(); await pause(100);
    check('hardSave не откатил рабочие «Задачи»', cloudTasks() === 'РАБОЧИЕ ЗАДАЧИ (новые)', cloudTasks());
    check('hardSave не потерял рабочий документ', cloudHasWorkdoc());
    check('hardSave поднял forceEpoch', (JSON.parse(server.doc.data).forceEpoch || 0) > Date.now() - 60000);

    // 6. Офлайн: пуш падает БЕЗ записи; после сети правка доезжает слиянием.
    freshHome(); workCloud();
    online = false;
    editTasks('офлайн-правка');
    S.pushCloudNow(); await pause(100);
    check('офлайн-пуш не тронул облако', cloudTasks() === 'РАБОЧИЕ ЗАДАЧИ (новые)', cloudTasks());
    online = true;
    S.pushCloudNow(); await pause(100);
    check('после сети правка доехала со слиянием',
          cloudTasks().includes('офлайн-правка') && cloudTasks().includes('РАБОЧИЕ ЗАДАЧИ (новые)') && cloudHasWorkdoc(), cloudTasks());

    // 7. Более новый hard save с другого устройства принимается и не перезаписывается
    //    (местная правка была сделана ДО него).
    freshHome();
    editTasks('местная правка');
    server.doc = cloudPayload({
      docs: [docObj('stock-tasks', 'Задачи', 'ПРИНУДИТЕЛЬНАЯ ВЕРСИЯ', T_WORK, 'tasks'),
             docObj('stock-personal', 'Личное', 'старое личное', T_OLD, 'personal')],
      tags: [], tagsUpdated: 0, deletedDocs: {}, deletedTags: {}, forceEpoch: Date.now() + 5000,
    });
    const beforeForce = server.doc.data;
    S.pushCloudNow(); await pause(100);
    check('чужой hard save принят локально',
          K.getStore().docs.find(x => x.id === 'stock-tasks').text === 'ПРИНУДИТЕЛЬНАЯ ВЕРСИЯ',
          K.getStore().docs.find(x => x.id === 'stock-tasks').text);
    check('чужой hard save не перезаписан нашим пушем', server.doc.data === beforeForce);

    // 8. Правка, сделанная ПОСЛЕ чужого hard save, не выбрасывается, а вливается.
    freshHome();
    server.doc = cloudPayload({
      docs: [docObj('stock-tasks', 'Задачи', 'ПРИНУДИТЕЛЬНАЯ ВЕРСИЯ', T_WORK, 'tasks'),
             docObj('stock-personal', 'Личное', 'старое личное', T_OLD, 'personal')],
      tags: [], tagsUpdated: 0, deletedDocs: {}, deletedTags: {}, forceEpoch: Date.now() - 5000,
    });
    editTasks('правка после hard save');
    S.pushCloudNow(); await pause(100); S.pushCloudNow(); await pause(100);
    check('правка после чужого hard save сохранена и выгружена',
          cloudTasks().includes('правка после hard save') && cloudTasks().includes('ПРИНУДИТЕЛЬНАЯ ВЕРСИЯ'), cloudTasks());

    window.fetch = realFetch;
    return out;
  });

  await browser.close();
  console.log('\n=== отставшее устройство не затирает облако ===');
  let bad = 0;
  for (const r of res) {
    if (!r.ok) bad++;
    console.log('  ' + (r.ok ? 'OK  ' : 'FAIL') + '  ' + r.name + (r.ok ? '' : '\n          ' + r.extra));
  }
  if (errors.length) console.log('  ошибки страницы: ' + errors.join(' | '));
  console.log(bad ? '\n  ' + bad + ' проверок провалено' : '\n  все проверки пройдены ✓');
  console.log();
  process.exit(bad || errors.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
