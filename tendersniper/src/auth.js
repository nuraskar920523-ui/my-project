// ====================================================================
// УЗЕЛ: АВТОРИЗАЦИЯ И МАРШРУТИЗАЦИЯ (РЕЖИМ «СЕНТЯБРЬ СОЛО» — АЛМАТЫ)
// ====================================================================
const inputData = $input.first()?.json || {};

// 1. Конфигурация доступа
const DEFAULT_ADMIN_CHAT_ID = 681740470; // Аскар Нуралиев
const AUTHORIZED_USER_IDS = new Set([681740470]);
const AUTHORIZED_USERNAMES = new Set(['askarnuraliyev']);

// 2. Определение источника (CRON или TELEGRAM)
const msg = inputData.message || inputData.edited_message || inputData.callback_query?.message;
const isCron = !msg;

// 3. Проверка блокировки через штатный $getWorkflowStaticData (без привязки к fs)
const staticData = $getWorkflowStaticData('global');
const LOCK_TIMEOUT_MS = 4 * 60 * 1000;
const lastScanTime = Number(staticData.lastScanTime || 0);

if (isCron) {
  if (Date.now() - lastScanTime < LOCK_TIMEOUT_MS) {
    console.log('[AUTH LOCK] Предыдущее сканирование еще выполняется. Пропуск запуска CRON.');
    return [];
  }
  staticData.lastScanTime = Date.now();

  console.log('[AUTH] Запуск по расписанию (CRON). Целевой чат: ' + DEFAULT_ADMIN_CHAT_ID);
  return [{
    json: {
      isAuthorized: true,
      shouldRunPipeline: true,
      chatId: DEFAULT_ADMIN_CHAT_ID,
      source: 'CRON',
      userName: 'Система (CRON)',
      directReplyMessage: null
    }
  }];
}

// 4. Данные пользователя Telegram
const fromUser = inputData.message?.from || inputData.edited_message?.from || inputData.callback_query?.from || {};
const userId = fromUser.id ? Number(fromUser.id) : null;
const username = fromUser.username ? String(fromUser.username).toLowerCase() : null;
const chatId = msg?.chat?.id || userId || DEFAULT_ADMIN_CHAT_ID;
const fullName = [fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'Пользователь';
const rawText = String(inputData.message?.text || inputData.edited_message?.text || inputData.callback_query?.data || '').trim();

// 5. Проверка авторизации
const isAuthorized = (userId && AUTHORIZED_USER_IDS.has(userId)) ||
                     (username && AUTHORIZED_USERNAMES.has(username));

if (!isAuthorized) {
  const warnMsg = '[SECURITY WARN] Попытка несанкционированного доступа! ID: ' + userId + ', Username: @' + (username || 'none') + ', Имя: ' + fullName + ', Текст: "' + rawText + '"';
  console.warn(warnMsg);

  const rejectionReply = 
    '⛔ <b>Доступ запрещён</b>\n\n' +
    'Ваш аккаунт (ID: <code>' + (userId || 'Unknown') + '</code>) не авторизован для управления радаром TenderSniper.\n\n' +
    'Обратитесь к администратору для добавления в белый список.';

  return [{
    json: {
      isAuthorized: false,
      shouldRunPipeline: false,
      chatId,
      source: 'UNAUTHORIZED',
      userName: fullName,
      directReplyMessage: rejectionReply
    }
  }];
}

// 6. Обработка команд /start и /help
if (rawText === '/start' || rawText === '/help') {
  const helpReply =
    '👋 <b>TenderSniper AI — Режим «Сентябрь Соло» (г. Алматы)</b>\n━━━━━━━━━━━━━━━━━━━━\n' +
    '👤 <b>Пользователь:</b> ' + fullName + ' (Авторизован ✅)\n' +
    '⏱ <b>Фоновый мониторинг:</b> 09:30 и 13:00 (Asia/Almaty)\n' +
    '📍 <b>Регион:</b> Только город Алматы (КАТО 75*)\n' +
    '⚖️ <b>Методы закупок:</b> Все доступные (ЗЦП, ОИ, Открытый конкурс и др.)\n' +
    '🎯 <b>Критерии отбора:</b> Чистая маржа ≥ 15% и 🟢 ТОЧНОЕ СОВПАДЕНИЕ (расширенная выборка)\n' +
    '📦 <b>Каталог:</b> Полная номенклатура Al-Style (без ограничений по остаткам)\n\n' +
    '📌 <b>Доступные команды:</b>\n' +
    '• <code>/scan</code> — запустить аудит алматинских лотов прямо сейчас\n' +
    '• <code>/help</code> — показать эту справку\n\n' +
    '<i>Бот отбирает лоты по каталогу Al-Style, проверяет спецификации через Gemini AI и рассчитывает чистую прибыль с налогом СНР 3% (ФНО 910.00, без НДС и КПН).</i>';

  return [{
    json: {
      isAuthorized: true,
      shouldRunPipeline: false,
      chatId,
      source: 'USER_COMMAND',
      userName: fullName,
      directReplyMessage: helpReply
    }
  }];
}

// 7. Строгий матчинг: ТОЛЬКО команда '/scan' инициирует запуск пайплайна
if (rawText === '/scan') {
  if (Date.now() - lastScanTime < LOCK_TIMEOUT_MS) {
    console.log('[AUTH LOCK] Предыдущее сканирование еще выполняется. Ответ пользователю.');
    return [{
      json: {
        isAuthorized: true,
        shouldRunPipeline: false,
        chatId,
        source: 'USER_SCAN_LOCKED',
        userName: fullName,
        directReplyMessage: '⏳ <b>Сканирование Алматы уже выполняется</b>\n\nВ данный момент система производит проверку портала Госзакупок по региону Алматы. Пожалуйста, подождите 1-2 минуты до завершения текущего цикла.'
      }
    }];
  }

  staticData.lastScanTime = Date.now();

  return [{
    json: {
      isAuthorized: true,
      shouldRunPipeline: true,
      chatId,
      source: 'USER_SCAN',
      userName: fullName,
      directReplyMessage: null
    }
  }];
}

// 8. Защита бюджета API: Любой другой ввод (текст, стикер, опечатка, callback_query без команды)
return [{
  json: {
    isAuthorized: true,
    shouldRunPipeline: false,
    chatId,
    source: 'UNKNOWN_COMMAND',
    userName: fullName,
    directReplyMessage: '⚠️ Неизвестная команда. Для запуска используйте /scan'
  }
}];