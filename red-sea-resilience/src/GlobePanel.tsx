import { useCallback, useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { boundsOf, densify, morphLine, pathNm, pointAt, type LonLat } from './lib/geo';
import { PORTS, ZONE } from './lib/routes';
import { search, type SearchHit, type TinyFishStatus } from './lib/tf';
import { startHandControl, type HandFrame } from './lib/handControl';

/* ---------- map data ---------- */
const LANE_STEP_DEG = 0.6;           // ≈65 km vertices: hugs the Red Sea channel
const ROUTE_LOOP_SECONDS = 190;      // demo passage, not real voyage time
const BLEND_MS = 1400;               // vessel glide after a reroute

const MAPTILER_KEY = (import.meta as any).env?.VITE_MAPLIBRE_KEY as string | undefined;
// Dark basemap so the globe matches the control-room palette.
const MAPTILER_STYLE = (key: string) => `https://api.maptiler.com/maps/dataviz-dark/style.json?key=${key}`;
// Keyless fallback so the globe still renders when the MapTiler key is rejected.
const FALLBACK_STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const SCHEMATIC_STYLE: any = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#05070c' } }],
};

const ZONE_FOCUS = { center: [46, 15] as [number, number], zoom: 3.0, pitch: 38, bearing: 8 };
const GLOBE_CENTER: [number, number] = [44, 20];

/** Zoom that fits the whole sphere inside the card (MapLibre: d = 1024·2ᶻ/π). */
const globeFitZoom = (width: number, height: number) => {
  const diameter = Math.min(height * 1.22, width * 0.8);
  return Math.max(0.15, Math.min(1.2, Math.log2((diameter * Math.PI) / 1024)));
};

const TICKER: Record<string, string> = {
  IDLE: 'Nominal routing · 4 lanes under watch',
  SIMULATING: 'Disruption detected · Bab-el-Mandeb risk zone active',
  ASSESSING: 'Agents assessing the Cape of Good Hope diversion',
  AWAITING_APPROVAL: 'Reroute proposed · awaiting operator approval',
  EXECUTING: 'Applying diversion · re-drawing lanes',
  REROUTED: 'Cape diversion active · lanes updated',
  RESETTING: 'Restoring nominal routing',
};

const VESSEL_COLOR: any = ['match', ['get', 'route'], 'cape', '#E8FF1F', '#ff6b6b'];
const LANE_COLOR: any = ['match', ['get', 'status'], 'rerouted', '#E8FF1F', '#00ffaa'];

const zoneFC = (poly: LonLat[], props: Record<string, unknown> = {}) => ({
  type: 'FeatureCollection' as const,
  features: [{
    type: 'Feature' as const,
    properties: props,
    geometry: { type: 'Polygon' as const, coordinates: [[...poly, poly[0]]] },
  }],
});

const portFC = () => ({
  type: 'FeatureCollection' as const,
  features: PORTS.map(p => ({
    type: 'Feature' as const,
    properties: { id: p.id, name: p.name, kind: p.kind },
    geometry: { type: 'Point' as const, coordinates: p.coord },
  })),
});

const guineaFC = () => ({
  type: 'FeatureCollection' as const,
  features: [{
    type: 'Feature' as const,
    properties: { name: 'Gulf of Guinea piracy watch' },
    geometry: { type: 'Point' as const, coordinates: [3.0, 3.2] },
  }],
});

/* ---------- dash animation frames ---------- */
const GESTURE_LABEL: Record<string, string> = {
  none: 'No hand in view',
  palm: 'Palm · rotate',
  pinch: 'Pinch · zoom',
  fist: 'Fist · reset view',
};

const DASHES: number[][] = [
  [0, 4, 3], [0.5, 4, 2.5], [1, 4, 2], [1.5, 4, 1.5],
  [2, 4, 1], [2.5, 4, 0.5], [3, 4, 0], [3.5, 4, 0],
];

const hashPhase = (value: string) => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) % 997;
  return h / 997;
};

const lerpCoord = (a: LonLat, b: LonLat, k: number): LonLat => {
  let lonA = a[0];
  let lonB = b[0];
  if (lonB - lonA > 180) lonA += 360;
  if (lonA - lonB > 180) lonB += 360;
  return [((lonA + (lonB - lonA) * k + 540) % 360) - 180, a[1] + (b[1] - a[1]) * k];
};

/** Tintable arrow so vessel heading follows the sea route. */
const arrowImage = (): ImageData | null => {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(16, 3);
  g.lineTo(28, 29);
  g.lineTo(16, 23);
  g.lineTo(4, 29);
  g.closePath();
  g.fill();
  return g.getImageData(0, 0, size, size);
};

const advisoryCache = new Map<string, SearchHit[]>();

interface GlobeProps {
  network: any;
  phase: string;
  status: TinyFishStatus;
  evidence?: any[];
  onReady?: () => void;
}

