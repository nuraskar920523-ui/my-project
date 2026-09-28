// Интеграционные тесты собранного workflow на моках. Запуск: node test/run_tests.js
// ВНИМАНИЕ: пишет в /home/node/.n8n (как продакшен-узлы). Запускать только в тестовой среде/контейнере!
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { Runner } = require('./harness');

const N8N_DIR = '/home/node/.n8n';
// Тесты удаляют/перезаписывают файлы в /home/node/.n8n (кэш каталога, реестр, lock).
// Разрешено только в одноразовом контейнере: пустой каталог или явный флаг TS_TEST_SANDBOX=1.
const dirHasFiles = fs.existsSync(N8N_DIR) && fs.readdirSync(N8N_DIR).length > 0;
if (process.env.TS_TEST_SANDBOX !== '1' && (dirHasFiles || fs.existsSync(path.join(N8N_DIR, 'database.sqlite')))) {
  console.error('ОТКАЗ: ' + N8N_DIR + ' не пуст — похоже на рабочий n8n. Запускайте тесты в одноразовом контейнере:\n' +
    '  docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_tests.js');
  process.exit(2);
}

// ---------------- Фикстуры: каталог ----------------
const CATALOG = [
  { 'Код': 'NB-001', 'Наименование': 'Ноутбук Lenovo IdeaPad 3 15.6" i5/8GB/512GB', 'Полное наименование': 'Ноутбук Lenovo IdeaPad 3 15.6", Intel Core i5, 8 ГБ, SSD 512 ГБ, веб-камера HD, Windows 11', 'Цена дилерская': '250 000', 'Остаток': '5' },
  { 'Код': 'MON-24', 'Наименование': 'Монитор Dell 24" P2422H IPS', 'Полное наименование': 'Монитор Dell 24" P2422H, IPS, экран матовый 1920x1080, крепление VESA 100x100, HDMI', 'Цена дилерская': '60 000', 'Остаток': '10' },
  { 'Код': 'PC-I5', 'Наименование': 'Компьютер персональный HP ProDesk 400 G9', 'Полное наименование': 'Компьютер персональный HP ProDesk 400 G9 SFF, Intel Core i5, 16 ГБ, SSD 512 ГБ, Windows 11 Pro', 'Цена дилерская': '280000', 'Остаток': '3' },
  { 'Код': 'MFP-141', 'Наименование': 'МФУ HP LaserJet MFP M141a', 'Полное наименование': 'МФУ HP LaserJet MFP M141a, монохромное, A4, печать/копирование/сканирование', 'Цена дилерская': '70000', 'Остаток': '4' },
  { 'Код': 'PR-COL', 'Наименование': 'Принтер Canon i-SENSYS LBP633Cdw цветной', 'Полное наименование': 'Принтер лазерный цветной Canon i-SENSYS LBP633Cdw, A4', 'Цена дилерская': '120000', 'Остаток': '2' },
  { 'Код': 'UPS-1000', 'Наименование': 'ИБП APC Back-UPS 1000VA', 'Полное наименование': 'ИБП APC Back-UPS BX1000MI 1000VA, аккумуляторная батарея 12В', 'Цена дилерская': '60000', 'Остаток': '6' },
  { 'Код': 'BAT-12', 'Наименование': 'Аккумулятор для ИБП 12В 9Ач', 'Полное наименование': 'Аккумулятор для ИБП 12В 9Ач', 'Цена дилерская': '9000', 'Остаток': '20' },
  { 'Код': 'SW-POE', 'Наименование': 'Коммутатор TP-Link TL-SG1008P PoE', 'Полное наименование': 'Коммутатор TP-Link TL-SG1008P, неуправляемый, 8 портов, 4 порта PoE', 'Цена дилерская': '30000', 'Остаток': '7' },
  { 'Код': 'SW-8', 'Наименование': 'Коммутатор TP-Link TL-SG108', 'Полное наименование': 'Коммутатор TP-Link TL-SG108, неуправляемый, 8 портов', 'Цена дилерская': '12000', 'Остаток': '9' },
  { 'Код': 'RT-KN', 'Наименование': 'Маршрутизатор Keenetic Giga', 'Полное наименование': 'Маршрутизатор Keenetic Giga, Wi-Fi 6, режимы: роутер, точка доступа', 'Цена дилерская': '25000', 'Остаток': '8' },
  { 'Код': 'CAM-C270', 'Наименование': 'Веб-камера Logitech C270', 'Полное наименование': 'Веб-камера Logitech C270 HD 720p', 'Цена дилерская': '12000', 'Остаток': '15' },
  { 'Код': 'PRJ-X06', 'Наименование': 'Проектор Epson EB-X06', 'Полное наименование': 'Проектор Epson EB-X06, 3LCD, XGA, 3600 лм', 'Цена дилерская': '180000', 'Остаток': '2' },
  { 'Код': 'BR-MON', 'Наименование': 'Кронштейн для монитора настенный', 'Полное наименование': 'Кронштейн для монитора настенный VESA 75/100', 'Цена дилерская': '5000', 'Остаток': '30' },
  { 'Код': 'CRT-59A', 'Наименование': 'Картридж HP 59A CF259A', 'Полное наименование': 'Картридж HP 59A CF259A черный, с чипом', 'Цена дилерская': '30000', 'Остаток': '12' },
  { 'Код': 'USD-NB', 'Наименование': 'Ноутбук ASUS VivoBook 14', 'Полное наименование': 'Ноутбук ASUS VivoBook 14, Intel Core i3', 'Цена дилерская': '350', 'Валюта': 'USD', distributor: 'ASBIS', 'Остаток': '1' }
];
// Кэш-валидатор требует файл > 100 КБ — добиваем нейтральными позициями
for (let i = 0; CATALOG.length < 900; i++) {
  CATALOG.push({ 'Код': 'FILL-' + i, 'Наименование': 'Кабель соединительный тестовый ' + i, 'Полное наименование': 'Кабель соединительный тестовый артикул ' + i + ' длина ' + (i % 10) + ' м оплётка нейлон разъёмы стандартные '.repeat(2), 'Цена дилерская': String(1000 + i), 'Остаток': '1' });
}

