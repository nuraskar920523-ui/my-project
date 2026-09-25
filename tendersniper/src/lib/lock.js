// Файловая блокировка сканирования. staticData n8n сохраняется только по завершении execution,
// поэтому не видна параллельным запускам; файл с эксклюзивным созданием ('wx') — видна сразу.
function tsReadLock(fs) {
  try { return JSON.parse(fs.readFileSync(TS_CONFIG.LOCK_PATH, 'utf8')); } catch (e) { return null; }
}
function tsAcquireLock(fs, owner, source) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(TS_CONFIG.LOCK_PATH, 'wx');
      fs.writeSync(fd, JSON.stringify({ owner: String(owner), source, ts: Date.now() }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.warn('[LOCK WARN] Не удалось создать lock-файл, запуск без блокировки: ' + e.message);
        return { ok: true, degraded: true };
      }
      const cur = tsReadLock(fs);
      const age = cur && cur.ts ? Date.now() - Number(cur.ts) : Infinity;
      if (age < TS_CONFIG.LOCK_TIMEOUT_MS) return { ok: false, lock: cur, ageMs: age };
      try { fs.unlinkSync(TS_CONFIG.LOCK_PATH); } catch (e2) {}
    }
  }
  return { ok: false, lock: tsReadLock(fs) };
}
function tsReleaseLock(fs, owner) {
  const cur = tsReadLock(fs);
  if (!cur) return false;
  if (owner !== undefined && owner !== null && String(cur.owner) !== String(owner)) return false;
  try { fs.unlinkSync(TS_CONFIG.LOCK_PATH); return true; } catch (e) { return false; }
}
