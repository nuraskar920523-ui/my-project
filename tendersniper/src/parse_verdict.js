// ====================================================================
// РАЗБОР ОТВЕТОВ GEMINI С СОПОСТАВЛЕНИЕМ СТРОГО ПО LOT_ID
// ====================================================================
const geminiItems = $input.all();
let candidateItems = [];
try {
  candidateItems = $('Pre-Filter & Candidate Builder').all().map(i => i.json).filter(Boolean);
} catch (e) {
  console.warn('[PARSE] Не удалось получить список кандидатов:', e.message);
}

// Построение хэш-карты кандидатов по всем возможным строковым идентификаторам
const candidateMap = new Map();
for (const cand of candidateItems) {
  if (cand.lotId) candidateMap.set(String(cand.lotId).trim(), cand);
  if (cand.lotNumber) candidateMap.set(String(cand.lotNumber).trim(), cand);
  if (cand.rawLotId) candidateMap.set(String(cand.rawLotId).trim(), cand);
}

// Ветка 0 узла "Есть кандидаты для ИИ?" для строгого сопоставления по pairedItem
let ifBranch0 = [];
try {
  ifBranch0 = $('Есть кандидаты для ИИ?').all().map(x => x.json).filter(Boolean);
} catch (e) {}

const fallbackChatId = candidateItems[0]?.chatId || 681740470;
const results = [];

