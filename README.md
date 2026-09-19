# ADS-B OpenLayers Radar View

A real-time, customizable ADS-B air traffic radar display built with React, OpenLayers, and OpenFreeMap. Designed to ingest data directly from a local **adsb.im Pi** feeder (via `aircraft.json`), a remote aggregator endpoint (like adsb.lol / adsb.fi), or a hybrid blend of both.

---

## Features

- **Hybrid Data Feed**: Merge ultra-low-latency local receiver data with wide-area aggregator feeds.
- **Dynamic Radar Scope**: Renders 5 distance range rings with automated extent fitting and window resize handling.
- **Real-Time Vector Styling**:
  - **Local/Direct Feed**: Highlighted in cyan (`#33ccff`).
  - **Military Aircraft**: Flagged and colored red (`#ff4d4d`).
  - **Tracked Call Signs / Tails**: Custom highlight list rendered in gold (`#ffb84d`).
  - **Dynamic Velocity Vectors**: Velocity trails automatically scaled to groundspeed ($gs > 25\text{ kts}$).
- **Stationary & Stale Filtering**: Automatically purges inactive aircraft or ground vehicles ($gs \le 25\text{ kts}$).
- **Zero API Keys**: Powered by OpenFreeMap vector styles (`styles/dark`).

---

## How It Works

1. **Configuration Loading**: On mount, `App.jsx` attempts to fetch runtime settings from `/config.json` in the public directory. If unavailable, it seamlessly falls back to default settings centered on Atlanta, GA.
2. **Data Normalization**: The `normalizeAircraft()` utility parses raw JSON payloads from standard dump1090 / readsb / tar1090 formats, unifying diverse field names (e.g., `hex`, `lat`, `lon`, `gs`, `track`, `dbFlags`) into a uniform object.
3. **Data Polling Cycles**:
   - **Local Pi Feed**: Polls `localUrl` at high frequency (default `100ms`).
   - **Aggregator Feed**: Polls `/api/adsb/v2/point/{lat}/{lon}/{radius}` at lower frequency (default `15000ms`).
4. **Map Engine & Layers**:
   - Uses OpenLayers (`ol/Map`) with vector sources (`VectorSource`).
   - Applies base tile styling via OpenFreeMap dark style using `ol-mapbox-style`.
   - Projects geographic coordinates (`fromLonLat`) into Web Mercator.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or higher recommended)
