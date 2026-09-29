// ====================================================================
// RADAR COLLECTOR: сбор итогов закупок г. Алматы (участники, их цены, победитель)
// Отдельный workflow, ночью раз в час. Работает порциями: каждое выполнение укладывается в ~4 мин
// и продолжает с места остановки (очередь хранится в базе радара).
//   Фаза 1 — поиск: лоты по ИТ-ключевым словам (все статусы), только КАТО 75* → очередь объявлений + заказчики.
//   Фаза 2 — история заказчиков: договоры заказчика → очередь объявлений.
//   Фаза 3 — итоги: Contract (победитель, ContractUnits.lotId) + Lots (бюджет) + TrdApp.AppLots (цены всех участников).
//   Фаза 4 — названия частых участников (Subjects).
// ====================================================================
const fs = require('fs');
//@@include:config
//@@include:env
//@@include:http
//@@include:goszakup
//@@include:lock
//@@include:radar
//@@include:radar_seed
//@@include:keywords_list

const TOKEN = tsGetEnv('GOSZAKUP_TOKEN');
const startedAt = Date.now();
const HARD_DEADLINE = startedAt + 240000;
const PHASE1_END = startedAt + 45000;
const PHASE2_END = startedAt + 90000;
const NEW_WORK_END = startedAt + 215000;
const KEYWORDS_PER_RUN = 6;
const CUSTOMER_REFRESH_MS = 14 * 86400000;
const RECHECK_MS = 7 * 86400000;
const MAX_ATTEMPTS = 4;
const MAX_LOTS = 25000;
const MAX_BIDS_PER_LOT = 12;
const PAUSE_MS = 250;

let execId = null;
try { execId = $execution?.id; } catch (e) {}
if (!execId) execId = 'radar-' + Date.now();

if (!TOKEN) {
  console.error('[RADAR] GOSZAKUP_TOKEN не найден в окружении.');
  return [{ json: { ok: false, error: 'GOSZAKUP_TOKEN не задан' } }];
}
const lock = tsAcquireLock(fs, execId, 'RADAR', TS_CONFIG.RADAR_LOCK_PATH);
if (!lock.ok) {
  console.log('[RADAR] Предыдущий сбор ещё выполняется — пропуск.');
  return [{ json: { ok: true, skipped: 'locked' } }];
}

const stats = { discovered: 0, queuedFromKw: 0, customersRefreshed: 0, queuedFromCustomers: 0, trdBuysProcessed: 0, trdBuysNoContract: 0, lotsSaved: 0, bidsSaved: 0, namesResolved: 0, errors: [] };
const db = tsLoadRadarDb(fs);
const now = Date.now();
const katoList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map(x => String(x || '').trim()).filter(Boolean);
const isAlmaty = (v) => { const k = katoList(v); return k.length > 0 && k.some(x => x.startsWith('75')); };
const note = (where, e) => { if (stats.errors.length < 15) stats.errors.push(where + ': ' + String(e.message || e).substring(0, 150)); };
function enqueue(trdBuyId, src) {
  const id = String(trdBuyId || '');
  if (!id || id === '0' || db.done[id] || db.queue[id]) return false;
  db.queue[id] = { addedAt: now, attempts: 0, nextCheck: 0, src };
  return true;
}

