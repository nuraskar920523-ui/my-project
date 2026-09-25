// ====================================================================
// УЗЕЛ: DOCUMENT EXTRACTION LAYER v5.3 (МУЛЬТИМОДАЛЬНЫЙ СЛОЙ ТЗ)
// Параллелизация батчами, защита от тяжелых PDF (>15 МБ),
// умная выжимка ТТХ со 2-3 страниц, сборщик мусора doc_cache (14 дней).
// ====================================================================
const fs = require('fs');
const https = require('https');
const http = require('http');

function httpRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP timeout (' + (options.timeout || 25000) + 'ms)')), options.timeout || 25000);
    const client = url.startsWith('https') ? https : http;
    const req = client.request(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timer);
        return httpRequest(res.headers.location, options).then(resolve, reject);
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        clearTimeout(timer);
        const buffer = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8'))
        });
      });
      res.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
    });
    req.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

const GOSZAKUP_TOKEN = (typeof $env !== 'undefined' && $env.GOSZAKUP_TOKEN) || (typeof process !== 'undefined' && process.env?.GOSZAKUP_TOKEN) || '';
const GEMINI_API_KEY = (typeof $env !== 'undefined' && $env.GEMINI_API_KEY) || (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || '';
const CACHE_DIR = '/home/node/.n8n/doc_cache';
const MAX_PDF_BYTES = 15 * 1024 * 1024; // 15 MB
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 дней

if (!fs.existsSync(CACHE_DIR)) {
  try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) {}
}

// 1. СБОРЩИК МУСОРА КЭША (GC): удаление файлов старше 14 дней
try {
  const nowMs = Date.now();
  const cachedFiles = fs.readdirSync(CACHE_DIR);
  let cleanedCount = 0;
  for (const f of cachedFiles) {
    if (f.endsWith('.txt')) {
      const fPath = `${CACHE_DIR}/${f}`;
      const stats = fs.statSync(fPath);
      if (nowMs - stats.mtimeMs > CACHE_TTL_MS) {
        fs.unlinkSync(fPath);
        cleanedCount++;
      }
    }
  }
  if (cleanedCount > 0) {
    console.log(`[DOC_CACHE GC] Удалено устаревших файлов кэша (>14 дней): ${cleanedCount}`);
  }
} catch (e) {
  console.warn('[DOC_CACHE GC WARN]', e.message);
}

// 2. Получаем все лоты и историю
let allLots = [];
try {
  const mergeData = $('Merge & Deduplicate Lots').first()?.json;
  allLots = mergeData?.data?.Lots || [];
} catch (e) {
  console.error('[DOC_EXTRACT] Ошибка получения лотов:', e.message);
}

let historyRows = [];
try {
  historyRows = $('Fetch Lot History').all().map(i => i.json).filter(Boolean);
} catch (e) {}

const sentLotIds = new Set();
for (const r of historyRows) {
  for (const [k, v] of Object.entries(r)) {
    const lk = k.toLowerCase();
    if (lk.includes('номер') || lk.includes('лот') || lk.includes('id')) {
      if (v) sentLotIds.add(String(v).trim());
    }
  }
}

// 3. Отбираем свежие лоты
const freshLots = allLots.filter(l => {
  const lotNum = String(l.lotNumber || l.id).trim();
  const lotId = String(l.id).trim();
  return !sentLotIds.has(lotNum) && !sentLotIds.has(lotId);
});

console.log(`[DOC_EXTRACT] Всего лотов: ${allLots.length} | Свежих для проверки ТЗ: ${freshLots.length}`);

// Вспомогательные функции
async function downloadPdf(url) {
  const res = await httpRequest(url, {
    headers: { 
      'Authorization': 'Bearer ' + GOSZAKUP_TOKEN,
      'User-Agent': 'Mozilla/5.0'
    },
    timeout: 20000
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.buffer;
}

async function extractWithGemini(pdfBuffer) {
  const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=' + GEMINI_API_KEY;
  const payload = JSON.stringify({
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: 'application/pdf',
              data: pdfBuffer.toString('base64')
            }
          },
          {
            text: 'Извлеки ТОЛЬКО технические характеристики: параметры, таблицы ТТХ, спецификации, точную модель картриджа/принтера/устройства, артикул, поддерживаемые модели принтеров. Исключи вводные юридические разделы и адреса. Максимум 500 символов. Если характеристик нет — верни пустую строку.'
          }
        ]
      }
    ]
  });

  const res = await httpRequest(geminiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: payload,
    timeout: 30000
  });

  if (!res.ok) {
    const errBody = res.text().substring(0, 150);
    throw new Error(`Gemini HTTP ${res.status}: ${errBody}`);
  }
  const data = res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function pickTechSpecPdf(files) {
  if (!Array.isArray(files) || files.length === 0) return null;
  const pdfs = files.filter(f => f.originalName && /\.pdf$/i.test(f.originalName.trim()) && f.filePath);
  if (pdfs.length === 0) return null;
  const match = pdfs.find(f => {
    const combined = ((f.originalName || '') + ' ' + (f.nameRu || '')).toLowerCase();
    return /techspec|техспецификац|спецификац|тз|приложение/i.test(combined);
  });
  return match || pdfs[0];
}

