// ====================================================================
// УЗЕЛ: АВТОРИЗАЦИЯ И МАРШРУТИЗАЦИЯ (РЕЖИМ «СЕНТЯБРЬ СОЛО» — АЛМАТЫ)
// ====================================================================
const fs = require('fs');
//@@include:config
//@@include:lock
//@@include:registry
//@@include:radar

const inputData = $input.first()?.json || {};

// 1. Конфигурация доступа — только числовые Telegram ID (username можно сменить/перехватить)
const DEFAULT_ADMIN_CHAT_ID = TS_CONFIG.ADMIN_CHAT_ID;
const AUTHORIZED_USER_IDS = new Set(TS_CONFIG.AUTHORIZED_USER_IDS.map(Number));

let execId = null;
try { execId = $execution?.id; } catch (e) {}
if (!execId) execId = 'manual-' + Date.now();

// 2. Определение источника (CRON или TELEGRAM)
const msg = inputData.message || inputData.edited_message || inputData.callback_query?.message;
const isCron = !msg;

function reply(fields) {
  return [{
    json: Object.assign({
      isAuthorized: true,
      shouldRunPipeline: false,
      chatId: DEFAULT_ADMIN_CHAT_ID,
      source: 'UNKNOWN',
      userName: '',
      directReplyMessage: null,
      lockOwner: null
    }, fields)
  }];
}

if (isCron) {
  const lk = tsAcquireLock(fs, execId, 'CRON');
  if (!lk.ok) {
    console.log('[AUTH LOCK] Предыдущее сканирование ещё выполняется (' + Math.round((lk.ageMs || 0) / 1000) + ' c). Пропуск запуска CRON.');
    return [];
  }
  console.log('[AUTH] Запуск по расписанию (CRON). Целевой чат: ' + DEFAULT_ADMIN_CHAT_ID);
  return reply({ shouldRunPipeline: true, source: 'CRON', userName: 'Система (CRON)', lockOwner: execId });
}

// 3. Данные пользователя Telegram
const fromUser = inputData.message?.from || inputData.edited_message?.from || inputData.callback_query?.from || {};
const userId = fromUser.id ? Number(fromUser.id) : null;
const username = fromUser.username ? String(fromUser.username).toLowerCase() : null;
const chatId = msg?.chat?.id || userId || DEFAULT_ADMIN_CHAT_ID;
const fullName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'Пользователь';
const rawText = String(inputData.message?.text || inputData.edited_message?.text || inputData.callback_query?.data || '').trim();
// "/scan@TenderBot extra" -> "/scan"
const command = (rawText.split(/\s+/)[0] || '').replace(/@[\w_]+$/, '').toLowerCase();

// 4. Проверка авторизации
const isAuthorized = !!(userId && AUTHORIZED_USER_IDS.has(userId));

if (!isAuthorized) {
  console.warn('[SECURITY WARN] Попытка несанкционированного доступа! ID: ' + userId + ', Username: @' + (username || 'none') + ', Имя: ' + fullName + ', Текст: "' + rawText.substring(0, 100) + '"');
  return reply({
    isAuthorized: false,
    chatId,
    source: 'UNAUTHORIZED',
    userName: fullName,
    directReplyMessage:
      '⛔ <b>Доступ запрещён</b>\n\n' +
      'Ваш аккаунт (ID: <code>' + (userId || 'Unknown') + '</code>) не авторизован для управления радаром TenderSniper.\n\n' +
      'Обратитесь к администратору для добавления в белый список.'
  });
}

