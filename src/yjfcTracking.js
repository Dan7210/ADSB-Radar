import { getDistance, offset } from 'ol/sphere.js';
import { estimatedLonLat } from './aircraftMotion.js';
export const HOME = { icao: 'KPDK', lat: 33.8760019, lon: -84.3020306 };
export const TAILS = ['N885GT', 'N161GT', 'N314GT', 'N98714', 'N2247T'];
export const API = 'https://adsb-radar.duckdns.org:8443/api';
export const NM = 1852;
export function activeAircraft(payload, now = Date.now()) {
  const maxAge = Math.min(120, Math.max(30, Number(payload.positionMaxAgeSecs) || 30));
  const byTail = new Map();
  for (const row of payload.ac || []) {
    const age = Math.max(0, (now - Date.parse(row.fetchedAt ?? payload.fetchedAt)) / 1000);
    const tail = String(row.r || '').trim().toUpperCase();
    const seen = Number(row.seen_pos);
    if (!TAILS.includes(tail) || row.lat == null || row.lon == null ||
        String(row.lat).trim() === '' || String(row.lon).trim() === '' ||
        !Number.isFinite(Number(row.lat)) || !Number.isFinite(Number(row.lon)) ||
        Math.abs(Number(row.lat)) > 90 || Math.abs(Number(row.lon)) > 180 ||
        !Number.isFinite(age) || row.seen_pos == null || !Number.isFinite(seen) || seen < 0 || seen + age > maxAge) continue;
    const aircraft = { ...row, r: tail, lat: Number(row.lat), lon: Number(row.lon), positionAge: seen + age };
    if (!byTail.has(tail) || seen < Number(byTail.get(tail).seen_pos)) byTail.set(tail, aircraft);
  }
  return [...byTail.values()].sort((a, b) => a.r.localeCompare(b.r));
}
export function viewMode(aircraft) {
  if (!aircraft.length) return 'destinations';
  const nearby = aircraft.filter(a => getDistance([HOME.lon, HOME.lat], estimatedLonLat(a)) <= 5 * NM);
  return nearby.length > aircraft.length / 2 ? 'home' : 'follow';
}
export function simulation(scenario, now = Date.now()) {
  const locations = scenario === 'home'
    ? [[HOME.lon, HOME.lat], [-84.28, 33.90], [-84.32, 33.85]]
    : scenario === 'follow' ? [[-83.32, 33.95], [-81.10, 32.13], [HOME.lon, HOME.lat]] : [];
  return { fetchedAt: new Date(now).toISOString(), ac: locations.map((center, index) => {
    const bearing = now / 120000 + index * 2;
    const [lon, lat] = offset(center, 0.6 * NM, bearing);
    return { r: TAILS[index], hex: `sim-${index}`, lon, lat, seen_pos: 0,
      track: (bearing * 180 / Math.PI + 90) % 360, gs: 105, alt_baro: 2500 + index * 1000, t: 'C172' };
  }) };
}