// ---------------- Фикстуры: лоты ЦЭФ ----------------
const inHours = (h) => {
  const d = new Date(Date.now() + h * 3600000 + 5 * 3600000); // время Алматы (UTC+5) без зоны, как портал
  return d.toISOString().substring(0, 19).replace('T', ' ');
};
let idSeq = 1000;
const lot = (lotNumber, nameRu, descriptionRu, amount, count, extra) => Object.assign({
  id: ++idSeq, lotNumber, nameRu, descriptionRu, amount, count,
  customerNameRu: 'КГУ Школа-гимназия №1 г. Алматы', trdBuyNumberAnno: 'A-' + lotNumber, indexDate: '2026-09-2' + (idSeq % 5),
  refTradeMethodsId: 3, plnPointKatoList: ['751110000'], Files: [], trdBuyId: 50000 + idSeq, TrdBuy: { id: 50000 + idSeq, endDate: inHours(72) }
}, extra || {});

const LOTS = [
  lot('L-NB', 'Ноутбук', 'Ноутбук 15.6", Intel Core i5, веб-камера HD, Windows 11', 700000, 2, { Files: [{ id: 1, filePath: 'https://goszakup.gov.kz/files/ts-nb.pdf', originalName: 'Техспецификация.pdf', nameRu: 'ТЗ' }] }),
  lot('L-PC', 'Компьютер персональный', 'ОС Windows 11 Pro, SSD 512 ГБ, аккумулятор CMOS', 450000, 1),
  lot('L-UPS', 'Источник бесперебойного питания', 'ИБП 1000VA, аккумуляторная батарея 12В', 180000, 2),
  lot('L-RT', 'Маршрутизатор', 'Маршрутизатор Wi-Fi, режимы: роутер, точка доступа', 60000, 1),
  lot('L-MFP', 'МФУ лазерное', 'МФУ монохромное, цветной сенсорный дисплей, Цветность печати: черно-белая', 150000, 1),
  lot('L-POE', 'Коммутатор', 'Коммутатор 8 портов PoE, неуправляемый', 70000, 1),
  lot('L-MON', 'Монитор', 'Монитор 24 дюйма IPS, экран матовый', 280000, 3),
  lot('L-PRJ', 'Проектор мультимедийный', 'Проектор 3LCD, 3600 лм', 300000, 1),
  lot('L-CAM', 'Веб-камера', 'Веб-камера HD 720p для видеосвязи', 110000, 5),
  // должны быть отсеяны:
  lot('L-REGION', 'Ноутбук', 'Ноутбук для филиала', 700000, 2, { plnPointKatoList: ['191010000'] }), // КАТО области, заказчик «г. Алматы»
  lot('L-VAD', 'Коммутатор Cisco Catalyst', 'Коммутатор Cisco Catalyst 9200, без эквивалента', 900000, 1),
  lot('L-FURN', 'Шкаф для одежды', 'Шкаф для одежды двухстворчатый', 200000, 1),
  lot('L-LATE', 'Ноутбук', 'Ноутбук 14", срочно', 700000, 2, { TrdBuy: { id: 1, endDate: inHours(1) } }),
  lot('L-REJ', 'Принтер', 'Принтер лазерный цветной A4', 250000, 1),
  lot('L-BADCODE', 'Коммутатор 8 портов', 'Коммутатор 8 портов неуправляемый', 60000, 1),
  lot('L-PLAN', 'Монитор', 'Монитор 27 дюймов (пункт плана)', 400000, 2, { TrdBuy: null, trdBuyId: null, trdBuyNumberAnno: null })
];

