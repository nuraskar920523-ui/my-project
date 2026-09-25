// ====================================================================
// ОБЪЕДИНЕНИЕ, ДЕДУПЛИКАЦИЯ И СТРОГАЯ ФИЛЬТРАЦИЯ ПО Г. АЛМАТЫ (КАТО 75*)
// Изоляция города Алматы от Алматинской области
// ====================================================================
const allItems = $input.all();
const seenIds = new Set();
const allLots = [];
let errorCount = 0;
let totalRaw = 0;
let skippedOtherRegions = 0;

// Регулярные выражения для жесткой изоляции г. Алматы от области
const RE_ALMATY_CITY = /(?:^|[^\wа-яё])(?:г\.?[ \t]*алматы|город[ \t]+алматы)(?:[^\wа-яё]|$)/i;
const RE_EXCLUDE_REGION = /(?:област[а-я]*|талдыкорган[а-я]*|қонаев[а-я]*|конаев[а-я]*|каскелен[а-я]*|қаскелең[а-я]*|есик[а-я]*|есік[а-я]*|иссык[а-я]*|тургень[а-я]*|жаркент[а-я]*|текели[а-я]*|карасайск[а-я]*|илийск[а-я]*|талгар[а-я]*|енбекшиказах[а-я]*|жамбылск[а-я]*)/i;

for (const item of allItems) {
  const resp = item.json || {};
  if (resp.error || resp.errors) {
    errorCount++;
    console.warn('[MERGE WARN] Ошибка в ответе API:', JSON.stringify(resp.error || resp.errors).substring(0, 200));
    continue;
  }
  const lots = resp.data?.Lots || [];
  totalRaw += lots.length;
  for (const lot of lots) {
    const lotId = String(lot.id);
    if (seenIds.has(lotId)) continue;
    seenIds.add(lotId);

    // СТРОГИЙ ГЕО-ФИЛЬТР (Изоляция г. Алматы от Области):
    // 1. КАТО должен начинаться строго с '75' (г. Алматы)
    const katoList = Array.isArray(lot.plnPointKatoList) ? lot.plnPointKatoList : [];
    const hasKato75 = katoList.some(k => String(k || '').trim().startsWith('75'));

    // 2. Fallback по названию заказчика: только 'г. алматы'/'город алматы' с исключением области
    const custName = String(lot.customerNameRu || '').toLowerCase();
    const isCustomerAlmatyCity = RE_ALMATY_CITY.test(custName) && !RE_EXCLUDE_REGION.test(custName);

    const isAlmaty = hasKato75 || isCustomerAlmatyCity;

    if (!isAlmaty) {
      skippedOtherRegions++;
      continue;
    }

    allLots.push(lot);
  }
}

const apiFailure = errorCount > 0 && totalRaw === 0 && allItems.length > 0;
if (apiFailure) {
  console.error(`[MERGE CRITICAL] Все ${allItems.length} запросов к ЦЭФ вернули ошибки! Возможен сбой GOSZAKUP_TOKEN.`);
}

console.log(`[MERGE ALMATY SOLO] Всего лотов: ${totalRaw} | Отсеяно других регионов/области: ${skippedOtherRegions} | Алматы: ${allLots.length} | Ошибок API: ${errorCount}`);

return [{
  json: {
    data: { Lots: allLots },
    mergedCount: allLots.length,
    totalRaw,
    skippedOtherRegions,
    errorCount,
    apiFailure
  }
}];