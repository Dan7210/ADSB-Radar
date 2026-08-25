const express = require('express');
const morgan = require('morgan');
const https = require('https');
const fs = require('fs');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = 8443; // Standard HTTPS API port
const FILE_PATH = '/run/adsb-feeder-ultrafeeder/readsb/aircraft.json'; // Adjust path if needed

// Allow cross-origin requests from GitHub Pages
app.use(cors({
  origin: '*',
  methods: ['GET', 'OPTIONS'],
  allowedHeaders: ['*']
}));

app.use(morgan('combined')); // Logs IP, timestamp, method, path, status, and user-agent

// Global Limiter: Max 1000 requests/sec across all clients
const globalLimiter = rateLimit({
  windowMs: 1000,
  max: 1000,
  message: { error: 'Global rate limit exceeded.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-Client Limiter: Max 5 requests/sec per IP
const clientLimiter = rateLimit({
  windowMs: 1000,
  max: 3,
  message: { error: 'Client rate limit exceeded (max 2 req/sec).' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

// Dedicated ADS-B Endpoint
app.get('/api/aircraft', clientLimiter, (req, res) => {
  fs.readFile(FILE_PATH, 'utf8', (err, data) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to read aircraft data' });
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(data);
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

// Load SSL certificates
const sslOptions = {
  key: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/adsb-radar.duckdns.org/fullchain.pem')
};

// Start HTTPS Server
https.createServer(sslOptions, app).listen(PORT, '0.0.0.0', () => {
  console.log(`Secure ADS-B API running at https://0.0.0.0:${PORT}/api/aircraft`);
});