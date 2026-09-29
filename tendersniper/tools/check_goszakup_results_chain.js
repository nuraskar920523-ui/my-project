// Шаг 2 проверки API для «радара демпинга» (только чтение, ~25 запросов).
// Берёт несколько реальных договоров по ЗЦП и проходит цепочку:
//   Contract → TrdBuy → Lots → TrdApp (заявки участников + AppLots с ценами) → ContractUnits.
// Запуск на сервере n8n:  GOSZAKUP_TOKEN=... node tools/check_goszakup_results_chain.js
// Результат: сводка в консоли + ./goszakup_results_chain_report.json (прислать разработчику целиком).
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');

const TOKEN = process.env.GOSZAKUP_TOKEN;
const BASE = (process.env.GOSZAKUP_BASE || 'https://ows.goszakup.gov.kz').replace(/\/$/, '');
const GQL = BASE + '/v3/graphql';
const REPORT_PATH = process.env.REPORT_PATH || './goszakup_results_chain_report.json';
const CHAINS = Number(process.env.CHAINS || 3);
if (!TOKEN) { console.error('Нет GOSZAKUP_TOKEN в окружении'); process.exit(2); }

const report = { startedAt: new Date().toISOString(), types: {}, filters: {}, lotsDumpingSample: null, chains: [], conclusions: {} };
let requests = 0;

