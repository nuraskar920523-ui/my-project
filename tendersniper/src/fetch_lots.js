// ====================================================================
// УЗЕЛ: ЗАГРУЗКА ЛОТОВ ИЗ ЦЭФ (GraphQL v3) — ПАГИНАЦИЯ + САМОВОССТАНОВЛЕНИЕ СХЕМЫ
// • Токен читается здесь из окружения и НЕ попадает в данные execution.
// • Пагинация через after/extensions.pageInfo (если API её поддерживает).
// • Расширенные поля (дедлайн TrdBuy.endDate, trdBuyId) запрашиваются, только если схема их
//   принимает; иначе автоматический откат на исходный запрос v5.3 (поведение не хуже прежнего).
// Выход: один item на ключевое слово в прежнем формате { data: { Lots } } | { error }.
// ====================================================================
//@@include:env
//@@include:http

const TOKEN = tsGetEnv('GOSZAKUP_TOKEN');
const ENDPOINT = 'https://ows.goszakup.gov.kz/v3/graphql';
const STATUS_IDS = [110, 210, 220, 230, 240];
const PAGE_LIMIT = 100;
const MAX_PAGES = 5;
const CONCURRENCY = 4;
const NODE_DEADLINE_MS = 170000;
const HARD_DEADLINE_MS = 250000;
const startedAt = Date.now();

// API ЦЭФ ищет по nameRu без учёта регистра (проверено на живом API 30.09: 0 лотов «только с заглавной»)
const keywords = $input.all().map(i => i.json?.keyword).filter(Boolean);

const BASE_FIELDS = 'id lotNumber nameRu descriptionRu amount count customerBin customerNameRu trdBuyNumberAnno indexDate refTradeMethodsId plnPointKatoList Files { id filePath originalName nameRu }';
const QUERY_LEVELS = [
  { name: 'extended+paging', fields: BASE_FIELDS + ' trdBuyId TrdBuy { id endDate }', paging: true },
  { name: 'base+paging', fields: BASE_FIELDS, paging: true },
  { name: 'base (v5.3)', fields: BASE_FIELDS, paging: false }
];

function buildQuery(level) {
  const vars = level.paging ? '$nameRu: String, $after: Int' : '$nameRu: String';
  const args = 'limit: ' + PAGE_LIMIT + (level.paging ? ', after: $after' : '') +
    ', filter: { refLotStatusId: [' + STATUS_IDS.join(', ') + '], nameRu: $nameRu }';
  return 'query GetITLots(' + vars + ') { Lots(' + args + ') { ' + level.fields + ' } }';
}

async function gql(level, keyword, after) {
  const variables = { nameRu: keyword };
  if (level.paging && after) variables.after = after;
  const body = JSON.stringify({ query: buildQuery(level), variables });
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const left = startedAt + HARD_DEADLINE_MS - Date.now();
    if (left < 5000) return { status: 0, json: null, networkError: 'Лимит времени узла' };
    try {
      const res = await tsHttpRequest(ENDPOINT, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + TOKEN,
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'TenderSniper-Radar/5.4 (Os.corp Energy Procurement Client; contact: admin@oscorp.kz)'
        },
        body,
        timeout: Math.min(45000, left)
      });
      let json = null;
      try { json = res.json(); } catch (e) {}
      if (res.status === 429 || res.status >= 500) { lastErr = new Error('HTTP ' + res.status); await tsSleep(1500 * (attempt + 1)); continue; }
      return { status: res.status, json };
    } catch (e) {
      lastErr = e;
      await tsSleep(1500 * (attempt + 1));
    }
  }
  return { status: 0, json: null, networkError: lastErr ? lastErr.message : 'network error' };
}

const isSchemaError = (r) => !!(r.json && Array.isArray(r.json.errors) && r.json.errors.length > 0 && (r.status === 200 || r.status === 400));

