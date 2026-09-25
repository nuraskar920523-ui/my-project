// Минимальный HTTP-клиент на https/http: лимит редиректов, снятие Authorization при смене хоста,
// ограничение размера ответа (обрыв загрузки, а не проверка после скачивания).
function tsHttpRequest(url, options, redirectsLeft) {
  options = options || {};
  if (redirectsLeft === undefined) redirectsLeft = 3;
  const httpsMod = require('https');
  const httpMod = require('http');
  const timeoutMs = options.timeout || 25000;
  const maxBytes = options.maxBytes || 0;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
    let req;
    const timer = setTimeout(() => { try { req && req.destroy(); } catch (e) {} done(reject, new Error('HTTP timeout (' + timeoutMs + 'ms)')); }, timeoutMs);
    const client = url.startsWith('https') ? httpsMod : httpMod;
    req = client.request(url, { method: options.method || 'GET', headers: options.headers || {} }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return done(reject, new Error('Too many redirects'));
        const nextUrl = new URL(res.headers.location, url).toString();
        const nextHeaders = Object.assign({}, options.headers || {});
        if (new URL(nextUrl).host !== new URL(url).host) {
          delete nextHeaders.Authorization; delete nextHeaders.authorization;
          delete nextHeaders['x-goog-api-key'];
        }
        clearTimeout(timer); settled = true;
        return tsHttpRequest(nextUrl, Object.assign({}, options, { headers: nextHeaders }), redirectsLeft - 1).then(resolve, reject);
      }
      const declared = Number(res.headers['content-length'] || 0);
      if (maxBytes && declared > maxBytes) {
        res.destroy();
        const err = new Error('FILE_TOO_LARGE'); err.code = 'FILE_TOO_LARGE'; err.size = declared;
        return done(reject, err);
      }
      const chunks = []; let total = 0;
      res.on('data', chunk => {
        total += chunk.length;
        if (maxBytes && total > maxBytes) {
          res.destroy();
          const err = new Error('FILE_TOO_LARGE'); err.code = 'FILE_TOO_LARGE'; err.size = total;
          return done(reject, err);
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        done(resolve, {
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          buffer,
          text: () => buffer.toString('utf8'),
          json: () => JSON.parse(buffer.toString('utf8'))
        });
      });
      res.on('error', err => done(reject, err));
    });
    req.on('error', err => done(reject, err));
    if (options.body) req.write(options.body);
    req.end();
  });
}
const tsSleep = (ms) => new Promise(r => setTimeout(r, ms));
