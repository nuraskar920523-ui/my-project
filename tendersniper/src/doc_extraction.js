// ====================================================================
// УЗЕЛ: DOCUMENT EXTRACTION LAYER v5.5 (ТЕКСТ ТЗ + СТРУКТУРА ТРЕБОВАНИЙ)
// • Дешёвые фильтры (история, реестр проверенных, бюджет, не-ИТ) — ДО скачивания файлов.
// • PDF — текст через Gemini; .DOCX — текст в коде (центральный каталог ZIP), без Gemini.
// • Только русский текст (строки с цифрами/латиницей из двуязычных таблиц сохраняются).
// • Шаг 1 матричной проверки: ТЗ → структурированный список требований с разметкой ловушек,
//   кэш {lotId}_spec.json (извлечение один раз на лот; для старого текстового кэша достраивается).
// • Приоритет — свежие лоты; лимиты 30 новых загрузок и 30 достроек структуры за запуск.
// • PDF > 10 МБ обрывается при загрузке; ключ Gemini — в заголовке; токен ЦЭФ не уходит на чужие хосты.
// ====================================================================
const fs = require('fs');
//@@include:config
//@@include:env
//@@include:http
//@@include:gemini
//@@include:registry
//@@include:lotfilters
//@@include:docx

const GOSZAKUP_TOKEN = tsGetEnv('GOSZAKUP_TOKEN');
const GEMINI_API_KEY = tsGetEnv('GEMINI_API_KEY');
const GEMINI_MODEL = tsGetEnv('GEMINI_MODEL', TS_CONFIG.GEMINI_MODEL_DEFAULT);
const CACHE_DIR = TS_CONFIG.N8N_DIR + '/doc_cache';
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_NEW_DOWNLOADS = 30;
const MAX_SPEC_BACKFILL = 30;
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
    if (!f.endsWith('.txt') && !f.endsWith('_spec.json')) continue;
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

async function downloadFile(url) {
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
        { text: 'Извлеки ТОЛЬКО русскоязычный текст технических характеристик: параметры, таблицы ТТХ, спецификации, точную модель картриджа/принтера/устройства, артикул, поддерживаемые модели принтеров, количество и единицы измерения. Дубликаты на казахском языке не включай. Дословно сохрани фразы «или эквивалент»/«аналог», требования к оригинальности, чипу, бренду, сертификатам и письмам производителя. Исключи вводные юридические разделы и адреса. Максимум 3500 символов. Если характеристик нет — верни пустую строку.' }
      ]
    }]
  }, 60000, startedAt + HARD_DEADLINE_MS);
  return tsRussianOnly(tsGeminiText(data).trim());
}

// Шаг 1 матричной проверки: полный список требований ТЗ с разметкой типовых ловушек
const SPEC_SCHEMA = {
  type: 'OBJECT',
  properties: {
    requirements: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          parameter: { type: 'STRING' },
          condition: { type: 'STRING' },
          value: { type: 'STRING' },
          is_mandatory: { type: 'BOOLEAN' },
          trap_category: { type: 'STRING', enum: ['none', 'chip_firmware', 'cpu_cores_freq', 'screen_aspect_wuxga', 'ports_poe_sfp', 'ip_sim_nfc', 'board_igpu', 'maf_certificate', 'exact_model_no_equiv', 'originality'] }
        },
        required: ['parameter', 'condition', 'value', 'is_mandatory', 'trap_category']
      }
    }
  },
  required: ['requirements']
};