// 1. Определение поддерживаемого уровня запроса (одна проба на первом ключевом слове)
let level = null;
let probe = null;
if (!TOKEN) {
  console.error('[FETCH CRITICAL] GOSZAKUP_TOKEN не найден в окружении!');
} else if (keywords.length > 0) {
  for (const lv of QUERY_LEVELS) {
    probe = await gql(lv, keywords[0], null);
    if (probe.status === 200 && probe.json && probe.json.data && !isSchemaError(probe)) { level = lv; break; }
    if (!isSchemaError(probe)) break; // авторизация/сеть — откатываться по схеме бессмысленно
    console.warn('[FETCH SCHEMA] Уровень «' + lv.name + '» отклонён API: ' + JSON.stringify(probe.json.errors).substring(0, 200));
  }
}

if (!level) {
  const reason = !TOKEN ? 'GOSZAKUP_TOKEN не задан' :
    (probe?.networkError || ('HTTP ' + probe?.status + ' ' + JSON.stringify(probe?.json?.errors || probe?.json || '').substring(0, 200)));
  console.error('[FETCH CRITICAL] Запросы к ЦЭФ невозможны: ' + reason);
  return keywords.map(keyword => ({ json: { keyword, error: { message: reason } } }));
}
console.log('[FETCH] Используется уровень запроса: ' + level.name);

// 2. Загрузка по ключевому слову с пагинацией
async function fetchKeyword(keyword, firstPage) {
  const lots = [];
  let after = null;
  let pages = 0;
  let truncated = false;
  let resp = firstPage;
  while (true) {
    if (!resp) resp = await gql(level, keyword, after);
    if (resp.networkError) return { keyword, error: { message: resp.networkError }, partialLots: lots };
    if (resp.status !== 200 || !resp.json) return { keyword, error: { message: 'HTTP ' + resp.status }, partialLots: lots };
    if (resp.json.errors && resp.json.errors.length) return { keyword, errors: resp.json.errors, partialLots: lots };
    const page = resp.json.data?.Lots || [];
    lots.push(...page);
    pages++;
    const pageInfo = resp.json.extensions?.pageInfo;
    const hasNext = level.paging && pageInfo && pageInfo.hasNextPage && pageInfo.lastId;
    if (!hasNext) break;
    if (pages >= MAX_PAGES || Date.now() - startedAt > NODE_DEADLINE_MS) { truncated = true; break; }
    after = pageInfo.lastId;
    resp = null;
    await tsSleep(250);
  }
  return { keyword, data: { Lots: lots }, pages, truncated };
}

const results = new Array(keywords.length);
for (let i = 0; i < keywords.length; i += CONCURRENCY) {
  const idxs = [];
  for (let j = i; j < Math.min(i + CONCURRENCY, keywords.length); j++) idxs.push(j);
  const chunk = await Promise.all(idxs.map(j => {
    if (Date.now() - startedAt > NODE_DEADLINE_MS) return Promise.resolve({ keyword: keywords[j], error: { message: 'Пропущено: лимит времени узла' } });
    return fetchKeyword(keywords[j], j === 0 ? probe : null);
  }));
  idxs.forEach((j, k) => { results[j] = chunk[k]; });
  await tsSleep(500);
}

// Частично загруженные страницы не теряем: отдаём их как данные, ошибку сохраняем отдельно
const out = results.map(r => {
  if (r.partialLots && r.partialLots.length) {
    return { json: { keyword: r.keyword, data: { Lots: r.partialLots }, partialError: r.error || r.errors, queryLevel: level.name } };
  }
  delete r.partialLots;
  return { json: Object.assign(r, { queryLevel: level.name }) };
});
const truncatedCount = results.filter(r => r.truncated).length;
console.log('[FETCH] Ключевых слов: ' + keywords.length + ' | Лотов (сырых): ' + results.reduce((s, r) => s + (r.data?.Lots?.length || r.partialLots?.length || 0), 0) +
  ' | Усечено пагинацией: ' + truncatedCount + ' | Время: ' + Math.round((Date.now() - startedAt) / 1000) + ' c');
return out;