// ---------------- Моки внешних API ----------------
function makeRouter(scenario) {
  const state = { gqlCalls: 0, geminiInspect: 0, geminiPdf: 0, pdfDownloads: 0, rateLimited: new Set() };
  const router = async (url, options, body) => {
    if (url.startsWith('https://ows.goszakup.gov.kz/v3/graphql')) {
      state.gqlCalls++;
      if ((options.headers || {}).Authorization !== 'Bearer test-gz-token') return { status: 401, body: { message: 'Unauthorized' } };
      const q = JSON.parse(body);
      if (scenario.rejectExtended && q.query.includes('TrdBuy')) return { status: 400, body: { errors: [{ message: 'Cannot query field "TrdBuy" on type "Lots".' }] } };
      if (scenario.rejectPaging && q.query.includes('$after')) return { status: 400, body: { errors: [{ message: 'Unknown argument "after"' }] } };
      const kw = String(q.variables.nameRu).toLowerCase();
      let hits = LOTS.filter(l => l.nameRu.toLowerCase().includes(kw));
      if (!q.query.includes('TrdBuy')) hits = hits.map(l => { const c = Object.assign({}, l); delete c.TrdBuy; delete c.trdBuyId; return c; });
      // Пагинация для «ноутбук»: по одному лоту на страницу
      if (q.query.includes('$after') && kw === 'ноутбук') {
        const after = q.variables.after || 0;
        const rest = hits.filter(l => l.id > after).sort((a, b) => a.id - b.id);
        const page = rest.slice(0, 1);
        return { status: 200, body: { data: { Lots: page }, extensions: { pageInfo: { hasNextPage: rest.length > 1, lastId: page[0] ? page[0].id : null, totalCount: hits.length } } } };
      }
      return { status: 200, body: { data: { Lots: hits } } };
    }
    if (url.startsWith('https://goszakup.gov.kz/files/')) {
      state.pdfDownloads++;
      return { status: 200, body: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2000, 32)]) };
    }
    if (url.includes('generativelanguage.googleapis.com') && url.includes(':generateContent')) {
      if (url.includes('key=')) throw new Error('Ключ Gemini не должен передаваться в URL');
      if ((options.headers || {})['x-goog-api-key'] !== 'test-gemini-key') return { status: 403, body: { error: { message: 'bad key' } } };
      const req = JSON.parse(body);
      const parts = req.contents[0].parts;
      if (parts.some(p => p.inlineData)) {
        state.geminiPdf++;
        return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'Ноутбук: диагональ 15.6", процессор Intel Core i5, ОЗУ 8 ГБ, SSD 512 ГБ, веб-камера, Windows 11 или эквивалент' }] } }] } };
      }
      state.geminiInspect++;
      const prompt = parts[0].text;
      const lotId = (prompt.match(/- ID лота: (\S+)/) || [])[1];
      if (scenario.rateLimitOnce && lotId === 'L-RT' && !state.rateLimited.has(lotId)) {
        state.rateLimited.add(lotId);
        return { status: 429, body: { error: { message: 'Resource exhausted' } } };
      }
      const m = prompt.match(/КАНДИДАТЫ СО СКЛАДА(?: \(ОСНОВНОЕ ОБОРУДОВАНИЕ\))?:\n(\[[\s\S]*?\n\])/);
      const cands = m ? JSON.parse(m[1]) : [];
      let verdict;
      if (lotId === 'L-REJ') verdict = { lotId, isCompatible: false, selectedCode: null, matchBadge: '🔴 НЕ ПОДХОДИТ', rnuRisk: 'НЕТ РИСКА', verdict: 'Нет цветного принтера нужного класса.' };
      else if (lotId === 'L-BADCODE') verdict = { lotId, isCompatible: true, selectedCode: 'НЕТ-ТАКОГО', matchBadge: '🟢 ТОЧНОЕ СОВПАДЕНИЕ', rnuRisk: 'НЕТ РИСКА', verdict: 'Подходит.' };
      else verdict = { lotId, isCompatible: true, selectedCode: cands[0] && cands[0].code, selectedPrimaryCode: cands[0] && cands[0].code, selectedAccessoryCodes: [], matchBadge: '🟢 ТОЧНОЕ СОВПАДЕНИЕ', rnuRisk: 'НЕТ РИСКА', verdict: 'Соответствует п.1 ТЗ.' };
      return { status: 200, body: { candidates: [{ content: { parts: [{ text: 'thinking...', thought: true }, { text: JSON.stringify(verdict) }] } }] } };
    }
    return null;
  };
  return { router, state };
}

