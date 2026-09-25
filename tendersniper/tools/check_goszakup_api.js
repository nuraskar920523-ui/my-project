// Проверка API ЦЭФ перед интеграцией (только чтение). Запуск на сервере n8n:
//   GOSZAKUP_TOKEN=... node tools/check_goszakup_api.js
// Показывает, какой уровень запроса поддерживает API (расширенные поля / пагинация / базовый v5.3),
// формат даты окончания приёма заявок и работает ли пагинация extensions.pageInfo.
'use strict';
const https = require('https');
const TOKEN = process.env.GOSZAKUP_TOKEN;
if (!TOKEN) { console.error('Нет GOSZAKUP_TOKEN в окружении'); process.exit(2); }
const BASE = 'id lotNumber nameRu descriptionRu amount count customerNameRu trdBuyNumberAnno indexDate refTradeMethodsId plnPointKatoList Files { id filePath originalName nameRu }';
const LEVELS = [
  ['extended+paging', BASE + ' trdBuyId TrdBuy { id endDate }', true],
  ['base+paging', BASE, true],
  ['base (v5.3)', BASE, false]
];
function post(query, variables) {
  const body = JSON.stringify({ query, variables });
  return new Promise((resolve, reject) => {
    const req = https.request('https://ows.goszakup.gov.kz/v3/graphql', { method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      const c = []; res.on('data', d => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on('error', reject); req.setTimeout(45000, () => req.destroy(new Error('timeout'))); req.write(body); req.end();
  });
}
(async () => {
  for (const [name, fields, paging] of LEVELS) {
    const q = 'query T($nameRu: String' + (paging ? ', $after: Int' : '') + ') { Lots(limit: 3' + (paging ? ', after: $after' : '') +
      ', filter: { refLotStatusId: [110, 210, 220, 230, 240], nameRu: $nameRu }) { ' + fields + ' } }';
    const r = await post(q, { nameRu: 'ноутбук' });
    const ok = r.status === 200 && r.json && r.json.data && !(r.json.errors && r.json.errors.length);
    console.log(`\n[${ok ? 'OK ' : 'ERR'}] уровень «${name}»: HTTP ${r.status}`);
    if (!ok) { console.log('  ' + JSON.stringify(r.json && (r.json.errors || r.json)).substring(0, 400)); if (r.status === 401 || r.status === 403) process.exit(1); continue; }
    const lots = r.json.data.Lots || [];
    console.log('  лотов в ответе: ' + lots.length + ' | extensions.pageInfo: ' + JSON.stringify(r.json.extensions && r.json.extensions.pageInfo || null));
    if (lots[0]) console.log('  пример: ' + JSON.stringify({ id: lots[0].id, lotNumber: lots[0].lotNumber, trdBuyId: lots[0].trdBuyId, endDate: lots[0].TrdBuy && lots[0].TrdBuy.endDate, kato: lots[0].plnPointKatoList, method: lots[0].refTradeMethodsId }));
    const pi = r.json.extensions && r.json.extensions.pageInfo;
    if (paging && pi && pi.hasNextPage && pi.lastId) {
      const r2 = await post(q, { nameRu: 'ноутбук', after: pi.lastId });
      const l2 = (r2.json && r2.json.data && r2.json.data.Lots) || [];
      const overlap = l2.filter(x => lots.some(y => y.id === x.id)).length;
      console.log('  страница 2: ' + l2.length + ' лотов, пересечение со страницей 1: ' + overlap + (overlap ? '  <-- ПАГИНАЦИЯ НЕ РАБОТАЕТ' : '  (пагинация работает)'));
    }
    console.log('\nИТОГ: workflow будет использовать уровень «' + name + '».');
    process.exit(0);
  }
  console.log('\nИТОГ: ни один уровень не принят API — интеграцию НЕ продолжать, сообщить владельцу.');
  process.exit(1);
})().catch(e => { console.error('Сетевая ошибка: ' + e.message); process.exit(1); });
