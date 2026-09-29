// Проверка: отдаёт ли API ЦЭФ итоги закупок (победитель, итоговая сумма, участники) — для «радара демпинга».
// Только чтение. Запуск на сервере n8n (токен из окружения, в вывод не печатается):
//   GOSZAKUP_TOKEN=... node tools/check_goszakup_results_api.js
// Результат: сводка в консоли + полный отчёт в ./goszakup_results_api_report.json (его прислать разработчику).
'use strict';
const https = require('https');
const http = require('http');
const fs = require('fs');

const TOKEN = process.env.GOSZAKUP_TOKEN;
const BASE = (process.env.GOSZAKUP_BASE || 'https://ows.goszakup.gov.kz').replace(/\/$/, '');
const GQL = BASE + '/v3/graphql';
const REPORT_PATH = process.env.REPORT_PATH || './goszakup_results_api_report.json';
if (!TOKEN) { console.error('Нет GOSZAKUP_TOKEN в окружении'); process.exit(2); }

const INTERESTING = /contract|trdapp|app|result|winner|protocol|trdbuy|bid|offer|subject|supplier|participant/i;
const report = { startedAt: new Date().toISOString(), endpoint: GQL, introspection: null, rootFields: [], probes: [], rest: [], conclusions: {} };
let requests = 0;
const MAX_REQUESTS = 120;
const GUESS_FIELDS = ['supplierBiin', 'supplierBin', 'supplierId', 'contractSum', 'contractSumWnds', 'faktSum', 'price', 'amount',
  'customerBin', 'customerBiin', 'trdBuyId', 'lotId', 'signDate', 'refContractStatusId', 'refTradeMethodsId'];

function request(method, url, body) {
  if (++requests > MAX_REQUESTS) return Promise.reject(new Error('лимит запросов скрипта'));
  const payload = body ? JSON.stringify(body) : null;
  const client = url.startsWith('https') ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { Authorization: 'Bearer ' + TOKEN, Accept: 'application/json' };
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
    const req = client.request(url, { method, headers }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => { const t = Buffer.concat(c).toString(); let j = null; try { j = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, json: j, text: t.substring(0, 500) }); });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}
const gql = (query, variables) => request('POST', GQL, { query, variables: variables || {} });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const unwrap = (t) => { while (t && (t.kind === 'NON_NULL' || t.kind === 'LIST')) t = t.ofType; return t || {}; };
const TYPE_REF = 'type { name kind ofType { name kind ofType { name kind ofType { name kind } } } }';

async function typeInfo(name) {
  const r = await gql(`{ __type(name: "${name}") { name kind fields { name ${TYPE_REF} } inputFields { name ${TYPE_REF} } } }`);
  return r.json && r.json.data && r.json.data.__type;
}

function shortErr(r) {
  const e = r.json && r.json.errors;
  return e ? e.map(x => x.message).join(' | ').substring(0, 400) : ('HTTP ' + r.status + ' ' + (r.text || '').substring(0, 200));
}

// Поля, по которым видно «кто победил и за сколько»
const KEY_PATTERNS = {
  winnerBin: /supplier.*bi[i]?n|bi[i]?n.*supplier|winner|supplierId/i,
  finalSum: /contract.*sum|sum.*contract|price|amount|total/i,
  customer: /customer/i,
  lotOrTrdBuy: /lot|trdbuy|trd_buy/i,
  date: /date|sign/i,
  status: /status/i
};

