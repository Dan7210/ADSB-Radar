import { useEffect, useRef, useState } from 'react';
import OLMap from 'ol/Map.js';
import View from 'ol/View.js';
import Zoom from 'ol/control/Zoom.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import { offset } from 'ol/sphere.js';
import { NM } from './yjfcTracking.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import Text from 'ol/style/Text.js';
import { apply } from 'ol-mapbox-style';
import { estimatedLonLat, stepMotion, updateMotion } from './aircraftMotion.js';
import 'ol/ol.css';
import './style.css';

const HOME = { icao: 'KPDK', lat: 33.8760019, lon: -84.3020306 };
const API_URL = 'https://adsb-radar.duckdns.org:8443/api/airport-visits';
const RADIUS_NM = 50;
const EARTH_RADIUS_NM = 3440.065;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const GOLD = '#ffbd52';
const OLD_COLOR = 'rgba(255,255,255,0.5)';
// Airport dot radius clamps, in pixels.
const MIN_DOT_RADIUS_PX = 8;
const MAX_DOT_RADIUS_PX = 15;
// Compact dots and a southern-US overview for the automatic #/YJFC map.
const YJFC_DOT_RADIUS_PX = 6;
const YJFC_DESTINATION_EXTENT = [-110, 26, -75, 40]; // west, south, east, north

function radiusBoundary(center = HOME, radius = RADIUS_NM) {
  const latitude = center.lat * Math.PI / 180;
  const longitude = center.lon * Math.PI / 180;
  const distance = radius / EARTH_RADIUS_NM;
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

function dotRadius(count, maxCount) {
  const ratio = Math.max(0, Math.min(1, count / Math.max(1, maxCount)));
  // Scale area by relative visit count, then clamp the radius for readability.
  return Math.max(MIN_DOT_RADIUS_PX, Math.min(MAX_DOT_RADIUS_PX,
    MAX_DOT_RADIUS_PX * Math.sqrt(ratio)));
}

function formatVisitDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleDateString();
}

