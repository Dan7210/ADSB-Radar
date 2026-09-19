import { useEffect, useState } from 'react';
import YJFCDestinations from './YJFCDestinations.jsx';
import { activeAircraft, API, viewMode } from './yjfcTracking.js';

export default function YJFCMap() {
  const [feed, setFeed] = useState({ ac: [] });
  const [now, setNow] = useState(Date.now);
  const [, setError] = useState('');
  const [focusedTail, setFocusedTail] = useState(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let active = true;
    let timer;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`${API}/yjfc-aircraft`, {
          cache: 'no-store', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]),
        });
        if (!response.ok) throw new Error(`YJFC feed unavailable (${response.status})`);
        const data = await response.json();
        if (!Array.isArray(data.ac) || (data.fetchedAt !== null && !Number.isFinite(Date.parse(data.fetchedAt)))) throw new Error('Invalid YJFC feed');
        if (active) { setFeed(data); setError(''); }
      } catch (failure) {
        if (active) setError(failure.message);
      } finally {
        if (active) timer = setTimeout(poll, 15000);
      }
    }
    poll();
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, []);
  const aircraft = activeAircraft(feed, now);
  const mode = viewMode(aircraft);
  const tailKey = aircraft.map(a => a.r).join(',');
  const focus = aircraft.find(a => a.r === focusedTail) || aircraft[0];
  useEffect(() => {
    if (mode !== 'follow') return;
    const tails = tailKey.split(',');
    const timer = setInterval(() => setFocusedTail(current => {
      const index = Math.max(0, tails.indexOf(current));
      return tails[(index + 1) % tails.length];
    }), 15000);
    return () => clearInterval(timer);
  }, [mode, tailKey]);
  return <YJFCDestinations tracking={{ mode, aircraft, focus, status: ''}} />;
}
