// ====================================================================
// УЗЕЛ: ДАЙДЖЕСТ И ЭКСПОРТ (РЕЖИМ «СЕНТЯБРЬ СОЛО» — РАСШИРЕННАЯ ВЫБОРКА)
// Критерии: Маржа >= 15%, Статус 🟢 ТОЧНОЕ СОВПАДЕНИЕ, Все методы (ЗЦП, ОИ, ОК)
// Без ограничения Топ-5: выдает всю выборку лотов для выполнения плана!
// ====================================================================
const items = $input.all();

let chatId = 681740470;
try {
  chatId = $('Auth & Command Router').first()?.json?.chatId || items[0]?.json?.chatId || 681740470;
} catch (e) {
  chatId = items[0]?.json?.chatId || 681740470;
}

function formatKZT(n) { 
  return Math.round(n || 0).toLocaleString('ru-RU') + ' ₸'; 
}

function escapeHtml(text) {
  if (!text) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getMethodName(id) {
  const numId = Number(id);
  const map = {
    1: 'Открытый конкурс',
    2: 'Открытый конкурс (ОК)',
    3: 'ЗЦП (Ценовые предложения)',
    4: 'Один источник (ОИНЗ)',
    5: 'Один источник (прямой)',
    6: 'Аукцион',
    7: 'Конкурс с ПКО',
    8: 'Электронный магазин (Omarket)',
    32: 'Конкурс с ПКО',
    50: 'Один источник (ЗЦП)',
    126: 'ЗЦП (квазигоссектор)',
    130: 'ГЗПОП',
    188: 'Конкурс (технадзор)'
  };
  return map[numId] || ('Способ ID ' + (id || 'ЗЦП'));
}

const now = new Date().toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' });

// 1. Отбор ВСЕХ лотов под критерии Соло-режима (Маржа >= 15% И точное совпадение)
const eligibleLots = [];
for (const item of items) {
  const d = item.json || {};
  if (!d.isCompatible || !d.productCode) continue;

  const margin = Number(d.marginPercent || 0);
  const isExactMatch = d.matchBadge === '🟢 ТОЧНОЕ СОВПАДЕНИЕ';

  const profit = Number(d.profit || 0);
  const isHighMargin = margin >= 15;
  const isHighProfit = profit >= 30000 && margin >= 5;

  if ((isHighMargin || isHighProfit) && isExactMatch) {
    eligibleLots.push(d);
  }
}

// 2. Сортировка по убыванию маржинальности (самые прибыльные первыми)
eligibleLots.sort((a, b) => (Number(b.marginPercent) || 0) - (Number(a.marginPercent) || 0));

const rowsToExport = [];
const verifiedBullets = [];
let totalProfit = 0;

for (let i = 0; i < eligibleLots.length; i++) {
  const d = eligibleLots[i];
  totalProfit += (d.profit || 0);
  const truncatedName = (d.productName || '').length > 45 ? d.productName.substring(0, 45) + '...' : (d.productName || '');
  const safeName = escapeHtml(truncatedName);
  const safeLotNum = escapeHtml(d.lotId);
  const tag = d.isBundle ? '📦 <b>[КОМПЛЕКТ]</b> ' : '🔹 ';
  const methodName = getMethodName(d.tradeMethodId);
  const distName = d.distributor === 'ASBIS' ? '🏢 ASBIS' : '🏢 Al-Style';

  verifiedBullets.push(
    tag + '<b>#' + (i + 1) + ' | Лот № ' + safeLotNum + '</b>: <i>' + safeName + '</i> (' + d.lotQty + ' шт)\n' +
    '   • Поставщик: <b>' + distName + '</b> | Товар: <code>' + escapeHtml(d.productCode || '—') + '</code>\n' +
    '   • Способ: <b>' + escapeHtml(methodName) + '</b>\n' +
    '   • Бюджет: <b>' + formatKZT(d.lotBudget) + '</b> | Подача: <b>' + formatKZT(d.targetBid) + '</b> (-10%)\n' +
    '   • Закупка: <code>' + formatKZT(d.totalCost) + '</code> | Доставка: <code>' + formatKZT(d.logisticsCost) + '</code>\n' +
    '   • Налог СНР 3%: <code>' + formatKZT(d.totalTax) + '</code> <i>(ФНО 910.00, без НДС и КПН)</i>\n' +
    '   • <b>Чистая прибыль:</b> <code>+' + formatKZT(d.profit) + '</code> (<b>+' + (d.marginPercent || 0).toFixed(1) + '%</b>)\n' +
    '   • Статус: ' + d.matchBadge + ' | ' + (d.rnuRisk || 'НЕТ РИСКА') + '\n' +
    '   • <i>' + escapeHtml(d.aiVerdict) + '</i>\n' +
    '   🔗 <a href="' + d.directUrl + '">Открыть лот на Госзакуп</a>'
  );

  rowsToExport.push({
    'Дата': now,
    'Менеджер': 'TenderSniper Almaty Solo',
    'Поставщик': d.distributor || 'Al-Style',
    'Номер_Лота': d.lotId,
    'rawLotId': d.rawLotId,
    'annoNum': d.annoNum,
    'Способ_Закупки': methodName,
    'Ссылка_Госзакуп': d.directUrl,
    'Код': d.productCode,
    'Товар': d.productName,
    'Тип_Закупки': d.isBundle ? 'Комплект' : 'Одиночный',
    'Кол-во': d.lotQty,
    'Бюджет_Лота': d.lotBudget,
    'Ставка_Подачи': d.targetBid,
    'Закупка_Итого': d.totalCost,
    'Доставка': d.logisticsCost,
    'Налоги_ТОО_Итого': d.totalTax,
    'НДС_к_Уплате': d.vatPayable,
    'КПН_20%': d.citPayable,
    'Чистая_Прибыль': d.profit,
    'Запас_Маржи_%': (d.marginPercent || 0).toFixed(1) + '%',
    'ИИ_Вердикт': d.aiVerdict,
    'ИИ_Риск_РНУ': d.rnuRisk,
    'Статус': 'Алматы Соло (Маржа ≥15%)'
  });
}

// 3. Формирование сообщений для Telegram с защитой от лимита 4096 символов
const outputMessages = [];

if (verifiedBullets.length > 0) {
  const MAX_BODY_LEN = 3000;
  const chunkList = [];
  let curChunk = [];
  let curLen = 0;

  for (const b of verifiedBullets) {
    if (curChunk.length > 0 && (curLen + b.length + 10) > MAX_BODY_LEN) {
      chunkList.push(curChunk);
      curChunk = [b];
      curLen = b.length;
    } else {
      curChunk.push(b);
      curLen += b.length + 10;
    }
  }
  if (curChunk.length > 0) chunkList.push(curChunk);

  const totalChunks = chunkList.length;

  for (let c = 0; c < totalChunks; c++) {
    const chunkBullets = chunkList[c];
    const chunkHeader = (totalChunks > 1) 
      ? '🍎 <b>TENDERSNIPER LITE — АЛМАТЫ СОЛО</b> (' + (c + 1) + '/' + totalChunks + ')\n━━━━━━━━━━━━━━━━━━━━\n'
      : '🍎 <b>TENDERSNIPER LITE — АЛМАТЫ СОЛО</b>\n━━━━━━━━━━━━━━━━━━━━\n';
    
    let chunkBody = '';
    const hasStaleCatalog = eligibleLots.some(l => l.staleCatalog);
    if (c === 0) {
      if (hasStaleCatalog) {
        chunkBody += '⚠️ <i>Внимание: Кэш каталога Al-Style старше 36 часов.</i>\n\n';
      }
      chunkBody += 
        '📍 <b>Регион:</b> г. Алматы (КАТО 75*) | Способы: ЗЦП, ОИ, ОК\n' +
        '🎯 <b>Отобрано лотов к подаче:</b> <b>' + eligibleLots.length + ' шт.</b> (Маржа ≥ 15%)\n' +
        '💰 <b>Общая прибыль по выборке:</b> <b>+' + formatKZT(totalProfit) + '</b>\n\n' +
        '📦 <b>ОТОБРАННЫЕ ЛОТЫ:</b>\n\n';
    }

    chunkBody += chunkBullets.join('\n\n');

    if (c === totalChunks - 1) {
      chunkBody += '\n\n━━━━━━━━━━━━━━━━━━━━\n📁 <i>Все ' + eligibleLots.length + ' лотов зафиксированы в Google Таблицу.</i>';
    }

    outputMessages.push({
      text: chunkHeader + chunkBody,
      chunkIndex: c,
      isFirstChunk: c === 0
    });
  }
} else {
  let isApiFailure = false;
  let isCatalogError = false;
  try {
    isApiFailure = $('Pre-Filter & Candidate Builder').first()?.json?.apiFailure ||
                   $('Document Extraction Layer').first()?.json?.apiFailure ||
                   $('Merge & Deduplicate Lots').first()?.json?.apiFailure || false;
    isCatalogError = $('Pre-Filter & Candidate Builder').first()?.json?.catalogLoadError || false;
  } catch (e) {}

  if (isCatalogError) {
    outputMessages.push({
      text:
        '❌ <b>TENDERSNIPER LITE — ОШИБКА КАТАЛОГА</b>\n━━━━━━━━━━━━━━━━━━━━\n' +
        '📍 <b>Регион:</b> г. Алматы (КАТО 75*)\n\n' +
        'Не удалось загрузить номенклатуру каталога Al-Style (файл кэша отсутствует или повреждён).\n' +
        'Проверьте наличие файла кэша <code>alstyle_catalog_cache.json</code> на сервере n8n.',
      chunkIndex: 0,
      isFirstChunk: true
    });
  } else if (isApiFailure) {
    outputMessages.push({
      text:
        '⚠️ <b>TENDERSNIPER LITE — АЛМАТЫ СОЛО</b>\n━━━━━━━━━━━━━━━━━━━━\n' +
        '📍 <b>Регион:</b> г. Алматы (КАТО 75*)\n\n' +
        '❌ <b>Сбой соединения с порталом Госзакупок (ЦЭФ GraphQL API)!</b>\n\n' +
        'Все запросы завершились ошибкой авторизации или сетевым тайм-аутом. Проверьте актуальность <code>GOSZAKUP_TOKEN</code> в переменных окружения n8n.\n\n' +
        '<i>Следующая автоматическая попытка: 09:30 или 13:00 (Asia/Almaty).</i>',
      chunkIndex: 0,
      isFirstChunk: true
    });
  } else {
    outputMessages.push({
      text:
        '🍎 <b>TENDERSNIPER LITE — АЛМАТЫ СОЛО</b>\n━━━━━━━━━━━━━━━━━━━━\n' +
        '📍 <b>Регион:</b> г. Алматы (КАТО 75*) | Способы: ЗЦП, ОИ, ОК\n\n' +
        'За текущий цикл подходящих лотов по Алматы с маржой <b>≥ 15%</b> и <b>100% точным совпадением</b> не найдено.\n' +
        '<i>Следующая проверка: 09:30 или 13:00 (Asia/Almaty).</i>',
      chunkIndex: 0,
      isFirstChunk: true
    });
  }
}

console.log('[ALMATY EXPANDED DIGEST] Отобрано лотов: ' + eligibleLots.length + ', прибыль: ' + totalProfit + ' KZT, сообщений: ' + outputMessages.length);

// Блокировка сканирования staticData.lastScanTime = 0 снимается исключительно в терминальном узле сохранения истории либо по истечении таймаута LOCK_TIMEOUT_MS

// Возвращаем сообщения для отправки в Telegram
return outputMessages.map(m => ({
  json: {
    chatId,
    hasMatches: rowsToExport.length > 0 && m.isFirstChunk,
    isFirstChunk: m.isFirstChunk,
    chunkIndex: m.chunkIndex,
    matchedCount: rowsToExport.length,
    summaryMessage: m.text,
    rowsToExport: m.isFirstChunk ? rowsToExport : []
  }
}));