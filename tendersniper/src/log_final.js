const prev = $input.all();
const first = prev[0]?.json || {};

if (first.hasMatches === false) {
  console.log('[PIPELINE COMPLETE] Новых подходящих лотов (маржа ≥15%) не обнаружено. Экспорт в Таблицы пропущен.');
} else {
  const histError = prev.find(item => item.json?.error);
  if (histError) {
    const errMsg = histError.json.error?.message || JSON.stringify(histError.json.error).substring(0, 150);
    console.warn('[GOOGLE SHEETS WARN] Не удалось сохранить историю в "История лотов": ' + errMsg);
  } else {
    console.log('[GOOGLE SHEETS SUCCESS] ✅ Успешно зафиксировано ' + prev.length + ' записей во вкладку "История лотов"!');
  }
}

// Освобождаем блокировку сканирования в терминальной точке конвейера
try {
  const staticData = $getWorkflowStaticData('global');
  staticData.lastScanTime = 0;
  console.log('[AUTH LOCK] Блокировка сканирования успешно снята.');
} catch (e) {}

return prev;
