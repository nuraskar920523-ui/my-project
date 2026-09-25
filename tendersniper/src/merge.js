// ====================================================================
// ОБЪЕДИНЕНИЕ, ДЕДУПЛИКАЦИЯ И СТРОГАЯ ФИЛЬТРАЦИЯ ПО Г. АЛМАТЫ (КАТО 75*)
// • Если у лота есть КАТО — решает только КАТО (доставка в область не пройдёт по имени заказчика).
// • Имя заказчика — только запасной вариант при пустом plnPointKatoList.
// • Отсев лотов с истекающим дедлайном (если API отдал TrdBuy.endDate).
// ====================================================================
//@@include:config

const allItems = $input.all();
const seenIds = new Set();
const allLots = [];
let errorCount = 0;
let partialErrorCount = 0;
let totalRaw = 0;
let skippedOtherRegions = 0;
let skippedDeadline = 0;
let skippedMethod = 0;
let withDeadline = 0;

const RE_ALMATY_CITY = /(?:^|[^\wа-яё])(?:г\.?[ \t]*алматы|город[ \t]+алматы)(?:[^\wа-яё]|$)/i;
const RE_EXCLUDE_REGION = /(?:област[а-я]*|талдыкорган[а-я]*|қонаев[а-я]*|конаев[а-я]*|каскелен[а-я]*|қаскелең[а-я]*|есик[а-я]*|есік[а-я]*|иссык[а-я]*|тургень[а-я]*|жаркент[а-я]*|текели[а-я]*|карасайск[а-я]*|илийск[а-я]*|талгар[а-я]*|енбекшиказах[а-я]*|жамбылск[а-я]*)/i;

// Дата портала без часового пояса трактуется как время Алматы (UTC+5)
function parsePortalDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let d;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    d = new Date(s.replace(' ', 'T') + (s.length === 16 ? ':00' : '') + TS_CONFIG.ALMATY_UTC_OFFSET);
  } else {
    d = new Date(s);
  }
  return isNaN(d.getTime()) ? null : d;
}

const excludedMethods = new Set(TS_CONFIG.EXCLUDE_TRADE_METHOD_IDS.map(Number));
const minDeadlineMs = TS_CONFIG.MIN_HOURS_TO_DEADLINE * 3600000;

for (const item of allItems) {
  const resp = item.json || {};
  if (resp.error || resp.errors) {
    errorCount++;
    console.warn('[MERGE WARN] Ошибка в ответе API (' + (resp.keyword || '?') + '):', JSON.stringify(resp.error || resp.errors).substring(0, 200));
    continue;
  }
  if (resp.partialError) partialErrorCount++;
  const lots = resp.data?.Lots || [];
  totalRaw += lots.length;
  for (const lot of lots) {
    const lotId = String(lot.id);
    if (seenIds.has(lotId)) continue;
    seenIds.add(lotId);

    // ГЕО-ФИЛЬТР
    const katoList = (Array.isArray(lot.plnPointKatoList) ? lot.plnPointKatoList : []).map(k => String(k || '').trim()).filter(Boolean);
    let isAlmaty;
    if (katoList.length > 0) {
      isAlmaty = katoList.some(k => k.startsWith('75'));
    } else {
      const custName = String(lot.customerNameRu || '').toLowerCase();
      isAlmaty = RE_ALMATY_CITY.test(custName) && !RE_EXCLUDE_REGION.test(custName);
    }
    if (!isAlmaty) { skippedOtherRegions++; continue; }

    if (excludedMethods.size && excludedMethods.has(Number(lot.refTradeMethodsId))) { skippedMethod++; continue; }

    // Нормализация расширенных полей
    lot.trdBuyId = lot.trdBuyId || lot.TrdBuy?.id || null;
    const endDate = parsePortalDate(lot.TrdBuy?.endDate);
    lot.endDate = endDate ? endDate.toISOString() : null;
    if (endDate) {
      withDeadline++;
      if (endDate.getTime() - Date.now() < minDeadlineMs) { skippedDeadline++; continue; }
    }

    allLots.push(lot);
  }
}

const apiFailure = errorCount > 0 && totalRaw === 0 && allItems.length > 0;
if (apiFailure) {
  console.error(`[MERGE CRITICAL] Все ${allItems.length} запросов к ЦЭФ вернули ошибки! Возможен сбой GOSZAKUP_TOKEN.`);
}

console.log(`[MERGE ALMATY SOLO] Всего лотов: ${totalRaw} | Других регионов: ${skippedOtherRegions} | Дедлайн < ${TS_CONFIG.MIN_HOURS_TO_DEADLINE}ч: ${skippedDeadline} | ` +
  `Исключённые способы: ${skippedMethod} | Алматы: ${allLots.length} | С известным дедлайном: ${withDeadline} | Ошибок API: ${errorCount} (+частичных: ${partialErrorCount})`);

return [{
  json: {
    data: { Lots: allLots },
    mergedCount: allLots.length,
    totalRaw,
    skippedOtherRegions,
    skippedDeadline,
    errorCount,
    partialErrorCount,
    keywordCount: allItems.length,
    apiFailure
  }
}];