async function extractStructuredSpec(russianText, lotTitle) {
  const prompt =
    'Ты — старший инженер по госзакупкам РК. Извлеки из технической спецификации лота ПОЛНЫЙ список технических и юридических требований к товару. НЕ сжимай и НЕ выбрасывай параметры.\n\n' +
    'Отдельно размечай типовые ловушки (trap_category):\n' +
    '• chip_firmware — обязательный чип в картридже, прошивка «без чипа», блокировка прошивкой;\n' +
    '• originality — требование оригинального расходника/товара конкретного производителя;\n' +
    '• cpu_cores_freq — базовая/турбо частота, число ядер/потоков, поколение процессора;\n' +
    '• board_igpu — встроенное видеоядро, видеовыходы, конкретные разъёмы материнской платы;\n' +
    '• screen_aspect_wuxga — разрешение и соотношение сторон (16:10 WUXGA 1920x1200 против 16:9 1920x1080);\n' +
    '• ports_poe_sfp — число портов, PoE/PoE+ (802.3af/at), SFP/SFP+;\n' +
    '• ip_sim_nfc — ОС, сервисы Google, SIM/LTE/5G, NFC, защита IP;\n' +
    '• maf_certificate — письмо производителя (MAF), сертификат дистрибьютора/партнёра;\n' +
    '• exact_model_no_equiv — конкретный бренд/модель без фразы «или эквивалент»;\n' +
    '• none — прочие требования.\n' +
    'is_mandatory = false только если ТЗ явно называет требование желательным/необязательным.\n\n' +
    'ЛОТ: ' + lotTitle + '\n\nТЕХНИЧЕСКАЯ СПЕЦИФИКАЦИЯ:\n' + russianText.substring(0, 12000);
  const data = await tsGeminiGenerate(GEMINI_API_KEY, GEMINI_MODEL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: SPEC_SCHEMA }
  }, 45000, startedAt + HARD_DEADLINE_MS);
  const parsed = JSON.parse(tsGeminiText(data) || '{}');
  return Array.isArray(parsed.requirements) ? parsed.requirements : [];
}

function pickTechSpecFile(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const docs = files.filter(f => f.originalName && /\.(pdf|docx)$/i.test(f.originalName.trim()) && f.filePath);
  if (docs.length === 0) return null;
  const match = docs.find(f => /techspec|техспецификац|спецификац|тз|приложение/i.test(((f.originalName || '') + ' ' + (f.nameRu || '')).toLowerCase()));
  return match || docs[0];
}

function applyExtracted(lot, targetFile, extractedText, structuredSpec) {
  lot.docSpecText = '';
  lot.structuredSpec = Array.isArray(structuredSpec) ? structuredSpec : [];
  if (extractedText) {
    const cleanedDoc = extractedText.length > 5000 ? extractedText.substring(0, 5000) + '\n... [ТТХ усечены по лимиту 5000 симв.]' : extractedText;
    lot.docSpecText = cleanedDoc;
    const baseDesc = (lot.descriptionRu || lot.nameRu || '').trim();
    lot.enrichedDesc = `[КРАТКОЕ ОПИСАНИЕ С ПОРТАЛА]:\n${baseDesc}\n\n=== ТЕХНИЧЕСКАЯ СПЕЦИФИКАЦИЯ ИЗ ПРИКРЕПЛЕННОГО ФАЙЛА (${targetFile.originalName}): ===\n${cleanedDoc}`;
  } else {
    lot.enrichedDesc = lot.descriptionRu || lot.nameRu || '';
  }
}

const readSpecCache = (p) => { try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return Array.isArray(v) ? v : null; } catch (e) { return null; } };
async function buildSpec(lot, text, cachePathSpec) {
  if (!GEMINI_API_KEY || !text || text.length < 30) return [];
  try {
    const spec = await extractStructuredSpec(text, lot.nameRu || lot.lotNumber || '');
    try { fs.writeFileSync(cachePathSpec, JSON.stringify(spec), 'utf8'); } catch (e) {}
    console.log(`[SPEC STRUCTURED] Лот ${lot.lotNumber}: ${spec.length} требований ТЗ`);
    return spec;
  } catch (e) {
    console.warn(`[SPEC WARN] Лот ${lot.lotNumber}: не удалось структурировать ТЗ: ${e.message}`);
    return [];
  }
}

