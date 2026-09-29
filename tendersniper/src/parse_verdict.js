// ====================================================================
// РАЗБОР ОТВЕТОВ GEMINI (1:1 с кандидатами — ответ лежит в том же item)
// • Код товара — только точное совпадение со списком кандидатов; при неоднозначности лот
//   помечается «🟡 требует ручной проверки», а не подставляется первый кандидат.
// • Финансы считаются той же функцией, что и в Pre-Filter (единая логистика и налог).
// • Окончательные вердикты записываются в реестр (повторно Gemini по ним не вызывается 7 дней).
// ====================================================================
const fs = require('fs');
//@@include:config
//@@include:registry
//@@include:regex_util
//@@include:finance

const items = $input.all().map(i => i.json || {});
const registry = tsLoadRegistry(fs);
const nowTs = Date.now();
let registered = 0;
const results = [];

const sameCode = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase() && String(a || '').trim() !== '';
function register(lotId, v) {
  if (!lotId || lotId === '—') return;
  registry.checked[String(lotId)] = { ts: nowTs, v };
  registered++;
}

for (const d of items) {
  try {
    if (d.empty) { results.push({ json: d }); continue; }

    const base = {
      chatId: d.chatId || TS_CONFIG.ADMIN_CHAT_ID,
      lotId: d.lotId || '—',
      lotName: d.lotName || '—',
      lotQty: d.lotQty || 1,
      lotBudget: d.lotBudget || 0,
      directUrl: d.directUrl || '',
      tradeMethodId: Number(d.tradeMethodId || 3),
      isBundle: !!d.isBundle,
      staleCatalog: !!d.staleCatalog,
      endDate: d.endDate || null,
      customerBin: d.customerBin || null,
      customerName: d.customerName || '',
      trdBuyId: d.trdBuyId || null,
      isManualReviewRequired: !!d.isManualReviewRequired,
      docExtractionError: d.docExtractionError || null,
      categoryTag: d.categoryTag || 'other'
    };

    // 1. Вендор-локи (детерминированный стоп-маркер, без ИИ)
    if (d.isVendorLocked) {
      register(d.lotId, 'locked');
      results.push({ json: Object.assign(base, {
        isCompatible: false, isVendorLocked: true,
        lockReason: d.lockReason || 'Проектный вендор / Заточка',
        matchBadge: '🔴 РИСК РНУ: ЗАЛОЧЕННЫЙ ЛОТ', rnuRisk: 'ВЫСОКИЙ РИСК РНУ',
        aiVerdict: 'Обнаружен стоп-маркер: ' + (d.lockReason || 'Проектный VAD-дистрибьютор'),
        productName: '—', productCode: null, distributor: '—', totalCost: 0, logisticsCost: 0, totalTax: 0, profit: 0, marginPercent: 0
      }) });
      continue;
    }

    // 2. Технический сбой ИИ — не регистрируем, лот будет перепроверен в следующем цикле
    let parsed = null;
    let apiError = d.geminiError || null;
    if (!apiError) {
      try {
        parsed = JSON.parse(String(d.geminiText || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
      } catch (e) {
        apiError = 'Ошибка формата ответа Gemini: ' + e.message;
      }
    }
    if (apiError) {
      console.error(`[GEMINI ERROR] Лот ${d.lotId}: ${String(apiError).substring(0, 200)}`);
      results.push({ json: Object.assign(base, {
        isCompatible: false, isVendorLocked: false, apiError: true,
        matchBadge: '⚠️ СБОЙ API GEMINI (ТРЕБУЕТСЯ ПОВТОР)', rnuRisk: 'ТЕХНИЧЕСКИЙ СБОЙ ИИ',
        aiVerdict: 'Технический сбой Gemini: ' + String(apiError).substring(0, 200) + '. Лот будет перепроверен в следующем цикле.',
        productName: null, productCode: null, distributor: '—', totalCost: 0, logisticsCost: 0, totalTax: 0, profit: 0, marginPercent: 0
      }) });
      continue;
    }

    if (parsed.lotId && String(parsed.lotId).trim() !== String(d.lotId).trim()) {
      console.warn(`[PARSE WARN] Gemini вернул lotId "${parsed.lotId}" для лота ${d.lotId} — используется исходный лот (сопоставление 1:1).`);
    }

    // Решение по МАТРИЦЕ принимает код, а не модель:
    //   стоп-сигнал (VAD / РНУ) → отказ; есть failed → отказ; обязательный no_data → ручная проверка;
    //   всё fulfilled → совпадение. Без матрицы (старый формат ответа) — прежняя логика по isCompatible.
    const matrix = Array.isArray(parsed.matrix) ? parsed.matrix.filter(m => m && m.parameter) : [];
    const failedItems = matrix.filter(m => m.status === 'failed');
    const noDataMandatory = matrix.filter(m => m.status === 'no_data' && m.is_mandatory !== false);
    const stopBadge = ['🔴 ТРЕБУЕТСЯ VAD', '🔴 РИСК РНУ'].includes(parsed.matchBadge) || /^ВЫСОКИЙ/.test(String(parsed.rnuRisk || ''));
    const shortList = (arr, mark) => arr.slice(0, 6).map(m => mark + ' ' + String(m.parameter).substring(0, 60) + (m.proof ? ': ' + String(m.proof).substring(0, 80) : '')).join('; ') + (arr.length > 6 ? '; …' : '');

    let isCompatible, matchBadge, rnuRisk;
    let aiVerdict = String(parsed.verdict || '').trim();
    let needsManualReview = false;
    let matrixManual = false;
    if (stopBadge) {
      isCompatible = false;
      matchBadge = parsed.matchBadge && parsed.matchBadge.startsWith('🔴') ? parsed.matchBadge : '🔴 РИСК РНУ';
      rnuRisk = parsed.rnuRisk || 'ВЫСОКИЙ РИСК РНУ';
    } else if (matrix.length && failedItems.length) {
      isCompatible = false;
      matchBadge = '🔴 НЕ ПОДХОДИТ';
      rnuRisk = failedItems.some(f => /чип|прошивк|оригинал|maf|дистрибьютор|эквивалент/i.test(f.parameter + ' ' + (f.proof || ''))) ? 'ВЫСОКИЙ РИСК РНУ' : 'НЕТ РИСКА';
      aiVerdict = `Не соответствует ТЗ по ${failedItems.length} из ${matrix.length} п.: ` + shortList(failedItems, '❌');
    } else if (matrix.length && noDataMandatory.length) {
      isCompatible = false;
      matrixManual = true;
      matchBadge = '🟡 ТРЕБУЕТ РУЧНОЙ ПРОВЕРКИ';
      rnuRisk = 'ТРЕБУЕТСЯ УТОЧНЕНИЕ ПАСПОРТА';
      aiVerdict = `Нет данных в каталоге по ${noDataMandatory.length} обязательным п. — сверьте паспорт товара: ` + shortList(noDataMandatory, '⚠️');
    } else if (matrix.length) {
      isCompatible = true;
      matchBadge = '🟢 ТОЧНОЕ СОВПАДЕНИЕ';
      rnuRisk = 'НЕТ РИСКА';
      aiVerdict = `Все требования ТЗ подтверждены (${matrix.length}/${matrix.length}). ` + aiVerdict;
    } else {
      isCompatible = !!parsed.isCompatible;
      matchBadge = parsed.matchBadge || (isCompatible ? '🟢 ТОЧНОЕ СОВПАДЕНИЕ' : '🔴 НЕ ПОДХОДИТ');
      rnuRisk = parsed.rnuRisk || (isCompatible ? 'НЕТ РИСКА' : 'ВЫСОКИЙ РИСК РНУ');
    }
    const matrixStats = matrix.length ? { total: matrix.length, failed: failedItems.length, noData: noDataMandatory.length } : null;

    // 3. Выбор товара — только точное совпадение кода
    let chosenName = null, chosenCode = null, chosenDistributor = 'Al-Style', unitCost = 0;
    if (isCompatible) {
      if (d.isBundle) {
        const prims = d.primaryCandidates || [];
        let primary = prims.find(c => sameCode(c.code, parsed.selectedPrimaryCode));
        if (!primary && prims.length === 1) primary = prims[0];
        if (primary) {
          unitCost = Number(primary.price) || 0;
          const accNames = [], accCodes = [];
          for (const code of (Array.isArray(parsed.selectedAccessoryCodes) ? parsed.selectedAccessoryCodes : [])) {
            const acc = (d.accessoryCandidates || []).find(c => sameCode(c.code, code));
            if (acc) { unitCost += Number(acc.price) || 0; accNames.push(String(acc.name).substring(0, 25)); accCodes.push(acc.code); }
          }
          chosenDistributor = primary.distributor || 'Al-Style';
          chosenCode = primary.code + (accCodes.length ? '+' + accCodes.join(',') : '');
          chosenName = parsed.bundleSummary || (primary.name + (accNames.length ? ' + ' + accNames.join(', ') : ''));
        } else {
          needsManualReview = true;
        }
      } else {
        const cands = d.candidates || [];
        let chosen = cands.find(c => sameCode(c.code, parsed.selectedCode));
        if (!chosen && cands.length === 1) chosen = cands[0];
        if (chosen) {
          unitCost = Number(chosen.price) || 0;
          chosenCode = chosen.code;
          chosenName = chosen.name;
          chosenDistributor = chosen.distributor || 'Al-Style';
        } else {
          needsManualReview = true;
        }
      }
    }

    if (matrixManual) needsManualReview = true;
    if (needsManualReview && !matrixManual) {
      isCompatible = false;
      matchBadge = '🟡 ТРЕБУЕТ РУЧНОЙ ПРОВЕРКИ';
      aiVerdict = 'ИИ признал лот совместимым, но выбранный код (' + (parsed.selectedCode || parsed.selectedPrimaryCode || 'пусто') + ') не найден среди кандидатов. ' + aiVerdict;
    }

    // 4. Финансы (единая модель)
    const fin = evaluateFinancials(base.lotBudget, unitCost, base.lotQty, chosenName || base.lotName);
    const profit = isCompatible ? fin.netProfit : 0;
    const marginPercent = isCompatible ? fin.marginPercent : 0;

    register(d.lotId, needsManualReview ? 'manual' : (isCompatible ? 'compatible' : 'rejected'));

    results.push({ json: Object.assign(base, {
      isCompatible, isVendorLocked: false, needsManualReview, matrixStats,
      matchBadge, rnuRisk, aiVerdict,
      targetBid: fin.targetBid,
      distributor: chosenDistributor,
      productCode: chosenCode,
      productName: chosenName,
      totalCost: fin.totalPurchase,
      logisticsCost: fin.logisticsCost,
      vatPayable: 0,
      citPayable: 0,
      totalTax: fin.totalTax,
      profit,
      marginPercent
    }) });
  } catch (err) {
    console.error('[PARSE LOT ERROR] Лот ' + (d.lotId || '?') + ': ' + err.message);
    results.push({ json: {
      isCompatible: false, apiError: true, error: err.message,
      lotId: d.lotId || '—', lotName: d.lotName || '—', directUrl: d.directUrl || '',
      matchBadge: '⚠️ ОШИБКА РАЗБОРА', distributor: '—',
      chatId: d.chatId || TS_CONFIG.ADMIN_CHAT_ID, profit: 0, marginPercent: 0
    } });
  }
}

if (registered > 0) tsSaveRegistry(fs, registry);

if (results.length === 0) {
  return [{ json: { empty: true, isCompatible: false, chatId: TS_CONFIG.ADMIN_CHAT_ID } }];
}

console.log('[PARSE GEMINI] Лотов: ' + results.length + ', подтверждённых ИИ: ' + results.filter(r => r.json.isCompatible).length +
  ', сбоев ИИ: ' + results.filter(r => r.json.apiError).length + ', в реестр: ' + registered);
return results;