export default function YJFCDestinations({ tracking }) {
  const mode = tracking?.mode || 'destinations';
  const isTracking = Boolean(tracking);
  const aircraftSource = useRef(new VectorSource());
  const aircraftFeatures = useRef(new Map());
  const focusAircraft = useRef(null);
  const animationFrame = useRef(null);
  const ringCenter = useRef(null);
  const ringsSource = useRef(new VectorSource());
  const layersRef = useRef(null);
  const mapElement = useRef(null);
  const mapRef = useRef(null);
  const linesRef = useRef(new VectorSource());
  const dotsRef = useRef(new VectorSource());
  const [visits, setVisits] = useState([]);
  const [selected, setSelected] = useState(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 0, top: 0 });
  const [error, setError] = useState('');

  useEffect(() => {
    focusAircraft.current = tracking?.focus || null;
  }, [tracking?.focus]);

  useEffect(() => {
    const featureMap = aircraftFeatures.current;
    const aircraftVectorSource = aircraftSource.current;
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
        const radius = isTracking ? YJFC_DOT_RADIUS_PX : feature.get('radius');
        const home = feature.get('home');
        return new Style({
          image: new CircleStyle({
            radius,
            fill: new Fill({ color: home || feature.get('recent') ? GOLD : '#e3eaf2' }),
            stroke: new Stroke({ color: '#07111f', width: 2 }),
          }),
          text: home ? new Text({
            text: 'KPDK',
            offsetY: -(radius + 10),
            font: '700 11px "JetBrains Mono", monospace',
            fill: new Fill({ color: GOLD }),
            stroke: new Stroke({ color: '#07111f', width: 3 }),
          }) : undefined,
        });
      },
    });

    const ringLayer = new VectorLayer({ source: ringsSource.current, style: new Style({
      stroke: new Stroke({ color: 'rgba(135,180,255,.38)', width: 1 }),
    }) });
    const aircraftLayer = new VectorLayer({ source: aircraftSource.current, style: feature => {
      const a = feature.get('aircraft');
      const position = feature.getGeometry().getCoordinates();
      const point = toLonLat(position);
      const behind = offset(point, Math.max(0.2, Number(a.gs || 0) / 120) * NM,
        (Number(a.track || 0) + 180) * Math.PI / 180);
      return [new Style({
        image: new CircleStyle({ radius: 5, fill: new Fill({ color: GOLD }),
          stroke: new Stroke({ color: '#07111f', width: 2 }) }),
        text: new Text({ text: `${a.r}\n${a.alt_baro === 'ground' ? 'SFC' : a.alt_baro != null ? a.alt_baro + ' FT' : 'ALT —'} · ${a.gs ?? '—'} KT`,
          offsetY: -25, font: '600 11px "JetBrains Mono", monospace',
          fill: new Fill({ color: GOLD }), stroke: new Stroke({ color: '#07111f', width: 3 }) }),
      }), new Style({ geometry: new LineString([fromLonLat(behind), position]),
        stroke: new Stroke({ color: GOLD, width: 1.5, lineDash: [2, 7] }) })];
    } });
    layersRef.current = { lineLayer, dotLayer, ringLayer, aircraftLayer };
    const map = new OLMap({
      target: mapElement.current,
      view: new View({ center: fromLonLat([HOME.lon, HOME.lat]), zoom: 7 }),
      controls: isTracking ? [] : [new Zoom()],
      ...(isTracking ? { interactions: [] } : {}),
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
        map.addLayer(ringLayer);
        map.addLayer(aircraftLayer);
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
      featureMap.clear();
      aircraftVectorSource.clear();
    };
  }, [isTracking]);

  useEffect(() => {
    if (!isTracking) return;
    const animate = frameTime => {
      for (const feature of aircraftFeatures.current.values()) {
        feature.getGeometry().setCoordinates(stepMotion(feature.get('motion'), frameTime));
      }

      if (mode === 'follow') {
        const focusFeature = aircraftFeatures.current.get(tracking?.focus?.r);
        const center = focusFeature?.getGeometry().getCoordinates();
        if (center && mapRef.current) {
          mapRef.current.getView().setCenter(center);
          if (ringCenter.current) {
            const dx = center[0] - ringCenter.current[0];
            const dy = center[1] - ringCenter.current[1];
            for (const ring of ringsSource.current.getFeatures()) ring.getGeometry().translate(dx, dy);
          }
          ringCenter.current = [...center];
        }
      }

      mapRef.current?.render();
      animationFrame.current = requestAnimationFrame(animate);
    };

    animationFrame.current = requestAnimationFrame(animate);
    return () => {
      if (animationFrame.current !== null) cancelAnimationFrame(animationFrame.current);
      animationFrame.current = null;
    };
  }, [isTracking, mode, tracking?.focus?.r]);

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
    const maxVisitCount = visits.reduce((max, visit) =>
      visit.icao?.toUpperCase() === HOME.icao ? max : Math.max(max, visit.visitCount), 1);
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    const home = homeVisit || { ...HOME, siteId: 'KPDK', visitCount: 0 };
    const homePoint = fromLonLat([HOME.lon, HOME.lat]);
    const lines = [];
    const dots = [new Feature({ geometry: new Point(homePoint), visit: home, home: true,
      radius: MAX_DOT_RADIUS_PX })];

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
        radius: dotRadius(visit.visitCount, maxVisitCount),
        recent,
      }));
    }

    linesRef.current.clear(true);
    dotsRef.current.clear(true);
    linesRef.current.addFeatures(lines);
    dotsRef.current.addFeatures(dots);
    mapRef.current?.render();
  }, [visits]);

  const focusTail = mode === 'follow' ? tracking?.focus?.r : undefined;
  useEffect(() => {
    if (!isTracking || !mapRef.current) return;
    const map = mapRef.current;
    const { lineLayer, dotLayer, ringLayer, aircraftLayer } = layersRef.current;
    const idle = mode === 'destinations';
    lineLayer.setVisible(idle);
    dotLayer.setVisible(idle);
    ringLayer.setVisible(!idle);
    aircraftLayer.setVisible(!idle);
    const focusCoordinates = aircraftFeatures.current.get(focusTail)?.getGeometry().getCoordinates();
    const focusPosition = mode === 'follow'
      ? focusCoordinates ? toLonLat(focusCoordinates)
        : focusAircraft.current ? estimatedLonLat(focusAircraft.current) : null
      : null;
    const center = focusPosition ? { lon: focusPosition[0], lat: focusPosition[1] } : HOME;
    const radius = mode === 'follow' ? 5 : 2.5;
    const extent = idle ? transformExtent(YJFC_DESTINATION_EXTENT, 'EPSG:4326', 'EPSG:3857')
      : radiusBoundary(center, radius).getExtent();
    ringsSource.current.clear(true);
    if (!idle) ringsSource.current.addFeatures(Array.from({ length: 5 }, (_, index) =>
      new Feature({ geometry: radiusBoundary(center, radius * (index + 1) / 5) })));
    ringCenter.current = !idle ? fromLonLat([center.lon, center.lat]) : null;
    const fit = () => {
      map.updateSize();
      map.getView().fit(extent, { padding: [80, 35, 80, 35], duration: 0 });
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(mapElement.current);
    return () => observer.disconnect();
  }, [isTracking, mode, focusTail]);

  useEffect(() => {
    const source = aircraftSource.current;
    const currentIds = new Set();
    const frameTime = performance.now();
    for (const aircraft of tracking?.visibleAircraft || tracking?.aircraft || []) {
      currentIds.add(aircraft.r);
      let feature = aircraftFeatures.current.get(aircraft.r);
      if (!feature) {
        const motion = updateMotion(null, aircraft, frameTime);
        feature = new Feature({ geometry: new Point(motion.rendered), aircraft, motion });
        aircraftFeatures.current.set(aircraft.r, feature);
        source.addFeature(feature);
      } else {
        updateMotion(feature.get('motion'), aircraft, frameTime);
        feature.set('aircraft', aircraft);
      }
    }
    for (const [id, feature] of aircraftFeatures.current) {
      if (!currentIds.has(id)) {
        source.removeFeature(feature);
        aircraftFeatures.current.delete(id);
      }
    }
  }, [tracking?.aircraft, tracking?.visibleAircraft]);

  return (
    <main className="radar destinations">
      <div ref={mapElement} className="map" tabIndex={0}
        aria-label={isTracking ? `YJFC ${mode} map` : 'Airport destinations map. Use plus and minus to zoom.'} />
      <header className="hud destinations-hud">
        <div>
          <div className="eyebrow">{mode === 'destinations' ? 'YJFC DESTINATIONS' : 'YJFC AIR TRAFFIC'}</div>
          <div className="title">{!isTracking ? 'From KPDK' : mode === 'destinations' ? 'From KPDK'
            : mode === 'home' ? 'KPDK · 2.5 NM' : `${tracking.focus?.r} · 5 NM`}</div>
          {isTracking && <div className="destinations-subtitle">{tracking.status}
            {mode === 'follow' && ' · Switching aircraft every 15 seconds'}</div>}
        </div>
        <div className="destinations-summary">
          <strong>{mode === 'destinations' ? Math.max(0,visits.length - 1) : tracking.aircraft.length}</strong>
          {mode === 'destinations' ? 'airports visited' : 'YJFC aircraft on ADS-B'}
        </div>
      </header>

      {mode === 'destinations' && <aside className="destinations-legend">
        <div><span className="legend-line recent" /> Visited in the last 30 days</div>
        <div><span className="legend-line older" /> Earlier visits</div>
      </aside>}

      {mode === 'destinations' && selected && <aside className="destinations-tooltip" role="tooltip" style={tooltipPosition}>
        <strong>{selected.icao || selected.siteId || 'Airport'}</strong>
        <span>{selected.icao?.toUpperCase() === HOME.icao ? 'Home base' : `${selected.visitCount} ${selected.visitCount === 1 ? 'visit' : 'visits'}`}</span>
        {selected.icao?.toUpperCase() !== HOME.icao && selected.lastVisitedAt && <span>Last seen {formatVisitDate(selected.lastVisitedAt)}</span>}
      </aside>}

      <footer className="footer destinations-footer">
        <span>KPDK · 33.8760° N / 84.3020° W</span>
        {error && <span className="error">{error}</span>}
      </footer>
    </main>
  );
}