export default function GlobePanel({ network, phase, status, evidence = [], onReady }: GlobeProps) {
  const cardRef = useRef<HTMLElement>(null);
  const holderRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);

  const netRef = useRef(network);
  const phaseRef = useRef(phase);
  const statusRef = useRef(status);
  const evidenceRef = useRef(evidence);
  const onReadyRef = useRef(onReady);

  const readyRef = useRef(false);
  const laneGeom = useRef<Map<string, { src: any; line: LonLat[] }>>(new Map());
  const trackRef = useRef<Map<string, LonLat[]>>(new Map());
  const posRef = useRef<Map<string, LonLat>>(new Map());
  const blendRef = useRef<{ from: Map<string, LonLat>; start: number } | null>(null);
  const morphRef = useRef<{ from: Map<string, LonLat[]>; start: number; dur: number } | null>(null);

  const spinRef = useRef(false);
  const lastInteraction = useRef(0);
  const lastVesselTick = useRef(0);
  const lastTrackTick = useRef(0);
  const lastFlowTick = useRef(0);
  const flowFrame = useRef(0);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const [spin, setSpin] = useState(false);
  const [note, setNote] = useState('Loading globe…');

  const [gestureOn, setGestureOn] = useState(false);
  const [gestureLabel, setGestureLabel] = useState('Waiting for camera');
  const [gestureStatus, setGestureStatus] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const landmarkRef = useRef<HTMLCanvasElement>(null);
  const gestureRef = useRef<{
    prevPalm: { x: number; y: number } | null;
    prevPinch: number | null;
    fistSince: number;
    lastReset: number;
  }>({ prevPalm: null, prevPinch: null, fistSince: 0, lastReset: 0 });

  netRef.current = network;
  phaseRef.current = phase;
  statusRef.current = status;
  evidenceRef.current = evidence;
  onReadyRef.current = onReady;
  spinRef.current = spin;

  /* ---------- geometry cache ---------- */
  const ensureGeometry = useCallback((net: any) => {
    for (const lane of net.lanes ?? []) {
      const cached = laneGeom.current.get(lane.id);
      if (!cached || cached.src !== lane.geometry) {
        laneGeom.current.set(lane.id, {
          src: lane.geometry,
          line: densify(lane.geometry as LonLat[], LANE_STEP_DEG),
        });
      }
    }
  }, []);

  /* ---------- popups ---------- */
  const openPopup = useCallback((lngLat: maplibregl.LngLatLike, content: HTMLElement) => {
    const map = mapRef.current;
    if (!map) return;
    popupRef.current?.remove();
    popupRef.current = new maplibregl.Popup({ closeButton: true, offset: 12, maxWidth: '290px', className: 'mpop-wrap' })
      .setLngLat(lngLat)
      .setDOMContent(content)
      .addTo(map);
  }, []);

  const row = (text: string, cls = '') => {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    return div;
  };

  const liveSources = (el: HTMLElement, key: string, query: string, purpose: string) => {
    const body = row('Checking live advisories…', 'mpop-adv');
    el.appendChild(body);
    if (statusRef.current === 'NOT_CONFIGURED') {
      body.textContent = 'Live advisory feed unavailable — status modelled locally.';
      return;
    }
    const cached = advisoryCache.get(key);
    if (cached) {
      renderHits(body, cached);
      return;
    }
    const ac = new AbortController();
    popupRef.current?.once('close', () => ac.abort());
    search(query, ac.signal, { purpose, recencyMinutes: 20160 })
      .then(hits => {
        const safe = hits.filter(h => /^https?:\/\//i.test(h.url)).slice(0, 3);
        advisoryCache.set(key, safe);
        renderHits(body, safe);
      })
      .catch(() => {
        if (!ac.signal.aborted) body.textContent = 'Advisory lookup failed — showing modelled status.';
      });
  };

  const renderHits = (body: HTMLElement, hits: SearchHit[]) => {
    body.replaceChildren();
    if (!hits.length) {
      body.textContent = 'No current advisory found — status modelled locally.';
      return;
    }
    const cap = row('Live advisories', 'mpop-cap');
    body.appendChild(cap);
    for (const h of hits) {
      const link = document.createElement('a');
      link.href = h.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = h.title || h.url;
      body.appendChild(link);
      if (h.date) body.appendChild(row(h.date, 'mpop-date'));
    }
  };

  const homeView = useCallback(() => {
    const el = holderRef.current;
    return {
      center: GLOBE_CENTER,
      // Globe projection renders the sphere much smaller than the mercator fit
      // formula suggests, so scale the fit up until the sphere fills the card
      // instead of floating in the middle of it.
      zoom: Math.min(2.2, globeFitZoom(el?.clientWidth ?? 1200, el?.clientHeight ?? 480) * 1.85),
      pitch: 12,
      bearing: 0,
    };
  }, []);

  /** Map hand poses onto the globe camera: palm = rotate/tilt, pinch = zoom, fist = reset. */
  const applyGesture = useCallback((frame: HandFrame) => {
    const map = mapRef.current;
    if (!map) return;
    const st = gestureRef.current;
    const now = performance.now();

    if (frame.gesture === 'palm') {
      if (st.prevPalm) {
        const dx = frame.palm.x - st.prevPalm.x;
        const dy = frame.palm.y - st.prevPalm.y;
        if (Math.abs(dx) > 0.003) {
          map.setBearing((map.getBearing() + dx * 150 + 360) % 360);
          lastInteraction.current = now;
        }
        if (Math.abs(dy) > 0.003) {
          map.setPitch(Math.max(0, Math.min(60, map.getPitch() - dy * 110)));
        }
      }
      st.prevPalm = { x: frame.palm.x, y: frame.palm.y };
      st.prevPinch = null;
      st.fistSince = 0;
    } else if (frame.gesture === 'pinch') {
      st.prevPalm = null;
      st.fistSince = 0;
      if (st.prevPinch != null) {
        const delta = (st.prevPinch - frame.pinch) * 9;
        if (Math.abs(delta) > 0.01) {
          map.setZoom(Math.max(0.2, Math.min(7, map.getZoom() + delta)));
          lastInteraction.current = now;
        }
      }
      st.prevPinch = frame.pinch;
    } else if (frame.gesture === 'fist') {
      st.prevPalm = null;
      st.prevPinch = null;
      if (!st.fistSince) st.fistSince = now;
      else if (now - st.fistSince > 900 && now - st.lastReset > 2500) {
        st.lastReset = now;
        st.fistSince = 0;
        map.easeTo({ ...homeView(), duration: 900 });
      }
    } else {
      st.prevPalm = null;
      st.prevPinch = null;
      st.fistSince = 0;
    }
  }, [homeView]);

  /* ---------- camera ---------- */
  useEffect(() => {
    if (!gestureOn) return;
    const video = videoRef.current;
    if (!video) return;

    let session: { stop(): void } | null = null;
    let cancelled = false;
    const draw = (frame: HandFrame) => {
      const canvas = landmarkRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!frame.landmarks.length) return;
      ctx.fillStyle = '#E8FF1F';
      for (const p of frame.landmarks) {
        ctx.beginPath();
        ctx.arc((1 - p.x) * canvas.width, p.y * canvas.height, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    setGestureLabel('Starting…');
    setGestureStatus('Allow camera access');
    startHandControl({
      video,
      onFrame: frame => {
        if (cancelled) return;
        applyGesture(frame);
        setGestureLabel(GESTURE_LABEL[frame.gesture] ?? frame.gesture);
        draw(frame);
      },
      onStatus: setGestureStatus,
    })
      .then(s => {
        if (cancelled) { s.stop(); return; }
        session = s;
        setGestureStatus('Palm to rotate · pinch to zoom · fist to reset');
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        // Keep the panel open so the reason is visible; toggling the hand
        // button retries once the browser permission is granted.
        setGestureLabel('Camera unavailable');
        setGestureStatus(err instanceof Error ? err.message : 'Camera unavailable');
      });

    return () => {
      cancelled = true;
      session?.stop();
      const canvas = landmarkRef.current;
      canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    };
  }, [gestureOn, applyGesture]);

  /* ---------- map lifecycle ---------- */
  useEffect(() => {
    const holderEl = holderRef.current;
    if (!holderEl || mapRef.current) return;

    let disposed = false;
    let map: maplibregl.Map | null = null;
    let readyTimer: number | undefined;
    // The style the map is actually showing, so a fallback to the schematic
    // keeps its background (the sphere) instead of turning invisible.
    let activeStyle: any = null;

    // Probe MapTiler before constructing the map: calling setStyle while a
    // style is loading leaves MapLibre stuck and 'style.load' never fires.
    const preflight = async (): Promise<any> => {
      if (!MAPTILER_KEY) return FALLBACK_STYLE;
      try {
        const r = await fetch(MAPTILER_STYLE(MAPTILER_KEY), { signal: AbortSignal.timeout(5000) });
        return r.ok ? MAPTILER_STYLE(MAPTILER_KEY) : FALLBACK_STYLE;
      } catch {
        return FALLBACK_STYLE;
      }
    };

    const install = (schematic: boolean) => {
      if (!map) return;
      map.setProjection({ type: 'globe' } as any);
      // "Remove the background": the globe floats on the page instead of sitting
      // inside a dark basemap panel. Geography, lanes and overlays stay intact.
      // The schematic style has no geography, so its background *is* the sphere
      // and must stay painted.
      for (const layer of map.getStyle().layers ?? []) {
        if (layer.type === 'background') {
          try {
            map.setPaintProperty(layer.id, 'background-opacity', schematic ? 1 : 0);
            map.setPaintProperty(layer.id, 'background-color', schematic ? '#0a1226' : 'rgba(0,0,0,0)');
          } catch { /* layer type without these props */ }
        }
      }
      try {
        (map as any).setSky?.({
          'sky-color': '#070d1a',
          'horizon-color': '#2a4a7a',
          'fog-color': '#05070c',
          'sky-horizon-blend': 0.7,
          'horizon-fog-blend': 0.6,
          'fog-ground-blend': 0.95,
        });
      } catch { /* older builds: flat map */ }

      if (!map.hasImage('vessel-arrow')) {
        const img = arrowImage();
        if (img) { try { map.addImage('vessel-arrow', img, { sdf: true }); } catch { /* unsupported */ } }
      }

      if (!map.getSource('zone')) {
        map.addSource('zone', { type: 'geojson', data: zoneFC(ZONE) as any });
        map.addLayer({ id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': '#ff6b6b', 'fill-opacity': 0.1 } });
        map.addLayer({
          id: 'zone-line', type: 'line', source: 'zone',
          paint: { 'line-color': '#ff6b6b', 'line-width': 1.3, 'line-opacity': 0.6, 'line-dasharray': [3, 3] },
        });
      }

      if (!map.getSource('guinea')) {
        map.addSource('guinea', { type: 'geojson', data: guineaFC() as any });
        map.addLayer({
          id: 'guinea-halo', type: 'circle', source: 'guinea',
          paint: { 'circle-radius': 16, 'circle-color': '#ffb347', 'circle-opacity': 0.14 },
        });
        map.addLayer({
          id: 'guinea-dot', type: 'circle', source: 'guinea',
          paint: { 'circle-radius': 3.5, 'circle-color': '#ffb347', 'circle-stroke-color': '#1a1207', 'circle-stroke-width': 1 },
        });
      }

      if (!map.getSource('lanes')) {
        map.addSource('lanes', { type: 'geojson', data: laneFC(netRef.current, laneGeom.current) as any });
        map.addLayer({
          id: 'lanes-glow', type: 'line', source: 'lanes',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': LANE_COLOR, 'line-width': 9, 'line-opacity': 0.14, 'line-blur': 5 },
        });
        map.addLayer({
          id: 'lanes', type: 'line', source: 'lanes',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': LANE_COLOR, 'line-width': 2, 'line-opacity': 0.95 },
        });
        // Direction-of-travel pulse. Animated via line-dasharray offsets.
        map.addLayer({
          id: 'lanes-flow', type: 'line', source: 'lanes',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: {
            'line-color': ['match', ['get', 'status'], 'rerouted', '#E8FF1F', '#ffffff'],
            'line-width': 2.2,
            'line-opacity': 0.55,
            'line-dasharray': DASHES[0],
          },
        });
      }

      if (!map.getSource('tracks')) {
        map.addSource('tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } as any });
        map.addLayer({
          id: 'tracks', type: 'line', source: 'tracks',
          layout: { 'line-join': 'round', 'line-cap': 'round' },
          paint: { 'line-color': VESSEL_COLOR, 'line-width': 1.6, 'line-opacity': 0.45 },
        });
      }

      if (!map.getSource('ports')) {
        map.addSource('ports', { type: 'geojson', data: portFC() as any });
        map.addLayer({
          id: 'ports', type: 'circle', source: 'ports',
          paint: {
            'circle-radius': ['match', ['get', 'kind'], 'transit', 2.6, 2.8],
            'circle-color': ['match', ['get', 'kind'], 'transit', '#93a9bd', '#c3d3e2'],
            'circle-stroke-color': '#0b1018',
            'circle-stroke-width': 1,
          },
        });
        map.addLayer({
          id: 'port-labels', type: 'symbol', source: 'ports',
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 9.5,
            'text-offset': [0, 1.1],
            'text-anchor': 'top',
            'text-allow-overlap': false,
            'text-ignore-placement': false,
          },
          paint: { 'text-color': 'rgba(203,218,233,.72)', 'text-halo-color': '#05070c', 'text-halo-width': 1.2 },
        });
      }

      if (!map.getSource('vessels')) {
        map.addSource('vessels', { type: 'geojson', data: vesselFC(netRef.current, laneGeom.current, performance.now(), null, posRef.current) as any });
        map.addLayer({
          id: 'vessels-halo', type: 'circle', source: 'vessels',
          paint: { 'circle-color': VESSEL_COLOR, 'circle-radius': 11, 'circle-opacity': 0.16 },
        });
        map.addLayer({
          id: 'vessels', type: 'circle', source: 'vessels',
          paint: {
            'circle-color': VESSEL_COLOR,
            'circle-radius': 4.4,
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': 1.3,
          },
        });
        map.addLayer({
          id: 'vessels-arrow', type: 'symbol', source: 'vessels',
          layout: {
            'icon-image': 'vessel-arrow',
            'icon-size': 0.52,
            'icon-rotate': ['get', 'bearing'],
            'icon-rotation-alignment': 'map',
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
          paint: { 'icon-color': VESSEL_COLOR, 'icon-halo-color': '#05070c', 'icon-halo-width': 1 },
        });
        map.addLayer({
          id: 'vessel-labels', type: 'symbol', source: 'vessels', minzoom: 1.15,
          layout: {
            'text-field': ['get', 'name'],
            'text-size': 9.5,
            'text-offset': [0, 1.4],
            'text-anchor': 'top',
            'text-allow-overlap': false,
          },
          paint: { 'text-color': '#e8f2ff', 'text-halo-color': '#05070c', 'text-halo-width': 1.3 },
        });
      }

      // Zone visibility is state-driven, not style-driven.
      const zoneOn = phaseRef.current !== 'IDLE' && phaseRef.current !== 'RESETTING';
      for (const id of ['zone-fill', 'zone-line']) {
        if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', zoneOn ? 'visible' : 'none');
      }
    };

    const markReady = () => {
      if (readyRef.current) return;
      readyRef.current = true;
      window.clearTimeout(readyTimer);
      onReadyRef.current?.();
    };

    const create = (style: any) => {
      if (disposed) return;
      try {
        map = new maplibregl.Map({
          container: holderEl,
          style,
          center: [57, 17],
          zoom: 0.75,
          pitch: 0,
          bearing: 0,
          maxPitch: 85,
          dragRotate: true,
          pitchWithRotate: true,
          touchPitch: true,
          canvasContextAttributes: { antialias: true, alpha: true },
          attributionControl: { compact: true },
        });
      } catch {
        setNote('WebGL unavailable — schematic only');
        return;
      }

      mapRef.current = map;
      if (import.meta.env.DEV) (window as any).__globeMap = map;

      // The card is laid out after the lazy chunk mounts (and media queries can
      // change it), so MapLibre can boot against a stale box and never paint.
      // Re-measure a few times instead of trusting the first layout pass.
      for (const ms of [0, 160, 700]) {
        window.setTimeout(() => {
          if (disposed || !map) return;
          map.resize();
          if (!readyRef.current) map.triggerRepaint();
        }, ms);
      }
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

      const markInteraction = () => { lastInteraction.current = performance.now(); };
      map.on('mousedown', markInteraction);
      map.on('touchstart', markInteraction);
      map.on('wheel', markInteraction);
      map.on('dragstart', markInteraction);
      map.on('rotatestart', markInteraction);

      map.on('click', 'vessels', (ev: any) => {
        const p = ev.features?.[0]?.properties ?? {};
        const el = document.createElement('div');
        el.className = 'mpop';
        const h = document.createElement('b');
        h.textContent = p.name ?? p.id ?? 'Vessel';
        el.appendChild(h);
        el.appendChild(row(p.cargo ?? 'Cold-chain cargo'));
        el.appendChild(row(`${p.lane ?? ''} · ${p.route === 'cape' ? 'Cape diversion' : 'Suez routing'}`));
        el.appendChild(row(`ETA ${p.eta ?? '—'} · 2–8 °C reefer`, 'mpop-mono'));
        const [lon, lat] = ev.features[0].geometry.coordinates;
        el.appendChild(row(`Position ${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(2)}°${lon >= 0 ? 'E' : 'W'}`, 'mpop-mono'));
        el.appendChild(row('AIS position simulated for this demo', 'mpop-note'));
        openPopup(ev.lngLat, el);
      });

      map.on('click', 'lanes', (ev: any) => {
        const p = ev.features?.[0]?.properties ?? {};
        const el = document.createElement('div');
        el.className = 'mpop';
        const h = document.createElement('b');
        h.textContent = p.name ?? 'Lane';
        el.appendChild(h);
        el.appendChild(row(p.status === 'rerouted' ? 'Cape of Good Hope diversion' : 'Suez Canal routing'));
        el.appendChild(row(`${Number(p.nm ?? 0).toLocaleString()} nm · ${(Number(p.nm ?? 0) / (14 * 24)).toFixed(1)} days at 14 kn`, 'mpop-mono'));
        openPopup(ev.lngLat, el);
      });

      map.on('click', 'ports', (ev: any) => {
        const p = ev.features?.[0]?.properties ?? {};
        const el = document.createElement('div');
        el.className = 'mpop';
        const h = document.createElement('b');
        h.textContent = p.name ?? 'Port';
        el.appendChild(h);
        el.appendChild(row(p.kind === 'transit' ? 'Transit chokepoint' : p.kind === 'origin' ? 'Load port' : 'Discharge port', 'mpop-mono'));
        liveSources(el, `port:${p.name}`, `${p.name} port congestion strike delay`, `Find current congestion, strike and berth delays at ${p.name}`);
        openPopup(ev.lngLat, el);
      });

      map.on('click', 'zone-fill', (ev: any) => {
        const el = document.createElement('div');
        el.className = 'mpop';
        const h = document.createElement('b');
        h.textContent = 'Bab-el-Mandeb risk zone';
        el.appendChild(h);
        el.appendChild(row('Southern Red Sea / Gulf of Aden transit corridor'));
        el.appendChild(row('Active while the disruption scenario is running', 'mpop-mono'));
        const latest = evidenceRef.current?.[0];
        if (latest?.sourceUrl) {
          const a = document.createElement('a');
          a.href = latest.sourceUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = latest.title || 'Latest advisory';
          el.appendChild(row('Latest advisory', 'mpop-cap'));
          el.appendChild(a);
        }
        openPopup(ev.lngLat, el);
      });

      map.on('click', 'guinea-dot', (ev: any) => {
        const el = document.createElement('div');
        el.className = 'mpop';
        const h = document.createElement('b');
        h.textContent = 'Gulf of Guinea piracy watch';
        el.appendChild(h);
        el.appendChild(row('Cape diversions pass this piracy high-risk area'));
        liveSources(el, 'guinea', 'Gulf of Guinea piracy attack advisory', 'Find recent Gulf of Guinea piracy advisories relevant to Cape diversions');
        openPopup(ev.lngLat, el);
      });

      for (const layer of ['vessels', 'vessels-arrow', 'lanes', 'ports', 'zone-fill', 'guinea-dot']) {
        map.on('mouseenter', layer, () => { if (map) map.getCanvas().style.cursor = 'pointer'; });
        map.on('mouseleave', layer, () => { if (map) map.getCanvas().style.cursor = ''; });
      }

      let fellBackToSchematic = false;
      map.on('error', () => {
        if (!map || map.isStyleLoaded() || fellBackToSchematic) return;
        fellBackToSchematic = true;
        setNote('Basemap unavailable — schematic view');
        window.setTimeout(() => {
          if (!disposed && map && !map.isStyleLoaded()) {
            activeStyle = SCHEMATIC_STYLE;
            map.setStyle(SCHEMATIC_STYLE);
          }
        }, 1200);
      });

      map.on('style.load', () => {
        if (!map) return;
        setNote(activeStyle === SCHEMATIC_STYLE ? 'Schematic view — basemap unavailable' : '');
        install(activeStyle === SCHEMATIC_STYLE);

        const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        const home = homeView();
        map.jumpTo({ ...home, zoom: home.zoom * 0.7 });
        if (!reduce) map.easeTo({ ...home, duration: 2300, essential: true });
        else map.jumpTo(home as any);
        markReady();
      });
    };

    void (async () => {
      const style = await preflight();
      if (disposed) return;
      activeStyle = style;
      create(style);
      readyTimer = window.setTimeout(() => {
        if (!readyRef.current && map?.getCanvas()) {
          setNote(n => n || 'Basemap loading — lanes only');
          markReady();
        }
      }, 9000);
    })();

    const resize = () => {
      const m = mapRef.current;
      if (!m) return;
      m.resize();
      // The sphere's diameter is derived from the card size, so a phone rotated
      // or a split-screen drag leaves the globe framed for the old box. Re-home
      // it unless the operator just moved the camera themselves.
      if (performance.now() - lastInteraction.current > 30_000) {
        m.easeTo({ ...homeView(), duration: 600 });
      }
    };
    window.addEventListener('resize', resize);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    ro?.observe(holderEl);
    const onFs = () => window.setTimeout(resize, 60);
    document.addEventListener('fullscreenchange', onFs);

    return () => {
      disposed = true;
      window.clearTimeout(readyTimer);
      window.removeEventListener('resize', resize);
      document.removeEventListener('fullscreenchange', onFs);
      ro?.disconnect();
      popupRef.current?.remove();
      map?.remove();
      mapRef.current = null;
    };
  }, [openPopup, homeView]);

  /* ---------- routes + vessels animation ---------- */
  useEffect(() => {
    const previous = new Map(laneGeom.current);
    ensureGeometry(network);

    const changed = (network.lanes ?? []).filter(
      (lane: any) => previous.get(lane.id)?.src !== lane.geometry,
    );

    const map = mapRef.current;
    if (!map) return;
    const src = map.getSource('lanes') as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    const now = performance.now();
    src.setData(laneFC(network, laneGeom.current) as any);
    blendRef.current = posRef.current.size ? { from: new Map(posRef.current), start: now } : null;

    // Draw the route change instead of snapping a new line onto the globe.
    const from = new Map<string, LonLat[]>();
    for (const lane of changed) {
      const line = previous.get(lane.id)?.line;
      if (line) from.set(lane.id, line);
    }
    morphRef.current = from.size ? { from, start: now, dur: BLEND_MS } : null;
  }, [network, ensureGeometry]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (phase === 'SIMULATING' || phase === 'ASSESSING') {
      map.flyTo({ ...ZONE_FOCUS, duration: 1600, essential: true });
    } else if (phase === 'REROUTED') {
      const lines = network.lanes
        .filter((l: any) => l.status === 'rerouted')
        .map((l: any) => densify(l.geometry as LonLat[], 2));
      if (lines.length) map.fitBounds(boundsOf(lines), { padding: 64, duration: 1800, pitch: 18 });
    } else if (phase === 'IDLE') {
      map.easeTo({ ...homeView(), duration: 1400 });
    }
  }, [phase, network, homeView]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const on = phase !== 'IDLE' && phase !== 'RESETTING';
    for (const id of ['zone-fill', 'zone-line']) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  }, [phase]);

  /* ---------- live loop ---------- */
  useEffect(() => {
    let raf = 0;
    let last = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const map = mapRef.current;
      if (!map || !map.isStyleLoaded()) { last = now; return; }
      const net = netRef.current;

      // Auto-rotate, paused whenever the operator is driving the camera.
      if (spinRef.current && !document.hidden) {
        const idle = now - lastInteraction.current > 2500;
        if (idle && !map.isMoving()) {
          map.setBearing((map.getBearing() + 0.045) % 360);
        }
      }

      if (blendRef.current && now - blendRef.current.start > BLEND_MS) blendRef.current = null;

      if (now - lastVesselTick.current >= 50) {
        lastVesselTick.current = now;
        const src = map.getSource('vessels') as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(vesselFC(net, laneGeom.current, now, blendRef.current, posRef.current) as any);
      }

      // Route-change animation: swing the lane geometry around the Cape.
      const morph = morphRef.current;
      if (morph) {
        const k = Math.min(1, (now - morph.start) / morph.dur);
        const src = map.getSource('lanes') as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(laneFC(net, laneGeom.current, morph.from, k) as any);
        if (k >= 1) morphRef.current = null;
      }

      if (now - lastTrackTick.current >= 700) {
        lastTrackTick.current = now;
        recordTracks(net, posRef.current, trackRef.current);
        const tracks = map.getSource('tracks') as maplibregl.GeoJSONSource | undefined;
        if (tracks) tracks.setData(tracksFC(net, trackRef.current) as any);
      }

      if (now - lastFlowTick.current >= 110) {
        lastFlowTick.current = now;
        const id = 'lanes-flow';
        if (map.getLayer(id)) {
          flowFrame.current = (flowFrame.current + 1) % DASHES.length;
          map.setPaintProperty(id, 'line-dasharray', DASHES[flowFrame.current]);
        }
        if (map.getLayer('zone-fill')) {
          const pulse = 0.07 + 0.06 * Math.abs(Math.sin(now / 1100));
          map.setPaintProperty('zone-fill', 'fill-opacity', pulse);
        }
      }

      if (badgeRef.current && now - last >= 1000) {
        last = now;
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        badgeRef.current.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* ---------- controls ---------- */
  const home = () => mapRef.current?.easeTo({ ...homeView(), duration: 1200 });
  const focusZone = () => mapRef.current?.flyTo({ ...ZONE_FOCUS, duration: 1400 });
  const fullscreen = () => {
    const card = cardRef.current;
    if (!card) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void card.requestFullscreen?.();
  };

  const tickerText = TICKER[phase] ?? TICKER.IDLE;

  return (
    <section className="card mapcard" ref={cardRef}>
      <div ref={holderRef} className="map" />

      <div className="mapmeta">
        <div className="mapbadge mono">Demo fleet · AIS simulated</div>
        <div className={`mapfeed mono ${status === 'CONNECTED' ? 'live' : ''}`}>
          {status === 'CONNECTED' ? 'Advisory feed live' : status === 'NOT_CONFIGURED' ? 'Local fallback' : 'Advisory feed degraded'}
          <span ref={badgeRef} className="mapclock">--:--:--Z</span>
        </div>
      </div>

      <div className="mapctl">
        <button onClick={home} title="Reset globe view" aria-label="Reset globe view">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c3.2 3.2 3.2 13.8 0 17M12 3.5c-3.2 3.2-3.2 13.8 0 17" /></svg>
        </button>
        <button onClick={focusZone} title="Focus the risk zone" aria-label="Focus the risk zone">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="12" cy="12" r="5" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>
        </button>
        <button className={spin ? 'on' : ''} onClick={() => setSpin(s => !s)} title="Auto-rotate globe" aria-label="Auto-rotate globe">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M20 12a8 8 0 1 1-2.4-5.7" /><path d="M20 4.5V9h-4.5" /></svg>
        </button>
        <button onClick={fullscreen} title="Fullscreen" aria-label="Fullscreen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M9 3H3v6M15 3h6v6M9 21H3v-6M15 21h6v-6" /></svg>
        </button>
        <button
          className={gestureOn ? 'on' : ''}
          onClick={() => { setGestureOn(v => !v); setSpin(false); }}
          title="Hand-gesture control"
          aria-label="Hand-gesture control"
          aria-pressed={gestureOn}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7.5 11.5V6.8a1.4 1.4 0 0 1 2.8 0v4.2" />
            <path d="M10.3 11V5.4a1.4 1.4 0 0 1 2.8 0V11" />
            <path d="M13.1 11V6.6a1.4 1.4 0 0 1 2.8 0V11" />
            <path d="M15.9 11.3V9.1a1.4 1.4 0 0 1 2.8 0v5.2a6 6 0 0 1-6 6h-1.2a4 4 0 0 1-3.2-1.6l-2.6-3.5a1.5 1.5 0 0 1 2.4-1.8l1.5 1.9" />
          </svg>
        </button>
      </div>

      {gestureOn && (
        <div className="gesturepanel">
          <div className="gview">
            <video ref={videoRef} playsInline muted autoPlay />
            <canvas ref={landmarkRef} width={180} height={135} aria-hidden="true" />
            <button className="gstop" onClick={() => setGestureOn(false)} aria-label="Stop hand control">✕</button>
          </div>
          <div className="ghud mono">
            <b>{gestureLabel}</b>
            <span>{gestureStatus}</span>
          </div>
          <div className="gtips mono">Palm → rotate · Pinch → zoom · Fist → reset</div>
        </div>
      )}

      {note && <div className="mapnote mono">{note}</div>}

      <div className={`mapticker mono${phase === 'IDLE' ? ' soft' : ''}`}>
        <i className={phase === 'IDLE' ? '' : 'pulse'} />
        {tickerText}
      </div>

      <div className="maplegend mono">
        <span><i className="lg-suez" /> Suez lane</span>
        <span><i className="lg-cape" /> Cape diversion</span>
        <span><i className="lg-zone" /> Risk zone</span>
      </div>

      <div className="rim" />
    </section>
  );
}

/* ---------- feature collections ---------- */
type GeomCache = Map<string, { src: any; line: LonLat[] }>;

const lineFor = (lane: any, cache: GeomCache): LonLat[] => {
  const entry = cache.get(lane.id);
  return entry && entry.src === lane.geometry
    ? entry.line
    : densify(lane.geometry as LonLat[], LANE_STEP_DEG);
};

/** MapLibre draws a line from 180° to −180° the long way round, so split it. */
const splitAntimeridian = (coords: LonLat[]): LonLat[][] => {
  const parts: LonLat[][] = [];
  let current: LonLat[] = [];
  for (const point of coords) {
    const prev = current[current.length - 1];
    if (prev && Math.abs(point[0] - prev[0]) > 180) {
      if (current.length > 1) parts.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 1) parts.push(current);
  return parts;
};

function laneFC(net: any, cache: GeomCache, from?: Map<string, LonLat[]>, k = 1) {
  const features = (net.lanes ?? []).flatMap((lane: any) => {
    const target = lineFor(lane, cache);
    const start = from?.get(lane.id);
    const coordinates = start && k < 1 ? morphLine(start, target, k) : target;
    const nm = Math.round(pathNm(coordinates));
    return splitAntimeridian(coordinates).map((part, partIndex) => ({
      type: 'Feature' as const,
      properties: {
        id: lane.id,
        name: lane.name,
        status: lane.status,
        part: partIndex,
        nm,
      },
      geometry: { type: 'LineString' as const, coordinates: part },
    }));
  });
  return { type: 'FeatureCollection' as const, features };
}

function vesselFC(
  net: any,
  cache: GeomCache,
  tMs: number,
  blend: { from: Map<string, LonLat>; start: number } | null,
  positions: Map<string, LonLat>,
) {
  const features: any[] = [];
  const glide = blend ? Math.min(1, (tMs - blend.start) / BLEND_MS) : 1;

  const vessels = net.vessels ?? [];
  for (let index = 0; index < vessels.length; index++) {
    const v = vessels[index];
    const lane = (net.lanes ?? []).find((l: any) => l.id === v.laneId);
    if (!lane) continue;
    const line = lineFor(lane, cache);
    const speed = 0.82 + hashPhase(v.id) * 0.5;      // demo speed variation
    // Spread the fleet along its routes instead of bunching every ship at port.
    const offset = 0.1 + index * 0.23 + hashPhase(v.id) * 0.06;
    const cycle = ((tMs / 1000 / (ROUTE_LOOP_SECONDS * speed)) + offset) % 1.14;
    const t = Math.min(1, cycle);
    const { coord, bearing } = pointAt(line, t);

    // Glide from the pre-reroute position so a diversion does not teleport ships.
    const from = blend?.from.get(v.id);
    const shown = from && glide < 1 ? lerpCoord(from, coord, glide) : coord;
    positions.set(v.id, shown);

    features.push({
      type: 'Feature',
      properties: {
        id: v.id,
        name: v.id,
        route: v.route,
        cargo: v.cargo,
        lane: lane.name,
        bearing,
        eta: v.route === 'cape' ? `+${Number(v.extraDays ?? 0).toFixed(1)}d` : `${v.remainingDays}d`,
      },
      geometry: { type: 'Point', coordinates: shown },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** Append the latest simulated AIS positions to a short trail, skipping jumps. */
function recordTracks(net: any, positions: Map<string, LonLat>, tracks: Map<string, LonLat[]>) {
  for (const v of net.vessels ?? []) {
    const pos = positions.get(v.id);
    if (!pos) continue;
    const hist = tracks.get(v.id) ?? [];
    const prev = hist[hist.length - 1];
    if (prev) {
      const d = Math.abs(prev[0] - pos[0]) + Math.abs(prev[1] - pos[1]);
      if (d > 6) hist.length = 0;
      else if (d < 0.004) { tracks.set(v.id, hist); continue; }
    }
    hist.push(pos);
    if (hist.length > 18) hist.shift();
    tracks.set(v.id, hist);
  }
}

function tracksFC(net: any, tracks: Map<string, LonLat[]>) {
  const features: any[] = [];
  for (const v of net.vessels ?? []) {
    const hist = tracks.get(v.id);
    if (!hist || hist.length < 2) continue;
    features.push({
      type: 'Feature',
      properties: { route: v.route },
      geometry: { type: 'LineString', coordinates: hist },
    });
  }
  return { type: 'FeatureCollection', features };
}
