// Локальный реестр лотов: sent — отправленные в дайджест, checked — уже проверенные ИИ/вендор-локом.
// Не зависит от успешности записи в Google Sheets и не даёт повторно тратить Gemini на отклонённые лоты.
function tsLoadRegistry(fs) {
  try {
    const r = JSON.parse(fs.readFileSync(TS_CONFIG.REGISTRY_PATH, 'utf8'));
    return { checked: r.checked || {}, sent: r.sent || {} };
  } catch (e) {
    return { checked: {}, sent: {} };
  }
}
function tsSaveRegistry(fs, reg) {
  const now = Date.now();
  const checkedTtl = TS_CONFIG.CHECKED_TTL_DAYS * 86400000;
  const sentTtl = TS_CONFIG.SENT_TTL_DAYS * 86400000;
  const clean = { checked: {}, sent: {} };
  for (const [k, v] of Object.entries(reg.checked || {})) if (v && now - v.ts < checkedTtl) clean.checked[k] = v;
  for (const [k, v] of Object.entries(reg.sent || {})) if (v && now - v.ts < sentTtl) clean.sent[k] = v;
  try {
    const tmp = TS_CONFIG.REGISTRY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(clean), 'utf8');
    fs.renameSync(tmp, TS_CONFIG.REGISTRY_PATH);
    return true;
  } catch (e) {
    console.warn('[REGISTRY WARN] Не удалось сохранить реестр: ' + e.message);
    return false;
  }
}
function tsLotKeys(lot) {
  return [lot.lotNumber, lot.lotId, lot.id].filter(v => v !== undefined && v !== null && String(v).trim() !== '').map(v => String(v).trim());
}
function tsIsKnownLot(reg, keys) {
  const now = Date.now();
  for (const k of keys) {
    if (reg.sent[k]) return 'sent';
    const c = reg.checked[k];
    if (c && now - c.ts < TS_CONFIG.CHECKED_TTL_DAYS * 86400000) return 'checked';
  }
  return null;
}
// ID из листа «История лотов»: только колонки с номером лота (не row_number / даты)
function tsHistoryIds(rows) {
  const ids = new Set();
  for (const r of rows) {
    for (const [k, v] of Object.entries(r || {})) {
      const lk = k.toLowerCase();
      if (lk === 'row_number' || lk.includes('дата')) continue;
      if (lk.includes('номер') || lk.includes('лот') || lk === 'id' || lk.endsWith('_id') || lk.endsWith('lotid')) {
        if (v !== undefined && v !== null && String(v).trim() !== '') ids.add(String(v).trim());
      }
    }
  }
  return ids;
}
