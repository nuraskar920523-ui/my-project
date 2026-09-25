// Проверка файла каталога (только чтение): ключи строк, дистрибьюторы, валюта, какие цены выберет Pre-Filter.
//   node tools/inspect_catalog.js [/home/node/.n8n/multi_catalog_cache.json]
'use strict';
const fs = require('fs');
const p = process.argv[2] || '/home/node/.n8n/multi_catalog_cache.json';
const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
if (!Array.isArray(rows)) { console.error('Каталог не массив'); process.exit(1); }
console.log('Файл: ' + p + ' | строк: ' + rows.length);
const byDist = {};
for (const r of rows) {
  const d = r.distributor || '(нет поля distributor → Al-Style)';
  byDist[d] = byDist[d] || { count: 0, keys: new Set(), currencies: new Set(), samples: [] };
  const b = byDist[d]; b.count++;
  for (const [k, v] of Object.entries(r)) { b.keys.add(k); if (/валют|currency/i.test(k)) b.currencies.add(String(v)); }
  if (b.samples.length < 3) b.samples.push(r);
}
for (const [d, b] of Object.entries(byDist)) {
  console.log('\n=== ' + d + ': ' + b.count + ' строк');
  console.log('ключи: ' + [...b.keys].join(', '));
  const priceKeys = [...b.keys].filter(k => /дил|закуп|cost|опт|dealer|цена|price/i.test(k));
  console.log('ценовые ключи: ' + priceKeys.map(k => k + (/уцен|розн|rrp|retail|рекоменд|старая|old/i.test(k) ? ' (игнорируется)' : /дил|закуп|cost|опт|dealer/i.test(k) ? ' (ПРИОРИТЕТ)' : ' (запасной)')).join(', '));
  console.log('валюта (поле): ' + (b.currencies.size ? [...b.currencies].join(', ') : 'поля валюты нет'));
  for (const s of b.samples) console.log('  пример: ' + JSON.stringify(s).substring(0, 300));
}
console.log('\nПРОВЕРЬТЕ: цены ASBIS в тенге? Если в USD и поля валюты нет — Pre-Filter посчитает их как тенге (ОШИБКА). Сообщите владельцу.');
