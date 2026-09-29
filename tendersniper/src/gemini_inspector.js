// ====================================================================
// УЗЕЛ: GEMINI AI ИНСПЕКТОР (Code) — ЛИНЕЙНЫЙ ПОТОК БЕЗ ВЕТВЛЕНИЯ
// • Все items проходят насквозь: вендор-локи и «empty» — без вызова ИИ, остальные — с вердиктом.
//   (Раньше ветка IF false шла прямо в дайджест, и он запускался ДВАЖДЫ.)
// • Ключ читается из окружения внутри узла и не попадает в данные execution.
// • Реальные повторы на 429/5xx с паузой; ограничение параллельности и общего времени узла.
// ====================================================================
//@@include:config
//@@include:env
//@@include:http
//@@include:gemini

const GEMINI_API_KEY = tsGetEnv('GEMINI_API_KEY');
const GEMINI_MODEL = tsGetEnv('GEMINI_MODEL', TS_CONFIG.GEMINI_MODEL_DEFAULT);
const THINKING_LEVEL = tsGetEnv('GEMINI_THINKING_LEVEL', 'medium');
const CONCURRENCY = 3;
const NODE_DEADLINE_MS = 170000;   // новые лоты не начинаются после этого
const HARD_DEADLINE_MS = 250000;   // никакой запрос/повтор не выходит за эту границу (лимит runner 300 c)
const startedAt = Date.now();

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    lotId: { type: 'STRING' },
    isCompatible: { type: 'BOOLEAN' },
    selectedCode: { type: 'STRING', nullable: true },
    selectedPrimaryCode: { type: 'STRING', nullable: true },
    selectedAccessoryCodes: { type: 'ARRAY', items: { type: 'STRING' } },
    bundleSummary: { type: 'STRING', nullable: true },
    matrix: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          parameter: { type: 'STRING' },
          status: { type: 'STRING', enum: ['fulfilled', 'failed', 'no_data'] },
          proof: { type: 'STRING' },
          is_mandatory: { type: 'BOOLEAN' }
        },
        required: ['parameter', 'status', 'proof', 'is_mandatory']
      }
    },
    matchBadge: { type: 'STRING', nullable: true, enum: ['🟢 ТОЧНОЕ СОВПАДЕНИЕ', '🔴 НЕ ПОДХОДИТ', '🔴 РИСК РНУ', '🔴 ТРЕБУЕТСЯ VAD'] },
    rnuRisk: { type: 'STRING', nullable: true, enum: ['НЕТ РИСКА', 'ВЫСОКИЙ РИСК РНУ', 'ВЫСОКИЙ РИСК РНУ: КОРРУПЦИОННАЯ ЗАТОЧКА', 'ВЫСОКИЙ (ПРОЕКТНАЯ ЗАЩИТА)'] },
    verdict: { type: 'STRING' }
  },
  required: ['lotId', 'matrix', 'verdict']
};

const items = $input.all().map(i => Object.assign({}, i.json || {}));
const needsAi = (d) => !d.empty && !d.isVendorLocked && d.geminiPrompt;

async function inspect(d) {
  if (!GEMINI_API_KEY) { d.geminiError = 'GEMINI_API_KEY не задан'; return; }
  if (Date.now() - startedAt > NODE_DEADLINE_MS) { d.geminiError = 'SKIPPED_TIMEOUT'; return; }
  try {
    const data = await tsGeminiGenerate(GEMINI_API_KEY, GEMINI_MODEL, {
      contents: [{ parts: [{ text: d.geminiPrompt }] }],
      // Режим размышления для проверки ТЗ (как настроено на сервере); уровень — через GEMINI_THINKING_LEVEL
      generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, thinkingConfig: { thinkingLevel: THINKING_LEVEL } }
    }, 45000, startedAt + HARD_DEADLINE_MS);
    const text = tsGeminiText(data);
    if (!text) {
      const reason = data?.candidates?.[0]?.finishReason || data?.promptFeedback?.blockReason || 'пустой ответ';
      d.geminiError = 'Пустой ответ Gemini (' + reason + ')';
    } else {
      d.geminiText = text;
    }
  } catch (e) {
    d.geminiError = e.message;
  }
}

const queue = items.filter(needsAi);
for (let i = 0; i < queue.length; i += CONCURRENCY) {
  await Promise.all(queue.slice(i, i + CONCURRENCY).map(inspect));
}

for (const d of items) delete d.geminiPrompt; // промпты не храним в execution data

const failed = queue.filter(d => d.geminiError).length;
console.log(`[GEMINI INSPECTOR] Модель: ${GEMINI_MODEL} | Лотов для ИИ: ${queue.length} | Ошибок: ${failed} | Время: ${Math.round((Date.now() - startedAt) / 1000)} c`);
return items.map(json => ({ json }));
