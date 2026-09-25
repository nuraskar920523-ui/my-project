// ====================================================================
// УЗЕЛ: DOCUMENT EXTRACTION LAYER v5.4 (МУЛЬТИМОДАЛЬНЫЙ СЛОЙ ТЗ)
// • Дешёвые фильтры (история, реестр проверенных, бюджет, не-ИТ) — ДО скачивания PDF.
// • Приоритет — свежие лоты (indexDate desc); лимит 30 касается только НОВЫХ загрузок, кэш бесплатен.
// • Пустой результат Gemini тоже кэшируется (не дёргаем API повторно).
// • PDF > 10 МБ обрывается во время загрузки (inline-лимит Gemini ~20 МБ с base64).
// • Ключ Gemini — в заголовке; токен ЦЭФ не уходит на сторонние хосты при редиректе.
// • ТТХ из файла кладутся в lot.docSpecText отдельно (для классификации используется только название).
// ====================================================================
const fs = require('fs');
//@@include:config
//@@include:env
//@@include:http
//@@include:gemini
//@@include:registry
//@@include:lotfilters

const GOSZAKUP_TOKEN = tsGetEnv('GOSZAKUP_TOKEN');
const GEMINI_API_KEY = tsGetEnv('GEMINI_API_KEY');
const GEMINI_MODEL = tsGetEnv('GEMINI_MODEL', TS_CONFIG.GEMINI_MODEL_DEFAULT);
const CACHE_DIR = TS_CONFIG.N8N_DIR + '/doc_cache';
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_NEW_DOWNLOADS = 30;
const CONCURRENCY = 4;
const NODE_DEADLINE_MS = 170000;
const HARD_DEADLINE_MS = 250000;
const startedAt = Date.now();

if (!fs.existsSync(CACHE_DIR)) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
}

// 1. СБОРЩИК МУСОРА КЭША
try {
  const nowMs = Date.now();
  let cleanedCount = 0;
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (!f.endsWith('.txt')) continue;
    const fPath = `${CACHE_DIR}/${f}`;
    if (nowMs - fs.statSync(fPath).mtimeMs > CACHE_TTL_MS) { fs.unlinkSync(fPath); cleanedCount++; }
  }
  if (cleanedCount > 0) console.log(`[DOC_CACHE GC] Удалено устаревших файлов кэша (>14 дней): ${cleanedCount}`);
} catch (e) {
  console.warn('[DOC_CACHE GC WARN]', e.message);
}

// 2. Лоты, история, реестр
let allLots = [];
try {
  allLots = $('Merge & Deduplicate Lots').first()?.json?.data?.Lots || [];
} catch (e) {
  console.error('[DOC_EXTRACT] Ошибка получения лотов:', e.message);
}

let historyRows = [];
try { historyRows = $('Fetch Lot History').all().map(i => i.json).filter(Boolean); } catch (e) {}
const sentLotIds = tsHistoryIds(historyRows);
const registry = tsLoadRegistry(fs);

// 3. Кандидаты на чтение ТЗ: не отправленные, не проверенные, в бюджете, не явно не-ИТ
let skippedKnown = 0, skippedCheap = 0;
const freshLots = allLots.filter(l => {
  const keys = tsLotKeys(l);
  if (keys.some(k => sentLotIds.has(k)) || tsIsKnownLot(registry, keys)) { skippedKnown++; return false; }
  const budget = parseFloat(l.amount) || 0;
  if (budget < TS_CONFIG.MIN_LOT_BUDGET || budget > TS_CONFIG.MAX_LOT_BUDGET || tsIsNonItText(l.nameRu)) { skippedCheap++; return false; }
  return true;
});
freshLots.sort((a, b) => String(b.indexDate || '').localeCompare(String(a.indexDate || '')) || (Number(b.id) || 0) - (Number(a.id) || 0));

console.log(`[DOC_EXTRACT] Всего лотов: ${allLots.length} | Уже известных: ${skippedKnown} | Отсеяно дёшево: ${skippedCheap} | Свежих для ТЗ: ${freshLots.length}`);