try {
  // ---------- Фаза 1: поиск лотов Алматы по ключевым словам ----------
  for (let i = 0; i < KEYWORDS_PER_RUN && Date.now() < PHASE1_END; i++) {
    const kw = IT_KEYWORDS[(db.kwCursor + i) % IT_KEYWORDS.length];
    try {
      const r = await tsGql(TOKEN, 'query R($nameRu: String) { Lots(limit: 100, filter: { nameRu: $nameRu }) { id trdBuyId customerBin customerNameRu plnPointKatoList } }', { nameRu: kw }, HARD_DEADLINE);
      for (const lot of (r.data && r.data.Lots) || []) {
        if (!isAlmaty(lot.plnPointKatoList)) continue;
        stats.discovered++;
        if (lot.customerBin) {
          const c = db.customers[lot.customerBin] || { name: lot.customerNameRu || '', refreshedAt: 0 };
          c.seenAt = now;
          db.customers[lot.customerBin] = c;
        }
        if (enqueue(lot.trdBuyId, 'kw')) stats.queuedFromKw++;
      }
    } catch (e) { note('kw ' + kw, e); }
    await tsSleep(PAUSE_MS);
  }
  db.kwCursor = (db.kwCursor + KEYWORDS_PER_RUN) % IT_KEYWORDS.length;

  // ---------- Фаза 2: история договоров заказчиков ----------
  const dueCustomers = Object.entries(db.customers)
    .filter(([, c]) => now - (c.refreshedAt || 0) > CUSTOMER_REFRESH_MS)
    .sort((a, b) => (a[1].refreshedAt || 0) - (b[1].refreshedAt || 0) || (b[1].seenAt || 0) - (a[1].seenAt || 0));
  for (const [bin, c] of dueCustomers) {
    if (Date.now() > PHASE2_END) break;
    try {
      const r = await tsGql(TOKEN, 'query R($bin: String) { Contract(limit: 50, filter: { customerBin: $bin }) { trdBuyId } }', { bin }, HARD_DEADLINE);
      for (const ct of (r.data && r.data.Contract) || []) if (enqueue(ct.trdBuyId, 'customer')) stats.queuedFromCustomers++;
      c.refreshedAt = Date.now();
      stats.customersRefreshed++;
    } catch (e) { note('customer ' + bin, e); }
    await tsSleep(PAUSE_MS);
  }

  // ---------- Фаза 3: итоги объявлений ----------
  const due = Object.entries(db.queue).filter(([, q]) => (q.nextCheck || 0) <= now).sort((a, b) => Number(b[0]) - Number(a[0]));
  for (const [id, q] of due) {
    if (Date.now() > NEW_WORK_END) break;
    try {
      const cr = await tsGql(TOKEN, 'query R($id: Int) { Contract(limit: 50, filter: { trdBuyId: $id }) { supplierBiin contractSum signDate trdBuyNumberAnno faktTradeMethodsId ContractUnits { lotId totalSum } } }', { id: Number(id) }, HARD_DEADLINE);
      const contracts = (cr.data && cr.data.Contract) || [];
      if (!contracts.length) {
        stats.trdBuysNoContract++;
        q.attempts = (q.attempts || 0) + 1;
        if (q.attempts >= MAX_ATTEMPTS) { delete db.queue[id]; db.done[id] = now; }
        else q.nextCheck = now + RECHECK_MS;
        await tsSleep(PAUSE_MS);
        continue;
      }
      await tsSleep(PAUSE_MS);
      const lr = await tsGql(TOKEN, 'query R($id: Int) { Lots(limit: 100, filter: { trdBuyId: $id }) { id lotNumber nameRu amount count dumping refTradeMethodsId customerBin trdBuyNumberAnno } }', { id: Number(id) }, HARD_DEADLINE);
      await tsSleep(PAUSE_MS);
      const ar = await tsGql(TOKEN, 'query R($id: Int) { TrdApp(limit: 100, filter: { buyId: $id }) { supplierBinIin AppLots { lotId amount statusId } } }', { id: Number(id) }, HARD_DEADLINE);
      const lots = (lr.data && lr.data.Lots) || [];
      const apps = (ar.data && ar.data.TrdApp) || [];

      // Победитель по лоту: договор, в строках которого указан lotId
      const winnerByLot = new Map();
      const winSumByLot = new Map();
      for (const ct of contracts) {
        const units = [].concat(ct.ContractUnits || []).filter(Boolean);
        for (const u of units) {
          if (!u.lotId) continue;
          winnerByLot.set(String(u.lotId), ct.supplierBiin);
          winSumByLot.set(String(u.lotId), (winSumByLot.get(String(u.lotId)) || 0) + (Number(u.totalSum) || 0));
        }
        if (!units.length && lots.length === 1) {
          winnerByLot.set(String(lots[0].id), ct.supplierBiin);
          winSumByLot.set(String(lots[0].id), Number(ct.contractSum) || 0);
        }
      }

      for (const lot of lots) {
        const lotId = String(lot.id);
        const byBin = new Map();
        for (const app of apps) {
          for (const al of [].concat(app.AppLots || []).filter(Boolean)) {
            if (String(al.lotId) !== lotId) continue;
            const amount = Math.round(Number(al.amount) || 0);
            if (amount <= 0 || !app.supplierBinIin) continue;
            const prev = byBin.get(app.supplierBinIin);
            if (prev === undefined || amount < prev) byBin.set(app.supplierBinIin, amount);
          }
        }
        const bids = [...byBin.entries()].sort((a, b) => a[1] - b[1]);
        const budget = Number(lot.amount) || 0;
        const w = winnerByLot.get(lotId) || null;
        const wa = w && byBin.has(w) ? byBin.get(w) : (winSumByLot.get(lotId) || null);
        let dp = null;
        if (w && budget > 0 && wa > 0 && wa <= budget * 1.05) dp = Math.max(-0.05, +(1 - wa / budget).toFixed(4));
        db.lots[lotId] = {
          t: Number(id), a: lot.trdBuyNumberAnno || contracts[0].trdBuyNumberAnno || '', c: lot.customerBin || '',
          n: String(lot.nameRu || '').substring(0, 100), k: tsRadarCategory(lot.nameRu), b: budget, q: Number(lot.count) || 0,
          dmp: Number(lot.dumping) || 0, m: Number(lot.refTradeMethodsId || contracts[0].faktTradeMethodsId) || 0,
          dt: contracts[0].signDate || null, w, wa, dp, nb: bids.length, bids: bids.slice(0, MAX_BIDS_PER_LOT)
        };
        stats.lotsSaved++;
        stats.bidsSaved += bids.length;
      }
      delete db.queue[id];
      db.done[id] = now;
      stats.trdBuysProcessed++;
      if (stats.trdBuysProcessed % 10 === 0) tsSaveRadarDb(fs, db);
    } catch (e) {
      note('trdBuy ' + id, e);
      if (/DEADLINE/.test(e.message)) break;
      q.attempts = (q.attempts || 0) + 1;
      q.nextCheck = now + 86400000;
      if (q.attempts >= MAX_ATTEMPTS) { delete db.queue[id]; db.done[id] = now; }
    }
    await tsSleep(PAUSE_MS);
  }

  // ---------- Фаза 4: названия частых участников ----------
  const partCount = new Map();
  for (const lot of Object.values(db.lots)) for (const [bin] of (lot.bids || [])) partCount.set(bin, (partCount.get(bin) || 0) + 1);
  const unnamed = [...partCount.entries()].filter(([bin, n]) => n >= 2 && !db.suppliers[bin]).sort((a, b) => b[1] - a[1]).slice(0, 15);
  for (const [bin] of unnamed) {
    if (Date.now() > HARD_DEADLINE - 15000) break;
    try {
      let r = await tsGql(TOKEN, 'query R($v: String) { Subjects(limit: 1, filter: { bin: $v }) { nameRu } }', { v: bin }, HARD_DEADLINE);
      let s = (r.data && r.data.Subjects || [])[0];
      if (!s) {
        r = await tsGql(TOKEN, 'query R($v: String) { Subjects(limit: 1, filter: { iin: $v }) { nameRu } }', { v: bin }, HARD_DEADLINE);
        s = (r.data && r.data.Subjects || [])[0];
      }
      if (s && s.nameRu) { db.suppliers[bin] = String(s.nameRu).trim(); stats.namesResolved++; }
      else db.suppliers[bin] = (TS_RADAR_SEED[bin] && TS_RADAR_SEED[bin].name) || ('БИН ' + bin);
    } catch (e) { note('subject ' + bin, e); }
    await tsSleep(PAUSE_MS);
  }

  // ---------- Очистка ----------
  const lotEntries = Object.entries(db.lots);
  if (lotEntries.length > MAX_LOTS) {
    lotEntries.sort((a, b) => String(a[1].dt || '').localeCompare(String(b[1].dt || '')));
    for (const [k] of lotEntries.slice(0, lotEntries.length - MAX_LOTS)) delete db.lots[k];
  }
  for (const [k, ts] of Object.entries(db.done)) if (now - ts > 400 * 86400000) delete db.done[k];

  tsSaveRadarDb(fs, db);
} finally {
  tsReleaseLock(fs, execId, TS_CONFIG.RADAR_LOCK_PATH);
}

const withResult = Object.values(db.lots).filter(l => l.dp !== null).length;
const summary = Object.assign(stats, {
  ok: true,
  dbLots: Object.keys(db.lots).length,
  dbLotsWithWinner: withResult,
  dbSuppliers: Object.keys(db.suppliers).length,
  dbCustomers: Object.keys(db.customers).length,
  queueLeft: Object.keys(db.queue).length,
  seconds: Math.round((Date.now() - startedAt) / 1000)
});
console.log(`[RADAR] Найдено лотов Алматы: ${stats.discovered} | В очередь: +${stats.queuedFromKw} (ключ.) +${stats.queuedFromCustomers} (заказчики) | ` +
  `Обработано объявлений: ${stats.trdBuysProcessed} (без договора: ${stats.trdBuysNoContract}) | Лотов: +${stats.lotsSaved}, заявок: +${stats.bidsSaved} | ` +
  `База: ${summary.dbLots} лотов (${withResult} с победителем), очередь ${summary.queueLeft} | ${summary.seconds} c` +
  (stats.errors.length ? ' | Ошибки: ' + stats.errors.join(' ; ') : ''));
return [{ json: summary }];
