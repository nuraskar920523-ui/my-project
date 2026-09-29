// GraphQL ЦЭФ (ows.goszakup.gov.kz v3) с повторами на 429/5xx/сеть и жёстким дедлайном узла.
// Ошибки схемы (errors в ответе) и 4xx не повторяются.
const TS_GQL_ENDPOINT = 'https://ows.goszakup.gov.kz/v3/graphql';
async function tsGql(token, query, variables, hardDeadlineAt) {
  const body = JSON.stringify({ query, variables: variables || {} });
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = hardDeadlineAt ? hardDeadlineAt - Date.now() : 45000;
    if (left < 3000) throw new Error('DEADLINE');
    let res;
    try {
      res = await tsHttpRequest(TS_GQL_ENDPOINT, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
        body,
        timeout: Math.min(45000, left)
      });
    } catch (e) {
      lastErr = e;
      await tsSleep(1500 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) { lastErr = new Error('HTTP ' + res.status); await tsSleep(1500 * (attempt + 1)); continue; }
    let json = null;
    try { json = res.json(); } catch (e) {}
    if (res.status !== 200 || !json) throw new Error('HTTP ' + res.status);
    if (json.errors && json.errors.length) throw new Error('GQL: ' + json.errors.map(x => x.message).join('; ').substring(0, 200));
    return json;
  }
  throw lastErr || new Error('GQL: неизвестная ошибка');
}
