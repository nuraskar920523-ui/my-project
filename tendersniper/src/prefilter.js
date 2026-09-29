// ====================================================================
// УЗЕЛ: 4-УРОВНЕВЫЙ ИНТЕЛЛЕКТУАЛЬНЫЙ КОНВЕЙЕР (V5.3.0 ANTI-STARVATION & HARD-LOCKS)
// Реализация архитектурного плана:
// 1. Структурный Hard-Lock: исключение isAcc/фурнитуры для первичных устройств (isPrimaryLot)
// 2. Слияние с retrieval: lotTokens строятся из названия + описания + ТТХ файла (rawTitle);
//    категория лота — только из названия и описания портала (classText)
// 3. IDF/Relevance скоринг кандидатов
// 4. Взаимное исключение категорий (RE_MONITOR vs RE_AIO vs RE_LAPTOP vs RE_DESKTOP)
// 5. Позитивная контекстная проверка для «гарнитур» + стоп-слова не-ИТ
// 6. Квотирование на уровне ЛОТОВ (Anti-Starvation: max 5 лотов на категорию)
// ====================================================================

// Загрузка мультикаталога напрямую с диска (защита от разрастания SQLite n8n)
const fs = require('fs');
//@@include:config
//@@include:env
//@@include:registry
//@@include:regex_util
//@@include:finance
//@@include:lotfilters
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
      chatId: TS_CONFIG.ADMIN_CHAT_ID
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

let chatId = TS_CONFIG.ADMIN_CHAT_ID;
try {
  chatId = $('Auth & Command Router').first()?.json?.chatId || TS_CONFIG.ADMIN_CHAT_ID;
} catch (e) {}

// --- ДЕДУПЛИКАЦИЯ ПО ИСТОРИИ (Google Sheets) И ЛОКАЛЬНОМУ РЕЕСТРУ ---
const sentLotIds = tsHistoryIds(historyRows);
const registry = tsLoadRegistry(fs);
const USD_KZT_RATE = parseFloat(tsGetEnv('USD_KZT_RATE', '0')) || 0;
let skippedUsdRows = 0;
let skippedDocPending = 0;

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

const RE_FURNITURE = makeWordRegex('мебель[а-я]*|спальн[а-я]*|кухонн[а-я]*|кроват[а-я]*|шкаф[а-я]*|диван[а-я]*|матрас[а-я]*|комод[а-я]*|стол|стола|столы|столов|тумбочк[а-я]*');
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
// «Цветной сенсорный дисплей/экран» у монохромного МФУ — не требование цветной печати
const RE_COLOR_DISPLAY = /(?:цветн[а-я]*|color)[ \t]+(?:сенсорн[а-я]*[ \t]+)?(?:жк[- \t]*|lcd[ \t]*|tft[ \t]*)?(?:дисплей|экран|панел|touch|display|screen)[а-я]*|(?:дисплей|экран|панель|display|screen)[а-я]*[ \t:–-]+(?:сенсорн[а-я]*[ \t,]+)?(?:цветн[а-я]*|color)/gi;
const stripColorDisplay = (t) => String(t || '').replace(RE_COLOR_DISPLAY, ' ');
// Цветность ПЕЧАТИ: 'color' | 'mono' | null (если есть оба признака — решает ИИ, фильтр не применяется).
// «цветность» (существительное) и цветное сканирование/копирование не считаются требованием цветной печати.
const RE_COLOR_PRINT = makeWordRegex('цветн(?:ой|ая|ое|ые|ого|ых|ую|ым|ыми)|color|cmyk|полноцветн[а-я]*|түрлі[ \t]*түсті');
const RE_COLOR_NON_PRINT = /цветн[а-я]*[ \t]+(?:сканирован|копирован|скан|копи)[а-я]*|(?:сканирован|копирован)[а-я]*[ \t:–-]+цветн[а-я]*/gi;
function detectColorMode(text) {
  const t = stripColorDisplay(text).replace(RE_COLOR_NON_PRINT, ' ');
  const c = RE_COLOR_PRINT.test(t);
  const m = RE_MONO.test(t);
  if (c && !m) return 'color';
  if (m && !c) return 'mono';
  return null;
}
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

