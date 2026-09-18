import test from 'node:test';
import assert from 'node:assert/strict';
import { offset } from 'ol/sphere.js';
import { activeAircraft, viewMode, simulation, HOME, NM, TAILS } from './yjfcTracking.js';
const now = Date.now();
const row = (tail, nm) => {
  const [lon, lat] = offset([HOME.lon, HOME.lat], nm * NM, 0);
  return { r: tail, lon, lat, seen_pos: 0 };
};
test('idle, strict local majority, remote majority, and tie select the expected modes', () => {
  assert.equal(viewMode([]), 'destinations');
  assert.equal(viewMode([row(TAILS[0], 4.99)]), 'home');
  assert.equal(viewMode([row(TAILS[0], 5.01)]), 'follow');
  assert.equal(viewMode([row(TAILS[0], 1), row(TAILS[1], 2), row(TAILS[2], 40)]), 'home');
  assert.equal(viewMode([row(TAILS[0], 1), row(TAILS[1], 40)]), 'follow');
});
test('positions expire as wall time advances, including when polling fails', () => {
  const feed = { fetchedAt: new Date(now).toISOString(), ac: [row(TAILS[0], 1)] };
  assert.equal(activeAircraft(feed, now).length, 1);
  assert.equal(activeAircraft(feed, now + 31000).length, 0);
  assert.equal(activeAircraft({ ac: feed.ac }, now).length, 0);
});
test('rejects invalid positions, stale positions, and other tails; deduplicates registrations', () => {
  const valid = row(TAILS[0], 1);
  const ac = [valid, { ...valid, seen_pos: 3 }, { ...valid, r: 'N12345' },
    { ...valid, r: TAILS[1], lat: null }, { ...valid, r: TAILS[2], seen_pos: 31 },
    { ...valid, r: TAILS[3], lon: 200 }, { ...valid, r: TAILS[4], seen_pos: null }];
  assert.deepEqual(activeAircraft({ fetchedAt: new Date(now).toISOString(), ac }, now), [valid]);
});
test('each simulation exercises its actual selection logic and aircraft move', () => {
  for (const mode of ['destinations', 'home', 'follow']) {
    assert.equal(viewMode(activeAircraft(simulation(mode, now), now)), mode);
  }
  assert.notEqual(simulation('follow', now).ac[0].lon, simulation('follow', now + 1000).ac[0].lon);
});
