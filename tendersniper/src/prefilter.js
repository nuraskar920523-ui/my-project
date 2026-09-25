const geminiKey = (typeof $env !== 'undefined' && $env.GEMINI_API_KEY) || (typeof process !== 'undefined' && process.env?.GEMINI_API_KEY) || '';
// ====================================================================
// УЗЕЛ: 4-УРОВНЕВЫЙ ИНТЕЛЛЕКТУАЛЬНЫЙ КОНВЕЙЕР (V5.3.0 ANTI-STARVATION & HARD-LOCKS)
// Реализация архитектурного плана:
// 1. Структурный Hard-Lock: исключение isAcc/фурнитуры для первичных устройств (isPrimaryLot)
// 2. Слияние с retrieval: lotTokens строятся из полного обогащенного текста (rawTitle)
// 3. IDF/Relevance скоринг кандидатов
// 4. Взаимное исключение категорий (RE_MONITOR vs RE_AIO vs RE_LAPTOP vs RE_DESKTOP)
// 5. Позитивная контекстная проверка для «гарнитур» + стоп-слова не-ИТ
// 6. Квотирование на уровне ЛОТОВ (Anti-Starvation: max 3 лота на категорию)
// ====================================================================

// Загрузка мультикаталога напрямую с диска (защита от разрастания SQLite n8n)
const fs = require('fs');
const catalogStatus = $input.first()?.json || {};

let catalogRows = [];
const targetPath = catalogStatus.catalogPath || '/home/node/.n8n/multi_catalog_cache.json';
const fallbackPath = '/home/node/.n8n/alstyle_catalog_cache.json';

try {
  if (fs.existsSync(targetPath)) {
    catalogRows = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  } else if (fs.existsSync(fallbackPath)) {
    catalogRows = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
  }
} catch (e) {
  console.error('[PRE-FILTER ERROR] Ошибка чтения каталога:', e.message);
}

if (!Array.isArray(catalogRows) || catalogRows.length === 0) {
  console.error('[PRE-FILTER ERROR] Каталог не загружен (0 товаров)!');
  return [{
    json: {
      empty: true,
      catalogLoadError: true,
      chatId: 681740470
    }
  }];
}
const isCatalogStale = !!catalogStatus.staleCatalog;

let recentLots = [];
try {
  const docResp = $('Document Extraction Layer').first()?.json;
  if (docResp && Array.isArray(docResp.enrichedLots) && docResp.enrichedLots.length > 0) {
    recentLots = docResp.enrichedLots;
  } else {
    const apiResp = $('Merge & Deduplicate Lots').first()?.json;
    recentLots = apiResp?.data?.Lots || [];
  }
} catch (e) {
  console.error('[GOSZAKUP EXCEPTION]', e.message);
}

let historyRows = [];
try {
  historyRows = $('Fetch Lot History').all().map(i => i.json).filter(Boolean);
} catch (e) {}

let chatId = 681740470;
try {
  chatId = $('Auth & Command Router').first()?.json?.chatId || 681740470;
} catch (e) {}

// --- ДЕДУПЛИКАЦИЯ ПО ИСТОРИИ ---
const sentLotIds = new Set();
for (const r of historyRows) {
  for (const [k, v] of Object.entries(r)) {
    const lk = k.toLowerCase();
    if (lk.includes('номер') || lk.includes('лот') || lk.includes('id')) {
      if (v) sentLotIds.add(String(v).trim());
    }
  }
}

function makeWordRegex(pattern) {
  return new RegExp('(?<![a-zа-яё0-9])(' + pattern + ')(?![a-zа-яё0-9])', 'i');
}

const VENDOR_LOCK_PATTERNS = [
  { regex: makeWordRegex('fortilink'), name: 'Fortinet FortiLink (Проектный VAD вендор)' },
  { regex: makeWordRegex('fortigate'), name: 'Fortinet FortiGate (Проектный VAD вендор)' },
  { regex: makeWordRegex('cisco'), name: 'Cisco Systems (Проектный VAD вендор)' },
  { regex: makeWordRegex('catalyst'), name: 'Cisco Catalyst (Проектный VAD вендор)' },
  { regex: makeWordRegex('check[ \t]*point'), name: 'Check Point (Проектный VAD вендор)' },
  { regex: makeWordRegex('aruba'), name: 'Aruba Networks (Проектный вендор)' },
  { regex: makeWordRegex('авторизационн[а-я]*[ \t]*письм[а-я]*'), name: 'Требование авторизационного письма (MAF)' },
  { regex: makeWordRegex('maf|маф'), name: 'MAF (Manufacturer Authorization Form)' },
  { regex: makeWordRegex('партнерск[а-я]*[ \t]*сертификат[а-я]*[ \t]*вендор[а-я]*'), name: 'Партнерский сертификат вендора' },
  { regex: makeWordRegex('письм[а-я]*[ \t]*от[ \t]*правообладател[а-я]*'), name: 'Письмо от правообладателя' },
  { regex: makeWordRegex('официальн[а-я]*[ \t]*дистрибьютор[а-я]*'), name: 'Требование статуса официального дистрибьютора' },
  { regex: makeWordRegex('whatsapp|ватсап|ватцап'), name: 'Коррупционный маркер (согласование через WhatsApp)' },
  { regex: makeWordRegex('предоставить[ \t]*образец[ \t]*до|согласовать[ \t]*образец[ \t]*до'), name: 'Заточка (предоставление образца до подписания)' },
  { regex: makeWordRegex('фото[ \t/]*видео[ \t]*образц[а-я]*'), name: 'Заточка (фото/видео образца)' }
];

const RE_NON_IT_LOT = /(?:мебель[а-я]*|спальн[а-я]*|кухонн[а-я]*|кроват[а-я]*|шкаф[а-я]*|диван[а-я]*|матрас[а-я]*|одежд[а-я]*|посуд[а-я]*|клеточн[а-я]*\s*культур|зажим[а-я]*\s*для\s*бумаг|папка-планшет|планшет\s*канцелярск|дезинфекционн[а-я]*|морозильн[а-я]*|холодильн[а-я]*|автомобильн[а-я]*|велосипедн[а-я]*|камера[ \t]+хранения)/i;
const RE_FURNITURE = /(?:мебель[а-я]*|спальн[а-я]*|кухонн[а-я]*|кроват[а-я]*|шкаф[а-я]*|диван[а-я]*|матрас[а-я]*|комод[а-я]*|стол[а-я]*|тумбочк[а-я]*)/i;
const RE_HEADSET_POSITIVE = /(?:наушник|микрофон|аудио|bluetooth|блютуз|проводн|беспроводн|usb|jack|разъем|type-c|связи|гарнитур[а-я]*[ \t]+для[ \t]+(?:пк|компьютер|телефон|раци|call|колл|диспетчер))/i;