// Только сильные маркеры планшетного ПК (Windows/аккумулятор/динамик/память встречаются у ПК и ноутбуков)
const RE_TABLET_PC = makeWordRegex('ipados|ipad|айпад|android|андроид|планшетный[ \t]*пк|планшетный[ \t]*компьютер|galaxy[ \t]*tab|lenovo[ \t]*tab|mediapad|matepad|redmi[ \t]*pad|xiaomi[ \t]*pad');
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

// ====================================================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ СЖАТИЯ ТЗ И ИЗВЛЕЧЕНИЯ ТТХ
// ====================================================================

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
    return compressed.length > 2500 ? compressed.substring(0, 2497) + '...' : compressed;
  }
  return text.substring(0, 1500) + (text.length > 1500 ? '...[сжато]' : '');
}


// 1. ИНВЕРТИРОВАННЫЙ ИНДЕКС КАТАЛОГА AL-STYLE
const products = [];
const tokenIndex = new Map();
const primaryIndices = [];
const accessoryIndices = [];

for (let idx = 0; idx < catalogRows.length; idx++) {
  const row = catalogRows[idx];
  let purchasePrice = 0, code = '', sku = '', name = '', fullName = '', stock = 0, distributor = row.distributor || 'Al-Style';
  let dealerPrice = 0, genericPrice = 0, currency = '';

  for (const [key, rawVal] of Object.entries(row)) {
    const cleanKey = key.toLowerCase().trim();
    const val = String(rawVal || '').trim();
    // Цена: приоритет дилерской/закупочной; розничная/РРЦ/уценка не используются
    const isPriceKey = /дил|закуп|cost|опт|dealer|цена|price/.test(cleanKey);
    if (isPriceKey && !/уцен|розн|rrp|retail|рекоменд|старая|old/.test(cleanKey)) {
      const num = parseFloat(val.replace(/\s+/g, '').replace(/,/g, '.').replace(/[^0-9.]/g, ''));
      if (!isNaN(num) && num > 0) {
        if (/дил|закуп|cost|опт|dealer/.test(cleanKey)) { if (!dealerPrice) dealerPrice = num; }
        else if (!genericPrice) genericPrice = num;
      }
    }
    if (/валют|currency/.test(cleanKey)) currency = val.toUpperCase();
    if ((cleanKey.includes('код') && !/штрих|barcode|ean/.test(cleanKey)) || cleanKey === 'code') code = val;
    if (cleanKey.startsWith('арт') || cleanKey === 'sku' || cleanKey === 'article') sku = val;
    if (cleanKey.includes('полное') || cleanKey.includes('full') || cleanKey.includes('описан')) fullName = val;
    else if (cleanKey.includes('наимен') || cleanKey.includes('name')) name = val;
    if (cleanKey.includes('остат') || cleanKey.includes('склад') || cleanKey.includes('stock')) {
      const s = parseInt(val.replace(/[^0-9]/g, ''));
      if (!isNaN(s)) stock = s;
    }
  }

  purchasePrice = dealerPrice || genericPrice;
  // Валюта: цены в USD пересчитываются по USD_KZT_RATE; без курса такие строки пропускаются
  if (purchasePrice && /USD|\$|ДОЛЛ/.test(currency)) {
    if (USD_KZT_RATE > 0) purchasePrice = Math.round(purchasePrice * USD_KZT_RATE);
    else { skippedUsdRows++; purchasePrice = 0; }
  }

  if (purchasePrice > 100) {
    const title = fullName || name;
    const shortName = (name || title).trim();
    if (title && title.length >= 3) {
      const tokens = tokenize(title);
      if (tokens.length > 0) {
        const coreTitle = title.replace(/(?:для|for)[ \t]+(?:принтер|копир|мфу|плоттер)[^,;]*/gi, '');
        const is3DOrPos = RE_3D_OR_POS.test(title);
        const startsWithPart = RE_PARTS_PREFIX.test(title);
        const hasPrimaryDevice = RE_PRIMARY.test(coreTitle) || RE_MFP_MODEL_SERIES.test(coreTitle);
        const isPart = RE_ACCESSORY.test(coreTitle);
        // Фурнитура/бытовая техника определяются по НАЧАЛУ короткого названия и по целым словам:
        // иначе «VESA крепление» в описании монитора или «эКРАН» (кран) делали товар аксессуаром
        const isInstallHardware = /^(?:суппорт|соединител|кабель-канал|доводчик|заглушк|кронштейн|креплен|подставк|стойк|монтажн[а-я]*[ \t]+панел)/i.test(shortName) ||
          (!hasPrimaryDevice && makeWordRegex('кронштейн[а-я]*|крепление|подставк[а-я]*|кабель-канал[а-я]*').test(shortName));
        const isSmartWatch = /(?:смарт[ \t]*часы|smart[ \t]*watch|фитнес[ \t]*браслет)/i.test(title);
        const isIntercom = /(?:домофон|видеодомофон)/i.test(title);
        const isHomeAppliance = makeWordRegex('весы|чайник[а-я]*|утюг[а-я]*|пылесос[а-я]*|фен|блендер[а-я]*|миксер[а-я]*|тостер[а-я]*|смеситель|водонагревател[а-я]*').test(shortName);

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
          isColor: detectColorMode(title) === 'color',
          isMono: detectColorMode(title) === 'mono',
          isLaptop: !isAcc && RE_LAPTOP.test(title) && !/(?:рюкзак|сумк|чехол|папк|портфель)/i.test(title),
          isAIO: !isAcc && !isMFP && RE_AIO.test(title),
          isServer: !isAcc && RE_SERVER.test(title),
          hasPoE: RE_POE.test(title),
          isUnmanaged: RE_UNMANAGED.test(title),
          isRouter: RE_ROUTER.test(title) && !RE_SWITCH.test(title),
          isSwitch: RE_SWITCH.test(title) && !RE_ROUTER.test(title),
          isDigitizer: /huion|xp-pen|wacom|дигитайзер|перо\s+без\s+батареи|уровн[а-я]*\s+давления|графический\s+планшет/i.test(title),
          isTabletPC: /ipad|galaxy\s*tab|lenovo\s*tab|mediapad|matepad|redmi\s*pad|xiaomi\s*pad|планшетный\s*компьютер/i.test(title),
          // Новые ИТ-категории (раньше поля отсутствовали, и хард-локи отсекали ВСЕ товары)
          isUPS: !isAcc && RE_UPS.test(shortName) && !/^(?:аккумулятор|батаре|сменн)/i.test(shortName),
          isProjector: !isAcc && RE_PROJECTOR.test(shortName) && !/^(?:экран|лампа|кронштейн|пульт|потолочн)/i.test(shortName),
          isCamera: !isAcc && RE_CAMERA.test(shortName) && !/^(?:кронштейн|корпус|коробк|блок[ \t]+питания|объектив)/i.test(shortName),
          isAccessPoint: !isAcc && RE_ACCESS_POINT.test(shortName) && !/^(?:антенн|инжектор|кронштейн)/i.test(shortName)
        };

        prodObj.isPrimaryProd = prodObj.isMFP || prodObj.isPrinterOnly || prodObj.isLaptop || prodObj.isAIO || prodObj.isDesktop || prodObj.isMonitor || prodObj.isTabletPC || prodObj.isServer || prodObj.isSwitch || prodObj.isRouter || prodObj.isPhone || prodObj.isFlashDrive ||
          prodObj.isUPS || prodObj.isProjector || prodObj.isCamera || prodObj.isAccessPoint;

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

console.log(`[PRE-FILTER V5.4] Индексировано: ${products.length} товаров (первичных: ${primaryIndices.length}, аксессуаров: ${accessoryIndices.length}), ${tokenIndex.size} уникальных токенов.` +
  (skippedUsdRows ? ` Пропущено строк в USD без курса USD_KZT_RATE: ${skippedUsdRows}.` : ''));

// ---------- ПРОМПТЫ МАТРИЧНОЙ ПРОВЕРКИ (шаг 2; шаг 1 — структура ТЗ в Document Extraction) ----------
const SPECS_MAX = 1500;
const fullSpecs = (p) => { const t = String(p.fullName || p.name || ''); return t.length > SPECS_MAX ? t.substring(0, SPECS_MAX) + '…' : t; };
function requirementsBlock(lot, fullLotText) {
  if (Array.isArray(lot.structuredSpec) && lot.structuredSpec.length) {
    return "СТРУКТУРИРОВАННЫЕ ТРЕБОВАНИЯ ТЗ ЛОТА (JSON):\n" + JSON.stringify(lot.structuredSpec, null, 1);
  }
  return "ТЕХНИЧЕСКАЯ СПЕЦИФИКАЦИЯ ЛОТА (текст — сначала выдели из него все требования):\n" + compressLotText(fullLotText);
}
const MATRIX_RULES =
  "ПРАВИЛА МАТРИЧНОГО АУДИТА:\n" +
  "1. Для КАЖДОГО требования ТЗ сформируй запись в массиве matrix (для выбранного кандидата; если ни один не подходит — для лучшего из них):\n" +
  "   • parameter — название требования как в ТЗ; is_mandatory — обязательно ли оно по ТЗ;\n" +
  "   • status: \"fulfilled\" — характеристики кандидата однозначно подтверждают требование; \"failed\" — кандидат НЕ соответствует " +
  "(например: i3-10105F без встроенного видео при требовании iGPU; экран 16:9 вместо 16:10 WUXGA; картридж без чипа при требовании чипа; совместимый вместо оригинала; 8 портов вместо 24; нет SIM/NFC/IP68); " +
  "\"no_data\" — в описании кандидата нет сведений. КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО угадывать по памяти: нет в описании — только \"no_data\";\n" +
  "   • proof — точная цитата из описания кандидата или факт несоответствия.\n\n";
const SAFETY_RULES =
  "СТОП-ПРАВИЛА (независимо от матрицы):\n" +
  "А. Запрет подмены класса: МФУ ≠ принтер, планшетный ПК ≠ графический планшет, монитор ≠ кронштейн, ПК ≠ кабели.\n" +
  "Б. VAD-бренды и письма производителя: если ТЗ требует Fortinet/Cisco/CheckPoint, MAF, авторизационное письмо или сертификат дистрибьютора — matchBadge: \"🔴 ТРЕБУЕТСЯ VAD\", rnuRisk: \"ВЫСОКИЙ РИСК РНУ\".\n" +
  "В. Коррупционные маркеры (согласование по личному WhatsApp/телефону, образец до подписания договора) — matchBadge: \"🔴 РИСК РНУ\", rnuRisk: \"ВЫСОКИЙ РИСК РНУ: КОРРУПЦИОННАЯ ЗАТОЧКА\".\n" +
  "Г. Конкретный бренд/модель без «или эквивалент»: если выбранный кандидат — именно этот бренд/модель, это НЕ препятствие (fulfilled, rnuRisk: \"НЕТ РИСКА\"); если другой — failed.\n" +
  "Если стоп-правил нет — matchBadge не указывай (решение принимается по матрице).\n\n";

// 2. ФИЛЬТРАЦИЯ ЛОТОВ ГОСЗАКУПОК
const output = [];

for (const lot of recentLots) {
  const lotDisplayNum = String(lot.lotNumber || lot.trdBuyNumberAnno || lot.id || '');
  if (!lotDisplayNum) continue;
  const lotKeys = [lotDisplayNum].concat(tsLotKeys(lot));
  if (lotKeys.some(k => sentLotIds.has(k)) || tsIsKnownLot(registry, lotKeys)) continue;
  // ТЗ ещё не прочитано (очередь Document Extraction) — проверим в следующем цикле
  if (lot.docPending) { skippedDocPending++; continue; }

  const lotBudget = parseFloat(lot.amount) || 0;
  const lotQty = parseInt(lot.count) || 1;
  const lotBudgetPerUnit = lotQty > 0 ? (lotBudget / lotQty) : lotBudget;
  const lotNameOnly = lot.nameRu || '';
  const lotDescOnly = lot.descriptionRu || '';
  const lotEnriched = (lot.enrichedDesc || '').trim();
  const lotDocSpec = (lot.docSpecText || '').trim();
  const fullLotText = (lotEnriched || (lotNameOnly + ' ' + lotDescOnly)).trim();
  // classText — название + краткое описание портала: по нему определяется КАТЕГОРИЯ лота
  // rawTitle — плюс ТТХ из PDF: для поиска кандидатов и требований (A3, PoE, цветность)
  const classText = (lotNameOnly + ' ' + lotDescOnly).trim();
  const rawTitle = (classText + (lotDocSpec ? ' ' + lotDocSpec : '')).trim();
  if (lotBudget < TS_CONFIG.MIN_LOT_BUDGET || lotBudget > TS_CONFIG.MAX_LOT_BUDGET || !rawTitle) continue;

  // ХАРД-ЛОК: Отсечение заведомо не-ИТ закупок (по названию и описанию портала, не по PDF)
  if (tsIsNonItText(lotNameOnly) || tsIsNonItText(lotDescOnly)) continue;

  // ПОЗИТИВНАЯ ПРОВЕРКА ДЛЯ СЛОВА "ГАРНИТУР":
  if (/гарнитур[а-я]*/i.test(classText)) {
    const hasFurniture = RE_FURNITURE.test(classText);
    const hasPositiveHeadset = RE_HEADSET_POSITIVE.test(rawTitle);
    if (hasFurniture || !hasPositiveHeadset) continue;
  }

  const directUrl = lot.trdBuyId
    ? 'https://goszakup.gov.kz/ru/announce/index/' + encodeURIComponent(lot.trdBuyId)
    : 'https://goszakup.gov.kz/ru/search/lots?filter%5Bcustomer%5D=&filter%5Bnumber%5D=' + encodeURIComponent(lot.lotNumber || lotDisplayNum);
  const lotMeta = {
    customerBin: lot.customerBin || null,
    customerName: lot.customerNameRu || '',
    endDate: lot.endDate || null,
    trdBuyId: lot.trdBuyId || null,
    isManualReviewRequired: !!lot.isManualReviewRequired,
    docExtractionError: lot.docExtractionError || null
  };

  // ФИЛЬТР 1: ВЕНДОР-ЛОКИ
  let isLocked = false;
  for (const vl of VENDOR_LOCK_PATTERNS) {
    if (vl.regex.test(rawTitle)) {
      output.push({
        json: Object.assign({
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
        }, lotMeta)
      });
      isLocked = true;
      break;
    }
  }
  if (isLocked) continue;

  // ШАГ 2: RETRIEVAL - токены лота строятся из названия, описания и ТТХ файла (без служебных заголовков)
  const lotTokens = tokenize(rawTitle);
  if (lotTokens.length === 0) continue;
  const lotNameTokens = new Set(tokenize(lotNameOnly));

  // Лот только на расходники: в названии есть расходник и НЕТ самого устройства
  // («МФУ и картриджи» — комплект; «Картридж для принтера HP» — расходник)
  const lotNameDeviceCore = lotNameOnly.replace(/(?:для|к)[ \t]+(?:принтер|мфу|копир|плоттер|аппарат)[^,;]*/gi, ' ');
  const isCartridgeOnlyLot = makeWordRegex('картридж[а-я]*|тонер[а-я]*|драм[а-я]*|чернил[а-я]*|фотобарабан[а-я]*|туба|термопленк[а-я]*').test(lotNameOnly) &&
    !makeWordRegex('мфу|принтер[а-я]*|многофункциональн[а-я]*|копировальн[а-я]*[ \t]+аппарат[а-я]*').test(lotNameDeviceCore);

  const lotHasA3 = RE_A3.test(rawTitle);
  const lotHasMfpNegation = RE_MFP_NEGATION.test(classText);
  let lotIsMFP = false;
  if (isCartridgeOnlyLot) {
    lotIsMFP = false;
  } else if (lotHasMfpNegation && !makeWordRegex('мфу|3-в-1|3[ \t]*в[ \t]*1|all-in-one|многофункциональн[а-я]*|imagerunner|mfp').test(classText)) {
    lotIsMFP = false;
  } else {
    lotIsMFP = RE_MFP_MODEL_SERIES.test(classText) || RE_MFP_FEATURE.test(classText);
  }

  const lotIsPrinterOnly = !isCartridgeOnlyLot && RE_PRINTER.test(classText) && !lotIsMFP;
  const lotColorMode = detectColorMode(rawTitle);
  const lotIsColor = lotColorMode === 'color';
  const lotIsMono = lotColorMode === 'mono';

  const lotIsLaptop = RE_LAPTOP.test(classText) || /портативн[а-я]*[ \t]+компьютер|компьютер[ \t]+портативн/i.test(lotNameOnly);
  const lotIsAIO = !lotIsMFP && !lotIsPrinterOnly && RE_AIO.test(classText);
  const lotIsTabletPC = !lotIsLaptop && (RE_TABLET_PC.test(classText) ||
    (makeWordRegex('планшет[а-я]*').test(lotNameOnly) && !RE_DIGITIZER.test(rawTitle) && lotBudgetPerUnit >= 60000));
  const lotIsDigitizerOnly = RE_DIGITIZER.test(rawTitle) && !lotIsTabletPC;
  const lotNameStartsMonitor = /^монитор/i.test(lotNameOnly.trim());
  const lotIsDesktop = !lotIsLaptop && !lotIsAIO && !lotIsTabletPC && !lotNameStartsMonitor && (
    RE_DESKTOP.test(classText) ||
    (makeWordRegex('компьютер[а-я]*').test(lotNameOnly) && !/планшетн|карманн|портативн/i.test(lotNameOnly))
  );
  const lotIsServer = RE_SERVER.test(classText) && !makeWordRegex('шкаф[а-я]*|стойк[а-я]*').test(lotNameOnly);
  const lotIsRouter = RE_ROUTER.test(classText) && !RE_SWITCH.test(classText);
  const lotIsSwitch = RE_SWITCH.test(classText) && !RE_ROUTER.test(classText);
  // Монитор внутри комплекта ПК — не отдельная категория (иначе комплект не находил кандидатов)
  const lotIsMonitor = RE_MONITOR.test(classText) && !lotIsAIO && !lotIsLaptop && !lotIsDesktop;
  const lotIsPhone = (makeWordRegex('телефон[а-я]*|смартфон[а-я]*').test(lotNameOnly) || /(?:сотовый|мобильный)\s*телефон|смартфон/i.test(classText)) && !/для\s*(?:зарядки|подключения|питания)\s*(?:телефонов|смартфонов)/i.test(classText);

  const hasCoreDevice = lotIsMFP || lotIsPrinterOnly || lotIsLaptop || lotIsAIO || lotIsDesktop || lotIsMonitor || lotIsServer || lotIsTabletPC || lotIsPhone;
  const lotIsFlash = !hasCoreDevice && RE_FLASH.test(classText);

  // Новые ИТ-категории — только если лот не является основным устройством
  // (веб-камера ноутбука, режим «точка доступа» роутера, аккумулятор ИБП больше не ломают отбор)
  const lotIsUPS = !hasCoreDevice && RE_UPS.test(classText) && !/^(?:аккумулятор|батаре|сменн|замена)/i.test(lotNameOnly.trim());
  const lotIsProjector = !hasCoreDevice && RE_PROJECTOR.test(classText) && !/^(?:экран|полотно|кронштейн|лампа|крепл)/i.test(lotNameOnly.trim());
  const lotIsCamera = !hasCoreDevice && RE_CAMERA.test(classText) && !makeWordRegex('монтаж[а-я]*|установк[а-я]*|обслуживани[а-я]*').test(lotNameOnly) && !/^(?:кронштейн|коробк)/i.test(lotNameOnly.trim());
  const lotIsAccessPoint = !hasCoreDevice && !lotIsRouter && !lotIsSwitch && RE_ACCESS_POINT.test(classText) && !makeWordRegex('монтаж[а-я]*|настройк[а-я]*').test(lotNameOnly);

  const lotRequiresPoE = RE_POE.test(rawTitle) && !/без[ \t]+poe|poe[ \t]*[:–-]?[ \t]*(?:нет|отсутств)/i.test(rawTitle);
  const lotRequiresManaged = RE_MANAGED.test(rawTitle) && !RE_UNMANAGED.test(classText);

  const hasPrinterOrMFP = (lotIsMFP || lotIsPrinterOnly) && !isCartridgeOnlyLot;
  // «Стартовый картридж в комплекте» — не требование поставки расходников
  const classNoStarter = classText.replace(/стартов[а-я]*[ \t]+(?:картридж|тонер)[а-я]*/gi, ' ');
  const hasCartridge = makeWordRegex('картридж[а-я]*|тонер[а-я]*').test(classNoStarter);
  const isPrinterBundle = hasPrinterOrMFP && hasCartridge && !isCartridgeOnlyLot;

  const hasPC = lotIsDesktop || lotIsAIO;
  const hasKBMOrMon = makeWordRegex('монитор[а-я]*|клавиатур[а-я]*|мышь|мыши').test(classText);
  const isPCBundle = hasPC && hasKBMOrMon;
  const isBundle = isPrinterBundle || isPCBundle;

  const isPrimaryLot = lotIsMFP || lotIsPrinterOnly || lotIsLaptop || lotIsAIO || lotIsDesktop || lotIsMonitor || lotIsTabletPC || lotIsServer || lotIsSwitch || lotIsRouter || lotIsPhone || lotIsFlash || lotIsUPS || lotIsProjector || lotIsCamera || lotIsAccessPoint;

  let categoryTag = 'other';
  if (lotIsMonitor) categoryTag = 'monitor';
  else if (hasPrinterOrMFP) categoryTag = 'printer_mfp';
  else if (lotIsDesktop || lotIsLaptop || lotIsAIO) categoryTag = 'computer';
  else if (lotIsTabletPC || lotIsDigitizerOnly) categoryTag = 'tablet';
  else if (lotIsServer) categoryTag = 'server';
  else if (lotIsRouter || lotIsSwitch) categoryTag = 'network';
  else if (lotIsPhone) categoryTag = 'phone';
  else if (lotIsFlash) categoryTag = 'flash';
  else if (lotIsUPS) categoryTag = 'ups';
  else if (lotIsProjector) categoryTag = 'projector';
  else if (lotIsCamera) categoryTag = 'camera';
  else if (lotIsAccessPoint) categoryTag = 'network';
  else if (isCartridgeOnlyLot || RE_ACCESSORY.test(classText)) categoryTag = 'cartridge_part';

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
        if (!prod.isPrimaryProd) continue;
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
            distributor: prod.distributor || 'Al-Style',
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
            distributor: prod.distributor || 'Al-Style',
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
      specs: fullSpecs(p),
      price: p.price,
      score: +p.score.toFixed(1)
    }));
    const topAccessory = accessoryScored.slice(0, 3);
    const topAccessoryForAi = topAccessory.map(a => ({
      code: a.code,
      name: a.name,
      specs: fullSpecs(a),
      price: a.price,
      score: +a.score.toFixed(1)
    }));
    const primaryCost = topPrimary[0].price;
    const accessoryCost = topAccessory.length > 0 ? topAccessory[0].price : 0;
    const baseFin = evaluateFinancials(lotBudget, primaryCost + accessoryCost, lotQty, topPrimary[0].name);
    if (!baseFin.isViable) continue;

    const geminiPrompt =
      "Ты — старший юрист по госзакупкам РК и главный технический эксперт ТОО «Os.corp Energy». Проверь применимость КОМПЛЕКТА со склада к лоту и заполни МАТРИЦУ СООТВЕТСТВИЯ.\n\n" +
      "ДАННЫЕ ЛОТА:\n- ID лота: " + lotDisplayNum + "\n- Наименование: " + lotNameOnly + "\n- Бюджет: " + lotBudget + " KZT, Количество: " + lotQty + " шт.\n\n" +
      requirementsBlock(lot, fullLotText) + "\n\n" +
      "КАНДИДАТЫ СО СКЛАДА — ОСНОВНОЕ ОБОРУДОВАНИЕ (полные характеристики):\n" + JSON.stringify(topPrimaryForAi, null, 1) + "\n\n" +
      "КАНДИДАТЫ СО СКЛАДА — РАСХОДНИКИ / КОМПЛЕКТУЮЩИЕ:\n" + JSON.stringify(topAccessoryForAi, null, 1) + "\n\n" +
      MATRIX_RULES + SAFETY_RULES +
      "КОМПЛЕКТАЦИЯ: если ТЗ требует и устройство, и расходники — матрица должна покрывать обе позиции. Стартовый картридж из комплекта устройства отдельной позицией не считается.\n" +
      "ВЫБОР КОДОВ: selectedPrimaryCode и selectedAccessoryCodes — ТОЛЬКО коды из списков выше, символ в символ. lotId — ID лота без изменений.\n" +
      "verdict — 1–3 предложения, до 300 символов.\n\n" +
      "Ответь строго по JSON-схеме, без пояснений вне JSON.";

    output.push({
      json: {
        categoryTag,
        chatId,
        tradeMethodId: Number(lot.refTradeMethodsId || 3),
        staleCatalog: isCatalogStale,
        isBundle: true,
        isVendorLocked: false,
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
        geminiPrompt,
        requirementsCount: Array.isArray(lot.structuredSpec) ? lot.structuredSpec.length : 0,
        ...lotMeta
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
      // PoE и управляемость (раньше вычислялись, но не применялись)
      if ((lotIsSwitch || lotIsAccessPoint) && lotRequiresPoE && !prod.hasPoE) continue;
      if (lotIsSwitch && lotRequiresManaged && prod.isUnmanaged) continue;

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
      specs: fullSpecs(c),
      price: c.price,
      score: +c.score.toFixed(1)
    }));

    const bestFin = topCandidates[0].fin;

    const geminiPrompt =
      "Ты — старший юрист по госзакупкам РК и главный технический эксперт ТОО «Os.corp Energy». Сопоставь кандидатов со склада с требованиями ТЗ лота и заполни МАТРИЦУ СООТВЕТСТВИЯ.\n\n" +
      "ДАННЫЕ ЛОТА:\n- ID лота: " + lotDisplayNum + "\n- Наименование: " + lotNameOnly + "\n- Бюджет: " + lotBudget + " KZT, Количество: " + lotQty + " шт.\n\n" +
      requirementsBlock(lot, fullLotText) + "\n\n" +
      "КАНДИДАТЫ СО СКЛАДА (полные характеристики):\n" + JSON.stringify(candidatePayload, null, 1) + "\n\n" +
      MATRIX_RULES + SAFETY_RULES +
      "ВЫБОР КОДА: selectedCode — ТОЛЬКО код из списка кандидатов, символ в символ (кандидат, для которого заполнена матрица). lotId — ID лота без изменений.\n" +
      "verdict — 1–3 предложения, до 300 символов.\n\n" +
      "Ответь строго по JSON-схеме, без пояснений вне JSON.";

    output.push({
      json: {
        categoryTag,
        chatId,
        isBundle: false,
        isVendorLocked: false,
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
        geminiPrompt,
        requirementsCount: Array.isArray(lot.structuredSpec) ? lot.structuredSpec.length : 0,
        ...lotMeta
      }
    });
  }
}

// ШАГ 7: КВОТИРОВАНИЕ НА УРОВНЕ ЛОТОВ (ANTI-STARVATION FAIR LOT SELECTION)
output.sort((a, b) => (b.json.profit || 0) - (a.json.profit || 0));

// Не более 5 лотов на категорию, затем добор до 30 из переполнения; остальные — в следующий цикл
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

const deferredLots = overflowLots.length;
console.log(`[PRE-FILTER] Кандидатов для ИИ: ${selectedLots.filter(l => !l.json.isVendorLocked).length} | Вендор-локов: ${selectedLots.filter(l => l.json.isVendorLocked).length} | ` +
  `Отложено до след. цикла: ${deferredLots} | Ждут чтения ТЗ: ${skippedDocPending}`);

if (selectedLots.length === 0) {
  return [{ json: { empty: true, chatId, deferredLots, skippedDocPending } }];
}
if (deferredLots || skippedDocPending) {
  selectedLots[0].json.deferredLots = deferredLots;
  selectedLots[0].json.skippedDocPending = skippedDocPending;
}

return selectedLots;