for (let i = 0; i < geminiItems.length; i++) {
  try {
    const geminiItem = geminiItems[i]?.json || {};

    // Сопоставление с кандидатом строго через pairedItem либо через lotId из ответа
    let pairedLotData = null;
    const pairedIdx = geminiItems[i]?.pairedItem?.item !== undefined ? geminiItems[i].pairedItem.item : null;
    if (pairedIdx !== null && ifBranch0[pairedIdx]) {
      pairedLotData = ifBranch0[pairedIdx];
    } else if (pairedIdx !== null && candidateItems[pairedIdx]) {
      pairedLotData = candidateItems[pairedIdx];
    }

    // 1. ИЗВЛЕЧЕНИЕ СТРУКТУРИРОВАННОГО ОТВЕТА GEMINI
    let verdict = {
      lotId: null,
      isCompatible: false,
      selectedCode: null,
      selectedPrimaryCode: null,
      selectedAccessoryCodes: [],
      bundleSummary: null,
      matchBadge: '🔴 НЕ ПОДХОДИТ',
      rnuRisk: 'РИСК РНУ',
      verdict: 'Товар не соответствует ТЗ'
    };

    // Явная обработка технических сбоев API Gemini (таймаут, 429, 500)
    if (geminiItem.error) {
      const errMsg = geminiItem.error.message || JSON.stringify(geminiItem.error).substring(0, 150);
      console.error(`[GEMINI API ERROR] Сбой в запросе #${i}: ${errMsg}`);
      verdict.isCompatible = false;
      verdict.matchBadge = '⚠️ СБОЙ API GEMINI (ТРЕБУЕТСЯ ПОВТОР)';
      verdict.rnuRisk = 'ТЕХНИЧЕСКИЙ СБОЙ ИИ';
      verdict.verdict = `Технический сбой API Gemini (${errMsg}). Требуется повторный запуск проверки.`;
    } else {
      try {
        const rawText = geminiItem.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = typeof rawText === 'object' ? rawText : JSON.parse(rawText);
          verdict = {
            lotId: parsed.lotId ? String(parsed.lotId).trim() : null,
            isCompatible: !!parsed.isCompatible,
            selectedCode: parsed.selectedCode ? String(parsed.selectedCode).trim() : null,
            selectedPrimaryCode: parsed.selectedPrimaryCode ? String(parsed.selectedPrimaryCode).trim() : null,
            selectedAccessoryCodes: Array.isArray(parsed.selectedAccessoryCodes) ? parsed.selectedAccessoryCodes.map(String) : [],
            bundleSummary: parsed.bundleSummary || null,
            matchBadge: parsed.matchBadge || (parsed.isCompatible ? '🟢 ТОЧНОЕ СОВПАДЕНИЕ' : '🔴 НЕ ПОДХОДИТ'),
            rnuRisk: parsed.rnuRisk || (parsed.isCompatible ? 'НЕТ РИСКА' : 'РИСК РНУ'),
            verdict: parsed.verdict || ''
          };
        }
      } catch (err) {
        console.error(`[STRUCTURED PARSE ERROR] Ошибка парсинга JSON #${i}: ${err.message}`);
        verdict.isCompatible = false;
        verdict.matchBadge = '⚠️ СБОЙ API GEMINI (ТРЕБУЕТСЯ ПОВТОР)';
        verdict.rnuRisk = 'ОШИБКА ФОРМАТА ИИ';
        verdict.verdict = `Ошибка формата ответа Gemini: ${err.message}`;
      }
    }

    // 2. СОПОСТАВЛЕНИЕ СТРОГО ПО LOT_ID / LOTNUMBER
    let lotData = null;
    if (verdict.lotId && candidateMap.has(verdict.lotId)) {
      lotData = candidateMap.get(verdict.lotId);
    } else if (pairedLotData) {
      lotData = pairedLotData;
    } else if (candidateItems[i]) {
      lotData = candidateItems[i];
    } else {
      lotData = { lotId: verdict.lotId || `lot-${i}`, lotName: 'Неизвестный лот' };
    }

    // 3. ПРОВЕРКА HARD-LOCK (СТОП-МАРКЕРЫ И РИСК РНУ)
    if (lotData.isVendorLocked) {
      results.push({
        json: {
          isCompatible: false,
          isVendorLocked: true,
          tradeMethodId: Number(lotData.tradeMethodId || 3),
          chatId: lotData.chatId || fallbackChatId,
          lotId: lotData.lotId || '—',
          lotName: lotData.lotName || '—',
          lotQty: lotData.lotQty || 1,
          lotBudget: lotData.lotBudget || 0,
          directUrl: lotData.directUrl || '',
          lockReason: lotData.lockReason || 'Проектный вендор / Заточка',
          matchBadge: '🔴 РИСК РНУ: ЗАЛОЧЕННЫЙ ЛОТ',
          rnuRisk: 'ВЫСОКИЙ РИСК РНУ',
          aiVerdict: 'Обнаружен стоп-маркер: ' + (lotData.lockReason || 'Проектный VAD-дистрибьютор'),
          productName: '—',
          productCode: '—',
          distributor: 'Al-Style',
          totalCost: 0,
          logisticsCost: 0,
          profit: 0,
          marginPercent: 0
        }
      });
      continue;
    }

    // 4. РАСЧЕТ ИТОГОВ (ОДИНОЧНЫЙ ТОВАР ИЛИ КОМПЛЕКТ)
    let chosenName = null;
    let chosenCode = null;
    let chosenDistributor = 'Al-Style';
    let totalPurchaseCost = 0;
    const qty = lotData.lotQty || 1;

    if (verdict.isCompatible) {
      if (lotData.isBundle) {
        let primaryItem = (lotData.primaryCandidates || []).find(c => String(c.code).trim() === String(verdict.selectedPrimaryCode || '').trim());
        if (!primaryItem && (lotData.primaryCandidates || []).length > 0) {
          primaryItem = lotData.primaryCandidates[0];
        }
        if (primaryItem) {
          chosenDistributor = primaryItem.distributor || 'Al-Style';
          let bundleCost = primaryItem.price || 0;
          const accessoryNames = [];
          for (const accCode of verdict.selectedAccessoryCodes) {
            const accItem = (lotData.accessoryCandidates || []).find(c => String(c.code).trim() === String(accCode).trim());
            if (accItem) {
              bundleCost += (accItem.price || 0);
              accessoryNames.push(accItem.name.substring(0, 25));
            }
          }
          totalPurchaseCost = bundleCost * qty;
          chosenCode = primaryItem.code + (verdict.selectedAccessoryCodes.length ? '+' + verdict.selectedAccessoryCodes.join(',') : '');
          chosenName = (verdict.bundleSummary || (primaryItem.name + (accessoryNames.length ? ' + ' + accessoryNames.join(', ') : '')));
        } else {
          verdict.isCompatible = false;
        }
      } else {
        const candidates = lotData.candidates || [];
        let chosen = null;
        if (verdict.selectedCode) {
          chosen = candidates.find(c => String(c.code).trim() === String(verdict.selectedCode).trim());
        }
        if (!chosen && verdict.verdict) {
          for (const c of candidates) {
            const cCode = String(c.code).trim();
            if (cCode && (verdict.verdict.includes(cCode) || (c.name && verdict.verdict.includes(c.name.slice(0, 20))))) {
              chosen = c;
              break;
            }
          }
        }
        if (!chosen && candidates.length > 0) {
          chosen = candidates[0];
        }
        if (chosen) {
          totalPurchaseCost = (chosen.price || 0) * qty;
          chosenCode = chosen.code;
          chosenName = chosen.name;
          chosenDistributor = chosen.distributor || 'Al-Style';
        } else {
          verdict.isCompatible = false;
        }
      }
    }

    // Финансово-налоговый расчет: СНР 3% (ФНО 910.00, без НДС и без КПН)
    const SNR_TAX_RATE = 0.03;
    const TARGET_DISCOUNT = 0.10;

    const targetBid = lotData.targetBid || Math.round((lotData.lotBudget || 0) * (1 - TARGET_DISCOUNT));
    
    // Оптимизация логистики: для мелких партий (картриджи, кабели, флешки, мыши) доставка пакетом
    const lotTitle = (lotData.lotName || '').toLowerCase();
    const isSmall = /флеш|накопитель|картридж|тонер|мышь|клавиатур|патч-корд|кабель|гарнитур/i.test(lotTitle);
    const logCost = isSmall ? Math.min(6000, 1500 * qty) : (3000 * qty);

    const snrTax = Math.round(targetBid * SNR_TAX_RATE);
    const vatPayable = 0; // ТОО на СНР не платит НДС
    const citPayable = 0; // ТОО на СНР не платит КПН 20%
    const totalTax = snrTax; // Ровно 3% от выручки

    const safeCost = (typeof totalPurchaseCost === 'number' && !isNaN(totalPurchaseCost)) ? Math.round(totalPurchaseCost) : 0;
    const totalExpenses = safeCost + logCost + totalTax;
    let finalProfit = verdict.isCompatible ? (targetBid - totalExpenses) : 0;
    if (isNaN(finalProfit)) finalProfit = 0;
    let marginPct = targetBid > 0 ? (finalProfit / targetBid) * 100 : 0;
    if (isNaN(marginPct)) marginPct = 0;

    results.push({
      json: {
        isCompatible: verdict.isCompatible,
        isBundle: !!lotData.isBundle,
        isVendorLocked: false,
        isManualReviewRequired: !!lotData.isManualReviewRequired,
        tradeMethodId: Number(lotData.tradeMethodId || 3),
        rawLotId: lotData.rawLotId,
        annoNum: lotData.annoNum,
        staleCatalog: !!lotData.staleCatalog,
        matchBadge: verdict.matchBadge,
        rnuRisk: verdict.rnuRisk,
        aiVerdict: verdict.verdict,
        chatId: lotData.chatId || fallbackChatId,
        lotId: lotData.lotId || '—',
        lotName: lotData.lotName || '—',
        lotQty: qty,
        lotBudget: lotData.lotBudget || 0,
        targetBid,
        directUrl: lotData.directUrl || '',
        distributor: chosenDistributor || 'Al-Style',
        productCode: chosenCode,
        productName: chosenName,
        totalCost: totalPurchaseCost,
        logisticsCost: logCost,
        vatPayable: 0,
        citPayable: 0,
        totalTax,
        profit: Math.round(finalProfit),
        marginPercent: +marginPct.toFixed(1)
      }
    });
  } catch (lotParseErr) {
    console.error('[PARSE LOT ERROR on item ' + i + ']:', lotParseErr.message);
    const safeLot = candidateItems[i] || geminiItems[i]?.json || {};
    results.push({
      json: {
        isCompatible: false,
        error: lotParseErr.message,
        lotId: safeLot.lotId || '—',
        lotName: safeLot.lotName || '—',
        distributor: 'Al-Style',
        chatId: safeLot.chatId || fallbackChatId,
        profit: 0,
        marginPercent: 0
      }
    });
  }
}

if (results.length === 0) {
  return [{ json: { isCompatible: false, chatId: fallbackChatId } }];
}

console.log('[PARSE GEMINI] Всего лотов: ' + results.length + ', подтвержденных ИИ: ' + results.filter(r => r.json.isCompatible).length);
return results;