import { useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { fromLonLat } from 'ol/proj.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import Text from 'ol/style/Text.js';
import { apply } from 'ol-mapbox-style';
import 'ol/ol.css';
import './style.css';

const HOME = { icao: 'KPDK', lat: 33.8760019, lon: -84.3020306 };
const API_URL = 'https://adsb-radar.duckdns.org:8443/api/airport-visits';
const RADIUS_NM = 50;
const EARTH_RADIUS_NM = 3440.065;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GOLD = '#ffbd52';
const OLD_COLOR = 'rgba(255,255,255,0.5)';

function radiusBoundary() {
  const latitude = HOME.lat * Math.PI / 180;
  const longitude = HOME.lon * Math.PI / 180;
  const distance = RADIUS_NM / EARTH_RADIUS_NM;
  const coordinates = [];
  for (let degrees = 0; degrees <= 360; degrees += 5) {
    const bearing = degrees * Math.PI / 180;
    const lat = Math.asin(Math.sin(latitude) * Math.cos(distance) +
      Math.cos(latitude) * Math.sin(distance) * Math.cos(bearing));
    const lon = longitude + Math.atan2(
      Math.sin(bearing) * Math.sin(distance) * Math.cos(latitude),
      Math.cos(distance) - Math.sin(latitude) * Math.sin(lat)
    );
    coordinates.push(fromLonLat([lon * 180 / Math.PI, lat * 180 / Math.PI]));
  }
  return new LineString(coordinates);
}

function normalizeVisits(raw) {
  if (!Array.isArray(raw)) throw new Error('Airport visits response is invalid');
  return raw.filter((visit) => {
    const lat = Number(visit.lat);
    const lon = Number(visit.lon);
    return visit.lat !== null && visit.lon !== null &&
      Number.isFinite(lat) && Number.isFinite(lon) &&
      Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  }).map((visit) => ({
    ...visit,
    lat: Number(visit.lat),
    lon: Number(visit.lon),
    visitCount: Math.max(1, Number(visit.visitCount) || 1),
    lastVisitedAt: visit.lastVisitedAt || visit.visitedAt,
  }));
}

function dotRadius(count) {
  return Math.min(15, 5 + 2.5 * Math.sqrt(Math.max(0, count - 1)));
}

function formatVisitDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
}

