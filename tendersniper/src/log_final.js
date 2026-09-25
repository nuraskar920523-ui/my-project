// Финальный лог записи в Google Sheets.
// Блокировка сканирования здесь больше НЕ снимается: это делает «Build Digest & Export Rows»
// (только свою блокировку, по lockOwner), иначе поздний запуск мог снять чужой lock.
const prev = $input.all();
const histError = prev.find(item => item.json?.error);
if (histError) {
  const errMsg = histError.json.error?.message || JSON.stringify(histError.json.error).substring(0, 150);
  console.warn('[GOOGLE SHEETS WARN] Не удалось сохранить историю в "История лотов": ' + errMsg + ' (дедуп продолжит работать по локальному реестру)');
} else {
  console.log('[GOOGLE SHEETS SUCCESS] ✅ Зафиксировано ' + prev.length + ' записей во вкладку "История лотов".');
}
return prev;