function gql(query, variables) {
  if (++requests > 80) return Promise.reject(new Error('лимит запросов скрипта'));
  const payload = JSON.stringify({ query, variables: variables || {} });
  const client = GQL.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(GQL, { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    req.write(payload); req.end();
  });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const unwrap = (t) => { while (t && (t.kind === 'NON_NULL' || t.kind === 'LIST')) t = t.ofType; return t || {}; };
const TYPE_REF = 'type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }';
const errOf = (r) => (r.json && r.json.errors) ? r.json.errors.map(e => e.message).join(' | ').substring(0, 300) : ('HTTP ' + r.status);

async function describe(name) {
  const r = await gql(`{ __type(name: "${name}") { name fields { name ${TYPE_REF} } inputFields { name ${TYPE_REF} } } }`);
  const t = r.json && r.json.data && r.json.data.__type;
  if (!t) return null;
  const list = (t.fields || t.inputFields || []).map(f => ({ name: f.name, type: unwrap(f.type).name, kind: unwrap(f.type).kind }));
  return { scalars: list.filter(f => f.kind === 'SCALAR' || f.kind === 'ENUM').map(f => f.name), objects: list.filter(f => f.kind === 'OBJECT').map(f => f.name + ':' + f.type), all: list.map(f => f.name + ':' + f.type) };
}

async function main() {
  // 1. Описание вложенных типов, которых не было в первом отчёте
  for (const t of ['TrdAppLots', 'ContractUnits', 'Lots', 'TrdAppFiltersInput', 'LotsFiltersInput', 'ContractFiltersInput', 'ContractUnitsFiltersInput']) {
    const d = await describe(t);
    if (t.endsWith('Input')) report.filters[t] = d ? d.all : null; else report.types[t] = d;
    console.log((d ? '✅ ' : '❌ ') + t + (d ? ': ' + d.all.join(', ') : ' — тип не найден'));
  }
  const appLotsScalars = (report.types.TrdAppLots && report.types.TrdAppLots.scalars) || [];
  const unitsScalars = (report.types.ContractUnits && report.types.ContractUnits.scalars) || [];
  const lotsScalars = (report.types.Lots && report.types.Lots.scalars) || [];
  const lotFilterFields = (report.filters.LotsFiltersInput || []).map(x => x.split(':')[0]);

  // 2. Пример поля dumping у лотов
  if (lotsScalars.includes('dumping')) {
    const r = await gql(`{ Lots(limit: 50) { id lotNumber amount dumping refLotStatusId trdBuyId } }`);
    const rows = (r.json && r.json.data && r.json.data.Lots) || [];
    const values = {};
    for (const l of rows) values[JSON.stringify(l.dumping)] = (values[JSON.stringify(l.dumping)] || 0) + 1;
    report.lotsDumpingSample = { distinctValues: values, examples: rows.filter(l => l.dumping && l.dumping !== '0' && l.dumping !== 0).slice(0, 5), error: rows.length ? null : errOf(r) };
    console.log('\nПоле Lots.dumping, значения в 50 свежих лотах: ' + JSON.stringify(values));
  }

  // 3. Реальные договоры по ЗЦП (faktTradeMethodsId=3) с привязкой к объявлению
  const cr = await gql(`{ Contract(limit: 30, filter: { faktTradeMethodsId: 3 }) { id trdBuyId trdBuyNumberAnno supplierBiin contractSum contractSumWnds customerBin signDate refContractStatusId } }`);
  const contracts = ((cr.json && cr.json.data && cr.json.data.Contract) || []).filter(c => c.trdBuyId > 0);
  console.log('\nДоговоров ЗЦП с trdBuyId: ' + contracts.length + (contracts.length ? '' : ' (' + errOf(cr) + ')'));

  const seen = new Set();
  for (const c of contracts) {
    if (report.chains.length >= CHAINS) break;
    if (seen.has(c.trdBuyId)) continue;
    seen.add(c.trdBuyId);
    const chain = { contract: c, trdBuy: null, lots: null, apps: null, units: null, errors: [] };

    const tb = await gql(`{ TrdBuy(filter: { id: ${c.trdBuyId} }, limit: 1) { id numberAnno nameRu totalSum countLots refTradeMethodsId refBuyStatusId orgBin customerBin kato endDate itogiDatePublic biinSupplier } }`);
    chain.trdBuy = (tb.json && tb.json.data && tb.json.data.TrdBuy || [])[0] || null;
    if (!chain.trdBuy) chain.errors.push('TrdBuy: ' + errOf(tb));

    const lotKey = lotFilterFields.includes('trdBuyId') ? `trdBuyId: ${c.trdBuyId}` : (lotFilterFields.includes('trdBuyNumberAnno') ? `trdBuyNumberAnno: "${c.trdBuyNumberAnno}"` : null);
    if (lotKey) {
      const lf = lotsScalars.filter(n => /^(id|lotNumber|nameRu|amount|count|dumping|refLotStatusId|trdBuyId|customerBin|plnPointKatoList|enstruList)$/.test(n));
      const lr = await gql(`{ Lots(filter: { ${lotKey} }, limit: 20) { ${(lf.length ? lf : ['id']).join(' ')} } }`);
      chain.lots = (lr.json && lr.json.data && lr.json.data.Lots) || null;
      if (!chain.lots) chain.errors.push('Lots: ' + errOf(lr));
    } else chain.errors.push('Lots: нет фильтра по trdBuyId/trdBuyNumberAnno');

    const ar = await gql(`{ TrdApp(filter: { buyId: ${c.trdBuyId} }, limit: 50) { id supplierId supplierBinIin dateApply protNumber ${appLotsScalars.length ? 'AppLots { ' + appLotsScalars.join(' ') + ' }' : ''} } }`);
    chain.apps = (ar.json && ar.json.data && ar.json.data.TrdApp) || null;
    if (!chain.apps) chain.errors.push('TrdApp: ' + errOf(ar));

    if (unitsScalars.length) {
      const ur = await gql(`{ Contract(filter: { id: ${c.id} }, limit: 1) { id ContractUnits { ${unitsScalars.join(' ')} } } }`);
      const row = (ur.json && ur.json.data && ur.json.data.Contract || [])[0];
      chain.units = row ? row.ContractUnits : null;
      if (!row) chain.errors.push('ContractUnits: ' + errOf(ur));
    }
    report.chains.push(chain);
    await sleep(300);
  }

  // 4. Выводы
  const priceFields = appLotsScalars.filter(n => /price|sum|amount|cost/i.test(n));
  const lotLinkFields = appLotsScalars.filter(n => /lot/i.test(n));
  const appsWithPrices = report.chains.reduce((s, ch) => s + (ch.apps || []).filter(a => a.AppLots && [].concat(a.AppLots).some(al => priceFields.some(p => al && al[p]))).length, 0);
  report.conclusions = {
    appLotsFields: appLotsScalars,
    participantPriceFields: priceFields,
    appLotToLotLink: lotLinkFields,
    chainsBuilt: report.chains.length,
    appsFound: report.chains.reduce((s, ch) => s + (ch.apps ? ch.apps.length : 0), 0),
    appsWithPrices,
    contractUnitsFields: unitsScalars,
    lotsHasDumping: lotsScalars.includes('dumping')
  };
  report.requests = requests;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  console.log('\n================ ИТОГ ================');
  for (const ch of report.chains) {
    console.log(`\nОбъявление ${ch.contract.trdBuyNumberAnno}: бюджет ${ch.trdBuy ? ch.trdBuy.totalSum : '?'} → договор ${ch.contract.contractSum} (победитель ${ch.contract.supplierBiin})`);
    console.log('  лотов: ' + (ch.lots ? ch.lots.length : '?') + ' | заявок участников: ' + (ch.apps ? ch.apps.length : '?'));
    for (const a of (ch.apps || []).slice(0, 6)) {
      const al = [].concat(a.AppLots || []).filter(Boolean);
      console.log('   • ' + a.supplierBinIin + ': ' + (al.length ? al.map(x => priceFields.map(p => p + '=' + x[p]).join(' ')).join(' ; ') : 'AppLots пусто'));
    }
    if (ch.errors.length) console.log('  ошибки: ' + ch.errors.join(' | '));
  }
  const c = report.conclusions;
  console.log('\n' + (c.participantPriceFields.length ? '✅' : '❌') + ' Поля цены в заявке участника (AppLots): ' + (c.participantPriceFields.join(', ') || 'нет'));
  console.log((c.appsWithPrices ? '✅' : '❌') + ' Заявок с заполненной ценой: ' + c.appsWithPrices + ' из ' + c.appsFound);
  console.log((c.appLotToLotLink.length ? '✅' : '❌') + ' Связь заявки с лотом: ' + (c.appLotToLotLink.join(', ') || 'нет'));
  console.log((c.lotsHasDumping ? '✅' : '❌') + ' Поле Lots.dumping');
  console.log('\nПолный отчёт: ' + REPORT_PATH + ' — прислать разработчику целиком. Запросов: ' + requests);
}

main().catch(e => { report.fatal = e.message; report.requests = requests; fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2)); console.error('Ошибка: ' + e.message); process.exit(1); });