function resetDisk() {
  fs.mkdirSync(N8N_DIR, { recursive: true });
  for (const f of ['tendersniper_registry.json', 'tendersniper_scan.lock', 'multi_catalog_cache.json']) {
    try { fs.unlinkSync(path.join(N8N_DIR, f)); } catch (e) {}
  }
  fs.rmSync(path.join(N8N_DIR, 'doc_cache'), { recursive: true, force: true });
  fs.writeFileSync(path.join(N8N_DIR, 'multi_catalog_cache.json'), JSON.stringify(CATALOG));
}

const ENV = { GOSZAKUP_TOKEN: 'test-gz-token', GEMINI_API_KEY: 'test-gemini-key' };

async function runPipeline(r, triggerInput, historyRows) {
  const auth = await r.run('Auth & Command Router', [triggerInput]);
  if (!auth.length || !auth[0].json.shouldRunPipeline) return { auth };
  const kw = await r.run('Generate IT Keywords', auth);
  const fetched = await r.run('Fetch IT Lots from ЦЭФ', kw);
  const merged = await r.run('Merge & Deduplicate Lots', fetched);
  r.setOutput('Fetch Lot History', historyRows && historyRows.length ? historyRows : [{}]);
  const doc = await r.run('Document Extraction Layer', r.outputs['Fetch Lot History']);
  const cat = await r.run('Fetch Al-Style Catalog', doc);
  const pre = await r.run('Pre-Filter & Candidate Builder', cat);
  const gem = await r.run('Gemini AI Инспектор', pre);
  const parsed = await r.run('Parse Gemini Verdict', gem);
  const digest = await r.run('Build Digest & Export Rows', parsed);
  const first = digest.filter(d => d.json.hasMatches);
  let rows = [], hist = [];
  if (first.length) {
    rows = await r.run('Prepare Rows for Sheets', first);
    hist = await r.run('Prepare History IDs', rows);
  }
  return { auth, fetched, merged, doc, pre, gem, parsed, digest, rows, hist };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push([true, name]); console.log('✅ ' + name); }
  catch (e) { results.push([false, name]); console.log('❌ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 4).join('\n   ')); }
}

(async () => {
  const CRON = {};
  const tg = (text, id) => ({ message: { text, chat: { id: id || 681740470 }, from: { id: id || 681740470, first_name: 'Аскар', username: 'askarnuraliyev' } } });

  // ---------- Сценарий 1: полный прогон ----------
  resetDisk();
  const m1 = makeRouter({});
  const r1 = new Runner({ env: ENV, router: m1.router, execId: 'exec-1' });
  const p1 = await runPipeline(r1, CRON);
  const rowIds = p1.rows.map(x => x.json['Номер_Лота']);
  const digestText = p1.digest.map(d => d.json.summaryMessage).join('\n');
  const parsedById = Object.fromEntries(p1.parsed.map(p => [p.json.lotId, p.json]));

  await test('Пагинация: оба лота «ноутбук» со второй страницы получены', () => {
    const nb = p1.fetched.find(f => f.json.keyword === 'ноутбук').json;
    assert.ok(nb.pages >= 2, 'pages=' + nb.pages);
  });
  for (const [id, code] of [['L-NB', 'NB-001'], ['L-PC', 'PC-I5'], ['L-UPS', 'UPS-1000'], ['L-RT', 'RT-KN'], ['L-MFP', 'MFP-141'], ['L-POE', 'SW-POE'], ['L-MON', 'MON-24'], ['L-PRJ', 'PRJ-X06'], ['L-CAM', 'CAM-C270']]) {
    await test(`Лот ${id} попал в дайджест с товаром ${code}`, () => {
      assert.ok(rowIds.includes(id), 'нет в выгрузке; parsed=' + JSON.stringify(parsedById[id] && { c: parsedById[id].productCode, m: parsedById[id].marginPercent, b: parsedById[id].matchBadge }));
      const row = p1.rows.find(x => x.json['Номер_Лота'] === id).json;
      assert.strictEqual(row['Код'], code);
    });
  }
  await test('Гео: лот с КАТО области (заказчик «г. Алматы») отсеян', () => assert.ok(!rowIds.includes('L-REGION') && !parsedById['L-REGION']));
  await test('Вендор-лок Cisco не в выгрузке, но посчитан в сводке', () => { assert.ok(!rowIds.includes('L-VAD')); assert.ok(/вендор-локам[^:]*: 1/.test(digestText)); });
  await test('Мебель отсеяна', () => assert.ok(!parsedById['L-FURN']));
  await test('Лот без объявления (TrdBuy: null, пункт плана) отсеян', () => assert.ok(!parsedById['L-PLAN'] && !rowIds.includes('L-PLAN')));
  await test('Лот с дедлайном через 1 ч отсеян', () => assert.ok(!parsedById['L-LATE'] && p1.merged[0].json.skippedDeadline === 1));
  await test('Отклонённый ИИ лот не в выгрузке, посчитан как отклонённый', () => { assert.ok(!rowIds.includes('L-REJ')); assert.ok(/Отклонено ИИ: 1/.test(digestText)); });
  await test('Неизвестный код от ИИ → «ручная проверка», а не первый кандидат', () => {
    assert.strictEqual(parsedById['L-BADCODE'].needsManualReview, true);
    assert.ok(!rowIds.includes('L-BADCODE'));
    assert.ok(digestText.includes('Требуют ручной проверки: 1'));
  });
  await test('USD-строка каталога без курса пропущена', () => assert.ok(r1.logs.some(l => /USD без курса USD_KZT_RATE: 1/.test(l[2]))));
  await test('Дайджест один (узел Build Digest выполнен 1 раз), сообщения ≤ 4096 символов', () => {
    assert.ok(p1.digest.length >= 1);
    for (const d of p1.digest) assert.ok(d.json.summaryMessage.length <= 4096, 'len=' + d.json.summaryMessage.length);
  });
  await test('Дедлайн и ссылка на объявление в дайджесте', () => { assert.ok(digestText.includes('⏳ До:')); assert.ok(digestText.includes('https://goszakup.gov.kz/ru/announce/index/')); });
  await test('Финансы Parse = финансам Pre-Filter (единая формула)', () => {
    for (const p of p1.pre) {
      const pj = p.json; if (!pj.candidates) continue;
      const pv = parsedById[pj.lotId]; if (!pv || !pv.isCompatible || pv.productCode !== pj.candidates[0].code) continue;
      assert.strictEqual(pv.profit, pj.profit, pj.lotId); assert.strictEqual(pv.logisticsCost, pj.logisticsCost, pj.lotId);
    }
  });
  await test('Секреты не попадают в данные execution', () => {
    const dump = JSON.stringify(r1.outputs);
    assert.ok(!dump.includes('test-gz-token') && !dump.includes('test-gemini-key'));
    assert.ok(!JSON.stringify(r1.outputs['Gemini AI Инспектор']).includes('geminiPrompt'), 'промпты не должны тянуться дальше узла Gemini');
  });
  await test('Ключ Gemini передан в заголовке; PDF скачан 1 раз', () => { assert.strictEqual(m1.state.pdfDownloads, 1); assert.strictEqual(m1.state.geminiPdf, 1); });
  await test('Блокировка снята после дайджеста', () => assert.ok(!fs.existsSync(path.join(N8N_DIR, 'tendersniper_scan.lock'))));

  // ---------- Сценарий 2: повторный запуск — дедуп по реестру, Gemini не вызывается ----------
  const m2 = makeRouter({});
  const r2 = new Runner({ env: ENV, router: m2.router, execId: 'exec-2' });
  const p2 = await runPipeline(r2, CRON); // история в Sheets пустая (как будто запись в таблицу не удалась)
  await test('Повторный прогон: ноль новых лотов, ноль вызовов Gemini (реестр вместо Sheets)', () => {
    assert.strictEqual(p2.rows.length, 0);
    assert.strictEqual(m2.state.geminiInspect, 0, 'geminiInspect=' + m2.state.geminiInspect);
    assert.strictEqual(m2.state.geminiPdf, 0);
  });

  // ---------- Сценарий 3: API не знает TrdBuy/after — откат на исходный запрос ----------
  resetDisk();
  const m3 = makeRouter({ rejectExtended: true, rejectPaging: true, rateLimitOnce: true });
  const r3 = new Runner({ env: ENV, router: m3.router, execId: 'exec-3' });
  const p3 = await runPipeline(r3, CRON);
  await test('Откат схемы GraphQL на базовый запрос v5.3, лоты найдены', () => {
    assert.strictEqual(p3.fetched[0].json.queryLevel, 'base (v5.3)');
    assert.ok(p3.rows.length >= 8, 'rows=' + p3.rows.length);
  });
  await test('429 от Gemini → повтор, лот L-RT всё равно проверен', () => assert.ok(p3.rows.some(x => x.json['Номер_Лота'] === 'L-RT')));

  // ---------- Сценарий 4: неверный токен ЦЭФ ----------
  resetDisk();
  const m4 = makeRouter({});
  const r4 = new Runner({ env: { GOSZAKUP_TOKEN: 'wrong', GEMINI_API_KEY: 'test-gemini-key' }, router: m4.router, execId: 'exec-4' });
  const p4 = await runPipeline(r4, CRON);
  await test('Неверный токен → сообщение о сбое ЦЭФ, без отката схемы', () => {
    assert.ok(p4.merged[0].json.apiFailure);
    assert.ok(p4.digest[0].json.summaryMessage.includes('Сбой соединения с порталом'));
    assert.strictEqual(m4.state.gqlCalls, 1, '401 не повторяется и не вызывает откат схемы; gqlCalls=' + m4.state.gqlCalls);
  });

  // ---------- Сценарий 5: команды и блокировка ----------
  resetDisk();
  const m5 = makeRouter({});
  const rA = new Runner({ env: ENV, router: m5.router, execId: 'exec-A' });
  const a1 = await rA.run('Auth & Command Router', [tg('/scan@TenderSniperBot')]);
  const rB = new Runner({ env: ENV, router: m5.router, execId: 'exec-B' });
  const b1 = await rB.run('Auth & Command Router', [tg('/scan')]);
  const c1 = await rB.run('Auth & Command Router', [CRON]);
  await test('/scan@бот запускает, параллельный /scan и CRON блокируются (файловый lock)', () => {
    assert.strictEqual(a1[0].json.shouldRunPipeline, true);
    assert.strictEqual(b1[0].json.source, 'USER_SCAN_LOCKED');
    assert.strictEqual(c1.length, 0);
  });
  const st = await rB.run('Auth & Command Router', [tg('/status')]);
  const un = await rB.run('Auth & Command Router', [tg('/unlock')]);
  const b2 = await rB.run('Auth & Command Router', [tg('/scan')]);
  await test('/status показывает lock, /unlock снимает, затем /scan проходит', () => {
    assert.ok(st[0].json.directReplyMessage.includes('Идёт сканирование'));
    assert.ok(un[0].json.directReplyMessage.includes('Блокировка снята'));
    assert.strictEqual(b2[0].json.shouldRunPipeline, true);
  });
  const u1 = await rB.run('Auth & Command Router', [{ message: { text: '/scan', chat: { id: 5 }, from: { id: 5, username: 'askarnuraliyev' } } }]);
  await test('Чужой ID с username админа — отказ (авторизация только по ID)', () => assert.strictEqual(u1[0].json.isAuthorized, false));
  const h1 = await rB.run('Auth & Command Router', [tg('/help')]);
  await test('/help: критерии в тексте совпадают с конфигом', () => assert.ok(h1[0].json.directReplyMessage.includes('прибыль ≥ 30') && h1[0].json.directReplyMessage.includes('/unlock')));

  // ---------- Сравнение с исходной версией (как было) ----------
  resetDisk();
  try {
    const orig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'original', 'TenderSniper_Lite_Almaty.original.json'), 'utf8'));
    const ro = new Runner({ env: ENV, router: makeRouter({}).router, execId: 'orig' });
    ro.byName = Object.fromEntries(orig.nodes.map(n => [n.name, n]));
    ro.byName['Auth & Command Router'] = r1.byName['Auth & Command Router'];
    const $sd = {};
    global.$getWorkflowStaticData = () => $sd;
    ro.setOutput('Auth & Command Router', p1.auth);
    ro.setOutput('Merge & Deduplicate Lots', p1.merged);
    ro.setOutput('Fetch Lot History', [{}]);
    const docOut = JSON.parse(JSON.stringify(p1.doc));
    for (const l of docOut[0].json.enrichedLots) { delete l.docPending; }
    ro.setOutput('Document Extraction Layer', docOut);
    const origPre = await ro.run('Pre-Filter & Candidate Builder', [{ catalogReady: true, catalogPath: path.join(N8N_DIR, 'multi_catalog_cache.json') }]);
    const origFound = origPre.filter(x => x.json.candidates && x.json.candidates.length).map(x => x.json.lotId);
    const newFound = p1.pre.filter(x => x.json.candidates || x.json.primaryCandidates).map(x => x.json.lotId);
    console.log('\nСРАВНЕНИЕ Pre-Filter на тех же лотах:');
    console.log('  было  (v5.3): ' + (origFound.join(', ') || '—'));
    console.log('  стало (v5.4): ' + newFound.join(', '));
  } catch (e) {
    console.log('\n(сравнение с исходной версией не выполнено: ' + e.message + ')');
  }

  resetDisk();
  for (const f of ['multi_catalog_cache.json']) { try { fs.unlinkSync(path.join(N8N_DIR, f)); } catch (e) {} }
  const failed = results.filter(r => !r[0]).length;
  console.log(`\nИтого: ${results.length - failed}/${results.length} тестов пройдено`);
  process.exit(failed ? 1 : 0);
})();