const RE_A3 = makeWordRegex('а3|a3');
const RE_MFP_MODEL_SERIES = makeWordRegex(
  'мфу|3-в-1|3[ \t]*в[ \t]*1|all-in-one|многофункциональн[а-я]*|' +
  'mfp|imagerunner|maxify|workcentre|altalink|' +
  'i-sensys[ \t]+mf[a-z0-9]*|' +
  'laserjet[ \t]+(?:pro[ \t]+)?mfp|' +
  'smart[ \t]*tank[ \t]*(?:5|6|7)[0-9]{2}|' +
  'deskjet[ \t]+ink[ \t]+advantage|' +
  'pantum[ \t]+(?:[bm]|cm)[0-9]{4}[a-z0-9]*|' +
  'ecosys[ \t]+m[0-9]{4}[a-z0-9]*|taskalfa|' +
  '(?:dcp|mfc)-[a-z0-9]+|' +
  'b[23][0-3]5[a-z0-9]*|c415[a-z0-9]*|c71[0-9]{2}[a-z0-9]*|b71[0-9]{2}[a-z0-9]*'
);
const RE_MFP_FEATURE = makeWordRegex('копир[а-я]*|сканирован[а-я]*|копировальн[а-я]*|сканер[а-я]*');
const RE_MFP_NEGATION = /(?:без|не[ \t]+имеет|отсутству(?:ет|ют)|исключая)[ \t]+(?:функци[ий][ \t]+)?(?:копир[а-я]*|сканир[а-я]*|мфу)/i;
const RE_MFP = makeWordRegex('мфу|3-в-1|3[ \t]*в[ \t]*1|all-in-one|многофункциональн[а-я]*|mfp|imagerunner|maxify|workcentre|altalink|копир[а-я]*|сканирован[а-я]*|копировальн[а-я]*|сканер[а-я]*');
const RE_PRINTER = makeWordRegex('принтер[а-я]*');
const RE_3D_OR_POS = makeWordRegex('3d|3д|чеков|этикеток|филаментн[а-я]*|фотополимерн[а-я]*|термопринтер');
const RE_PARTS_PREFIX = /^(?:рюкзак|сумк|чехол|папк|портфель|подставк|картридж|тонер|драм|чернила|барабан|фотобарабан|термопл|вал|бушинг|шлейф|шарнир|ролик|сепаратор|накладк|девелопер|фьюзер|лоток|тумб|пьедестал|чип|ракел|лезви|термоблок|шестерн|ремкомплект|ремонтный[ \t]*комплект|комплект[ \t]*инициализации|кабел|патч-корд|фильтр|удлинитель|переходник|адаптер|гарнитур|наушник|бумаг|скрепк)[а-я]*/i;
const RE_COLOR = makeWordRegex('цветн[а-я]*|color|cmyk|полноцветн[а-я]*|түрлі[ \t]*түсті');
const RE_MONO = makeWordRegex('монохромн[а-я]*|черно-бел[а-я]*|ч/б|ч-б|mono|ак-кара');
const RE_LAPTOP = makeWordRegex('ноутбук[а-я]*|лэптоп[а-я]*|laptop');
const RE_AIO = makeWordRegex('моноблок[а-я]*|all-in-one|aio');
const RE_DESKTOP = makeWordRegex('системный[ \t]+блок|десктоп|неттоп|nettop|компьютер[ \t]+в[ \t]+сборе|пк[ \t]+game|компьютер[ \t]+персональный|офисный[ \t]+компьютер');
const RE_SERVER = makeWordRegex('сервер[а-я]*|server|стоечный[ \t]+сервер|rack[ \t]+server');
const RE_POE = makeWordRegex('poe|poe\\+|802\\.3af|802\\.3at');
const RE_MANAGED = makeWordRegex('управляем[а-я]*|l2|l3|managed');
const RE_ROUTER = makeWordRegex('маршрутизатор[а-я]*|роутер[а-я]*|router');
const RE_SWITCH = makeWordRegex('коммутатор[а-я]*|свитч[а-я]*|switch');
const RE_UNMANAGED = makeWordRegex('неуправляем[а-я]*|unmanaged');
const RE_MONITOR = makeWordRegex('монитор[а-я]*');
const RE_PHONE = makeWordRegex('телефон[а-я]*|смартфон[а-я]*');
const RE_FLASH = makeWordRegex('флеш[а-я]*|flash|usb-флеш[а-я]*');

const RE_TABLET_PC = makeWordRegex('ipados|ipad|айпад|ios|android|андроид|windows[ 	]*1[01]|планшетный[ 	]*пк|планшетный[ 	]*компьютер|сенсорный[ 	]*экран|сенсорный[ 	]*дисплей|multi-touch|мультитач|a16|bionic|apple|snapdragon|dimensity|qualcomm|m1|m2|m3|m4|touch[ 	]*id|face[ 	]*id|фронтальн[а-я]*[ 	]*камер[а-я]*|основн[а-я]*[ 	]*камер[а-я]*|динамик[а-я]*|аккумулятор|li-pol|wi-fi[ 	]*6|дисплей[ 	]*не[ 	]*менее|встроенн[а-я]*[ 	]*памят[а-я]*');
const RE_DIGITIZER = makeWordRegex('дигитайзер|digitizer|перо[ 	]+без[ 	]+батареи|пассивн[а-я]*[ 	]+перо|стилус[ 	]+без[ 	]+батареи|уровн[а-я]*[ 	]+давления|lpi|8192|4096|huion|xp-pen|wacom|графическ[а-я]*[ 	]+планшет|планшет[ 	]+для[ 	]+рисован[а-я]*|интерактивн[а-я]*[ 	]+дисплей[ 	]+huion');

// ХАРД-ЛОКИ НОВЫХ IT-КАТЕГОРИЙ (Task 7): ИБП, Проекторы, Видеонаблюдение/Камеры, Точки доступа
const RE_UPS = makeWordRegex('ибп|ups|источник[ 	]+бесперебойного[ 	]+питания|бесперебойник[а-я]*|on-line[ 	]+ибп|line-interactive');
const RE_PROJECTOR = makeWordRegex('проектор[а-я]*|мультимедийный[ 	]+проектор');
const RE_CAMERA = makeWordRegex('видеокамер[а-я]*|ip-камер[а-я]*|камера[ 	]+видеонаблюдения|веб-камер[а-я]*|web-камер[а-я]*|видеонаблюдени[а-я]*');
const RE_ACCESS_POINT = makeWordRegex('точка[ 	]+доступа|access[ 	]*point|ap[ 	]+wi-fi|беспроводная[ 	]+точка[ 	]+доступа');

const RE_ACCESSORY = makeWordRegex(
  'картридж[а-я]*|тонер[а-я]*|драм[а-я]*|чернил[а-я]*|барабан[а-я]*|фотобарабан[а-я]*|термопл[а-я]*|' +
  'термоэлемент[а-я]*|термистор[а-я]*|вал[а-я]*|бушинг[а-я]*|шлейф[а-я]*|шарнир[а-я]*|ролик[а-я]*|' +
  'сепаратор[а-я]*|накладк[а-я]*|девелопер[а-я]*|фьюзер[а-я]*|лоток[а-я]*|тумб[а-я]*|пьедестал[а-я]*|' +
  'чип[а-я]*|ракел[а-я]*|лезви[а-я]*|термоблок[а-я]*|шестерн[а-я]*|ремкомплект[а-я]*|ремонтный[ \t]*комплект[а-я]*|' +
  'комплект[ \t]*инициализации|кабел[а-я]*|патч-корд[а-я]*|фильтр[а-я]*|удлинитель[а-я]*|переходник[а-я]*|' +
  'адаптер[а-я]*|гарнитур[а-я]*|наушник[а-я]*|бумаг[а-я]*|мышь|клавиатур[а-я]*|коврик[а-я]*|скрепк[а-я]*|' +
  'суппорт[а-я]*|соединител[а-я]*|кабель-канал[а-я]*|кронштейн[а-я]*|доводчик[а-я]*|заглушк[а-я]*|панел[а-я]*[ \t]*монтажн[а-я]*'
);
const RE_PRIMARY = makeWordRegex('ноутбук[а-я]*|принтер[а-я]*|мфу|компьютер[а-я]*|моноблок[а-я]*|сервер[а-я]*|коммутатор[а-я]*|маршрутизатор[а-я]*|роутер[а-я]*|монитор[а-я]*|смартфон[а-я]*|телефон[а-я]*');