export default function YJFCDestinations() {
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const linesRef = useRef(new VectorSource());
  const dotsRef = useRef(new VectorSource());
  const [visits, setVisits] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });
  const [error, setError] = useState('');

  useEffect(() => {
    const boundary = radiusBoundary();
    const lineLayer = new VectorLayer({
      source: linesRef.current,
      style: (feature) => new Style({
        stroke: new Stroke({
          color: feature.get('recent') ? GOLD : OLD_COLOR,
          width: feature.get('recent') ? 2 : 1.5,
          lineDash: feature.get('recent') ? undefined : [6, 8],
        }),
      }),
    });
    const dotLayer = new VectorLayer({
      source: dotsRef.current,
      style: (feature) => {
        const visit = feature.get('visit');
        const home = feature.get('home');
        return new Style({
          image: new CircleStyle({
            radius: home ? Math.max(8, dotRadius(visit.visitCount)) : dotRadius(visit.visitCount),
            fill: new Fill({ color: home || feature.get('recent') ? GOLD : '#e3eaf2' }),
            stroke: new Stroke({ color: '#07111f', width: 2 }),
          }),
          text: home ? new Text({
            text: 'KPDK',
            offsetY: -19,
            font: '700 11px "JetBrains Mono", monospace',
            fill: new Fill({ color: GOLD }),
            stroke: new Stroke({ color: '#07111f', width: 3 }),
          }) : undefined,
        });
      },
    });

    const map = new OLMap({
      target: mapElement.current,
      view: new View({ center: fromLonLat([HOME.lon, HOME.lat]), zoom: 7 }),
      controls: [new Zoom()],
    });
    mapRef.current = map;

    // Set the initial 50 nmi range once, preserving user zoom on resize.
    map.getView().fit(boundary.getExtent(), { padding: [75, 75, 75, 75], duration: 0 });
    let active = true;
    apply(map, 'https://tiles.openfreemap.org/styles/dark')
      .then(() => {
        if (!active) return;
        map.addLayer(lineLayer);
        map.addLayer(dotLayer);
      })
      .catch(() => {
        if (active) setError('Could not load the map background.');
      });

    const clearHover = () => {
      setSelected(null);
      map.getTargetElement().style.cursor = '';
    };
    const handlePointerMove = (event) => {
      if (event.dragging) {
        clearHover();
        return;
      }
      const feature = map.forEachFeatureAtPixel(event.pixel,
        (candidate) => candidate.get('visit') ? candidate : undefined,
        { hitTolerance: 8, layerFilter: (layer) => layer === dotLayer });
      map.getTargetElement().style.cursor = feature ? 'pointer' : '';
      setSelected(feature?.get('visit') || null);
      const [width, height] = map.getSize();
      setTooltipPosition({
        left: Math.max(8, Math.min(event.pixel[0] + 16, width - 228)),
        top: Math.max(8, Math.min(event.pixel[1] + 16, height - 112)),
      });
    };
    map.on('pointermove', handlePointerMove);
    map.on('movestart', clearHover);
    const viewport = map.getViewport();
    viewport.addEventListener('pointerleave', clearHover);

    return () => {
      active = false;
      viewport.removeEventListener('pointerleave', clearHover);
      map.un('movestart', clearHover);
      map.un('pointermove', handlePointerMove);
      map.setTarget(undefined);
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer;
    const controller = new AbortController();
    async function pollVisits() {
      try {
        const response = await fetch(API_URL, { cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Airport visits unavailable (${response.status})`);
        const nextVisits = normalizeVisits(await response.json());
        if (active) {
          setVisits(nextVisits);
          setError('');
        }
      } catch (failure) {
        if (active) setError(failure.message);
      } finally {
        if (active) timer = setTimeout(pollVisits, 60000);
      }
    }
    pollVisits();
    return () => {
      active = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, []);

  useEffect(() => {
    const homeVisit = visits.find((visit) => visit.icao?.toUpperCase() === HOME.icao);
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const home = homeVisit || { ...HOME, siteId: 'KPDK', visitCount: 0 };
    const homePoint = fromLonLat([HOME.lon, HOME.lat]);
    const lines = [];
    const dots = [new Feature({ geometry: new Point(homePoint), visit: home, home: true })];

    for (const visit of visits) {
      if (visit.icao?.toUpperCase() === HOME.icao) continue;
      const destination = fromLonLat([visit.lon, visit.lat]);
      const recent = Date.parse(visit.lastVisitedAt) >= cutoff;
      lines.push(new Feature({
        geometry: new LineString([homePoint, destination]),
        recent,
      }));
      dots.push(new Feature({
        geometry: new Point(destination),
        visit,
        recent,
      }));
    }

    linesRef.current.clear(true);
    dotsRef.current.clear(true);
    linesRef.current.addFeatures(lines);
    dotsRef.current.addFeatures(dots);
    mapRef.current?.render();
  }, [visits]);

  return (
    <main className="radar destinations">
      <div ref={mapElement} className="map" tabIndex={0} aria-label="Airport destinations map. Use plus and minus to zoom." />
      <header className="hud destinations-hud">
        <div>
          <div className="eyebrow">YJFC DESTINATIONS</div>
          <div className="title">From KPDK</div>
        </div>
        <div className="destinations-summary">
          <strong>{visits.length}</strong> airports visited
        </div>
      </header>

      <aside className="destinations-legend">
        <div><span className="legend-line recent" /> Visited in the last 30 days</div>
        <div><span className="legend-line older" /> Earlier visits</div>
      </aside>

      {selected && <aside className="destinations-tooltip" role="tooltip" style={tooltipPosition}>
        <strong>{selected.icao || selected.siteId || 'Airport'}</strong>
        <span>{selected.icao?.toUpperCase() === HOME.icao ? 'Home base' : `${selected.visitCount} ${selected.visitCount === 1 ? 'visit' : 'visits'}`}</span>
        {selected.lastVisitedAt && <span>Last seen {formatVisitDate(selected.lastVisitedAt)}</span>}
      </aside>}

      <footer className="footer destinations-footer">
        <span>KPDK · 33.8760° N / 84.3020° W</span>
        {error && <span className="error">{error}</span>}
      </footer>
    </main>
  );
}