async function processSingleLot(lot) {
  const targetFile = pickTechSpecPdf(lot.Files);
  if (!targetFile) {
    lot.enrichedDesc = lot.descriptionRu || lot.nameRu || '';
    return;
  }

  const cacheKey = `${lot.id}_${targetFile.id || 'f'}.txt`;
  const cachePath = `${CACHE_DIR}/${cacheKey}`;

  let extractedText = '';

  // Проверка кэша
  if (fs.existsSync(cachePath)) {
    try {
      extractedText = fs.readFileSync(cachePath, 'utf8');
      console.log(`[DOC_EXTRACT CACHE HIT] Лот ${lot.lotNumber} -> ${cacheKey}`);
    } catch (e) {}
  }

  if (!extractedText) {
    try {
      console.log(`[DOC_EXTRACT FETCH] Лот ${lot.lotNumber}: скачивание ${targetFile.originalName}...`);
      const pdfBuf = await downloadPdf(targetFile.filePath);

      // Защита от переполнения payload (> 15 MB)
      if (pdfBuf.length > MAX_PDF_BYTES) {
        console.warn(`[DOC_EXTRACT WARN: FILE_TOO_LARGE] Лот ${lot.lotNumber}: файл ${(pdfBuf.length / (1024 * 1024)).toFixed(1)} МБ превышает лимит 15 МБ`);
        lot.isManualReviewRequired = true;
        lot.enrichedDesc = `[⚠️ ТРЕБУЕТСЯ РУЧНОЙ АУДИТ СКАНА ТЗ (>15 МБ)]: ${lot.descriptionRu || lot.nameRu || ''}`;
        return;
      }

      if (pdfBuf && pdfBuf.length > 500 && pdfBuf.subarray(0, 4).toString() === '%PDF') {
        extractedText = await extractWithGemini(pdfBuf);
        if (extractedText) {
          try { fs.writeFileSync(cachePath, extractedText, 'utf8'); } catch (e) {}
          console.log(`[DOC_EXTRACT SUCCESS] Лот ${lot.lotNumber}: извлечено ${extractedText.length} симв.`);
        }
      } else {
        console.warn(`[DOC_EXTRACT WARN] Лот ${lot.lotNumber}: файл не является валидным PDF`);
      }
    } catch (err) {
      console.warn(`[DOC_EXTRACT FAILED] Лот ${lot.lotNumber}: ${err.message}`);
      lot.docExtractionError = err.message;
    }
  }

  if (extractedText) {
    // Интеллектуальное усечение: сохраняем ключевые ТТХ
    let cleanedDoc = extractedText;
    if (cleanedDoc.length > 4000) {
      cleanedDoc = cleanedDoc.substring(0, 4000) + '\n... [ТТХ усечены по лимиту 4000 симв.]';
    }
    const baseDesc = (lot.descriptionRu || lot.nameRu || '').trim();
    lot.enrichedDesc = `[КРАТКОЕ ОПИСАНИЕ С ПОРТАЛА]:\n${baseDesc}\n\n=== ТЕХНИЧЕСКАЯ СПЕЦИФИКАЦИЯ ИЗ ПРИКРЕПЛЕННОГО ФАЙЛА (${targetFile.originalName}): ===\n${cleanedDoc}`;
  } else {
    lot.enrichedDesc = lot.descriptionRu || lot.nameRu || '';
  }
}

// 4. ПАРАЛЛЕЛИЗАЦИЯ: батчи по 4 одновременных запроса к Gemini
const lotsToProcess = freshLots.slice(0, 30);
const CONCURRENCY = 4;
for (let i = 0; i < lotsToProcess.length; i += CONCURRENCY) {
  const chunk = lotsToProcess.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(l => processSingleLot(l)));
}

// Для остальных лотов (ранее виденных)
for (const lot of allLots) {
  if (!lot.enrichedDesc) {
    lot.enrichedDesc = lot.descriptionRu || lot.nameRu || '';
  }
}

// Возвращаем единый агрегированный объект, а распаковка в массив выполняется в Pre-Filter
return [{
  json: {
    ready: true,
    totalLots: allLots.length,
    freshLotsCount: freshLots.length,
    processedCount: lotsToProcess.length,
    enrichedLots: allLots
  }
}];
