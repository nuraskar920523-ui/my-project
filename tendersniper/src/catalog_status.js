// ЧТЕНИЕ МУЛЬТИКАТАЛОГА (AL-STYLE + ASBIS) И ПЕРЕДАЧА МЕТАДАННЫХ
// Оптимизировано: возвращает 1 элемент статуса вместо 18 000 элементов, предотвращая разрастание SQLite БД
const fs = require('fs');
const multiCachePath = '/home/node/.n8n/multi_catalog_cache.json';
const multiBackupPath = '/home/node/.n8n/multi_catalog_cache.json.bak';
const alstyleCachePath = '/home/node/.n8n/alstyle_catalog_cache.json';

let targetPath = null;
let mtime = null;
const fileInfo = (p) => { try { const st = fs.statSync(p); return st.size > 100000 ? { path: p, mtime: st.mtimeMs } : null; } catch (e) { return null; } };
const multi = fileInfo(multiCachePath) || fileInfo(multiBackupPath);
const alstyle = fileInfo(alstyleCachePath);
// Источники: Al-Style — из более свежего файла (ночная синхронизация обновляет только alstyle_catalog_cache.json),
// ASBIS — из мультикаталога
let catalogSources = [];
let alstyleMtime = null, asbisMtime = null;
if (multi && alstyle && alstyle.mtime > multi.mtime) {
  catalogSources = [{ path: alstyle.path, filter: 'all', distributor: 'Al-Style' }, { path: multi.path, filter: 'asbis' }];
  alstyleMtime = alstyle.mtime; asbisMtime = multi.mtime;
  console.log('[CATALOG] Al-Style — из alstyle_catalog_cache.json (свежее мультикаталога), ASBIS — из мультикаталога');
} else if (multi) {
  catalogSources = [{ path: multi.path, filter: 'all' }];
  alstyleMtime = asbisMtime = multi.mtime;
} else if (alstyle) {
  console.warn('[CACHE FALLBACK] Используется только каталог Al-Style: ' + alstyle.path);
  catalogSources = [{ path: alstyle.path, filter: 'all', distributor: 'Al-Style' }];
  alstyleMtime = alstyle.mtime;
}
if (catalogSources.length) { targetPath = catalogSources[0].path; mtime = alstyleMtime; }

if (!targetPath) {
  console.error('[CATALOG ERROR] Файл мультикаталога не найден ни по одному из путей!');
  return [{
    json: {
      catalogLoadError: true,
      catalogReady: false,
      mtime: null,
      error: 'Файл кэша мультикаталога не найден'
    }
  }];
}

const ageHours = mtime ? (Date.now() - mtime) / (1000 * 60 * 60) : 999;
const staleCatalog = ageHours > 48;

try {
  const stat = fs.statSync(targetPath);
  // Быстрая проверка размера
  if (stat.size < 100000) throw new Error('File too small');
} catch (e) {
  return [{ json: { catalogLoadError: true, catalogReady: false, error: e.message } }];
}

console.log(`[MULTI-CATALOG METADATA] Мультикаталог валидирован (${targetPath}, возраст: ${ageHours.toFixed(1)}ч, stale: ${staleCatalog}).`);

return [{
  json: {
    catalogReady: true,
    catalogLoadError: false,
    staleCatalog,
    catalogAgeHours: +ageHours.toFixed(1),
    catalogSources,
    alstyleAgeHours: alstyleMtime ? +((Date.now() - alstyleMtime) / 3600000).toFixed(1) : null,
    asbisAgeHours: asbisMtime ? +((Date.now() - asbisMtime) / 3600000).toFixed(1) : null,
    catalogMtime: mtime,
    catalogPath: targetPath
  }
}];