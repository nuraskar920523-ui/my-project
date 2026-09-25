// ====================================================================
// УЗЕЛ: ДАЙДЖЕСТ И ЭКСПОРТ (РЕЖИМ «СЕНТЯБРЬ СОЛО» — РАСШИРЕННАЯ ВЫБОРКА)
// Критерии: Маржа >= 15%, Статус 🟢 ТОЧНОЕ СОВПАДЕНИЕ, Все методы (ЗЦП, ОИ, ОК)
// Без ограничения Топ-5: выдает всю выборку лотов для выполнения плана!
// ====================================================================
const fs = require('fs');
//@@include:config
//@@include:lock
//@@include:registry
//@@include:regex_util
//@@include:finance

const items = $input.all();

let chatId = TS_CONFIG.ADMIN_CHAT_ID;
let lockOwner = null;
try {
  const auth = $('Auth & Command Router').first()?.json || {};
  chatId = auth.chatId || items[0]?.json?.chatId || TS_CONFIG.ADMIN_CHAT_ID;
  lockOwner = auth.lockOwner || null;
} catch (e) {
  chatId = items[0]?.json?.chatId || TS_CONFIG.ADMIN_CHAT_ID;
}

function formatDeadline(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const hoursLeft = Math.round((d.getTime() - Date.now()) / 3600000);
  return d.toLocaleString('ru-RU', { timeZone: 'Asia/Almaty', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) +
    ' (' + (hoursLeft >= 48 ? Math.round(hoursLeft / 24) + ' дн.' : hoursLeft + ' ч') + ')';
}
const truncate = (t, n) => { const s = String(t || ''); return s.length > n ? s.substring(0, n - 1) + '…' : s; };

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

const CRITERIA_TEXT = 'Маржа ≥ ' + TS_CONFIG.DIGEST_MIN_MARGIN + '% или прибыль ≥ ' +
  TS_CONFIG.DIGEST_ALT_MIN_PROFIT.toLocaleString('ru-RU') + ' ₸ при марже ≥ ' + TS_CONFIG.DIGEST_ALT_MIN_MARGIN + '%';

// 1. Отбор лотов под критерии Соло-режима + сбор статистики пропущенного
const eligibleLots = [];
const manualLots = [];
let lockedCount = 0, aiFailCount = 0, rejectedCount = 0, belowCount = 0;
for (const item of items) {
  const d = item.json || {};
  if (d.empty) continue;
  if (d.isVendorLocked) { lockedCount++; continue; }
  if (d.apiError) { aiFailCount++; continue; }
  if (d.needsManualReview) { manualLots.push(d); continue; }
  if (!d.isCompatible || !d.productCode) { rejectedCount++; continue; }
  const isExactMatch = d.matchBadge === '🟢 ТОЧНОЕ СОВПАДЕНИЕ';
  if (isExactMatch && isDigestEligible(d.marginPercent, d.profit)) eligibleLots.push(d);
  else belowCount++;
}

let preMeta = {}, mergeMeta = {};
try { preMeta = $('Pre-Filter & Candidate Builder').first()?.json || {}; } catch (e) {}
try { mergeMeta = $('Merge & Deduplicate Lots').first()?.json || {}; } catch (e) {}

// 2. Сортировка по убыванию маржинальности (самые прибыльные первыми)
eligibleLots.sort((a, b) => (Number(b.marginPercent) || 0) - (Number(a.marginPercent) || 0));

const rowsToExport = [];
const verifiedBullets = [];
let totalProfit = 0;

for (let i = 0; i < eligibleLots.length; i++) {
  const d = eligibleLots[i];
  totalProfit += (d.profit || 0);
  const truncatedName = truncate(d.productName, 60);
  const deadlineText = formatDeadline(d.endDate);
  const safeName = escapeHtml(truncatedName);
  const safeLotNum = escapeHtml(d.lotId);
  const tag = d.isBundle ? '📦 <b>[КОМПЛЕКТ]</b> ' : '🔹 ';
  const methodName = getMethodName(d.tradeMethodId);
  const distName = d.distributor === 'ASBIS' ? '🏢 ASBIS' : '🏢 Al-Style';

  verifiedBullets.push(
    tag + '<b>#' + (i + 1) + ' | Лот № ' + safeLotNum + '</b>: <i>' + safeName + '</i> (' + d.lotQty + ' шт)\n' +
    '   • Поставщик: <b>' + distName + '</b> | Товар: <code>' + escapeHtml(d.productCode || '—') + '</code>\n' +
    '   • Способ: <b>' + escapeHtml(methodName) + '</b>' + (deadlineText ? ' | ⏳ До: <b>' + escapeHtml(deadlineText) + '</b>' : '') + '\n' +
    '   • Бюджет: <b>' + formatKZT(d.lotBudget) + '</b> | Подача: <b>' + formatKZT(d.targetBid) + '</b> (-' + Math.round(TS_CONFIG.BID_DISCOUNT * 100) + '%)\n' +
    '   • Закупка: <code>' + formatKZT(d.totalCost) + '</code> | Доставка: <code>' + formatKZT(d.logisticsCost) + '</code>\n' +
    '   • Налог СНР 3%: <code>' + formatKZT(d.totalTax) + '</code> <i>(ФНО 910.00, без НДС и КПН)</i>\n' +
    '   • <b>Чистая прибыль:</b> <code>+' + formatKZT(d.profit) + '</code> (<b>+' + (d.marginPercent || 0).toFixed(1) + '%</b>)\n' +
    '   • Статус: ' + d.matchBadge + ' | ' + (d.rnuRisk || 'НЕТ РИСКА') + '\n' +
    (d.isManualReviewRequired ? '   • ⚠️ <i>Скан ТЗ слишком большой — сверьте ТЗ вручную</i>\n' : '') +
    '   • <i>' + escapeHtml(truncate(d.aiVerdict, 350)) + '</i>\n' +
    '   🔗 <a href="' + escapeHtml(d.directUrl) + '">Открыть лот на Госзакуп</a>'
  );

  rowsToExport.push({
    'Дата': now,
    'Менеджер': 'TenderSniper Almaty Solo',
    'Поставщик': d.distributor || 'Al-Style',
    'Номер_Лота': d.lotId,
    'rawLotId': d.trdBuyId || '',
    'annoNum': '',
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
    'Статус': 'Алматы Соло (' + CRITERIA_TEXT + ')' + (d.endDate ? ' | дедлайн ' + formatDeadline(d.endDate) : '')
  });
}

// 3. Сводка по лотам, которые не попали в выборку (раньше терялись молча)
const statLines = [];
if (manualLots.length) {
  statLines.push('🟡 <b>Требуют ручной проверки: ' + manualLots.length + '</b>');
  for (const m of manualLots.slice(0, 8)) {
    statLines.push('   • <a href="' + escapeHtml(m.directUrl) + '">Лот № ' + escapeHtml(m.lotId) + '</a> — ' + escapeHtml(truncate(m.lotName, 50)));
  }
}
if (aiFailCount) statLines.push('⚠️ Не проверено из-за сбоя Gemini: <b>' + aiFailCount + '</b> (повтор в следующем цикле)');
if (lockedCount) statLines.push('⛔ Отсеяно по вендор-локам/заточке: ' + lockedCount);
if (rejectedCount || belowCount) statLines.push('🔍 Отклонено ИИ: ' + rejectedCount + ' | Ниже порога маржи: ' + belowCount);
if (preMeta.deferredLots) statLines.push('⏭ Отложено до следующего цикла (лимит 30 лотов): ' + preMeta.deferredLots);
if (preMeta.skippedDocPending) statLines.push('📄 Ждут чтения ТЗ: ' + preMeta.skippedDocPending);
if (mergeMeta.errorCount && !mergeMeta.apiFailure) statLines.push('⚠️ Ошибки ЦЭФ API: ' + mergeMeta.errorCount + ' из ' + (mergeMeta.keywordCount || '?') + ' запросов');
const statsBlock = statLines.length ? '\n\n' + statLines.join('\n') : '';

// 4. Формирование сообщений для Telegram с защитой от лимита 4096 символов
const outputMessages = [];

if (verifiedBullets.length > 0) {
  const MAX_BODY_LEN = 2600; // + заголовок и сводка — укладываемся в лимит Telegram 4096
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
        chunkBody += '⚠️ <i>Внимание: кэш каталога старше 48 часов — цены могли измениться.</i>\n\n';
      }
      chunkBody += 
        '📍 <b>Регион:</b> г. Алматы (КАТО 75*) | Способы: ЗЦП, ОИ, ОК\n' +
        '🎯 <b>Отобрано лотов к подаче:</b> <b>' + eligibleLots.length + ' шт.</b> (' + CRITERIA_TEXT + ')\n' +
        '💰 <b>Общая прибыль по выборке:</b> <b>+' + formatKZT(totalProfit) + '</b>\n\n' +
        '📦 <b>ОТОБРАННЫЕ ЛОТЫ:</b>\n\n';
    }

    chunkBody += chunkBullets.join('\n\n');

    if (c === totalChunks - 1) {
      chunkBody += statsBlock + '\n\n━━━━━━━━━━━━━━━━━━━━\n📁 <i>Все ' + eligibleLots.length + ' лотов записываются в Google Таблицу.</i>';
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
        'Проверьте наличие файлов <code>multi_catalog_cache.json</code> / <code>alstyle_catalog_cache.json</code> в <code>/home/node/.n8n/</code>.',
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
        'За текущий цикл подходящих лотов по Алматы (' + CRITERIA_TEXT + ', 🟢 точное совпадение) не найдено.' + statsBlock + '\n\n' +
        '<i>Следующая проверка: 09:30 или 13:00 (Asia/Almaty).</i>',
      chunkIndex: 0,
      isFirstChunk: true
    });
  }
}

console.log('[ALMATY EXPANDED DIGEST] Отобрано лотов: ' + eligibleLots.length + ', прибыль: ' + totalProfit + ' KZT, сообщений: ' + outputMessages.length);

// 5. Отправленные лоты — в локальный реестр ДО отправки (дедуп не зависит от записи в Google Sheets)
if (eligibleLots.length) {
  const reg = tsLoadRegistry(fs);
  const ts = Date.now();
  for (const d of eligibleLots) reg.sent[String(d.lotId)] = { ts };
  tsSaveRegistry(fs, reg);
}

// 6. Снятие блокировки сканирования (только своей — по lockOwner из Auth)
if (lockOwner) {
  const released = tsReleaseLock(fs, lockOwner);
  console.log('[AUTH LOCK] ' + (released ? 'Блокировка снята.' : 'Блокировка уже снята или принадлежит другому запуску.'));
}

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