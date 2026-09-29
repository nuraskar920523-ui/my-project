// ---------- РАДАР ДЕМПИНГА: база итогов закупок и оценка риска лота ----------
// База (пишет только Radar Collector): TS_CONFIG.RADAR_DB_PATH
// lots[lotId] = { t: trdBuyId, a: номер объявления, c: БИН заказчика, n: название, k: категория, b: бюджет лота,
//                 q: количество, dmp: флаг Lots.dumping, m: способ закупки, dt: дата договора,
//                 w: БИН победителя, wa: сумма победителя, dp: скидка победителя (доля 0..1),
//                 bids: [[БИН, сумма заявки], ...] по возрастанию, nb: число заявок }

const TS_RADAR_CATEGORIES = [
  ['consumables', 'расходники', /картридж|тонер|чернил|фотобарабан|драм-?картридж|барабан|фотовал|термоплён|термоплен/],
  ['peripherals', 'периферия', /клавиатур|мыш[ьи]|наушник|гарнитур|колонк|веб-?камер|web-?камер|коврик/],
  ['mfp', 'МФУ', /мфу|многофункциональн/],
  ['printer', 'принтеры', /принтер|плоттер/],
  ['laptop', 'ноутбуки', /ноутбук|лэптоп|портативн[а-я]* компьютер/],
  ['aio', 'моноблоки', /моноблок/],
  ['monitor', 'мониторы', /монитор/],
  ['tablet', 'планшеты', /планшет/],
  ['server', 'серверы', /сервер/],
  ['pc', 'компьютеры', /системн[а-я]* блок|компьютер|рабоч[а-я]* станци/],
  ['ups', 'ИБП', /ибп|бесперебойн|стабилизатор/],
  ['network', 'сеть', /коммутатор|маршрутизатор|роутер|точк[аи] доступа|сетев[а-я]* оборудован|медиаконвертер|wi-?fi/],
  ['cctv', 'видеонаблюдение', /видеонаблюд|видеокамер|ip-?камер|видеорегистратор|камер/],
  ['projector', 'проекторы', /проектор|интерактивн/],
  ['cable', 'кабель', /кабел|патч-?корд|витая пара|удлинител|сетевой фильтр/],
  ['phone', 'телефоны', /телефон|смартфон|радиостанц/],
  ['scanner', 'сканеры', /сканер/],
  ['storage', 'накопители', /накопител|ssd|жёстк|жестк|флеш|карт[аы] памяти/]
];
function tsRadarCategory(name) {
  const t = String(name || '').toLowerCase();
  for (const [key, , re] of TS_RADAR_CATEGORIES) if (re.test(t)) return key;
  return 'other';
}
function tsRadarCategoryLabel(key) {
  const row = TS_RADAR_CATEGORIES.find(r => r[0] === key);
  return row ? row[1] : 'прочее';
}
function tsRadarBand(budget) {
  const b = Number(budget) || 0;
  return b < 150000 ? 'S' : (b < 1000000 ? 'M' : 'L');
}

function tsRadarEmptyDb() {
  return { version: 1, updatedAt: null, lots: {}, suppliers: {}, customers: {}, queue: {}, done: {}, kwCursor: 0 };
}
function tsLoadRadarDb(fs) {
  try {
    const db = JSON.parse(fs.readFileSync(TS_CONFIG.RADAR_DB_PATH, 'utf8'));
    return Object.assign(tsRadarEmptyDb(), db);
  } catch (e) {
    return tsRadarEmptyDb();
  }
}
function tsSaveRadarDb(fs, db) {
  db.updatedAt = new Date().toISOString();
  const tmp = TS_CONFIG.RADAR_DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db), 'utf8');
  fs.renameSync(tmp, TS_CONFIG.RADAR_DB_PATH);
}