const RE_LOG_SMALL = makeWordRegex('флеш[а-я]*|flash|usb|кабель[а-я]*|патч-корд[а-я]*|мышь|mouse|коврик[а-я]*|наушник[а-я]*|гарнитур[а-я]*|headset|адаптер[а-я]*|переходник[а-я]*|картридж[а-я]*|тонер[а-я]*|cartridge|toner');
const RE_LOG_HEAVY = makeWordRegex('сервер[а-я]*|стойк[а-я]*');
const RE_LOG_OFFICE = makeWordRegex('принтер[а-я]*|мфу|компьютер[а-я]*|системный[ \t]*блок|моноблок[а-я]*|монитор[а-я]*|ибп');

const STOP_WORDS = new Set([
  'штук', 'штука', 'штуки', 'шт', 'поставка', 'для', 'комплект', 'товар', 'товара', 'товаров',
  'услуга', 'работа', 'техническая', 'спецификация', 'согласно', 'требования',
  'паспорт', 'гарантия', 'качество', 'соответствие', 'новый', 'доставка', 'пункт',
  'более', 'менее', 'но', 'не', 'до', 'от', 'по', 'на', 'из', 'со', 'ко', 'во',
  'же', 'ли', 'бы', 'при', 'под', 'над', 'через', 'между', 'после', 'перед',
  'около', 'возле', 'среди', 'один', 'два', 'три', 'также', 'все', 'всего',
  'всех', 'только', 'любой', 'любая', 'любые', 'каждый', 'каждая', 'каждое',
  'номер', 'тип', 'вид', 'класс', 'версия', 'модель', 'серия', 'цвет', 'размер',
  'черный', 'белый', 'серый', 'стандарт', 'наличии', 'новые', 'оригинал', 'оригинальный',
  'качественный', 'должен', 'должна', 'должно', 'быть', 'иметь', 'обеспечивать',
  'предусмотрено', 'возможность',
  'бытовой', 'бытовая', 'бытовое', 'бытовые', 'специализированный', 'специализированная', 'универсальный', 'универсальная'
]);

function tokenize(text) {
  if (!text) return [];
  const rawWords = text.toLowerCase()
    .replace(/[\(\)\[\]\{\}\.,;:!?"'«»—–\/\\]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w));

  const tokens = new Set();
  for (const w of rawWords) {
    if (w.includes('-') || w.includes('_')) {
      const parts = w.split(/[-_]/).filter(p => p.length >= 2 && !/^\d+$/.test(p) && !STOP_WORDS.has(p));
      for (const p of parts) tokens.add(p);
      const clean = w.replace(/[-_]/g, '');
      if (clean.length >= 2 && !/^\d+$/.test(clean) && !STOP_WORDS.has(clean)) tokens.add(clean);
    }
    if (!/^\d+$/.test(w)) tokens.add(w);
  }
  return Array.from(tokens);
}

function calculateLogistics(productName, lotQty) {
  const isSmall = RE_LOG_SMALL.test(productName);
  let unitFee = 3000;
  if (RE_LOG_HEAVY.test(productName)) {
    unitFee = 15000;
  } else if (RE_LOG_OFFICE.test(productName)) {
    unitFee = 4500;
  } else if (isSmall) {
    unitFee = 500;
  }
  let baseCost = unitFee * lotQty;
  if (isSmall) {
    baseCost = Math.min(baseCost, 6000);
  }
  return Math.min(Math.max(baseCost, 3000), 150000);
}

function evaluateFinancials(lotBudget, purchaseCost, lotQty, productName) {
  // Налоговый режим: СНР на основе упрощенной декларации (3% от общего оборота, ФНО 910.00)
  // ТОО «Os.Corp Energy» не является плательщиком НДС (НДС = 0, КПН = 0)
  const SNR_TAX_RATE = 0.03;

  const targetBid = Math.round(lotBudget * 0.90);
  const totalPurchase = Math.round(purchaseCost * lotQty);
  const logisticsCost = calculateLogistics(productName, lotQty);

  const snrTax = Math.round(targetBid * SNR_TAX_RATE);
  const vatPayable = 0; // Без НДС
  const citPayable = 0; // Без КПН 20%
  const totalTax = snrTax; // Ровно 3% от суммы контракта

  const totalExpenses = totalPurchase + logisticsCost + totalTax;
  const netProfit = targetBid - totalExpenses;
  const marginPercent = targetBid > 0 ? +((netProfit / targetBid) * 100).toFixed(1) : 0;

  let isViable = false;
  if (targetBid <= 100000) {
    isViable = (netProfit >= 7000 && marginPercent >= 10);
  } else if (targetBid <= 1000000) {
    isViable = (netProfit >= 15000 && marginPercent >= 8);
  } else {
    isViable = (netProfit >= 40000 && marginPercent >= 6);
  }

  return {
    targetBid,
    totalPurchase,
    logisticsCost,
    vatPayable,
    citPayable,
    totalTax,
    totalExpenses,
    netProfit,
    marginPercent,
    isViable
  };
}

// ====================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ СЖАТИЯ ТЗ И ИЗВЛЕЧЕНИЯ ТТХ
// ====================================================================
function extractSpecs(fullNameStr) {
  if (!fullNameStr) return '';
  const parts = String(fullNameStr).split(',').map(p => p.trim()).filter(Boolean);
  if (parts.length <= 2) return String(fullNameStr).substring(0, 120);
  const specParts = parts.slice(2);
  const specsStr = specParts.slice(0, 7).join(' | ');
  return specsStr.length > 150 ? specsStr.substring(0, 147) + '...' : specsStr;
}

function compressLotText(text) {
  if (!text || text.length <= 400) return text || '';
  const KZ_CHARS = /[\u04D9\u0493\u049B\u04A3\u04E9\u04B1\u04AF\u04BB\u0456\u04D8\u0492\u049A\u04A2\u04E8\u04B0\u04AE\u04BA\u0406]/;
  const LEGAL_RE = /(?:поставщик обязан|оплата производится|гарантия|товар должен быть новым|срок поставки|место поставки|требования к упаковке|при наличии|в соответствии с|согласно|закон рк|банковских|календарных|дня подписания)/i;
  const TECH_RE = /[0-9]+\s*(?:гб|gb|мгц|mhz|ггц|ghz|вт|w|мс|ms|ppm|dpi|мп|mp)|(?:ips|tn|va|oled|ssd|hdd|ddr[0-9]*|fhd|uhd|4k|adf|dadf|rj-?[0-9]+|usb|wi-fi|bluetooth|hdmi|nvme|windows|core|ryzen|intel|amd|a3|а3|a4|а4|≥|≤|×|[0-9]+x[0-9]+|не менее|не более)/i;
  
  const lines = text.split('\n');
  const techLines = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.length < 3) continue;
    if (KZ_CHARS.test(t)) continue;
    if (LEGAL_RE.test(t)) continue;
    if (TECH_RE.test(t) || t.includes(':') || t.startsWith('•') || t.startsWith('-') || t.startsWith('*')) {
      techLines.push('• ' + t.replace(/^[•\-*\s]+/, ''));
    }
  }
  const compressed = techLines.join('\n');
  if (compressed.length >= 50) {
    return compressed.length > 750 ? compressed.substring(0, 747) + '...' : compressed;
  }
  return text.substring(0, 450) + (text.length > 450 ? '...[сжато]' : '');
}