async function downloadPdf(url) {
  const res = await tsHttpRequest(url, {
    headers: { 'Authorization': 'Bearer ' + GOSZAKUP_TOKEN, 'User-Agent': 'Mozilla/5.0' },
    timeout: 20000,
    maxBytes: MAX_PDF_BYTES
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.buffer;
}

async function extractWithGemini(pdfBuffer) {
  const data = await tsGeminiGenerate(GEMINI_API_KEY, GEMINI_MODEL, {
    contents: [{
      parts: [
        { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        { text: 'Извлеки ТОЛЬКО технические характеристики: параметры, таблицы ТТХ, спецификации, точную модель картриджа/принтера/устройства, артикул, поддерживаемые модели принтеров, количество и единицы измерения. Дословно сохрани фразы «или эквивалент»/«аналог» и требования к бренду, если они есть. Исключи вводные юридические разделы и адреса. Максимум 1200 символов. Если характеристик нет — верни пустую строку.' }
      ]
    }]
  }, 60000, startedAt + HARD_DEADLINE_MS);
  return tsGeminiText(data).trim();
}

function pickTechSpecPdf(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const pdfs = files.filter(f => f.originalName && /\.pdf$/i.test(f.originalName.trim()) && f.filePath);
  if (pdfs.length === 0) return null;
  const match = pdfs.find(f => /techspec|техспецификац|спецификац|тз|приложение/i.test(((f.originalName || '') + ' ' + (f.nameRu || '')).toLowerCase()));
  return match || pdfs[0];
}

function applyExtracted(lot, targetFile, extractedText) {
  lot.docSpecText = '';
  if (extractedText) {
    const cleanedDoc = extractedText.length > 4000 ? extractedText.substring(0, 4000) + '\n... [ТТХ усечены по лимиту 4000 симв.]' : extractedText;
    lot.docSpecText = cleanedDoc;
    const baseDesc = (lot.descriptionRu || lot.nameRu || '').trim();
    lot.enrichedDesc = `[КРАТКОЕ ОПИСАНИЕ С ПОРТАЛА]:\n${baseDesc}\n\n=== ТЕХНИЧЕСКАЯ СПЕЦИФИКАЦИЯ ИЗ ПРИКРЕПЛЕННОГО ФАЙЛА (${targetFile.originalName}): ===\n${cleanedDoc}`;
  } else {
    lot.enrichedDesc = lot.descriptionRu || lot.nameRu || '';
  }
}

// 4. Разделение: кэш-хиты (бесплатно) и новые загрузки (лимит)
const toDownload = [];
let cacheHits = 0;
for (const lot of freshLots) {
  const targetFile = pickTechSpecPdf(lot.Files);
  if (!targetFile) { lot.enrichedDesc = lot.descriptionRu || lot.nameRu || ''; lot.docSpecText = ''; continue; }
  const cachePath = `${CACHE_DIR}/${lot.id}_${targetFile.id || 'f'}.txt`;
  if (fs.existsSync(cachePath)) {
    try {
      applyExtracted(lot, targetFile, fs.readFileSync(cachePath, 'utf8'));
      cacheHits++;
      continue;
    } catch (e) {}
  }
  toDownload.push({ lot, targetFile, cachePath });
}

async function processDownload(job) {
  const { lot, targetFile, cachePath } = job;
  try {
    const pdfBuf = await downloadPdf(targetFile.filePath);
    if (pdfBuf.length > 500 && pdfBuf.subarray(0, 4).toString() === '%PDF') {
      const text = await extractWithGemini(pdfBuf);
      try { fs.writeFileSync(cachePath, text, 'utf8'); } catch (e) {}
      applyExtracted(lot, targetFile, text);
      console.log(`[DOC_EXTRACT SUCCESS] Лот ${lot.lotNumber}: извлечено ${text.length} симв.`);
    } else {
      try { fs.writeFileSync(cachePath, '', 'utf8'); } catch (e) {}
      console.warn(`[DOC_EXTRACT WARN] Лот ${lot.lotNumber}: файл не является валидным PDF`);
      applyExtracted(lot, targetFile, '');
    }
  } catch (err) {
    if (err.code === 'FILE_TOO_LARGE') {
      console.warn(`[DOC_EXTRACT WARN: FILE_TOO_LARGE] Лот ${lot.lotNumber}: файл > ${MAX_PDF_BYTES / 1048576} МБ`);
      lot.isManualReviewRequired = true;
      lot.docSpecText = '';
      lot.enrichedDesc = `[⚠️ ТРЕБУЕТСЯ РУЧНОЙ АУДИТ СКАНА ТЗ (>${MAX_PDF_BYTES / 1048576} МБ)]: ${lot.descriptionRu || lot.nameRu || ''}`;
      return;
    }
    console.warn(`[DOC_EXTRACT FAILED] Лот ${lot.lotNumber}: ${err.message}`);
    lot.docExtractionError = err.message;
    applyExtracted(lot, targetFile, '');
  }
}

// 5. Параллельная загрузка батчами с лимитом времени узла
const jobs = GEMINI_API_KEY ? toDownload.slice(0, MAX_NEW_DOWNLOADS) : [];
if (!GEMINI_API_KEY) console.error('[DOC_EXTRACT] GEMINI_API_KEY не найден — чтение ТЗ пропущено.');
let processed = 0;
for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  if (Date.now() - startedAt > NODE_DEADLINE_MS) { console.warn('[DOC_EXTRACT] Лимит времени узла — остаток ТЗ будет прочитан в следующем цикле.'); break; }
  await Promise.all(jobs.slice(i, i + CONCURRENCY).map(processDownload));
  processed += Math.min(CONCURRENCY, jobs.length - i);
}

// Лоты с непрочитанным ТЗ откладываются до следующего цикла (иначе ИИ оценит их без спецификации,
// а реестр пометит как «проверенные»)
const doneLots = new Set(jobs.slice(0, processed).map(j => j.lot));
for (const job of toDownload) {
  if (!doneLots.has(job.lot)) job.lot.docPending = true;
}

for (const lot of allLots) {
  if (lot.enrichedDesc === undefined) lot.enrichedDesc = lot.descriptionRu || lot.nameRu || '';
  if (lot.docSpecText === undefined) lot.docSpecText = '';
}

console.log(`[DOC_EXTRACT] Кэш-хитов: ${cacheHits} | Новых загрузок: ${processed}/${toDownload.length}`);

return [{
  json: {
    ready: true,
    totalLots: allLots.length,
    freshLotsCount: freshLots.length,
    processedCount: processed,
    pendingDownloads: Math.max(0, toDownload.length - processed),
    enrichedLots: allLots
  }
}];
