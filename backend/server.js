const express = require('express');
const morgan = require('morgan');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 8443;
const FILE_PATH = '/run/adsb-feeder-ultrafeeder/readsb/aircraft.json';

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
    } catch (parseErr) {
      res.status(500).json({ error: 'Failed to parse aircraft JSON stream' });
    }
  });
});

// Proxy endpoint for adsb.lol requests
app.get('/api/adsb-lol/:lat/:lon/:radius', clientLimiter, async (req, res) => {
  const { lat, lon, radius } = req.params;
  const targetUrl = `https://api.adsb.lol/v2/point/${lat}/${lon}/${radius}`;

  try {
    const response = await fetch(targetUrl);
    if (!response.ok) {
      return res.status(response.status).json({ error: 'adsb.lol upstream error' });
    }
    const data = await response.json();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch from adsb.lol' });
  }
});

const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/fullchain.pem')
};

https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Secure ADS-B API running at https://0.0.0.0:${PORT}/api/aircraft`);
});