async function main() {
  // 1. Интроспекция корня
  const intro = await gql(`{ __schema { queryType { fields { name args { name ${TYPE_REF} } ${TYPE_REF} } } } }`);
  const rootFields = intro.json && intro.json.data && intro.json.data.__schema && intro.json.data.__schema.queryType.fields;
  report.introspection = rootFields ? 'OK' : ('НЕДОСТУПНА: ' + shortErr(intro));
  console.log('Интроспекция схемы: ' + report.introspection);
  if (intro.status === 401 || intro.status === 403) { console.error('Токен отклонён (HTTP ' + intro.status + ')'); save(); process.exit(1); }

  let candidates = [];
  if (rootFields) {
    report.rootFields = rootFields.map(f => ({ name: f.name, returns: unwrap(f.type).name, args: f.args.map(a => a.name + ':' + (unwrap(a.type).name || '?')) }));
    console.log('\nКорневые запросы (' + rootFields.length + '): ' + rootFields.map(f => f.name).join(', '));
    candidates = rootFields.filter(f => INTERESTING.test(f.name) || INTERESTING.test(unwrap(f.type).name || ''));
  } else {
    // Интроспекция закрыта — пробуем типичные имена; ошибки API часто подсказывают правильные («Did you mean …»)
    candidates = ['Contract', 'Contracts', 'TrdApp', 'TrdApps', 'TrdBuy', 'TrdBuys', 'Subjects', 'Subject'].map(n => ({ name: n, args: [], guessed: true }));
  }

  // 2. Пробные запросы к интересным сущностям
  for (const f of candidates) {
    const probe = { root: f.name, returnType: null, filterFields: [], fields: [], ok: false, sample: null, error: null, keyFields: {} };
    let scalarFields = ['id'];
    if (!f.guessed) {
      const tName = unwrap(f.type).name;
      probe.returnType = tName;
      const t = tName ? await typeInfo(tName) : null;
      if (t && t.fields) {
        probe.fields = t.fields.map(x => x.name + ':' + (unwrap(x.type).name || '?'));
        scalarFields = t.fields.filter(x => { const u = unwrap(x.type); return u.kind === 'SCALAR' || u.kind === 'ENUM'; }).map(x => x.name).slice(0, 60);
        const nested = t.fields.filter(x => unwrap(x.type).kind === 'OBJECT').map(x => x.name);
        probe.nestedObjects = nested;
      }
      const filterArg = (f.args || []).find(a => a.name === 'filter');
      if (filterArg) {
        const ft = await typeInfo(unwrap(filterArg.type).name);
        if (ft && ft.inputFields) probe.filterFields = ft.inputFields.map(x => x.name + ':' + (unwrap(x.type).name || '?'));
      }
    }
    for (const [key, re] of Object.entries(KEY_PATTERNS)) probe.keyFields[key] = scalarFields.filter(n => re.test(n));

    const hasLimit = f.guessed || (f.args || []).some(a => a.name === 'limit');
    const requiredArgs = (f.args || []).filter(a => a.type && a.type.kind === 'NON_NULL' && a.name !== 'limit');
    if (requiredArgs.length) { probe.error = 'требует аргументы: ' + requiredArgs.map(a => a.name).join(', '); report.probes.push(probe); continue; }
    const q = `{ ${f.name}${hasLimit ? '(limit: 2)' : ''} { ${scalarFields.join(' ')} } }`;
    const r = await gql(q);
    const data = r.json && r.json.data && r.json.data[f.name];
    if (r.status === 200 && data !== undefined && !(r.json.errors && r.json.errors.length)) {
      probe.ok = true;
      probe.sample = Array.isArray(data) ? data.slice(0, 2) : data;
      probe.pageInfo = r.json.extensions && r.json.extensions.pageInfo || null;
      if (f.guessed) {
        // Схема закрыта: проверяем типичные имена полей по одному
        const accepted = ['id'];
        for (const fld of GUESS_FIELDS) {
          const rf = await gql(`{ ${f.name}(limit: 1) { id ${fld} } }`);
          if (rf.status === 200 && rf.json && rf.json.data && !(rf.json.errors && rf.json.errors.length)) accepted.push(fld);
          await sleep(150);
        }
        probe.fields = accepted;
        for (const [key, re] of Object.entries(KEY_PATTERNS)) probe.keyFields[key] = accepted.filter(n => re.test(n));
        const rs = await gql(`{ ${f.name}(limit: 2) { ${accepted.join(' ')} } }`);
        if (rs.json && rs.json.data) probe.sample = rs.json.data[f.name];
      }
    } else {
      probe.error = shortErr(r);
    }
    report.probes.push(probe);
    await sleep(300);
  }

  // 3. REST v3 (на случай, если итоги есть только там)
  for (const path of ['/v3/contract', '/v3/trd-buy', '/v3/trd-app', '/v3/lots', '/v3/subject/all']) {
    try {
      const r = await request('GET', BASE + path + '?limit=1');
      const items = r.json && (r.json.items || r.json.data || (Array.isArray(r.json) ? r.json : null));
      const first = Array.isArray(items) ? items[0] : (r.json && typeof r.json === 'object' ? r.json : null);
      report.rest.push({ path, status: r.status, keys: first ? Object.keys(first).slice(0, 60) : null, total: r.json && (r.json.total || r.json.totalCount) || null });
    } catch (e) {
      report.rest.push({ path, error: e.message });
    }
    await sleep(300);
  }

  // 4. Выводы
  const okProbes = report.probes.filter(p => p.ok);
  const restOk = report.rest.filter(r => r.status === 200 && r.keys);
  const anyKey = (k) => okProbes.filter(p => p.keyFields[k] && p.keyFields[k].length).map(p => p.root + ': ' + p.keyFields[k].join(', '))
    .concat(restOk.map(r => ({ path: r.path, keys: r.keys.filter(x => KEY_PATTERNS[k].test(x.replace(/_/g, ''))) })).filter(x => x.keys.length).map(x => 'REST ' + x.path + ': ' + x.keys.join(', ')));
  report.conclusions = {
    winnerBin: anyKey('winnerBin'),
    finalSum: anyKey('finalSum'),
    customer: anyKey('customer'),
    linkToLotOrTrdBuy: anyKey('lotOrTrdBuy'),
    participantsOrBids: okProbes.filter(p => /app|bid|offer|participant/i.test(p.root)).map(p => p.root),
    restAvailable: report.rest.filter(r => r.status === 200).map(r => r.path)
  };
  save();

  console.log('\n================ ИТОГ ================');
  for (const p of report.probes) console.log((p.ok ? '✅ ' : '❌ ') + p.root + (p.returnType ? ' → ' + p.returnType : '') + (p.ok ? '' : ' — ' + p.error));
  console.log('\nREST: ' + report.rest.map(r => r.path + '=' + (r.status || r.error)).join(', '));
  const c = report.conclusions;
  const line = (label, arr) => console.log((arr.length ? '✅ ' : '❌ ') + label + (arr.length ? ': ' + arr.join(' ; ') : ': не найдено'));
  console.log('');
  line('БИН победителя/поставщика', c.winnerBin);
  line('Итоговая сумма/цена', c.finalSum);
  line('Заказчик', c.customer);
  line('Связь с лотом/объявлением', c.linkToLotOrTrdBuy);
  line('Участники и их ценовые предложения', c.participantsOrBids);
  line('REST-эндпоинты', c.restAvailable);
  console.log('\nПолный отчёт: ' + REPORT_PATH + ' — прислать разработчику целиком.');
}

function save() {
  report.requests = requests;
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
}

main().catch(e => { report.fatal = e.message; save(); console.error('Ошибка: ' + e.message); process.exit(1); });
