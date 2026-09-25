// Вызов Gemini generateContent с повтором на 429/5xx/сетевые сбои (ключ — в заголовке, не в URL).
// hardDeadlineAt — абсолютное время (ms), после которого новые попытки не начинаются
// (Code-узел в task runner по умолчанию прерывается через 300 c).
async function tsGeminiGenerate(apiKey, model, body, timeoutMs, hardDeadlineAt) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
  const payload = JSON.stringify(body);
  const delays = [2000, 6000, 15000];
  let lastErr = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const left = hardDeadlineAt ? hardDeadlineAt - Date.now() : Infinity;
    if (left < 5000) throw lastErr || new Error('SKIPPED_TIMEOUT: лимит времени узла');
    try {
      const res = await tsHttpRequest(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Content-Length': Buffer.byteLength(payload) },
        body: payload,
        timeout: Math.min(timeoutMs || 45000, left)
      });
      if (res.ok) return res.json();
      lastErr = new Error('Gemini HTTP ' + res.status + ': ' + res.text().substring(0, 200));
      if (!(res.status === 429 || res.status >= 500)) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (/Gemini HTTP (4\d\d)/.test(e.message) && !/Gemini HTTP 429/.test(e.message)) throw e;
    }
    if (attempt < delays.length) {
      if (hardDeadlineAt && Date.now() + delays[attempt] > hardDeadlineAt - 5000) break;
      await tsSleep(delays[attempt]);
    }
  }
  throw lastErr || new Error('Gemini: неизвестная ошибка');
}
// Текст ответа без «мыслительных» частей (thinking-модели)
function tsGeminiText(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  const texts = parts.filter(p => p && typeof p.text === 'string' && !p.thought).map(p => p.text);
  return texts.length ? texts[texts.length - 1] : '';
}
