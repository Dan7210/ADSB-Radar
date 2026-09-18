const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('YJFC uses five global registration requests shared with visit tracking', async () => {
  const requests = [];
  const routes = new Map();
  const intervals = [];
  let fail = false;
  let visitsProcessed = 0;
  const app = { use() {}, get(route, ...handlers) { routes.set(route, handlers.at(-1)); } };
  const context = vm.createContext({
    require(name) {
      if (name === 'express') return () => app;
      if (['morgan', 'cors', 'express-rate-limit'].includes(name)) return () => () => {};
      if (name === 'https') return { createServer: () => ({ listen() {} }) };
      if (name === 'fs') return { readFileSync: () => '' };
      if (name === './airportVisits.cjs') return {
        loadAirports: () => [], loadVisits: () => [], loadVisitState: () => new Map(),
        saveVisits: async () => {}, saveVisitState: async () => {}, nearbyAirports: () => [],
        updateVisitsForTail(visits) { visitsProcessed++; return { visits, changes: 0, currentIds: new Set() }; },
      };
      throw Error(name);
    },
    console: { log() {}, error() {} }, AbortSignal,
    setInterval(fn) { intervals.push(fn); },
    fetch: async url => {
      requests.push(url);
      if (fail) throw Error('offline');
      return { ok: true, json: async () => ({ ac: [{ lat: 33.876, lon: -84.302, seen_pos: 0 }] }) };
    },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 5);
  assert.ok(requests.every(url => url.includes('/v2/reg/')));
  assert.equal(visitsProcessed, 5);
  let body;
  let status = 200;
  const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; } };
  routes.get('/api/yjfc-aircraft')({}, res);
  assert.equal(body.ac.length, 5);
  assert.equal(new Set(body.ac.map(a => a.r)).size, 5);
  assert.ok(Number.isFinite(Date.parse(body.fetchedAt)));
  await intervals[0](); // No general-radar clients: no area request.
  assert.equal(requests.length, 5);
  fail = true;
  await intervals[1]();
  routes.get('/api/yjfc-aircraft')({}, res);
  assert.equal(status, 503);
});