- [npm](https://www.npmjs.com/) or [pnpm](https://pnpm.io/)
- An active **adsb.im** feeder setup (Raspberry Pi running `dump1090`, `readsb`, or `tar1090`) connected to your network.

### Quick Start

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Dan7210/ADSB-Radar.git
   cd adsb-radar
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

---

## Configuration (`public/config.json`)

To customize the radar for your exact location, aircraft watchlist, and local Pi setup without rebuilding code, place a `config.json` file inside your `public/` directory.

### Example `public/config.json`:

```json
{
  "center": [-84.3880, 33.7490],
  "radiusStepNm": 2,
  "source": "both",
  "localRefreshMs": 100,
  "aggregatorRefreshMs": 15000,
  "localUrl": "http://10.0.0.7:8080/data/aircraft.json",
  "hideStationary": true,
  "staleTimeoutSecs": 30,
  "highlightedTails": [
    "N885GT",
    "N161GT",
    "N314GT",
    "N98714"
  ],
  "normalColor": "#d9e7ff",
  "localColor": "#33ccff",
  "highlightColor": "#ffb84d",
  "militaryColor": "#ff4d4d",
  "ringColor": "rgba(135, 180, 255, 0.38)",
  "ringWidth": 1
}
```

### Configuration Parameters

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `center` | `[Longitude, Latitude]` | `[-84.3880, 33.7490]` | Radar center coordinates in decimal degrees. |
| `radiusStepNm` | `number` | `20` | Spacing between each of the 5 range rings in Nautical Miles (NM). |
| `source` | `string` | `"both"` | Data feed mode: `"local"`, `"aggregator"`, or `"both"`. |
| `localRefreshMs` | `number` | `100` | Polling frequency for local `aircraft.json` in milliseconds. |
| `aggregatorRefreshMs` | `number` | `15000` | Polling frequency for remote aggregator API in milliseconds. If using a free API (as default), don't poll too frequently or you will be rate limited! |
| `localUrl` | `string` | `"http://10.0.0.7:8080/data/aircraft.json"` | Direct HTTP URL to your local Pi feeder's JSON endpoint. |
| `hideStationary` | `boolean` | `true` | Filter out targets moving at or below 25 knots. |
| `staleTimeoutSecs` | `number` | `30` | Time in seconds before old targets are discarded. |
| `highlightedTails` | `string[]` | `["N885GT", ...]` | Target callsigns/tail numbers to render in highlight color. |
| `normalColor` | `string` | `"#d9e7ff"` | Target color for aggregator-only aircraft. |
| `localColor` | `string` | `"#33ccff"` | Target color for local Pi feed aircraft. |
| `highlightColor` | `string` | `"#ffb84d"` | Target color for watchlisted tails. |
| `militaryColor` | `string` | `"#ff4d4d"` | Target color for military aircraft (`a.mil` or `dbFlags & 1`). |
| `ringColor` | `string` | `"rgba(135, 180, 255, 0.38)"` | Stroke color for distance range rings. |
| `ringWidth` | `number` | `1` | Stroke width for range rings. |

---

## Styling & UI Customization

The component expects a CSS file (`style.css`) providing dark HUD radar layout styling. Key classes utilized in `App.jsx`:

- `.radar`: Fullscreen main container.
- `.map`: OpenLayers map container element.
- `.hud`: Overlay header for title and metrics.
- `.metrics`: Shows contact count and live status indicator (`.live` / `.bad`).
- `.crosshair`: Center screen crosshair overlay.
- `.range-labels`: Overlay indicators displaying range ring distance labels.
- `.footer`: Bottom HUD showing current lat/lon coordinates, timestamp, and error messages.

---

## License

MIT License - feel free to use and adapt this project for personal feeder radar displays.

## Automatic YJFC map

The `#/YJFC` route reuses the destinations map and selects its view automatically:

- No fresh YJFC positions: fixed CONUS view with recorded airport visits, route lines, and visit tooltips.
- Strict majority within 5 nautical miles of KPDK: fixed KPDK view with a 5 nmi outer ring and only YJFC aircraft.
- Otherwise (including ties): follows each active YJFC registration for 15 seconds with a 10 nmi outer ring. The camera follows position updates and adjusts to window resizing.

“Active” means a valid ADS-B position no older than 120 seconds, including slow or stationary aircraft. Each tail keeps its own successful fetch timestamp; failures never reset that timestamp. This accommodates the staggered polling cycle while still expiring positions during outages. Feed errors are shown separately from the destinations view.

The frontend uses `/api/yjfc-aircraft`. Deploy/restart the updated backend alongside the frontend. A single backend scheduler queries the five registrations in rotation and reuses each result for airport-visit tracking. Every adsb.lol request is separated by at least 11 seconds after the previous request completes. The existing general radar retains `/api/adsb-lol`; an area lookup occupies one rotation slot only while that endpoint has recent clients. A fleet cycle takes roughly 55–66 seconds plus response time. API routes only serve caches and never trigger upstream requests. Each successful tail result is published immediately, empty responses clear that tail, and failed refreshes preserve its previous value and timestamp. HTTP 429 pauses the shared scheduler for at least 60 seconds or the upstream Retry-After interval, whichever is longer. Run a single backend process for this shared request budget. YJFC no longer downloads the full local or area feed.

The `#/YJFC` route always uses live data; simulation controls and URL overrides are disabled.

Run the focused regression tests with `node --test src/yjfcTracking.test.js backend/yjfcFeed.test.cjs`.
