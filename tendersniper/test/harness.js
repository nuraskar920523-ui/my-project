// Мини-рантайм n8n Code node для прогона собранного workflow на моках (ЦЭФ GraphQL, Gemini, PDF).
// Запуск: node test/run_tests.js (использует /home/node/.n8n как в продакшене — только для тестовой среды!)
'use strict';
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function loadWorkflow() {
  const p = path.join(__dirname, '..', 'dist', 'TenderSniper_Lite_Almaty.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- Мок https: маршрутизатор (url, options, body) -> { status, body(Buffer|string|object), headers } ----------
function makeHttpsMock(router, log) {
  return {
    request(url, options, cb) {
      const req = new EventEmitter();
      let body = '';
      req.write = (chunk) => { body += chunk; };
      req.destroy = () => {};
      req.end = () => {
        setImmediate(async () => {
          let r;
          try { r = await router(String(url), options || {}, body); } catch (e) { req.emit('error', e); return; }
          if (!r) { req.emit('error', new Error('mock: no route for ' + url)); return; }
          log.push({ url: String(url), method: options.method || 'GET', headers: options.headers || {}, body });
          const res = new EventEmitter();
          res.statusCode = r.status || 200;
          const buf = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
          res.headers = Object.assign({ 'content-length': String(buf.length) }, r.headers || {});
          res.resume = () => {};
          res.destroy = () => { res._destroyed = true; };
          cb(res);
          if (!res._destroyed) res.emit('data', buf);
          if (!res._destroyed) res.emit('end');
        });
      };
      return req;
    }
  };
}

class Runner {
  constructor(opts) {
    this.wf = loadWorkflow();
    this.byName = Object.fromEntries(this.wf.nodes.map(n => [n.name, n]));
    this.outputs = {};
    this.env = opts.env || {};
    this.router = opts.router;
    this.httpLog = [];
    this.logs = [];
    this.execId = opts.execId || 'exec-1';
    this.quiet = opts.quiet !== false;
  }
  async run(nodeName, inputItems) {
    const node = this.byName[nodeName];
    if (!node) throw new Error('Нет узла ' + nodeName);
    if (node.type !== 'n8n-nodes-base.code') throw new Error(nodeName + ' не Code-узел');
    const self = this;
    const items = (inputItems || []).map(i => (i && i.json ? i : { json: i }));
    const $input = { all: () => items, first: () => items[0], last: () => items[items.length - 1] };
    const $ = (name) => {
      if (!(name in self.outputs)) throw new Error(`Referenced node "${name}" is unexecuted`);
      const out = self.outputs[name];
      return { all: () => out, first: () => out[0], last: () => out[out.length - 1] };
    };
    const httpsMock = makeHttpsMock(this.router, this.httpLog);
    const req = (m) => (m === 'https' || m === 'http') ? httpsMock : require(m);
    const logger = {
      log: (...a) => { self.logs.push(['log', nodeName, a.join(' ')]); if (!self.quiet) console.log(`  [${nodeName}]`, ...a); },
      warn: (...a) => { self.logs.push(['warn', nodeName, a.join(' ')]); if (!self.quiet) console.warn(`  [${nodeName}]`, ...a); },
      error: (...a) => { self.logs.push(['error', nodeName, a.join(' ')]); if (!self.quiet) console.error(`  [${nodeName}]`, ...a); }
    };
    const fn = new AsyncFunction('$input', '$', '$env', '$execution', 'require', 'console', node.parameters.jsCode);
    let result = await fn($input, $, this.env, { id: this.execId }, req, logger);
    result = (result || []).map(r => (r && r.json ? r : { json: r }));
    // n8n сериализует данные между узлами
    result = JSON.parse(JSON.stringify(result));
    this.outputs[nodeName] = result;
    return result;
  }
  setOutput(nodeName, items) { this.outputs[nodeName] = items.map(i => (i && i.json ? i : { json: i })); }
}

module.exports = { Runner };