// 1. ИНВЕРТИРОВАННЫЙ ИНДЕКС КАТАЛОГА AL-STYLE
const products = [];
const tokenIndex = new Map();
const primaryIndices = [];
const accessoryIndices = [];

for (let idx = 0; idx < catalogRows.length; idx++) {
  const row = catalogRows[idx];
  let purchasePrice = 0, code = '', sku = '', name = '', fullName = '', stock = 0, distributor = row.distributor || 'Al-Style';

  for (const [key, rawVal] of Object.entries(row)) {
    const cleanKey = key.toLowerCase().trim();
    const val = String(rawVal || '').trim();
    if (!purchasePrice && (cleanKey.includes('дил') || cleanKey.includes('закуп') || cleanKey.includes('цена') || cleanKey.includes('cost'))) {
      if (!cleanKey.includes('уцен')) {
        const num = parseFloat(val.replace(/\s+/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, ''));
        if (!isNaN(num) && num > 100) purchasePrice = num;
      }
    }
    if (cleanKey.includes('код') || cleanKey === 'code') code = val;
    if (cleanKey.includes('арт') || cleanKey === 'sku') sku = val;
    if (cleanKey.includes('полное') || cleanKey.includes('full') || cleanKey.includes('описан')) fullName = val;
    else if (cleanKey.includes('наимен') || cleanKey.includes('name')) name = val;
    if (cleanKey.includes('остат') || cleanKey.includes('склад') || cleanKey.includes('stock')) {
      const s = parseInt(val.replace(/[^0-9]/g, ''));
      if (!isNaN(s)) stock = s;
    }
  }

  if (purchasePrice > 100) {
    const title = fullName || name;
    if (title && title.length >= 3) {
      const tokens = tokenize(title);
      if (tokens.length > 0) {
        const coreTitle = title.replace(/(?:для|for)[ \t]+(?:принтер|копир|мфу|плоттер)[^,;]*/gi, '');
        const is3DOrPos = RE_3D_OR_POS.test(title);
        const startsWithPart = RE_PARTS_PREFIX.test(title);
        const hasPrimaryDevice = RE_PRIMARY.test(coreTitle) || RE_MFP_MODEL_SERIES.test(coreTitle);
        const isPart = RE_ACCESSORY.test(coreTitle);
        const isInstallHardware = /(?:суппорт|соединител|кабель-канал|доводчик|заглушк|кронштейн|креплен|подставк|стойк|монтажн[а-я]*[ \t]+панел)/i.test(title);
        const isSmartWatch = /(?:смарт[ \t]*часы|smart[ \t]*watch|фитнес[ \t]*браслет)/i.test(title);
        const isIntercom = /(?:домофон|видеодомофон)/i.test(title);
        const isHomeAppliance = /(?:весы|чайник|утюг|пылесос|фен|блендер|миксер|тостер|кран|водонагревател)/i.test(title);

        const isAcc = is3DOrPos || startsWithPart || isInstallHardware || isHomeAppliance || (isPart && !hasPrimaryDevice);
        const isMFP = !isAcc && (RE_MFP_MODEL_SERIES.test(coreTitle) || RE_MFP_FEATURE.test(coreTitle));
        const isPrinterOnly = !isAcc && !isMFP && (
          RE_PRINTER.test(coreTitle) || /canon[ \t]+i-sensys[ \t]+lbp|pantum[ \t]+p[0-9]{4}|xerox[ \t]+b[12][13]0/i.test(coreTitle)
        );
        const isMonitor = !isAcc && RE_MONITOR.test(coreTitle) && !RE_AIO.test(title) && !RE_LAPTOP.test(title) && !isInstallHardware && !isSmartWatch && !isIntercom;
        const isDesktop = !isAcc && (
          RE_DESKTOP.test(coreTitle) || /пк[ \t]+game|компьютер[ \t]+в[ \t]+сборе/i.test(coreTitle)
        ) && !RE_LAPTOP.test(title) && !RE_AIO.test(title);
        const isPhone = !isAcc && /(?:смартфон|телефон[ \t]+сотовый|телефон[ \t]+мобильный|мобильный[ \t]+телефон)/i.test(title);
        const isFlashDrive = !isAcc && /(?:флеш-диск|флеш[ \t]*накопитель|flash[ \t]*drive|usb[ \t]*flash)/i.test(title);

        const pIndex = products.length;

        const prodObj = {
          distributor,
          code: code || sku || '—',
          name: title,
          fullName: fullName,
          price: purchasePrice,
          stock,
          isAcc,
          tokenSet: new Set(tokens),
          tokenCount: tokens.length,
          hasA3: RE_A3.test(title),
          isMFP: !!isMFP,
          isPrinterOnly: !!isPrinterOnly,
          isMonitor: !!isMonitor,
          isDesktop: !!isDesktop,
          isPhone: !!isPhone,
          isFlashDrive: !!isFlashDrive,
          isColor: RE_COLOR.test(title),
          isMono: RE_MONO.test(title),
          isLaptop: !isAcc && RE_LAPTOP.test(title) && !/(?:рюкзак|сумк|чехол|папк|портфель)/i.test(title),
          isAIO: RE_AIO.test(title),
          isServer: RE_SERVER.test(title),
          hasPoE: RE_POE.test(title),
          isUnmanaged: RE_UNMANAGED.test(title),
          isRouter: RE_ROUTER.test(title) && !RE_SWITCH.test(title),
          isSwitch: RE_SWITCH.test(title) && !RE_ROUTER.test(title),
          isDigitizer: /huion|xp-pen|wacom|дигитайзер|перо\s+без\s+батареи|уровн[а-я]*\s+давления|графический\s+планшет/i.test(title),
          isTabletPC: /ipad|galaxy\s*tab|lenovo\s*tab|mediapad|планшетный\s*компьютер/i.test(title)
        };

        prodObj.isPrimaryProd = prodObj.isMFP || prodObj.isPrinterOnly || prodObj.isLaptop || prodObj.isAIO || prodObj.isDesktop || prodObj.isMonitor || prodObj.isTabletPC || prodObj.isServer || prodObj.isSwitch || prodObj.isRouter || prodObj.isPhone || prodObj.isFlashDrive;

        products.push(prodObj);

        if (isAcc) accessoryIndices.push(pIndex);
        else primaryIndices.push(pIndex);

        for (const tok of new Set(tokens)) {
          let arr = tokenIndex.get(tok);
          if (!arr) {
            arr = [];
            tokenIndex.set(tok, arr);
          }
          arr.push(pIndex);
        }
      }
    }
  }
}

