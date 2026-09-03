import { useEffect, useMemo, useRef, useState } from 'react';
import OLMap from 'ol/Map.js'; 
import View from 'ol/View.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import LineString from 'ol/geom/LineString.js';
import CircleGeom from 'ol/geom/Circle.js';
import { fromLonLat } from 'ol/proj.js';
import Style from 'ol/style/Style.js';
import Stroke from 'ol/style/Stroke.js';
import Fill from 'ol/style/Fill.js';
import CircleStyle from 'ol/style/Circle.js';
import Text from 'ol/style/Text.js';
import { apply } from 'ol-mapbox-style';
import 'ol/ol.css';
import './style.css';

const DEFAULT_CONFIG = {
  center: [-84.3880, 33.7490], // [Longitude, Latitude] - Default: Atlanta
  radiusStepNm: 2,
  source: 'both', // 'local', 'aggregator', or 'both'
  localRefreshMs: 500,
  aggregatorRefreshMs: 15000,
  localUrl: 'https://adsb-radar.duckdns.org:8443/api/aircraft',
  hideStationary: true,
  staleTimeoutSecs: 30,
  highlightedTails: ['N885GT', 'N161GT', 'N314GT', 'N98714'],
  normalColor: '#d9e7ff',     // Aggregator-only aircraft color
  localColor: '#33ccff',      // Local Pi / Both aircraft color (Blue)
  highlightColor: '#ffb84d',  // Highlighted tail color (Gold)
  militaryColor: '#ff4d4d',   // Military aircraft (Red)
  ringColor: 'rgba(135, 180, 255, 0.38)',
  ringWidth: 1
};

const NM_TO_M = 1852;

const CATEGORY_MAP = {
  'A1': 'Light Aircraft',
  'A2': 'Small Aircraft',
  'A3': 'Large Aircraft',
  'A4': 'High-Vortex Heavy',
  'A5': 'Heavy Jet',
  'A6': 'High Performance',
  'A7': 'Helicopter',
  'B1': 'Glider',
  'B2': 'Lighter-than-Air',
  'B6': 'UAV / Drone'
};

function parseType(raw) {
  if (raw.aircraft_type) {
    const val = String(raw.aircraft_type).trim();
    if (val && !/^(adsb|adsb_icao|icao|tis_b|nan|null|undefined|tisb_other)$/i.test(val)) {
      return val;
    }
  }

  const candidates = [raw.t, raw.desc, raw.type];
  for (const val of candidates) {
    if (!val || typeof val !== 'string') continue;
    const str = val.trim();
    if (!str || /^(adsb|adsb_icao|icao|tis_b|nan|null|undefined|tisb_other)$/i.test(str)) continue;
    return str;
  }

  if (raw.category && CATEGORY_MAP[raw.category]) {
    return CATEGORY_MAP[raw.category];
  }

  return ''; // Return empty string so no type text renders
}

function normalizeAircraft(raw, nowSecs) {
  const list = Array.isArray(raw) ? raw : (raw.aircraft || raw.ac || []);
  return list.map(a => {
    let seen = Number(a.seen_pos ?? a.seen ?? 0);
    
    if (seen > 1000000000) {
      seen = Math.max(0, nowSecs - seen);
    }

    const isMilitary = Boolean(
      a.mil || 
      (typeof a.dbFlags === 'number' && (a.dbFlags & 1) !== 0)
    );

    // 1. Check Callsign -> 2. Check Tail/Registration -> 3. Fallback to Hex ICAO
    const callsign = String(a.flight ?? a.callsign ?? '').trim();
    const tailNumber = String(a.r ?? a.reg ?? a.tail ?? a.registration ?? '').trim();
    const hex = String(a.hex || a.icao || a.icao24 || a.id || '').trim();

    const displayIdent = callsign || tailNumber || hex || `${a.lat}:${a.lon}`;

    // Standardize altitude numerical values vs ground text
    let altVal = a.alt_baro ?? a.altitude ?? a.alt;
    if (altVal === 'ground') {
      altVal = 0;
    } else {
      altVal = Number(altVal);
    }

    return {
      id: String(hex || displayIdent),
      lat: Number(a.lat ?? a.latitude),
      lon: Number(a.lon ?? a.longitude),
      track: Number(a.track ?? a.heading ?? a.true_track ?? 0),
      gs: Number(a.gs ?? a.groundspeed ?? a.velocity ?? 0),
      flight: displayIdent,
      tail: tailNumber,
      type: parseType(a),
      altitude: altVal,
      isMilitary,
      seen
    };
  }).filter(a => Number.isFinite(a.lat) && Number.isFinite(a.lon));
}

