// Единая финансовая модель (одинакова в Pre-Filter и Parse Gemini Verdict).
// Налоговый режим: СНР на основе упрощённой декларации — 3% от оборота (ФНО 910.00), без НДС и КПН.
const RE_LOG_SMALL = makeWordRegex('флеш[а-я]*|flash|usb|кабель[а-я]*|патч-корд[а-я]*|мышь|мыши|mouse|коврик[а-я]*|наушник[а-я]*|гарнитур[а-я]*|headset|адаптер[а-я]*|переходник[а-я]*|картридж[а-я]*|тонер[а-я]*|cartridge|toner|клавиатур[а-я]*');
const RE_LOG_HEAVY = makeWordRegex('сервер[а-я]*|стойк[а-я]*|server');
const RE_LOG_OFFICE = makeWordRegex('принтер[а-я]*|мфу|компьютер[а-я]*|системный[ \t]*блок|моноблок[а-я]*|монитор[а-я]*|ибп|проектор[а-я]*');

function calculateLogistics(productName, lotQty) {
  const isSmall = RE_LOG_SMALL.test(productName);
  let unitFee = 3000;
  if (RE_LOG_HEAVY.test(productName)) unitFee = 15000;
  else if (RE_LOG_OFFICE.test(productName)) unitFee = 4500;
  else if (isSmall) unitFee = 500;
  let baseCost = unitFee * lotQty;
  if (isSmall) baseCost = Math.min(baseCost, 6000);
  return Math.min(Math.max(baseCost, 3000), 150000);
}

function evaluateFinancials(lotBudget, unitPurchaseCost, lotQty, productName) {
  const targetBid = Math.round(lotBudget * (1 - TS_CONFIG.BID_DISCOUNT));
  const totalPurchase = Math.round(unitPurchaseCost * lotQty);
  const logisticsCost = calculateLogistics(productName || '', lotQty);
  const totalTax = Math.round(targetBid * TS_CONFIG.SNR_TAX_RATE);
  const totalExpenses = totalPurchase + logisticsCost + totalTax;
  const netProfit = targetBid - totalExpenses;
  const marginPercent = targetBid > 0 ? +((netProfit / targetBid) * 100).toFixed(1) : 0;

  let isViable = false;
  if (targetBid <= 100000) isViable = (netProfit >= 7000 && marginPercent >= 10);
  else if (targetBid <= 1000000) isViable = (netProfit >= 15000 && marginPercent >= 8);
  else isViable = (netProfit >= 40000 && marginPercent >= 6);

  return { targetBid, totalPurchase, logisticsCost, vatPayable: 0, citPayable: 0, totalTax, totalExpenses, netProfit, marginPercent, isViable };
}

function isDigestEligible(marginPercent, profit) {
  const m = Number(marginPercent) || 0;
  const p = Number(profit) || 0;
  return m >= TS_CONFIG.DIGEST_MIN_MARGIN || (p >= TS_CONFIG.DIGEST_ALT_MIN_PROFIT && m >= TS_CONFIG.DIGEST_ALT_MIN_MARGIN);
}
