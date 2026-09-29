// Тесты радара демпинга: Radar Collector на моках ЦЭФ + оценка риска + блок в дайджесте.
// Запуск только в одноразовом контейнере (пишет в /home/node/.n8n):
//   docker run --rm -e TS_TEST_SANDBOX=1 -v "$PWD":/w -w /w node:22 node test/run_radar_tests.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { Runner } = require('./harness');

const N8N_DIR = '/home/node/.n8n';
const dirHasFiles = fs.existsSync(N8N_DIR) && fs.readdirSync(N8N_DIR).length > 0;
if (process.env.TS_TEST_SANDBOX !== '1' && dirHasFiles) {
  console.error('ОТКАЗ: ' + N8N_DIR + ' не пуст. Запускайте в одноразовом контейнере с TS_TEST_SANDBOX=1.');
  process.exit(2);
}
fs.mkdirSync(N8N_DIR, { recursive: true });
const DB_PATH = path.join(N8N_DIR, 'tendersniper_radar_db.json');
const LOCK_PATH = path.join(N8N_DIR, 'tendersniper_radar.lock');
const cleanup = () => { for (const f of [DB_PATH, LOCK_PATH, DB_PATH + '.tmp']) { try { fs.unlinkSync(f); } catch (e) {} } };

// Библиотеки радара для прямых проверок
const lib = {};
vm.runInNewContext(['config', 'radar_seed', 'radar'].map(n => fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', n + '.js'), 'utf8')).join('\n') +
  '\nOUT.cat = tsRadarCategory; OUT.index = tsRadarBuildIndex; OUT.assess = tsRadarAssess; OUT.econ = tsRadarEconomics; OUT.load = tsLoadRadarDb;', { OUT: lib, require });

const C1 = '961140001260';            // заказчик в Алматы
const WIN_SMALL = '020115600147';     // победитель ЗЦП 17454510 (реальный пример из отчёта)
const VINITA = '990940000600';        // из стартового списка (dumper)

// ---------- Мок ЦЭФ GraphQL ----------
function makeRouter() {
  const calls = [];
  const router = async (url, options, body) => {
    if (!url.startsWith('https://ows.goszakup.gov.kz/v3/graphql')) return null;
    if ((options.headers || {}).Authorization !== 'Bearer tok') return { status: 401, body: {} };
    const { query, variables: v } = JSON.parse(body);
    calls.push(query.replace(/\s+/g, ' ').substring(0, 60));
    const ok = (data) => ({ status: 200, body: { data } });
    if (/Lots\(limit: 100, filter: \{ nameRu/.test(query)) {
      if (v.nameRu !== 'принтер') return ok({ Lots: [] });
      return ok({ Lots: [
        { id: 1, trdBuyId: 17454510, customerBin: C1, customerNameRu: 'КГУ Школа', plnPointKatoList: ['751110000'] },
        { id: 2, trdBuyId: 999, customerBin: '111', customerNameRu: 'Область', plnPointKatoList: ['191010000'] }
      ] });
    }
    if (/Contract\(limit: 50, filter: \{ customerBin/.test(query)) {
      return ok({ Contract: v.bin === C1 ? [{ trdBuyId: 17454510 }, { trdBuyId: 17428584 }, { trdBuyId: 555 }, { trdBuyId: 0 }] : [] });
    }
    if (/Contract\(limit: 50, filter: \{ trdBuyId/.test(query)) {
      if (v.id === 17454510) return ok({ Contract: [{ supplierBiin: WIN_SMALL, contractSum: 70705, signDate: '2026-08-01 10:00:00', trdBuyNumberAnno: '17454510-1', faktTradeMethodsId: 3, ContractUnits: [{ lotId: 1, totalSum: 70705 }] }] });
      if (v.id === 17428584) return ok({ Contract: [
        { supplierBiin: VINITA, contractSum: 600000, signDate: '2026-08-08 08:45:57', trdBuyNumberAnno: '17428584-1', faktTradeMethodsId: 3, ContractUnits: [{ lotId: 11, totalSum: 450000 }, { lotId: 12, totalSum: 150000 }] }
      ] });
      return ok({ Contract: [] });
    }
    if (/Lots\(limit: 100, filter: \{ trdBuyId/.test(query)) {
      if (v.id === 17454510) return ok({ Lots: [{ id: 1, lotNumber: 'L1', nameRu: 'Ноутбук', amount: 80000, count: 1, dumping: 0, refTradeMethodsId: 3, customerBin: C1, trdBuyNumberAnno: '17454510-1' }] });
      if (v.id === 17428584) return ok({ Lots: [
        { id: 11, lotNumber: 'L11', nameRu: 'Картридж HP CF259A', amount: 1200000, count: 100, dumping: 1, refTradeMethodsId: 3, customerBin: C1, trdBuyNumberAnno: '17428584-1' },
        { id: 12, lotNumber: 'L12', nameRu: 'Картридж Canon 725', amount: 400000, count: 100, dumping: 0, refTradeMethodsId: 3, customerBin: C1, trdBuyNumberAnno: '17428584-1' }
      ] });
      return ok({ Lots: [] });
    }
    if (/TrdApp\(limit: 100/.test(query)) {
      if (v.id === 17454510) return ok({ TrdApp: [
        { supplierBinIin: '750308404257', AppLots: [{ lotId: 1, amount: 77200, statusId: 1 }] },
        { supplierBinIin: WIN_SMALL, AppLots: [{ lotId: 1, amount: 70705, statusId: 1 }] },
        { supplierBinIin: '620319300251', AppLots: [{ lotId: 1, amount: 79375, statusId: 1 }] }
      ] });
      if (v.id === 17428584) return ok({ TrdApp: [
        { supplierBinIin: VINITA, AppLots: [{ lotId: 11, amount: 450000 }, { lotId: 12, amount: 150000 }] },
        { supplierBinIin: '151040004133', AppLots: [{ lotId: 11, amount: 900000 }, { lotId: 12, amount: 380000 }] }
      ] });
      return ok({ TrdApp: [] });
    }
    if (/Subjects/.test(query)) {
      const names = { [VINITA]: 'ТОО "Винита Систем"', '151040004133': 'ТОО "Тест Поставщик"' };
      if (/bin: \$v/.test(query)) return ok({ Subjects: names[v.v] ? [{ nameRu: names[v.v] }] : [] });
      return ok({ Subjects: [] });
    }
    return { status: 200, body: { errors: [{ message: 'unexpected query' }] } };
  };
  return { router, calls };
}

const results = [];
async function test(name, fn) {
  try { await fn(); results.push(true); console.log('✅ ' + name); }
  catch (e) { results.push(false); console.log('❌ ' + name + '\n   ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n   ')); }
}

(async () => {
  cleanup();
  // ---------- 1. Коллектор ----------
  const m1 = makeRouter();
  const r1 = new Runner({ workflow: 'TenderSniper_Radar_Collector.json', env: { GOSZAKUP_TOKEN: 'tok' }, router: m1.router, execId: 'radar-1' });
  // Курсор ключевых слов: ставим «принтер» первым в порции
  const out1 = await r1.run('Radar Collector', [{}]);
  let db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));

  await test('Коллектор завершился без ошибок, блокировка снята', () => {
    assert.strictEqual(out1[0].json.ok, true, JSON.stringify(out1[0].json));
    assert.deepStrictEqual(out1[0].json.errors, []);
    assert.ok(!fs.existsSync(LOCK_PATH));
  });
  await test('Реальный пример 17454510: победитель 020115600147, скидка 11.6%, 3 заявки по возрастанию', () => {
    const l = db.lots['1'];
    assert.strictEqual(l.w, WIN_SMALL);
    assert.strictEqual(l.wa, 70705);
    assert.strictEqual(l.dp, 0.1162);
    assert.deepStrictEqual(l.bids.map(b => b[1]), [70705, 77200, 79375]);
    assert.strictEqual(l.nb, 3);
    assert.strictEqual(l.k, 'laptop');
  });
  await test('Многолотовое объявление: победитель по лоту через ContractUnits.lotId', () => {
    assert.strictEqual(db.lots['11'].w, VINITA);
    assert.strictEqual(db.lots['11'].dp, 0.625);
    assert.strictEqual(db.lots['12'].dp, 0.625);
    assert.strictEqual(db.lots['11'].dmp, 1);
  });
  await test('Лоты другого региона (КАТО 19*) не попадают в очередь', () => assert.ok(!db.queue['999'] && !db.done['999']));
  await test('Объявление без договора остаётся в очереди на перепроверку через 7 дней', () => {
    assert.strictEqual(db.queue['555'].attempts, 1);
    assert.ok(db.queue['555'].nextCheck > Date.now() + 6 * 86400000);
  });
  await test('Названия частых участников подтянуты из Subjects', () => assert.strictEqual(db.suppliers[VINITA], 'ТОО "Винита Систем"'));

  const m2 = makeRouter();
  const r2 = new Runner({ workflow: 'TenderSniper_Radar_Collector.json', env: { GOSZAKUP_TOKEN: 'tok' }, router: m2.router, execId: 'radar-2' });
  const out2 = await r2.run('Radar Collector', [{}]);
  await test('Повторный запуск: обработанные объявления не запрашиваются снова', () => {
    assert.strictEqual(out2[0].json.trdBuysProcessed, 0);
    assert.ok(!m2.calls.some(c => /TrdApp/.test(c)));
  });

  fs.writeFileSync(LOCK_PATH, JSON.stringify({ owner: 'other', ts: Date.now() }));
  const r3 = new Runner({ workflow: 'TenderSniper_Radar_Collector.json', env: { GOSZAKUP_TOKEN: 'tok' }, router: makeRouter().router, execId: 'radar-3' });
  const out3 = await r3.run('Radar Collector', [{}]);
  fs.unlinkSync(LOCK_PATH);
  await test('Параллельный запуск коллектора пропускается (своя блокировка)', () => assert.strictEqual(out3[0].json.skipped, 'locked'));

  // ---------- 2. Оценка риска ----------
  db = lib.load(fs);
  const idx = lib.index(db);
  await test('Категории: ноутбук / картридж / веб-камера / коммутатор', () => {
    assert.strictEqual(lib.cat('Ноутбук 15.6'), 'laptop');
    assert.strictEqual(lib.cat('Картридж HP 59A'), 'consumables');
    assert.strictEqual(lib.cat('Веб-камера Logitech'), 'peripherals');
    assert.strictEqual(lib.cat('Коммутатор PoE'), 'network');
  });
  const ra = lib.assess(idx, { customerBin: C1, name: 'Картридж для принтера', budget: 300000 });
  const econ = lib.econ(ra, { budget: 300000, totalCost: 150000, logistics: 3000 });
  await test('Картриджи у заказчика с демпингёром: ожидаемая скидка 62.5%, риск ВЫСОКИЙ, результат в минусе', () => {
    assert.strictEqual(ra.basis, 'заказчик, расходники');
    assert.strictEqual(ra.n, 2);
    assert.strictEqual(ra.expDiscount, 0.625);
    assert.strictEqual(ra.competitors[0].bin, VINITA);
    assert.strictEqual(ra.competitors[0].dumper, true);
    assert.strictEqual(econ.risk, 'high');
    assert.ok(econ.profitAtExp < 0);
    assert.strictEqual(econ.breakeven, Math.ceil(153000 / 0.97));
  });
  const raU = lib.assess(idx, { customerBin: '000000000000', name: 'Проектор', budget: 500000 });
  await test('Нет истории → «НЕТ ДАННЫХ», без выдуманных цифр', () => {
    assert.strictEqual(raU.expDiscount, null);
    assert.strictEqual(lib.econ(raU, { budget: 500000, totalCost: 300000, logistics: 4500 }).risk, 'unknown');
  });

  // ---------- 3. Блок в дайджесте ----------
  const lotItem = {
    isCompatible: true, productCode: 'CRT-59A', productName: 'Картридж HP 59A', matchBadge: '🟢 ТОЧНОЕ СОВПАДЕНИЕ', rnuRisk: 'НЕТ РИСКА',
    lotId: 'L-TEST', lotName: 'Картридж для принтера', lotQty: 5, lotBudget: 300000, targetBid: 270000, totalCost: 150000, logisticsCost: 3000,
    totalTax: 8100, profit: 108900, marginPercent: 40.3, customerBin: C1, directUrl: 'https://goszakup.gov.kz/ru/announce/index/1', aiVerdict: 'ok', tradeMethodId: 3
  };
  const rd = new Runner({ env: {}, router: async () => null, execId: 'digest-1' });
  rd.setOutput('Auth & Command Router', [{ chatId: 1, lockOwner: null }]);
  const dg = await rd.run('Build Digest & Export Rows', [lotItem]);
  const text = dg.map(x => x.json.summaryMessage).join('\n');
  await test('Дайджест: строка риска, соперник с ⚠️, ожидаемый результат и предел цены', () => {
    assert.ok(text.includes('⚔️ Риск демпинга: <b>🔴 ВЫСОКИЙ</b>'), text);
    assert.ok(text.includes('⚠️ТОО &quot;Винита Систем&quot;'), text);
    assert.ok(text.includes('ваш предел:'), text);
    assert.ok(dg[0].json.rowsToExport[0]['Статус'].includes('демпинг: ВЫСОКИЙ'));
  });

  cleanup();
  const rd2 = new Runner({ env: {}, router: async () => null, execId: 'digest-2' });
  rd2.setOutput('Auth & Command Router', [{ chatId: 1, lockOwner: null }]);
  const dg2 = await rd2.run('Build Digest & Export Rows', [lotItem]);
  await test('Без базы радара дайджест работает как раньше (без блока риска)', () => {
    const t = dg2.map(x => x.json.summaryMessage).join('\n');
    assert.ok(t.includes('Лот № L-TEST') && !t.includes('⚔️'));
  });

  cleanup();
  const failed = results.filter(x => !x).length;
  console.log(`\nИтого радар: ${results.length - failed}/${results.length} тестов пройдено`);
  process.exit(failed ? 1 : 0);
})();