const totalCatalogDocs = products.length;
const docFreq = new Map();
for (const [tok, pIndices] of tokenIndex.entries()) {
  docFreq.set(tok, pIndices.length);
}

function getIDF(tok) {
  const df = docFreq.get(tok) || 0;
  return Math.log(1 + (totalCatalogDocs / (df + 1)));
}

console.log(`[PRE-FILTER V5.3-ROBUST] Индексировано: ${products.length} товаров (первичных: ${primaryIndices.length}, аксессуаров: ${accessoryIndices.length}), ${tokenIndex.size} уникальных токенов.`);

// 2. ФИЛЬТРАЦИЯ ЛОТОВ ГОСЗАКУПОК
const output = [];

for (const lot of recentLots) {
  const lotDisplayNum = String(lot.lotNumber || lot.trdBuyNumberAnno || lot.id || '');
  if (!lotDisplayNum || sentLotIds.has(lotDisplayNum)) continue;

  const lotBudget = parseFloat(lot.amount) || 0;
  const lotQty = parseInt(lot.count) || 1;
  const lotBudgetPerUnit = lotQty > 0 ? (lotBudget / lotQty) : lotBudget;
  const lotNameOnly = lot.nameRu || '';
  const lotDescOnly = lot.descriptionRu || '';
  const lotEnriched = (lot.enrichedDesc || '').trim();
  const fullLotText = (lotEnriched || (lotNameOnly + ' ' + lotDescOnly)).trim();
  const rawTitle = lotNameOnly + ' ' + lotDescOnly + (lotEnriched ? ' ' + lotEnriched : '');
  const MAX_BUDGET_LIMIT = 10000000;
  if (lotBudget < 30000 || lotBudget > MAX_BUDGET_LIMIT || !rawTitle.trim()) continue;

  // ХАРД-ЛОК: Отсечение заведомо не-ИТ закупок
  if (RE_NON_IT_LOT.test(lotNameOnly) || RE_NON_IT_LOT.test(fullLotText)) {
    continue;
  }

  // ПОЗИТИВНАЯ ПРОВЕРКА ДЛЯ СЛОВА "ГАРНИТУР":
  if (/гарнитур[а-я]*/i.test(lotNameOnly) || /гарнитур[а-я]*/i.test(fullLotText)) {
    const hasFurniture = RE_FURNITURE.test(lotNameOnly) || RE_FURNITURE.test(fullLotText);
    const hasPositiveHeadset = RE_HEADSET_POSITIVE.test(lotNameOnly) || RE_HEADSET_POSITIVE.test(fullLotText);
    if (hasFurniture || !hasPositiveHeadset) {
      continue;
    }
  }

  const directUrl = 'https://goszakup.gov.kz/ru/search/lots?filter%5Bcustomer%5D=&filter%5Bnumber%5D=' + encodeURIComponent(lot.lotNumber || lotDisplayNum);

  // ФИЛЬТР 1: ВЕНДОР-ЛОКИ
  let isLocked = false;
  for (const vl of VENDOR_LOCK_PATTERNS) {
    if (vl.regex.test(rawTitle)) {
      output.push({
        json: {
          chatId,
          categoryTag: 'locked',
          isVendorLocked: true,
          lotId: String(lotDisplayNum),
          lotName: lotNameOnly,
          lotDesc: lot.enrichedDesc || lot.descriptionRu || '',
          lotQty,
          lotBudget,
          directUrl,
          lockReason: vl.name,
          profit: 0
        }
      });
      isLocked = true;
      break;
    }
  }
  if (isLocked) continue;

  // ШАГ 2: СЛИЯНИЕ С RETRIEVAL - токены лота строятся из полного обогащенного текста (rawTitle)
  const lotTokens = tokenize(rawTitle);
  if (lotTokens.length === 0) continue;
  const lotNameTokens = new Set(tokenize(lotNameOnly));

  const isCartridgeOnlyLot = makeWordRegex('картридж[а-я]*|тонер[а-я]*|драм[а-я]*|чернил[а-я]*|фотобарабан[а-я]*|туба|термопленк[а-я]*').test(lotNameOnly);

  const lotHasA3 = RE_A3.test(rawTitle);
  const lotHasMfpNegation = RE_MFP_NEGATION.test(rawTitle);
  let lotIsMFP = false;
  if (isCartridgeOnlyLot) {
    lotIsMFP = false;
  } else if (lotHasMfpNegation && !makeWordRegex('мфу|3-в-1|3[ \t]*в[ \t]*1|all-in-one|многофункциональн[а-я]*|imagerunner|mfp').test(rawTitle)) {
    lotIsMFP = false;
  } else {
    lotIsMFP = RE_MFP_MODEL_SERIES.test(rawTitle) || RE_MFP_FEATURE.test(rawTitle);
  }

  const lotIsPrinterOnly = !isCartridgeOnlyLot && RE_PRINTER.test(rawTitle) && !lotIsMFP;
  const lotIsColor = RE_COLOR.test(rawTitle);
  const lotIsMono = RE_MONO.test(rawTitle) && !lotIsColor;
  const lotIsLaptop = RE_LAPTOP.test(rawTitle);
  const lotIsAIO = RE_AIO.test(rawTitle);
  const lotIsDesktop = (
    RE_DESKTOP.test(rawTitle) ||
    (makeWordRegex('компьютер[а-я]*').test(lotNameOnly) && !lotIsLaptop && !lotIsAIO && !RE_TABLET_PC.test(rawTitle))
  ) && !lotIsLaptop && !lotIsAIO;
  const lotIsServer = RE_SERVER.test(rawTitle);
  const lotRequiresPoE = RE_POE.test(rawTitle);
  const lotRequiresManaged = RE_MANAGED.test(rawTitle);
  const lotIsRouter = RE_ROUTER.test(rawTitle) && !RE_SWITCH.test(rawTitle);
  const lotIsSwitch = RE_SWITCH.test(rawTitle) && !RE_ROUTER.test(rawTitle);
  const lotIsMonitor = RE_MONITOR.test(rawTitle) && !lotIsAIO && !lotIsLaptop;
  const lotIsPhone = (makeWordRegex('телефон[а-я]*|смартфон[а-я]*').test(lotNameOnly) || /(?:сотовый|мобильный)\s*телефон|смартфон/i.test(rawTitle)) && !/для\s*(?:зарядки|подключения|питания)\s*(?:телефонов|смартфонов)/i.test(rawTitle);
  const lotIsFlash = RE_FLASH.test(rawTitle);

  const lotIsTabletPC = RE_TABLET_PC.test(rawTitle) || (makeWordRegex('планшет[а-я]*').test(lotNameOnly) && !RE_DIGITIZER.test(rawTitle) && lotBudgetPerUnit >= 60000);
  const lotIsDigitizerOnly = RE_DIGITIZER.test(rawTitle) && !RE_TABLET_PC.test(rawTitle);

  // Классификация лота по новым IT-категориям:
  const lotIsUPS = RE_UPS.test(rawTitle) && !makeWordRegex('аккумулятор[а-я]*|батаре[яеи][а-я]*|замена[ \t]+батаре[ий]').test(rawTitle);
  const lotIsProjector = RE_PROJECTOR.test(rawTitle) && !makeWordRegex('экран[а-я]*|полотно|кронштейн[а-я]*|лампа[ \t]+для[ \t]+проектора').test(rawTitle);
  const lotIsCamera = RE_CAMERA.test(rawTitle) && !makeWordRegex('монтаж|установка|обслуживание|кронштейн[а-я]*|коробк[а-я]*').test(rawTitle);
  const lotIsAccessPoint = RE_ACCESS_POINT.test(rawTitle) && !makeWordRegex('монтаж|настройка').test(rawTitle);

  const hasPrinterOrMFP = (lotIsMFP || lotIsPrinterOnly) && !isCartridgeOnlyLot;
  const hasCartridge = RE_ACCESSORY.test(rawTitle) && makeWordRegex('картридж[а-я]*|тонер[а-я]*').test(rawTitle);
  const isPrinterBundle = hasPrinterOrMFP && hasCartridge && !isCartridgeOnlyLot;

  const hasPC = lotIsDesktop || lotIsAIO;
  const hasKBMOrMon = makeWordRegex('монитор[а-я]*|клавиатур[а-я]*|мышь').test(rawTitle);
  const isPCBundle = hasPC && hasKBMOrMon;
  const isBundle = isPrinterBundle || isPCBundle;

  const isPrimaryLot = lotIsMFP || lotIsPrinterOnly || lotIsLaptop || lotIsAIO || lotIsDesktop || lotIsMonitor || lotIsTabletPC || lotIsServer || lotIsSwitch || lotIsRouter || lotIsPhone || lotIsFlash || lotIsUPS || lotIsProjector || lotIsCamera || lotIsAccessPoint;

  let categoryTag = 'other';
  if (lotIsMonitor) categoryTag = 'monitor';
  else if (hasPrinterOrMFP) categoryTag = 'printer_mfp';
  else if (lotIsDesktop || lotIsLaptop || lotIsAIO) categoryTag = 'computer';
  else if (lotIsTabletPC || lotIsDigitizerOnly) categoryTag = 'tablet';
  else if (lotIsRouter || lotIsSwitch) categoryTag = 'network';
  else if (lotIsPhone) categoryTag = 'phone';
  else if (lotIsFlash) categoryTag = 'flash';
  else if (lotIsUPS) categoryTag = 'ups';
  else if (lotIsProjector) categoryTag = 'projector';
  else if (lotIsCamera) categoryTag = 'camera';
  else if (lotIsAccessPoint) categoryTag = 'network';
  else if (isCartridgeOnlyLot || RE_ACCESSORY.test(rawTitle)) categoryTag = 'cartridge_part';

  const candidateHits = new Map();
  const candidateScores = new Map();
  for (const tok of new Set(lotTokens)) {
    const pIndices = tokenIndex.get(tok);
    if (pIndices) {
      const idf = getIDF(tok);
      for (let i = 0; i < pIndices.length; i++) {
        const pIdx = pIndices[i];
        candidateHits.set(pIdx, (candidateHits.get(pIdx) || 0) + 1);
        candidateScores.set(pIdx, (candidateScores.get(pIdx) || 0) + idf);
      }
    }
  }

  // Также добавляем совпадения по точной категории для мониторов (direct category hit)
  if (lotIsMonitor) {
    const monIndices = tokenIndex.get('монитор') || [];
    for (const pIdx of monIndices) {
      if (!candidateHits.has(pIdx)) {
        candidateHits.set(pIdx, 1);
        candidateScores.set(pIdx, getIDF('монитор'));
      }
    }
  }

  if (candidateHits.size === 0) continue;

  if (isBundle) {
    const primaryScored = [];
    const accessoryScored = [];

    for (const [pIdx, hits] of candidateHits.entries()) {
      const idfScore = candidateScores.get(pIdx) || 0;
      const prod = products[pIdx];
      // stock check removed for Solo mode

      if (!prod.isAcc) {
        if (lotHasA3 && (!prod.hasA3 || prod.price < 250000)) continue;
        if (lotIsMFP && prod.isPrinterOnly) continue;
        if (lotIsPrinterOnly && prod.isMFP) continue;
        if (lotIsColor && prod.isMono) continue;
        if (lotIsMono && prod.isColor) continue;
        if (lotIsLaptop && !prod.isLaptop) continue;
        if (lotIsAIO && !prod.isAIO) continue;
        if (lotIsDesktop && !prod.isDesktop) continue;
        if (lotIsMonitor && !prod.isMonitor) continue;
        if (!lotIsMonitor && prod.isMonitor) continue;
        if (lotIsRouter && prod.isSwitch) continue;
        if (lotIsSwitch && prod.isRouter) continue;
        if (lotIsTabletPC && prod.isDigitizer) continue;
        if (lotIsDigitizerOnly && prod.isTabletPC) continue;

        if (hits >= 2 || idfScore >= 6.0) {
          primaryScored.push({
            code: prod.code,
            name: prod.name,
            fullName: prod.fullName || prod.name,
            price: prod.price,
            hits,
            score: ((() => {
              let s = (idfScore * 20) + (hits * 50);
              const uBudg = lotBudget / lotQty;
              if (uBudg > 0 && prod.price > 0) {
                const r = prod.price / uBudg;
                if (r >= 0.30 && r <= 0.85) s += 150;
                else if (r >= 0.15 && r < 0.30) s += 80;
                else if (r < 0.08 && uBudg >= 30000) s -= 120;
              }
              return s;
            })())
          });
        }
      } else {
        if (hits >= 1 || idfScore >= 4.0) {
          accessoryScored.push({
            code: prod.code,
            name: prod.name,
            fullName: prod.fullName || prod.name,
            price: prod.price,
            hits,
            score: (idfScore * 20) + (hits * 50)
          });
        }
      }
    }

    if (primaryScored.length === 0) continue;
    primaryScored.sort((a, b) => b.score - a.score);
    accessoryScored.sort((a, b) => b.score - a.score);

    const topPrimary = primaryScored.slice(0, 3);
    const topPrimaryForAi = topPrimary.map(p => ({
      code: p.code,
      name: p.name,
      specs: extractSpecs(p.fullName || p.name),
      price: p.price,
      score: +p.score.toFixed(1)
    }));
    const topAccessory = accessoryScored.slice(0, 3);
    const topAccessoryForAi = topAccessory.map(a => ({
      code: a.code,
      name: a.name,
      specs: extractSpecs(a.fullName || a.name),
      price: a.price,
      score: +a.score.toFixed(1)
    }));
    const primaryCost = topPrimary[0].price;
    const accessoryCost = topAccessory.length > 0 ? topAccessory[0].price : 0;
    const baseFin = evaluateFinancials(lotBudget, primaryCost + accessoryCost, lotQty, topPrimary[0].name);
    if (!baseFin.isViable) continue;

    const geminiPrompt =
      "Ты — старший юрист по госзакупкам РК и технический эксперт в ТОО «Os.corp Energy». Проведи аудит применимости КОМПЛЕКТА оборудования к лоту.\n\n" +
      "ДАННЫЕ ЛОТА:\n" +
      "- ID лота: " + lotDisplayNum + "\n" +
      "- Наименование лота: " + lotNameOnly + "\n" +
      "- Бюджет: " + lotBudget + " KZT, Количество: " + lotQty + " шт.\n" +
      "- Техническая спецификация лота (сжато): " + compressLotText(fullLotText) + "\n\n" +
      "КАНДИДАТЫ СО СКЛАДА (ОСНОВНОЕ ОБОРУДОВАНИЕ):\n" +
      JSON.stringify(topPrimaryForAi, null, 2) + "\n\n" +
      "КАНДИДАТЫ СО СКЛАДА (ДОПОЛНИТЕЛЬНЫЕ РАСХОДНИКИ / КОМПЛЕКТУЮЩИЕ):\n" +
      JSON.stringify(topAccessoryForAi, null, 2) + "\n\n" +
      "ПРАВИЛА АУДИТА:\n" +
      "1. ПРОВЕРКА КОМПЛЕКТАЦИИ. Если ТЗ требует поставку основного устройства и расходников — кандидат обязан содержать обе позиции.\n" +
      "2. ЗАПРЕТ ПОДМЕНЫ ФУНКЦИОНАЛЬНОГО КЛАССА. Нельзя заменять МФУ на принтер или наоборот.\n" +
      "3. ФОРМАТ verdict. Дай короткое (1–3 предложения) юридически обоснованное объяснение решения со ссылкой на пункт ТЗ.\n\n" +
      "Ответь строго по JSON-схеме, без пояснений вне JSON.";

    output.push({
      json: {
        categoryTag,
        chatId,
        geminiKey,
        tradeMethodId: lot.refTradeMethodsId || 3,
        isBundle: true,
        isVendorLocked: false,
        isManualReviewRequired: !!lot.isManualReviewRequired,
        lotId: String(lotDisplayNum),
        lotName: lotNameOnly,
        lotDesc: fullLotText,
        lotQty,
        lotBudget,
        directUrl,
        primaryCandidates: topPrimary,
        accessoryCandidates: topAccessory,
        profit: baseFin.netProfit,
        marginPercent: baseFin.marginPercent,
        targetBid: baseFin.targetBid,
        totalTax: baseFin.totalTax,
        vatPayable: baseFin.vatPayable,
        citPayable: baseFin.citPayable,
        logisticsCost: baseFin.logisticsCost,
        geminiPrompt
      }
    });

  } else {
    const scored = [];

    for (const [pIdx, hits] of candidateHits.entries()) {
      const idfScore = candidateScores.get(pIdx) || 0;
      const prod = products[pIdx];
      // stock check removed for Solo mode

      // ШАГ 1: СТРУКТУРНЫЙ ХАРД-ЛОК - взаимное исключение первичных устройств и аксессуаров
      if (isPrimaryLot && (prod.isAcc || !prod.isPrimaryProd)) continue;
      if (!isPrimaryLot && prod.isPrimaryProd) continue;

      // Точные категорийные Hard-Locks
      if (lotIsMonitor && !prod.isMonitor) continue;
      if (!lotIsMonitor && prod.isMonitor) continue;

      if (lotIsDesktop && !prod.isDesktop) continue;
      if (!lotIsDesktop && prod.isDesktop) continue;

      if (lotIsLaptop && !prod.isLaptop) continue;
      if (!lotIsLaptop && prod.isLaptop) continue;

      if (lotIsAIO && !prod.isAIO) continue;
      if (!lotIsAIO && prod.isAIO) continue;

      if (lotIsServer && !prod.isServer) continue;
      if (!lotIsServer && prod.isServer) continue;

      if (lotIsRouter && prod.isSwitch) continue;
      if (lotIsSwitch && prod.isRouter) continue;

      if (lotIsPhone && !prod.isPhone) continue;
      if (!lotIsPhone && prod.isPhone) continue;

      if (lotIsFlash && !prod.isFlashDrive) continue;
      if (!lotIsFlash && prod.isFlashDrive) continue;

      if (lotIsTabletPC && prod.isDigitizer) continue;
      if (lotIsDigitizerOnly && prod.isTabletPC) continue;

      // Хард-локи новых категорий:
      if (lotIsUPS && !prod.isUPS) continue;
      if (!lotIsUPS && prod.isUPS) continue;

      if (lotIsProjector && !prod.isProjector) continue;
      if (!lotIsProjector && prod.isProjector) continue;

      if (lotIsCamera && !prod.isCamera) continue;
      if (!lotIsCamera && prod.isCamera) continue;

      if (lotIsAccessPoint && !prod.isAccessPoint) continue;
      if (!lotIsAccessPoint && prod.isAccessPoint) continue;

      if (lotHasA3 && (!prod.hasA3 || prod.price < 250000)) continue;
      if (lotIsMFP && prod.isPrinterOnly) continue;
      if (lotIsPrinterOnly && prod.isMFP) continue;
      if (lotIsColor && prod.isMono) continue;
      if (lotIsMono && prod.isColor) continue;
      if (!hasPrinterOrMFP && (prod.isMFP || prod.isPrinterOnly)) continue;
      if (makeWordRegex('планшет[а-я]*').test(lotNameOnly) && lotBudgetPerUnit >= 60000 && prod.isDigitizer && prod.price < 35000) continue;

      const isCategoryDirectMatch = 
        (lotIsMonitor && prod.isMonitor) ||
        (lotIsMFP && prod.isMFP) ||
        (lotIsPrinterOnly && prod.isPrinterOnly) ||
        (lotIsLaptop && prod.isLaptop) ||
        (lotIsAIO && prod.isAIO) ||
        (lotIsDesktop && prod.isDesktop) ||
        (lotIsServer && prod.isServer) ||
        (lotIsRouter && prod.isRouter) ||
        (lotIsSwitch && prod.isSwitch) ||
        (lotIsTabletPC && prod.isTabletPC) ||
        (lotIsDigitizerOnly && prod.isDigitizer) ||
        (lotIsPhone && prod.isPhone) ||
        (lotIsFlash && prod.isFlashDrive) ||
        (lotIsUPS && prod.isUPS) ||
        (lotIsProjector && prod.isProjector) ||
        (lotIsCamera && prod.isCamera) ||
        (lotIsAccessPoint && prod.isAccessPoint) ||
        (categoryTag === 'cartridge_part' && prod.isAcc);

      if (hits < 2 && idfScore < 6.0 && !isCategoryDirectMatch) continue;

      let titleHits = 0;
      for (const t of prod.tokenSet) {
        if (lotNameTokens.has(t)) titleHits++;
      }

      // Детерминированная проверка ТТХ до финансовых расчетов
      if (typeof checkDeterministicCompliance === 'function') {
        const detCheck = checkDeterministicCompliance(fullLotText, prod.name);
        if (!detCheck.pass) continue;
      }

      const fin = evaluateFinancials(lotBudget, prod.price, lotQty, prod.name);
      if (!fin.isViable) continue;

      let score = (idfScore * 20) + (hits * 50) + (titleHits * 100);

      // Бюджетный коридор релевантности (Budget Tier Matching)
      const unitBudget = lotBudget / lotQty;
      if (unitBudget > 0 && prod.price > 0) {
        const priceRatio = prod.price / unitBudget;
        if (priceRatio >= 0.30 && priceRatio <= 0.85) {
          score += 180; // Идеальный класс оборудования под бюджет заказчика
        } else if (priceRatio >= 0.15 && priceRatio < 0.30) {
          score += 90;  // Надежный средний класс
        } else if (priceRatio < 0.08 && unitBudget >= 30000) {
          score -= 150; // Бытовая «мыльница» на крупный корпоративный тендер
        }
      }

      scored.push({
        distributor: prod.distributor || 'Al-Style',
        code: prod.code,
        name: prod.name,
        fullName: prod.fullName || prod.name,
        price: prod.price,
        stock: prod.stock,
        is_mfp: !!prod.isMFP,
        is_poe: !!prod.hasPoE,
        is_a3: !!prod.hasA3,
        is_color: !!prod.isColor,
        is_router: !!prod.isRouter,
        is_switch: !!prod.isSwitch,
        is_digitizer: !!prod.isDigitizer,
        is_tablet_pc: !!prod.isTabletPC,
        is_monitor: !!prod.isMonitor,
        fin,
        score
      });
    }

    if (scored.length === 0) continue;
    scored.sort((a, b) => b.score !== a.score ? (b.score - a.score) : (b.price - a.price));

    const topCandidates = scored.slice(0, 5);
    const candidatePayload = topCandidates.map(c => ({
      distributor: c.distributor || 'Al-Style',
      code: c.code,
      name: c.name,
      specs: extractSpecs(c.fullName || c.name),
      price: c.price,
      score: +c.score.toFixed(1)
    }));

    const bestFin = topCandidates[0].fin;
    const compressedLotSpec = compressLotText(fullLotText);

    const geminiPrompt =
      "Ты — старший юрист по госзакупкам РК и технический эксперт в ТОО «Os.corp Energy». Твоя задача — провести строгий технико-юридический аудит соответствия кандидатов со склада технической спецификации лота.\n\n" +
      "ДАННЫЕ ЛОТА:\n" +
      "- ID лота: " + lotDisplayNum + "\n" +
      "- Наименование лота: " + lotNameOnly + "\n" +
      "- Бюджет: " + lotBudget + " KZT, Количество: " + lotQty + " шт.\n" +
      "- Техническая спецификация лота (сжато): " + compressedLotSpec + "\n\n" +
      "КАНДИДАТЫ СО СКЛАДА:\n" +
      JSON.stringify(candidatePayload, null, 2) + "\n\n" +
      "ПРАВИЛА АУДИТА:\n" +
      "1. ЗАПРЕТ ПОДМЕНЫ ФУНКЦИОНАЛЬНОГО КЛАССА. МФУ (3-в-1: печать, сканирование, копирование) КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО заменять на однофункциональный принтер (только печать), и наоборот. Нельзя заменять монитор на кронштейн или мышь. Нельзя заменять ПК на кабельную фурнитуру.\n\n" +
      "2. ФОРМАТ И ХАРАКТЕРИСТИКИ ПЕЧАТИ. Если лот требует формат А3 — принтер А4 недопустим. Если цветную печать — монохромный недопустим. Для картриджей и тонеров: строго проверять модель (CF259A, 59A и др.), ресурс и обязательное наличие чипа (если ТЗ требует чип, картриджи «Без чипа» КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНЫ).\n\n" +
      "3. ЗАПРЕТ ПОДМЕНЫ ПЛАНШЕТНОГО ПК ГРАФИЧЕСКИМ ПЕРОМ. Если в ТЗ лота требуется автономный планшетный компьютер с ОС — КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО сопоставлять с графическими дигитайзерами без ОС.\n\n" +
      "4. ПРОЕКТНЫЕ VAD-БРЕНДЫ. Если ТЗ требует Fortinet, Cisco, CheckPoint либо MAF — ставь isCompatible: false, matchBadge: \"🔴 ТРЕБУЕТСЯ VAD\", rnuRisk: \"ВЫСОКИЙ РИСК РНУ\".\n\n" +
      "5. КОРРУПЦИОННЫЙ ЗАХВАТ («АНТИ-ЗАТОЧКА»). Маркеры заточки под конкретного поставщика — ставь rnuRisk: \"ВЫСОКИЙ РИСК РНУ: КОРРУПЦИОННАЯ ЗАТОЧКА\", isCompatible: false:\n" +
      "   - требование согласования по личному WhatsApp;\n" +
      "   - указание конкретной модели/бренда без обязательной формулировки «или эквивалент»;\n" +
      "   - расхождение наименования лота и содержания ТЗ.\n\n" +
      "6. СОГЛАСОВАННОСТЬ ОТВЕТА. Если isCompatible: false — selectedCode обязан быть null.\n\n" +
      "7. ФОРМАТ verdict. Дай короткое (1–3 предложения) юридически обоснованное объяснение решения со ссылкой на пункт ТЗ.\n\n" +
      "Ответь строго по JSON-схеме, без пояснений вне JSON.";

    output.push({
      json: {
        categoryTag,
        chatId,
        geminiKey,
        isBundle: false,
        isVendorLocked: false,
        isManualReviewRequired: !!lot.isManualReviewRequired,
        staleCatalog: isCatalogStale,
        tradeMethodId: Number(lot.refTradeMethodsId || lot.tradeMethodId || 3),
        lotId: String(lotDisplayNum),
        lotName: lotNameOnly,
        lotDesc: fullLotText,
        lotQty,
        lotBudget,
        directUrl,
        candidates: candidatePayload,
        profit: bestFin.netProfit,
        marginPercent: bestFin.marginPercent,
        targetBid: bestFin.targetBid,
        totalTax: bestFin.totalTax,
        vatPayable: bestFin.vatPayable,
        citPayable: bestFin.citPayable,
        logisticsCost: bestFin.logisticsCost,
        geminiPrompt
      }
    });
  }
}

// ШАГ 7: КВОТИРОВАНИЕ НА УРОВНЕ ЛОТОВ (ANTI-STARVATION FAIR LOT SELECTION)
output.sort((a, b) => (b.json.profit || 0) - (a.json.profit || 0));

const MAX_LOTS_PER_CATEGORY = 5;
const TOTAL_LOTS_LIMIT = 30;
const categoryCounts = new Map();
const selectedLots = [];
const overflowLots = [];

for (const lotItem of output) {
  const tag = lotItem.json.categoryTag || 'other';
  const cnt = categoryCounts.get(tag) || 0;
  if (cnt < MAX_LOTS_PER_CATEGORY) {
    selectedLots.push(lotItem);
    categoryCounts.set(tag, cnt + 1);
  } else {
    overflowLots.push(lotItem);
  }
}

while (selectedLots.length < TOTAL_LOTS_LIMIT && overflowLots.length > 0) {
  selectedLots.push(overflowLots.shift());
}

if (selectedLots.length === 0) {
  return [{ json: { empty: true, chatId } }];
}

return selectedLots;