const escapeHtml = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 5. /start и /help
if (command === '/start' || command === '/help') {
  const helpReply =
    '👋 <b>TenderSniper AI — Режим «Сентябрь Соло» (г. Алматы)</b>\n━━━━━━━━━━━━━━━━━━━━\n' +
    '👤 <b>Пользователь:</b> ' + escapeHtml(fullName) + ' (Авторизован ✅)\n' +
    '⏱ <b>Фоновый мониторинг:</b> ' + TS_CONFIG.SCAN_TIMES_TEXT + ' (Asia/Almaty), радар демпинга — 20:10–22:50\n' +
    '📍 <b>Регион:</b> Только город Алматы (КАТО 75*)\n' +
    '⚖️ <b>Методы закупок:</b> Все доступные (ЗЦП, ОИ, Открытый конкурс и др.)\n' +
    '⏳ <b>Дедлайн:</b> лоты, до окончания приёма которых меньше ' + TS_CONFIG.MIN_HOURS_TO_DEADLINE + ' ч, отбрасываются\n' +
    '🎯 <b>Критерии отбора:</b> 🟢 ТОЧНОЕ СОВПАДЕНИЕ и чистая маржа ≥ ' + TS_CONFIG.DIGEST_MIN_MARGIN + '% ' +
    '(или прибыль ≥ ' + TS_CONFIG.DIGEST_ALT_MIN_PROFIT.toLocaleString('ru-RU') + ' ₸ при марже ≥ ' + TS_CONFIG.DIGEST_ALT_MIN_MARGIN + '%)\n' +
    '📦 <b>Каталог:</b> Полная номенклатура Al-Style / ASBIS (без ограничений по остаткам)\n\n' +
    '📌 <b>Доступные команды:</b>\n' +
    '• <code>/scan</code> — запустить аудит алматинских лотов прямо сейчас\n' +
    '• <code>/status</code> — состояние радара (блокировка, реестр лотов)\n' +
    '• <code>/unlock</code> — снять зависшую блокировку сканирования\n' +
    '• <code>/help</code> — показать эту справку\n\n' +
    '<i>Бот отбирает лоты по каталогу, проверяет спецификации через Gemini AI и рассчитывает чистую прибыль с налогом СНР 3% (ФНО 910.00, без НДС и КПН).</i>';
  return reply({ chatId, source: 'USER_COMMAND', userName: fullName, directReplyMessage: helpReply });
}

function radarStatusLine() {
  try {
    const db = tsLoadRadarDb(fs);
    const lots = Object.values(db.lots);
    if (!lots.length) return '⚔️ Радар демпинга: база пуста (Radar Collector ещё не собирал данные)';
    return '⚔️ Радар демпинга: <b>' + lots.length + '</b> лотов (' + lots.filter(l => l.dp !== null).length + ' с победителем), ' +
      Object.keys(db.suppliers).length + ' участников, очередь ' + Object.keys(db.queue).length +
      (db.updatedAt ? ', обновлено ' + new Date(db.updatedAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' }) : '');
  } catch (e) { return '⚔️ Радар демпинга: ошибка чтения базы'; }
}

// 6. /status
if (command === '/status') {
  const lock = tsReadLock(fs);
  const reg = tsLoadRegistry(fs);
  const lockLine = lock
    ? '🔒 Идёт сканирование (источник: ' + escapeHtml(lock.source || '?') + ', ' + Math.round((Date.now() - Number(lock.ts || 0)) / 60000) + ' мин назад)'
    : '🔓 Сканирование не выполняется';
  return reply({
    chatId, source: 'USER_COMMAND', userName: fullName,
    directReplyMessage:
      '📊 <b>Статус TenderSniper</b>\n━━━━━━━━━━━━━━━━━━━━\n' + lockLine + '\n' +
      '📨 Отправлено лотов (реестр): <b>' + Object.keys(reg.sent).length + '</b>\n' +
      '🔍 Проверено ИИ за ' + TS_CONFIG.CHECKED_TTL_DAYS + ' дн.: <b>' + Object.keys(reg.checked).length + '</b>\n' +
      radarStatusLine()
  });
}

// 7. /unlock — принудительное снятие блокировки (если прошлый запуск упал)
if (command === '/unlock') {
  const released = tsReleaseLock(fs, null);
  return reply({
    chatId, source: 'USER_COMMAND', userName: fullName,
    directReplyMessage: released ? '🔓 <b>Блокировка снята.</b> Можно запускать /scan.' : 'ℹ️ Активной блокировки нет.'
  });
}

// 8. /scan — единственная команда, запускающая пайплайн
if (command === '/scan') {
  const lk = tsAcquireLock(fs, execId, 'USER_SCAN');
  if (!lk.ok) {
    console.log('[AUTH LOCK] Предыдущее сканирование ещё выполняется. Ответ пользователю.');
    return reply({
      chatId, source: 'USER_SCAN_LOCKED', userName: fullName,
      directReplyMessage:
        '⏳ <b>Сканирование Алматы уже выполняется</b>\n\n' +
        'Запущено ' + Math.round((lk.ageMs || 0) / 60000) + ' мин назад. Дождитесь дайджеста.\n' +
        'Если прошлый запуск завис — отправьте /unlock.'
    });
  }
  return reply({ shouldRunPipeline: true, chatId, source: 'USER_SCAN', userName: fullName, lockOwner: execId });
}

// 9. Защита бюджета API: любой другой ввод
return reply({
  chatId, source: 'UNKNOWN_COMMAND', userName: fullName,
  directReplyMessage: '⚠️ Неизвестная команда. Для запуска используйте /scan (справка: /help)'
});
