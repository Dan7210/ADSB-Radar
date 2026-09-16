const fs = require('fs');
const path = require('path');

const AIRPORTS_PATH = path.join(__dirname, 'airports.csv');
const VISITS_PATH = path.join(__dirname, 'airport-visits.json');
const STATE_PATH = path.join(__dirname, 'airport-visit-state.json');
const VISIT_RADIUS_NM = 3;
const REVISIT_COOLDOWN_MS = 30 * 60 * 1000;
const EARTH_RADIUS_NM = 3440.065;

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') {
        value += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      row.push(value);
      value = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(value);
      if (row.some((field) => field !== '')) rows.push(row);
      row = [];
      value = '';
    } else {
      value += char;
    }
  }
  if (quoted) throw new Error('Unterminated quoted field in airports.csv');
  row.push(value);
  if (row.some((field) => field !== '')) rows.push(row);
  return rows;
}

function loadAirports(filePath = AIRPORTS_PATH) {
  const [header, ...rows] = parseCsv(fs.readFileSync(filePath, 'utf8'));
  if (!header) throw new Error('airports.csv is empty');
  const columns = Object.fromEntries(header.map((name, index) => [name.replace(/^\uFEFF/, '').trim(), index]));
  
  // Site Id and coordinates remain required; ICAO Id and Loc Id are handled as fallbacks if present
  for (const name of ['Site Id', 'ARP Latitude DD', 'ARP Longitude DD']) {
    if (columns[name] === undefined) throw new Error(`airports.csv is missing ${name}`);
  }

  return rows.flatMap((row) => {
    const latitude = row[columns['ARP Latitude DD']]?.trim();
    const longitude = row[columns['ARP Longitude DD']]?.trim();
    const lat = Number(latitude);
    const lon = Number(longitude);

    const icaoId = columns['ICAO Id'] !== undefined ? row[columns['ICAO Id']]?.trim() : null;
    const locId = columns['Loc Id'] !== undefined ? row[columns['Loc Id']]?.trim() : null;
    const baseSiteId = row[columns['Site Id']]?.trim();

    // Fallback order: Icao Id -> Loc Id -> Site Id
    const siteId = icaoId || locId || baseSiteId;

    if (!siteId || !latitude || !longitude || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
    return [{
      siteId,
      icao: icaoId || null,
      lat,
      lon,
    }];
  });
}

function distanceNm(lat1, lon1, lat2, lon2) {
  const toRadians = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRadians;
  const dLon = (lon2 - lon1) * toRadians;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRadians) * Math.cos(lat2 * toRadians) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

function nearbyAirports(aircraft, airports, radiusNm = VISIT_RADIUS_NM) {
  if (aircraft.lat === null || aircraft.lon === null ||
      aircraft.lat === undefined || aircraft.lon === undefined) return [];
  const lat = Number(aircraft.lat);
  const lon = Number(aircraft.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180) return [];
  return airports.filter((airport) => distanceNm(lat, lon, airport.lat, airport.lon) <= radiusNm);
}

function updateVisitsForTail(visits, nearby, previousIds, visitedAt) {
  const nextVisits = visits.slice();
  const visitIndexes = new Map(nextVisits.map((visit, index) => [visit.siteId, index]));
  const currentIds = new Set();
  let changes = 0;

  for (const airport of nearby) {
    if (currentIds.has(airport.siteId)) continue;
    currentIds.add(airport.siteId);
    if (previousIds.has(airport.siteId)) continue;

    const index = visitIndexes.get(airport.siteId);
    if (index === undefined) {
      visitIndexes.set(airport.siteId, nextVisits.length);
      nextVisits.push({ ...airport, visitedAt, lastVisitedAt: visitedAt, visitCount: 1 });
      changes += 1;
      continue;
    }

    const previousVisit = nextVisits[index];
    const lastVisitTime = Date.parse(previousVisit.lastVisitedAt || previousVisit.visitedAt);
    if (Number.isFinite(lastVisitTime) &&
        Date.parse(visitedAt) - lastVisitTime < REVISIT_COOLDOWN_MS) continue;
    nextVisits[index] = {
      ...previousVisit,
      lastVisitedAt: visitedAt,
      visitCount: Math.max(1, Number(previousVisit.visitCount) || 1) + 1,
    };
    changes += 1;
  }

  return { visits: nextVisits, currentIds, changes };
}

function loadVisits(filePath = VISITS_PATH) {
  try {
    const visits = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(visits)) throw new Error('airport-visits.json must contain an array');
    return visits;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeJsonAtomically(value, filePath) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`);
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function saveVisits(visits, filePath = VISITS_PATH) {
  await writeJsonAtomically(visits, filePath);
}

function loadVisitState(filePath = STATE_PATH) {
  try {
    const state = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!state || Array.isArray(state) || typeof state !== 'object') {
      throw new Error('airport-visit-state.json must contain an object');
    }
    return new Map(Object.entries(state).map(([tail, ids]) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new Error('airport-visit-state.json contains invalid airport IDs');
      }
      return [tail, new Set(ids)];
    }));
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
}

async function saveVisitState(state, filePath = STATE_PATH) {
  await writeJsonAtomically(Object.fromEntries(
    [...state].map(([tail, ids]) => [tail, [...ids]])
  ), filePath);
}

module.exports = {
  loadAirports, loadVisits, saveVisits, loadVisitState, saveVisitState,
  nearbyAirports, distanceNm, updateVisitsForTail,
};