// 4. Разделение: кэш-хиты (бесплатно), достройка структуры для старого кэша, новые загрузки
const toDownload = [];
const toBackfill = [];
let cacheHits = 0;
for (const lot of freshLots) {
  const targetFile = pickTechSpecFile(lot.Files);
  if (!targetFile) { lot.enrichedDesc = lot.descriptionRu || lot.nameRu || ''; lot.docSpecText = ''; lot.structuredSpec = []; continue; }
  const ext = (targetFile.originalName.trim().split('.').pop() || '').toLowerCase();
  const cachePath = `${CACHE_DIR}/${lot.id}_${targetFile.id || 'f'}.txt`;
  const cachePathSpec = `${CACHE_DIR}/${lot.id}_spec.json`;
  if (fs.existsSync(cachePath)) {
    try {
      const text = fs.readFileSync(cachePath, 'utf8');
      const spec = readSpecCache(cachePathSpec);
      applyExtracted(lot, targetFile, text, spec || []);
      cacheHits++;
      if (spec === null && text.length >= 30) toBackfill.push({ lot, text, cachePathSpec });
      continue;
    } catch (e) {}
  }
  toDownload.push({ lot, targetFile, cachePath, cachePathSpec, ext });
}

async function processDownload(job) {
  const { lot, targetFile, cachePath, cachePathSpec, ext } = job;
  try {
    const buf = await downloadFile(targetFile.filePath);
    let text = '';
    if (ext === 'docx') {
      text = tsRussianOnly(tsDocxText(buf));
      console.log(`[DOCX PARSED] Лот ${lot.lotNumber}: ${text.length} симв. (без Gemini)`);
    } else if (buf.length > 500 && buf.subarray(0, 4).toString() === '%PDF') {
      if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY не задан');
      text = await extractWithGemini(buf);
      console.log(`[DOC_EXTRACT SUCCESS] Лот ${lot.lotNumber}: извлечено ${text.length} симв.`);
    } else {
      console.warn(`[DOC_EXTRACT WARN] Лот ${lot.lotNumber}: файл не является валидным PDF/DOCX`);
    }
    try { fs.writeFileSync(cachePath, text, 'utf8'); } catch (e) {}
    const spec = await buildSpec(lot, text, cachePathSpec);
    applyExtracted(lot, targetFile, text, spec);
  } catch (err) {
    if (err.code === 'FILE_TOO_LARGE') {
      console.warn(`[DOC_EXTRACT WARN: FILE_TOO_LARGE] Лот ${lot.lotNumber}: файл > ${MAX_PDF_BYTES / 1048576} МБ`);
      lot.isManualReviewRequired = true;
      lot.docSpecText = '';
      lot.structuredSpec = [];
      lot.enrichedDesc = `[⚠️ ТРЕБУЕТСЯ РУЧНОЙ АУДИТ СКАНА ТЗ (>${MAX_PDF_BYTES / 1048576} МБ)]: ${lot.descriptionRu || lot.nameRu || ''}`;
      return;
    }
    console.warn(`[DOC_EXTRACT FAILED] Лот ${lot.lotNumber}: ${err.message}`);
    lot.docExtractionError = err.message;
    applyExtracted(lot, targetFile, '', []);
  }
}

// 5. Параллельная обработка батчами с лимитом времени узла
const jobs = toDownload.slice(0, MAX_NEW_DOWNLOADS);
let processed = 0;
for (let i = 0; i < jobs.length; i += CONCURRENCY) {
  if (Date.now() - startedAt > NODE_DEADLINE_MS) { console.warn('[DOC_EXTRACT] Лимит времени узла — остаток ТЗ будет прочитан в следующем цикле.'); break; }
  await Promise.all(jobs.slice(i, i + CONCURRENCY).map(processDownload));
  processed += Math.min(CONCURRENCY, jobs.length - i);
}
let backfilled = 0;
const backfillJobs = toBackfill.slice(0, MAX_SPEC_BACKFILL);
for (let i = 0; i < backfillJobs.length; i += CONCURRENCY) {
  if (Date.now() - startedAt > NODE_DEADLINE_MS) break;
  await Promise.all(backfillJobs.slice(i, i + CONCURRENCY).map(async (b) => { b.lot.structuredSpec = await buildSpec(b.lot, b.text, b.cachePathSpec); }));
  backfilled += Math.min(CONCURRENCY, backfillJobs.length - i);
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
  if (!Array.isArray(lot.structuredSpec)) lot.structuredSpec = [];
}

console.log(`[DOC_EXTRACT] Кэш-хитов: ${cacheHits} | Новых загрузок: ${processed}/${toDownload.length} | Достроено структур ТЗ: ${backfilled}/${toBackfill.length}`);

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
