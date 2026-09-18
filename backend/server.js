const express = require('express');
const morgan = require('morgan');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const {
  loadAirports, loadVisits, saveVisits, loadVisitState, saveVisitState,
  nearbyAirports, updateVisitsForTail,
} = require('./airportVisits.cjs');

const app = express();
const PORT = 8443;
const FILE_PATH = '/run/adsb-feeder-ultrafeeder/readsb/aircraft.json';

// Atlanta, GA (Center) - 100 Nautical Miles Radius
const ATLANTA_LAT = '33.7490';
const ATLANTA_LON = '-84.3880';
const RADIUS_NMI = '100';
const TARGET_URL = `https://api.adsb.lol/v2/point/${ATLANTA_LAT}/${ATLANTA_LON}/${RADIUS_NMI}`;

const POLL_INTERVAL_MS = 15000;
const TRACKED_TAILS = ['N885GT', 'N161GT', 'N314GT', 'N98714', 'N2247T'];
const airports = loadAirports();
let airportVisits = loadVisits();
let activeAirportIdsByTail = loadVisitState();
let visitStateDirty = false;
let visitPollInProgress = false;
let cachedAdsbData = null;
let lastFetchError = null;
let cachedYjfcData = null;
let yjfcPollInProgress = false;
let areaPollInProgress = false;
let lastAreaRequestAt = 0;

// Background Poller
async function pollAdsbLol() {
  if (areaPollInProgress || Date.now() - lastAreaRequestAt > 60000) return;
  areaPollInProgress = true;
  try {
    const response = await fetch(TARGET_URL, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      throw new Error(`Upstream returned status ${response.status}`);
    }
    cachedAdsbData = await response.json();
    lastFetchError = null;
    console.log(`[adsb.lol] Successfully updated cache for Atlanta, GA (100 nmi radius)`);
  } catch (err) {
    console.error(`[adsb.lol] Poll failed: ${err.message}`);
    lastFetchError = err.message;
  } finally {
    areaPollInProgress = false;
  }
}

// Start polling
setInterval(pollAdsbLol, POLL_INTERVAL_MS);

// Query registrations globally; the Atlanta point feed cannot see visits elsewhere.
function sameVisitState(left, right) {
  if (left.size !== right.size) return false;
  for (const [tail, leftIds] of left) {
    const rightIds = right.get(tail);
    if (!rightIds || leftIds.size !== rightIds.size ||
        [...leftIds].some((id) => !rightIds.has(id))) return false;
  }
  return true;
}

