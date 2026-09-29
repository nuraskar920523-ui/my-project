// ====================================================================
// ГЕНЕРАЦИЯ ЦЕЛЕВЫХ ЗАПРОСОВ ПО ИТ-КАТЕГОРИЯМ КАТАЛОГА AL-STYLE
// Токен ЦЭФ здесь больше НЕ передаётся в items (иначе он сохраняется в истории executions).
// ====================================================================
//@@include:keywords_list

const lockOwner = $input.first()?.json?.lockOwner || null;
console.log('[KEYWORDS] Генерация ' + IT_KEYWORDS.length + ' целевых запросов по ИТ-категориям');
return IT_KEYWORDS.map(keyword => ({ json: { keyword, lockOwner } }));
