// ЧТЕНИЕ МУЛЬТИКАТАЛОГА (AL-STYLE + ASBIS) И ПЕРЕДАЧА МЕТАДАННЫХ
// Оптимизировано: возвращает 1 элемент статуса вместо 18 000 элементов, предотвращая разрастание SQLite БД
const fs = require('fs');
const multiCachePath = '/home/node/.n8n/multi_catalog_cache.json';
const multiBackupPath = '/home/node/.n8n/multi_catalog_cache.json.bak';
const alstyleCachePath = '/home/node/.n8n/alstyle_catalog_cache.json';

let targetPath = null;
let mtime = null;

if (fs.existsSync(multiCachePath) && fs.statSync(multiCachePath).size > 100000) {
  targetPath = multiCachePath;
  mtime = fs.statSync(multiCachePath).mtimeMs;
} else if (fs.existsSync(multiBackupPath) && fs.statSync(multiBackupPath).size > 100000) {
  console.warn('[CACHE FALLBACK] Мультикаталог взят из резервной копии: ' + multiBackupPath);
  targetPath = multiBackupPath;
  mtime = fs.statSync(multiBackupPath).mtimeMs;
} else if (fs.existsSync(alstyleCachePath) && fs.statSync(alstyleCachePath).size > 100000) {
  console.warn('[CACHE FALLBACK] Используется каталог Al-Style: ' + alstyleCachePath);
  targetPath = alstyleCachePath;
  mtime = fs.statSync(alstyleCachePath).mtimeMs;
}

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
    catalogMtime: mtime,
    catalogPath: targetPath
  }
}];