function tsRadarQuantile(arr, q) {
  if (!arr.length) return null;
  const s = arr.slice().sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// Индекс для быстрых оценок (строится один раз на запуск дайджеста)
function tsRadarBuildIndex(db) {
  const byCustomer = new Map();
  const byCatBand = new Map();
  const byCat = new Map();
  const supplier = new Map();
  const push = (m, k, v) => { let a = m.get(k); if (!a) { a = []; m.set(k, a); } a.push(v); };
  for (const lot of Object.values(db.lots || {})) {
    if (lot.c) push(byCustomer, lot.c, lot);
    push(byCatBand, lot.k + '|' + tsRadarBand(lot.b), lot);
    push(byCat, lot.k, lot);
    for (const [bin, amount] of (lot.bids || [])) {
      let s = supplier.get(bin);
      if (!s) { s = { part: 0, wins: 0, discs: [] }; supplier.set(bin, s); }
      s.part++;
      if (lot.w === bin) s.wins++;
      if (lot.b > 0 && amount > 0) s.discs.push(1 - amount / lot.b);
    }
  }
  return { db, byCustomer, byCatBand, byCat, supplier };
}

function tsRadarSupplierName(index, bin) {
  const dbName = index.db.suppliers && index.db.suppliers[bin];
  const seed = (typeof TS_RADAR_SEED !== 'undefined') ? TS_RADAR_SEED[bin] : null;
  return dbName || (seed && seed.name) || ('БИН ' + bin);
}
function tsRadarIsDumper(index, bin) {
  const seed = (typeof TS_RADAR_SEED !== 'undefined') ? TS_RADAR_SEED[bin] : null;
  if (seed && seed.dumper) return true;
  const s = index.supplier.get(bin);
  if (!s || s.discs.length < 3) return false;
  return tsRadarQuantile(s.discs, 0.5) >= 0.30;
}

// Оценка лота: на чём основана, ожидаемая скидка победителя, частые соперники у заказчика
function tsRadarAssess(index, lot) {
  const cat = tsRadarCategory(lot.name);
  const band = tsRadarBand(lot.budget);
  const withDisc = (arr) => (arr || []).filter(l => l.dp !== null && l.dp !== undefined);
  const custAll = index.byCustomer.get(lot.customerBin) || [];
  const custDisc = withDisc(custAll);
  const custCat = custDisc.filter(l => l.k === cat);
  const catBand = withDisc(index.byCatBand.get(cat + '|' + band));
  const catAll = withDisc(index.byCat.get(cat));

  let basis = null, sample = [];
  if (custCat.length >= 2) { basis = 'заказчик, ' + tsRadarCategoryLabel(cat); sample = custCat; }
  else if (custDisc.length >= 3) { basis = 'заказчик, все закупки'; sample = custDisc; }
  else if (catBand.length >= 5) { basis = 'Алматы, ' + tsRadarCategoryLabel(cat) + ', похожий бюджет'; sample = catBand; }
  else if (catAll.length >= 5) { basis = 'Алматы, ' + tsRadarCategoryLabel(cat); sample = catAll; }

  const discs = sample.map(l => l.dp);
  const bidders = sample.map(l => l.nb || (l.bids || []).length).filter(n => n > 0);

  // Частые соперники у этого заказчика
  const counts = new Map();
  for (const l of custAll) {
    for (const [bin] of (l.bids || [])) {
      const c = counts.get(bin) || { part: 0, wins: 0 };
      c.part++;
      if (l.w === bin) c.wins++;
      counts.set(bin, c);
    }
  }
  const competitors = [...counts.entries()]
    .sort((x, y) => (y[1].wins - x[1].wins) || (y[1].part - x[1].part))
    .slice(0, 3)
    .map(([bin, c]) => {
      const s = index.supplier.get(bin);
      return { bin, name: tsRadarSupplierName(index, bin), part: c.part, wins: c.wins,
        medDisc: s && s.discs.length ? tsRadarQuantile(s.discs, 0.5) : null, dumper: tsRadarIsDumper(index, bin) };
    });

  return {
    category: cat,
    basis,
    n: sample.length,
    customerLots: custAll.length,
    expDiscount: discs.length ? tsRadarQuantile(discs, 0.5) : null,
    p25: discs.length ? tsRadarQuantile(discs, 0.25) : null,
    p75: discs.length ? tsRadarQuantile(discs, 0.75) : null,
    avgBidders: bidders.length ? bidders.reduce((a, b) => a + b, 0) / bidders.length : null,
    competitors,
    hasDumper: competitors.some(c => c.dumper)
  };
}

// Экономика при ожидаемой цене победителя и безубыточная цена (налог СНР от выручки)
function tsRadarEconomics(assess, fin) {
  const budget = Number(fin.budget) || 0;
  const costs = (Number(fin.totalCost) || 0) + (Number(fin.logistics) || 0);
  const tax = TS_CONFIG.SNR_TAX_RATE;
  const breakeven = Math.ceil(costs / (1 - tax));
  const maxDiscount = budget > 0 ? 1 - breakeven / budget : null;
  let expPrice = null, profitAtExp = null;
  if (assess.expDiscount !== null && budget > 0) {
    expPrice = Math.round(budget * (1 - assess.expDiscount));
    profitAtExp = expPrice - costs - Math.round(expPrice * tax);
  }
  let risk;
  if (assess.expDiscount === null) risk = assess.hasDumper ? 'medium' : 'unknown';
  else if (profitAtExp < 0) risk = 'high';
  else if (assess.hasDumper || (maxDiscount !== null && maxDiscount - (assess.p75 === null ? assess.expDiscount : assess.p75) < 0.03)) risk = 'medium';
  else risk = 'low';
  return { breakeven, maxDiscount, expPrice, profitAtExp, risk };
}

const TS_RADAR_RISK_LABEL = { high: '🔴 ВЫСОКИЙ', medium: '🟠 СРЕДНИЙ', low: '🟢 НИЗКИЙ', unknown: '❔ НЕТ ДАННЫХ' };

function tsRadarLines(assess, econ, esc) {
  const pct = (x) => Math.round(x * 100) + '%';
  const kzt = (n) => Math.round(n || 0).toLocaleString('ru-RU') + ' ₸';
  const lines = [];
  let head = '   ⚔️ Риск демпинга: <b>' + TS_RADAR_RISK_LABEL[econ.risk] + '</b>';
  if (assess.expDiscount !== null) {
    head += ' — скидка победителя обычно ' + pct(assess.expDiscount) +
      (assess.p25 !== null && assess.p75 !== null && assess.n >= 3 ? ' (' + pct(assess.p25) + '–' + pct(assess.p75) + ')' : '') +
      ', участников ~' + (assess.avgBidders ? Math.round(assess.avgBidders) : '?') +
      ' <i>[' + esc(assess.basis) + ', ' + assess.n + ' закуп.]</i>';
  } else {
    head += assess.customerLots ? ' — у заказчика ' + assess.customerLots + ' закуп. без итогов' : ' — истории по заказчику и категории пока нет';
  }
  lines.push(head);
  if (assess.competitors.length) {
    lines.push('   • Соперники у заказчика: ' + assess.competitors.map(c =>
      (c.dumper ? '⚠️' : '') + esc(c.name) + ' (' + c.part + ' уч., ' + c.wins + ' поб.' + (c.medDisc !== null ? ', обычно −' + pct(c.medDisc) : '') + ')').join('; '));
  }
  const tail = [];
  if (econ.expPrice !== null) tail.push('при ~' + kzt(econ.expPrice) + ' ваш результат: <b>' + (econ.profitAtExp >= 0 ? '+' : '') + kzt(econ.profitAtExp) + '</b>');
  if (econ.maxDiscount !== null) tail.push('ваш предел: ' + kzt(econ.breakeven) + ' (−' + pct(Math.max(0, econ.maxDiscount)) + ')');
  if (tail.length) lines.push('   • ' + tail.join(' | '));
  return lines;
}