async function fetchAircraft(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const nowSecs = Date.now() / 1000;
  return normalizeAircraft(await response.json(), nowSecs);
}

async function fetchLocalAircraft(url) {
  const response = await fetch(url, {
    cache: 'no-store',
    headers: {
      'Bypass-Tunnel-Reminder': 'true'
    }
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const nowSecs = Date.now() / 1000;
  return normalizeAircraft(await response.json(), nowSecs);
}

export function Radar({ cfg }) {
  const mapEl = useRef(null);
  const mapRef = useRef(null);
  const aircraftSourceRef = useRef(new VectorSource());
  const ringSourceRef = useRef(new VectorSource());
  const aircraftFeaturesRef = useRef(new Map()); 
  const aircraftLayerRef = useRef(null);
  const ringLayerRef = useRef(null);
  const hoveredFeatureRef = useRef(null);
  const selectedFeatureRef = useRef(null);

  const [localAircraftMap, setLocalAircraftMap] = useState(new Map());
  const [aggregatorAircraftMap, setAggregatorAircraftMap] = useState(new Map());
  
  const [status, setStatus] = useState('STARTING');
  const [lastUpdate, setLastUpdate] = useState(null);
  const [error, setError] = useState('');

  const highlighted = useMemo(
    () => new Set(cfg.highlightedTails.map(x => x.trim().toUpperCase()).filter(Boolean)),
    [cfg.highlightedTails]
  );

  const aircraft = useMemo(() => {
    const combined = new Map();

    if (cfg.source === 'aggregator' || cfg.source === 'both') {
      aggregatorAircraftMap.forEach((a, id) => combined.set(id, { ...a, isLocal: false }));
    }

    if (cfg.source === 'local' || cfg.source === 'both') {
      localAircraftMap.forEach((a, id) => combined.set(id, { ...a, isLocal: true }));
    }

    return Array.from(combined.values()).filter(a => {
      if (cfg.hideStationary && a.gs <= 25) return false;
      if (cfg.staleTimeoutSecs > 0 && a.seen > cfg.staleTimeoutSecs) return false;
      return true;
    });
  }, [
    localAircraftMap, 
    aggregatorAircraftMap, 
    cfg.source, 
    cfg.hideStationary, 
    cfg.staleTimeoutSecs
  ]);

  useEffect(() => {
    const ringLayer = new VectorLayer({source: ringSourceRef.current});
    const aircraftLayer = new VectorLayer({source: aircraftSourceRef.current});

    ringLayerRef.current = ringLayer;
    aircraftLayerRef.current = aircraftLayer;

    const map = new OLMap({ 
      target: mapEl.current,
      view: new View({
        center: fromLonLat(cfg.center),
        zoom: 11.95
      }),
      controls: [],
      interactions: [] 
    });

    mapRef.current = map;

    apply(map, 'https://tiles.openfreemap.org/styles/dark')
      .then(() => {
        map.addLayer(ringLayer);
        map.addLayer(aircraftLayer);
      })
      .catch(err => {
        console.error(err);
        setError('Could not load OpenFreeMap Dark style.');
      });

    return () => {
      map.setTarget(undefined);
      mapRef.current = null;
      // eslint-disable-next-line react-hooks/exhaustive-deps
      aircraftFeaturesRef.current.clear();
      // eslint-disable-next-line react-hooks/exhaustive-deps
      aircraftSourceRef.current.clear();
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ringSourceRef.current.clear();
    };
  }, [cfg.center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const getFeature = e => map.forEachFeatureAtPixel(e.pixel, f => {
      if (f.get('aircraft')) return f;
    }, {hitTolerance: 8});

    const handlePointerMove = e => {
      const feature = getFeature(e);

      if (hoveredFeatureRef.current !== feature) {
        if (hoveredFeatureRef.current) hoveredFeatureRef.current.set('hovered', false);
        hoveredFeatureRef.current = feature || null;
        if (feature) feature.set('hovered', true);
        map.render();
      }

      map.getTargetElement().style.cursor = feature ? 'pointer' : '';
    };

    const handleClick = e => {
      const feature = getFeature(e);

      if (selectedFeatureRef.current && selectedFeatureRef.current !== feature)
        selectedFeatureRef.current.set('selected', false);

      selectedFeatureRef.current = feature || null;
      if (feature) feature.set('selected', true);

      map.render();
    };

    map.on('pointermove', handlePointerMove);
    map.on('singleclick', handleClick);

    return () => {
      map.un('pointermove', handlePointerMove);
      map.un('singleclick', handleClick);
      hoveredFeatureRef.current = null;
      selectedFeatureRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    map.getView().setCenter(fromLonLat(cfg.center));

    const center = fromLonLat(cfg.center);
    const rings = [];

    for (let i = 1; i <= 5; i++) {
      rings.push(new Feature({
        geometry: new CircleGeom(center, i * cfg.radiusStepNm * NM_TO_M)
      }));
    }

    ringSourceRef.current.clear(true);
    ringSourceRef.current.addFeatures(rings);

    ringLayerRef.current.setStyle(new Style({
      fill: new Fill({color: 'rgba(0,0,0,0)'}),
      stroke: new Stroke({
        color: cfg.ringColor,
        width: cfg.ringWidth
      })
    }));

    map.render();
  }, [cfg.center, cfg.radiusStepNm, cfg.ringColor, cfg.ringWidth]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const center = fromLonLat(cfg.center);
    const maxRadius = 5 * cfg.radiusStepNm * NM_TO_M;
    const outerExtent = new CircleGeom(center, maxRadius).getExtent();

    const scaleMapToFit = () => {
      map.updateSize(); 
      map.getView().fit(outerExtent, {
        padding: [60, 60, 60, 60], 
        duration: 0 
      });
    };

    setTimeout(scaleMapToFit, 50);
    window.addEventListener('resize', scaleMapToFit);
    
    return () => {
      window.removeEventListener('resize', scaleMapToFit);
    };
  }, [cfg.center, cfg.radiusStepNm]);

  useEffect(() => {
    const layer = aircraftLayerRef.current;
    if (!layer) return;

    layer.setStyle(feature => {
      const a = feature.get('aircraft');
      if (!a) return null;

      const isHighlighted = highlighted.has((a.flight || '').toUpperCase()) || 
                            highlighted.has((a.tail || '').toUpperCase());

      let color = cfg.normalColor;
      if (a.isLocal) {
        color = cfg.localColor;
      }
      if (a.isMilitary) {
        color = cfg.militaryColor;
      }
      if (isHighlighted) {
        color = cfg.highlightColor;
      }

      const position = feature.getGeometry().getCoordinates();
      const gs = a.gs || 0;

      // Check for NaN, non-finite, or zero/ground altitude
      const altStr = (Number.isNaN(a.altitude) || !Number.isFinite(a.altitude) || a.altitude === 0)
        ? 'SFC'
        : `${a.altitude.toLocaleString()} FT`;

      const styles = [
        new Style({
          geometry: new Point(position),
          image: new CircleStyle({
            radius: 4,
            fill: new Fill({color}),
            stroke: new Stroke({
              color: '#07111f',
              width: 1.5
            })
          }),
          text: new Text({
            text: a.flight || a.id.slice(-6),
            offsetY: -14,
            font: '600 11px "JetBrains Mono", monospace',
            fill: new Fill({color}),
            stroke: new Stroke({
              color: 'rgba(0,0,0,.75)',
              width: 3
            })
          })
        }),
        ...(feature.get('hovered') || feature.get('selected') ? [new Style({
          geometry: new Point(position),
          text: new Text({
            text: `${altStr}\n${a.type}`,
            offsetY: 28,
            font: '600 11px "JetBrains Mono", monospace',
            fill: new Fill({color}),
            stroke: new Stroke({
              color: 'rgba(0,0,0,.75)',
              width: 3
            })
          })
        })] : [])
      ];

      if (gs > 25) {
        const track = Number.isFinite(a.track) ? a.track : 0;
        const angle = track * Math.PI / 180;
        const velocity = gs * 0.514444;
        const trailLength = Math.max(1800, Math.min(12000, velocity * 25));

        const trailEnd = [
          position[0] - Math.sin(angle) * trailLength,
          position[1] - Math.cos(angle) * trailLength
        ];

        styles.push(
          new Style({
            geometry: new LineString([trailEnd, position]),
            stroke: new Stroke({
              color,
              width: 1.5,
              lineDash: [2, 7]
            })
          })
        );
      }

      return styles;
    });

    mapRef.current?.render();
  }, [highlighted, cfg.normalColor, cfg.localColor, cfg.highlightColor, cfg.militaryColor]);

  useEffect(() => {
    if (cfg.source === 'aggregator') return;
    let alive = true;
    let timer = null;

    async function pollLocal() {
      try {
        const rows = await fetchLocalAircraft(cfg.localUrl);
        if (!alive) return;

        const map = new Map();
        for (const a of rows) map.set(a.id, a);

        setLocalAircraftMap(map);
        setStatus('LIVE');
        setError('');
        setLastUpdate(new Date());
      } catch (err) {
        if (!alive) return;
        console.warn('Local feed warning:', err.message);
        if (cfg.source === 'local') {
          setStatus('ERROR');
          setError(err.message);
        }
      } finally {
        if (alive) timer = setTimeout(pollLocal, cfg.localRefreshMs || 1000);
      }
    }

    pollLocal();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [cfg.source, cfg.localUrl, cfg.localRefreshMs]);

  useEffect(() => {
    if (cfg.source === 'local') return;
    let alive = true;
    let timer = null;

    async function pollAggregator() {
      try {
        const lon = cfg.center[0];
        const lat = cfg.center[1];
        const radius = 20 * cfg.radiusStepNm;
        const aggregatorUrl = `https://adsb-radar.duckdns.org:8443/api/adsb-lol/${lat}/${lon}/${radius}`;

        const rows = await fetchAircraft(aggregatorUrl);
        if (!alive) return;

        const map = new Map();
        for (const a of rows) map.set(a.id, a);

        setAggregatorAircraftMap(map);
        setStatus('LIVE');
        setError('');
        setLastUpdate(new Date());
      } catch (err) {
        if (!alive) return;
        console.error(err);
        if (cfg.source === 'aggregator') {
          setStatus('ERROR');
          setError(err.message);
        }
      } finally {
        if (alive) timer = setTimeout(pollAggregator, cfg.aggregatorRefreshMs || 5000);
      }
    }

    pollAggregator();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [cfg.source, cfg.center, cfg.radiusStepNm, cfg.aggregatorRefreshMs]);

  useEffect(() => {
    const source = aircraftSourceRef.current;
    const featureMap = aircraftFeaturesRef.current;
    const currentIds = new Set();

    for (const a of aircraft) {
      currentIds.add(a.id);

      let feature = featureMap.get(a.id);

      if (!feature) {
        feature = new Feature({
          geometry: new Point(fromLonLat([a.lon, a.lat])),
          aircraft: a
        });

        featureMap.set(a.id, feature);
        source.addFeature(feature);
      } else {
        feature.getGeometry().setCoordinates(
          fromLonLat([a.lon, a.lat])
        );

        feature.set('aircraft', a);
      }
    }

    for (const [id, feature] of featureMap) {
      if (!currentIds.has(id)) {
        source.removeFeature(feature);
        featureMap.delete(id);
      }
    }

    mapRef.current?.render();
  }, [aircraft]);

  return (
    <main className="radar">
      <div ref={mapEl} className="map" />

      <header className="hud">
        <div>
          <div className="eyebrow">ATLANTA AIR TRAFFIC</div>
          <div className="title">ADS-B RADAR VIEW</div>
        </div>

        <div className="metrics">
          <span><b>{aircraft.length}</b> CONTACTS</span>
          <span>
            <i className={status === 'LIVE' ? 'live' : 'bad'} />
            {status}
          </span>
        </div>
      </header>

      <div className="crosshair" />

      <div className="range-labels">
        {[1, 2, 3, 4, 5].map(i => (
          <span key={i}>{i * cfg.radiusStepNm} NM</span>
        ))}
      </div>

      <footer className="footer">
        <span>
          {cfg.center[1].toFixed(4)}°
          {cfg.center[1] >= 0 ? 'N' : 'S'}
          {' / '}
          {Math.abs(cfg.center[0]).toFixed(4)}°
          {cfg.center[0] >= 0 ? 'E' : 'W'}
        </span>

        <span>
          {lastUpdate ? lastUpdate.toLocaleTimeString() : '--:--:--'}
        </span>

        {error && <span className="error">{error}</span>}
      </footer>
    </main>
  );
}

export default function App() {
  const [config, setConfig] = useState(null);

  useEffect(() => {
    fetch('/config.json')
      .then(res => {
        if (!res.ok) throw new Error('config.json not found');
        return res.json();
      })
      .then(data => {
        setConfig({ ...DEFAULT_CONFIG, ...data });
      })
      .catch(err => {
        console.warn('Failed to load config.json, falling back to defaults:', err);
        setConfig(DEFAULT_CONFIG);
      });
  }, []);

  if (!config) return null;

  return <Radar cfg={config} />;
}