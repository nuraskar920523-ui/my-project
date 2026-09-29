// Файловая блокировка сканирования. staticData n8n сохраняется только по завершении execution,
// поэтому не видна параллельным запускам; файл с эксклюзивным созданием ('wx') — видна сразу.
// lockPath — необязательный путь (по умолчанию блокировка сканирования основного бота).
function tsReadLock(fs, lockPath) {
  try { return JSON.parse(fs.readFileSync(lockPath || TS_CONFIG.LOCK_PATH, 'utf8')); } catch (e) { return null; }
}
function tsAcquireLock(fs, owner, source, lockPath) {
  lockPath = lockPath || TS_CONFIG.LOCK_PATH;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, JSON.stringify({ owner: String(owner), source, ts: Date.now() }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (e) {
      if (e.code !== 'EEXIST') {
        console.warn('[LOCK WARN] Не удалось создать lock-файл, запуск без блокировки: ' + e.message);
        return { ok: true, degraded: true };
      }
      const cur = tsReadLock(fs, lockPath);
      const age = cur && cur.ts ? Date.now() - Number(cur.ts) : Infinity;
      if (age < TS_CONFIG.LOCK_TIMEOUT_MS) return { ok: false, lock: cur, ageMs: age };
      try { fs.unlinkSync(lockPath); } catch (e2) {}
    }
  }
  return { ok: false, lock: tsReadLock(fs, lockPath) };
}
function tsReleaseLock(fs, owner, lockPath) {
  lockPath = lockPath || TS_CONFIG.LOCK_PATH;
  const cur = tsReadLock(fs, lockPath);
  if (!cur) return false;
  if (owner !== undefined && owner !== null && String(cur.owner) !== String(owner)) return false;
  try { fs.unlinkSync(lockPath); return true; } catch (e) { return false; }
}