async function pollAirportVisits(results) {
  if (visitPollInProgress) return;
  visitPollInProgress = true;
  try {
    let updatedVisits = airportVisits;
    let changes = 0;
    const nextActiveIds = new Map(activeAirportIdsByTail);
    const visitedAt = new Date().toISOString();
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error(`[airport visits] Lookup failed: ${result.reason.message}`);
        continue;
      }
      const positionedAircraft = result.value.aircraft.filter((aircraft) => {
        // The registration endpoint is exact; reject stale positions and mismatched registrations.
        if (aircraft.r && String(aircraft.r).trim().toUpperCase() !== result.value.tail) return false;
        return Number.isFinite(aircraft.seen_pos) && aircraft.seen_pos >= 0 && aircraft.seen_pos <= 60 &&
          aircraft.lat !== null && aircraft.lon !== null &&
          String(aircraft.lat).trim() !== '' && String(aircraft.lon).trim() !== '' &&
          Number.isFinite(Number(aircraft.lat)) && Number.isFinite(Number(aircraft.lon)) &&
          Math.abs(Number(aircraft.lat)) <= 90 && Math.abs(Number(aircraft.lon)) <= 180;
      });
      // No position is different from a confirmed position outside the airport radius.
      if (!positionedAircraft.length) continue;
      const nearby = positionedAircraft.flatMap((aircraft) => nearbyAirports(aircraft, airports));
      const update = updateVisitsForTail(
        updatedVisits, nearby, nextActiveIds.get(result.value.tail) || new Set(), visitedAt
      );
      updatedVisits = update.visits;
      changes += update.changes;
      nextActiveIds.set(result.value.tail, update.currentIds);
    }

    const stateChanged = !sameVisitState(activeAirportIdsByTail, nextActiveIds);
    if (changes) {
      await saveVisits(updatedVisits);
      airportVisits = updatedVisits;
      console.log(`[airport visits] Saved ${changes} airport visit(s)`);
    }
    activeAirportIdsByTail = nextActiveIds;
    if (stateChanged || visitStateDirty) {
      try {
        await saveVisitState(nextActiveIds);
        visitStateDirty = false;
      } catch (error) {
        visitStateDirty = true;
        console.error(`[airport visits] Could not save proximity state: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`[airport visits] Poll failed: ${error.message}`);
  } finally {
    visitPollInProgress = false;
  }
}

// One global registration lookup per tail per cycle, shared by the map and visit tracking.
async function pollYjfc() {
  if (yjfcPollInProgress) return;
  yjfcPollInProgress = true;
  const fetchedAt = new Date().toISOString();
  try {
    const results = await Promise.allSettled(TRACKED_TAILS.map(async tail => {
      const response = await fetch(`https://api.adsb.lol/v2/reg/${tail}`, {
        signal: AbortSignal.timeout(12000),
      });
      if (!response.ok) throw new Error(`${tail}: upstream returned ${response.status}`);
      const data = await response.json();
      if (!Array.isArray(data.ac)) throw new Error(`${tail}: invalid aircraft data`);
      return { tail, aircraft: data.ac.filter(a => !a.r || String(a.r).trim().toUpperCase() === tail)
        .map(a => ({ ...a, r: tail })) };
    }));
    // Failed lookups are omitted, never re-stamped as fresh aircraft.
    cachedYjfcData = { fetchedAt,
      ac: results.flatMap(result => result.status === 'fulfilled' ? result.value.aircraft : []),
      errors: results.filter(result => result.status === 'rejected').map(result => result.reason.message),
    };
    await pollAirportVisits(results);
  } finally {
    yjfcPollInProgress = false;
  }
}
pollYjfc();
setInterval(pollYjfc, POLL_INTERVAL_MS);

// Enable CORS
app.use(cors());
app.use(morgan('combined'));

const globalLimiter = rateLimit({
  windowMs: 1000,
  max: 1000,
  message: { error: 'Global rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const clientLimiter = rateLimit({
  windowMs: 1000,
  max: 3,
  message: { error: 'Client rate limit exceeded (max 3 req/sec).' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

// Serve readsb aircraft payload directly
app.get('/api/aircraft', clientLimiter, (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, rawData) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to read aircraft data' });
    }

    try {
      const parsedData = JSON.parse(rawData);
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.json(parsedData);
    } catch {
      res.status(500).json({ error: 'Failed to parse aircraft JSON stream' });
    }
  });
});

// Serve cached Atlanta adsb.lol data directly
app.get('/api/adsb-lol', clientLimiter, (req, res) => {
  // The general radar still needs an area feed. YJFC-only use never starts it.
  lastAreaRequestAt = Date.now();
  if (!cachedAdsbData) void pollAdsbLol();
  if (!cachedAdsbData) {
    return res.status(503).json({
      error: 'adsb.lol cache warming up',
      details: lastFetchError || 'Waiting for initial poll completion.'
    });
  }

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.json(cachedAdsbData);
});

app.get('/api/yjfc-aircraft', clientLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!cachedYjfcData) return res.status(503).json({ error: 'YJFC cache warming up' });
  if (cachedYjfcData.errors.length === TRACKED_TAILS.length) {
    return res.status(503).json({ error: 'All YJFC lookups failed' });
  }
  res.json(cachedYjfcData);
});

app.get('/api/airport-visits', clientLimiter, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(airportVisits);
});

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/fullchain.pem')
};

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Secure ADS-B API running at https://0.0.0.0:${PORT}/api/aircraft`);
});
