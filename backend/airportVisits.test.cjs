const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  loadAirports, loadVisits, saveVisits, loadVisitState, saveVisitState,
  nearbyAirports, updateVisitsForTail,
} = require('./airportVisits.cjs');

test('loads coordinates and ICAO from quoted airport CSV rows', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-airports-'));
  try {
    const file = path.join(directory, 'airports.csv');
    fs.writeFileSync(file, 'Site Id,Name,ICAO Id,ARP Latitude DD,ARP Longitude DD\n' +
      'A1,"Airport, North",KAAA,33.75,-84.38\n' +
      'A2,"Heliport, South",,33.76,-84.39\n' +
      'A3,Unknown,KZZZ,,\n');
    assert.deepEqual(loadAirports(file), [
      { siteId: 'A1', icao: 'KAAA', lat: 33.75, lon: -84.38 },
      { siteId: 'A2', icao: null, lat: 33.76, lon: -84.39 },
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('loads the supplied airport catalog', () => {
  const airports = loadAirports();
  assert.ok(airports.length > 1000);
  assert.ok(airports.some((airport) => airport.icao === 'KATL'));
  assert.ok(airports.some((airport) => airport.icao === 'KPDK'));
});

test('five nautical mile radius includes nearby airports only', () => {
  const airports = [
    { siteId: 'near', lat: 33.75, lon: -84.38 },
    { siteId: 'far', lat: 34, lon: -84.38 },
  ];
  assert.deepEqual(nearbyAirports({ lat: 33.75, lon: -84.38 }, airports).map((a) => a.siteId), ['near']);
  assert.deepEqual(nearbyAirports({ lat: null, lon: -84.38 }, airports), []);
});

test('counts a new visit after leaving and returning without counting every poll', () => {
  const airport = { siteId: 'A1', icao: 'KAAA', lat: 33.75, lon: -84.38 };
  const first = updateVisitsForTail([], [airport], new Set(), '2026-09-15T12:00:00.000Z');
  assert.equal(first.visits[0].visitCount, 1);
  assert.equal(updateVisitsForTail(first.visits, [airport], first.currentIds,
    '2026-09-15T12:01:00.000Z').changes, 0);
  const outside = updateVisitsForTail(first.visits, [], first.currentIds,
    '2026-09-15T12:02:00.000Z');
  assert.equal(updateVisitsForTail(outside.visits, [airport], outside.currentIds,
    '2026-09-15T12:10:00.000Z').changes, 0);
  const second = updateVisitsForTail(outside.visits, [airport], outside.currentIds,
    '2026-09-15T13:00:00.000Z');
  assert.equal(second.visits[0].visitCount, 2);
  assert.equal(second.visits[0].lastVisitedAt, '2026-09-15T13:00:00.000Z');
});

test('saved visits survive reload', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-visits-'));
  try {
    const file = path.join(directory, 'visits.json');
    assert.deepEqual(loadVisits(file), []);
    const visits = [{ siteId: 'A1', icao: 'KAAA', lat: 33.75, lon: -84.38,
      visitedAt: '2026-09-15T12:00:00.000Z' }];
    await saveVisits(visits, file);
    assert.deepEqual(loadVisits(file), visits);
    await saveVisits([...visits, { siteId: 'A2', icao: null, lat: 33.76, lon: -84.39,
      visitedAt: '2026-09-16T12:00:00.000Z' }], file);
    assert.equal(loadVisits(file).length, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('active airport proximity survives restart', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'adsb-visit-state-'));
  try {
    const file = path.join(directory, 'state.json');
    assert.equal(loadVisitState(file).size, 0);
    await saveVisitState(new Map([['N885GT', new Set(['A1', 'A2'])]]), file);
    assert.deepEqual([...loadVisitState(file).get('N885GT')], ['A1', 'A2']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
