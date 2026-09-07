const express = require('express');
const morgan = require('morgan');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 8443;
const FILE_PATH = '/run/adsb-feeder-ultrafeeder/readsb/aircraft.json';

// Atlanta, GA (Center) - 100 Nautical Miles Radius
const ATLANTA_LAT = '33.7490';
const ATLANTA_LON = '-84.3880';
const RADIUS_NMI = '100';
const TARGET_URL = `https://api.adsb.lol/v2/point/${ATLANTA_LAT}/${ATLANTA_LON}/${RADIUS_NMI}`;

const POLL_INTERVAL_MS = 15000;
let cachedAdsbData = null;
let lastFetchError = null;

// Background Poller
async function pollAdsbLol() {
  try {
    const response = await fetch(TARGET_URL);
    if (!response.ok) {
      throw new Error(`Upstream returned status ${response.status}`);
    }
    cachedAdsbData = await response.json();
    lastFetchError = null;
    console.log(`[adsb.lol] Successfully updated cache for Atlanta, GA (100 nmi radius)`);
  } catch (err) {
    console.error(`[adsb.lol] Poll failed: ${err.message}`);
    lastFetchError = err.message;
  }
}

// Start polling
pollAdsbLol();
setInterval(pollAdsbLol, POLL_INTERVAL_MS);

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

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/fullchain.pem')
};

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Secure ADS-B API running at https://0.0.0.0:${PORT}/api/aircraft`);
});