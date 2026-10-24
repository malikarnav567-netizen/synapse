import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

import { useNet } from './store';
import { deriveStatus, onStatusChange, probe, wallet } from './lib/tf';
import { AGENTS } from './lib/engine';

/* ---------- bento primitives (same language as Finance Bento) ---------- */
const GR: Record<string, string[]> = {
  blue: ['#b9a6ff', '#2e43ff', '#6d7dff', '#05082a'],
  graph: ['#9a9aa8', '#3a3a44', '#55555f', '#060608'],
  pink: ['#ffb3d6', '#ff2a85', '#ff6aa8', '#3a031c'],
  copper: ['#f6bf96', '#c2683a', '#dc8a5c', '#1d0b05'],
  green: ['#a6e8c8', '#36956f', '#58b58c', '#061d15'],
  lime: ['#f4ffb8', '#a3c400', '#c9e03a', '#121700'],
};

type CardProps = {
  id?: string;
  className?: string;
  tone?: string;
  style?: React.CSSProperties;
  children?: React.ReactNode;
};

const Card = ({ id, className = '', tone, style, children }: CardProps) => {
  const c = tone ? GR[tone] : undefined;
  return (
    <section className={`card ${className}${c ? '' : ' glass'}`} id={id} style={style}>
      {c && (
        <>
          <div
            className="g"
            style={{ background: `linear-gradient(180deg,${c[0]} 0%,${c[1]} 36%,${c[1]} 74%,${c[2]} 100%)` }}
          />
          <div className="core" style={{ background: c[3] }} />
        </>
      )}
      <div className="in-c">{children}</div>
      <div className="rim" />
    </section>
  );
};

const F: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '.': ['0', '0', '0', '0', '0', '0', '1'],
  '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
  '-': ['00000', '00000', '00000', '11111', '00000', '00000', '00000'],
  ' ': ['00', '00', '00', '00', '00', '00', '00'],
};

function DotNum({ text, pitch = 7 }: { text: string; pitch?: number }) {
  const cells: number[][] = [];
  let x = 0;
  for (const ch of text) {
    const g = F[ch] || F[' '];
    for (let r = 0; r < 7; r++) for (let k = 0; k < g[0].length; k++) if (g[r][k] === '1') cells.push([x + k, r]);
    x += g[0].length + 1;
  }
  return (
    <svg className="dots" width={Math.max(1, x - 1) * pitch} height={7 * pitch} role="img" aria-label={text}>
      {cells.map(([c, r], i) => (
        <circle key={i} cx={c * pitch + pitch / 2} cy={r * pitch + pitch / 2} r={pitch * 0.36} fill="#fff" />
      ))}
    </svg>
  );
}

function useCount(to: number, dur = 900) {
  const [v, setV] = useState(0);
  const cur = useRef(0);
  useEffect(() => {
    const from = cur.current;
    const t0 = performance.now();
    let id = 0;
    const f = (n: number) => {
      const t = Math.min(1, (n - t0) / dur);
      cur.current = from + (to - from) * (1 - Math.pow(1 - t, 3));
      setV(cur.current);
      if (t < 1) id = requestAnimationFrame(f);
    };
    id = requestAnimationFrame(f);
    return () => cancelAnimationFrame(id);
  }, [to, dur]);
  return v;
}

const Ticks = ({ frac, n = 36 }: { frac: number; n?: number }) => (
  <svg className="ticks" height="22" viewBox={`0 0 ${n * 8} 22`} preserveAspectRatio="none" aria-hidden="true">
    {Array.from({ length: n }, (_, i) => (
      <line
        key={i}
        x1={i * 8 + 2}
        x2={i * 8 + 2}
        y1={i % 6 === 0 ? 2 : 8}
        y2="20"
        stroke={i / (n - 1) <= frac ? '#E8FF1F' : 'rgba(255,255,255,.28)'}
        strokeWidth="1.6"
        strokeLinecap="round"
        style={{ transition: `stroke .2s ${i * 14}ms` }}
      />
    ))}
  </svg>
);

const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);
const SEV: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Critical' };

/* ---------- map ---------- */
const laneCollection = (net: any) => ({
  type: 'FeatureCollection' as const,
  features: net.lanes.map((l: any) => ({
    type: 'Feature' as const,
    properties: { id: l.id, name: l.name, status: l.status },
    geometry: { type: 'LineString' as const, coordinates: l.geometry },
  })),
});

const vesselCollection = (net: any) => ({
  type: 'FeatureCollection' as const,
  features: net.vessels.map((v: any) => {
    const lane = net.lanes.find((l: any) => l.id === v.laneId);
    const g: number[][] = lane?.geometry ?? [[43, 15]];
    const p = g[Math.min(g.length - 1, Math.floor(g.length * 0.6))];
    return {
      type: 'Feature' as const,
      properties: { id: v.id, route: v.route, cargo: v.cargo },
      geometry: { type: 'Point' as const, coordinates: p },
    };
  }),
});

const MAPTILER_KEY = (import.meta as any).env?.VITE_MAPLIBRE_KEY as string | undefined;

function GlobePanel({ network }: { network: any }) {
  const holder = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const netRef = useRef(network);
  const [note, setNote] = useState(MAPTILER_KEY ? 'Loading globe…' : 'No VITE_MAPLIBRE_KEY — showing schematic');

  netRef.current = network;

  useEffect(() => {
    if (!holder.current || mapRef.current) return;

    const style: any = MAPTILER_KEY
      ? `https://api.maptiler.com/maps/basic/style.json?key=${MAPTILER_KEY}`
      : {
          version: 8,
          sources: {},
          layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#05070c' } }],
        };

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container: holder.current,
        style,
        center: [40, 19],
        zoom: 1.55,
        pitch: 28,
        bearing: 0,
        antialias: true,
        attributionControl: { compact: true },
      });
    } catch {
      setNote('WebGL unavailable — schematic only');
      return;
    }

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');

    let failed = false;
    map.on('error', () => {
      if (failed) return;
      failed = true;
      setNote(MAPTILER_KEY ? 'Map tiles unavailable — check VITE_MAPLIBRE_KEY' : 'Schematic only');
    });

    map.on('load', () => {
      setNote('');
      try {
        (map as any).setProjection({ type: 'globe' });
      } catch {
        /* older maplibre builds: flat map */
      }

      map.addSource('lanes', { type: 'geojson', data: laneCollection(netRef.current) as any });
      map.addLayer({
        id: 'lanes-glow',
        type: 'line',
        source: 'lanes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#00ffaa', 'line-width': 7, 'line-opacity': 0.16, 'line-blur': 4 },
      });
      map.addLayer({
        id: 'lanes',
        type: 'line',
        source: 'lanes',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: {
          'line-color': ['match', ['get', 'status'], 'rerouted', '#E8FF1F', '#00ffaa'],
          'line-width': 2,
          'line-opacity': 0.9,
        },
      });

      map.addSource('vessels', { type: 'geojson', data: vesselCollection(netRef.current) as any });
      map.addLayer({
        id: 'vessels',
        type: 'circle',
        source: 'vessels',
        paint: {
          'circle-color': ['match', ['get', 'route'], 'cape', '#E8FF1F', '#ff6b6b'],
          'circle-radius': 4.5,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1,
        },
      });

      // Settle the camera so the globe reads as a sphere inside the card.
      map.easeTo({ pitch: 28, duration: 0 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const lanes = map.getSource('lanes') as maplibregl.GeoJSONSource | undefined;
    const vessels = map.getSource('vessels') as maplibregl.GeoJSONSource | undefined;
    lanes?.setData(laneCollection(network) as any);
    vessels?.setData(vesselCollection(network) as any);
  }, [network]);

  return (
    <section className="card mapcard">
      <div ref={holder} className="map" />
      <div className="mapnote mono">{note}</div>
      <div className="rim" />
    </section>
  );
}

/* ---------- app ---------- */
export default function App() {
  const s = useNet();
  const status = useSyncExternalStore(onStatusChange, deriveStatus);

  const { phase, decision: d, events, network } = s;
  const sum = d?.summary;
  const idle = phase === 'IDLE';

  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState(false);
  const [credits, setCredits] = useState('—');
  const fired = useRef(false);
  const feed = useRef<HTMLDivElement>(null);

  useEffect(() => {
    probe().finally(() => setReady(true));
    const t = setTimeout(() => setShown(true), 30);
    return () => clearTimeout(t);
  }, []);

  // ?simulate fires once, only when ready (no cleanup: StrictMode double-runs effects)
  useEffect(() => {
    if (!ready || fired.current || !location.search.includes('simulate')) return;
    fired.current = true;
    setTimeout(() => useNet.getState().simulate(), 1500);
  }, [ready]);

  useEffect(() => {
    if (!ready || status === 'NOT_CONFIGURED') return;
    wallet()
      .then((w: any) => {
        const v = w?.credits ?? w?.balance ?? w?.remaining ?? w?.credits_remaining;
        if (v != null) setCredits(String(v));
      })
      .catch(() => {});
  }, [ready, status, phase]);

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' });
  }, [events.length]);

  const lanesN = useCount(sum?.lanes ?? 0);
  const vesN = useCount(sum?.vessels ?? 0);
  const dayN = useCount(sum?.extraDays ?? 0);
  const conf = useCount((d?.confidence ?? 0) * 100);

  const evidence = [...(d?.evidence ?? []), ...s.extra].filter((e: any) => e.sourceUrl && e.retrievedAt);
  const label = status === 'CONNECTED' ? 'Live' : status === 'DEGRADED' ? 'Degraded' : status === 'OFFLINE' ? 'Offline' : 'Local fallback';
  const order = AGENTS.map((a: string) => events.some((e: any) => e.agent === a));
  const latest = order.lastIndexOf(true);
  const PH: Record<string, string> = {
    IDLE: 'Ready',
    SIMULATING: 'Starting',
    ASSESSING: 'Assessing',
    AWAITING_APPROVAL: 'Needs approval',
    EXECUTING: 'Applying',
    REROUTED: 'Rerouted',
    RESETTING: 'Resetting',
  };

  return (
    <div className="app">
      <div className={`canvas ${shown ? 'in' : ''}`}>
        <div className="top">
          <h1>
            Red Sea Resilience
            <span>{phase === 'REROUTED' ? 'Reroute applied' : 'Cold-chain disruption control'}</span>
          </h1>
          <div className="ctrls">
            <div className="seg" role="group" aria-label="Actions">
              <button className="pri" disabled={phase !== 'IDLE'} onClick={() => s.simulate()}>
                Simulate disruption
              </button>
              <button className="pri" disabled={phase !== 'AWAITING_APPROVAL'} onClick={() => s.approve()}>
                Approve reroute
              </button>
              <button disabled={idle || phase === 'RESETTING'} onClick={() => s.reset()}>
                Reset
              </button>
            </div>
            <div className="seg">
              <button disabled aria-label="TinyFish status">
                TinyFish: {status.replace('_', ' ')}
              </button>
            </div>
          </div>
        </div>

        <div className="grid">
          <GlobePanel network={network} />

          <Card id="feed" className="h1" tone="blue">
            <div className="row between">
              <div className="ttl">Agent activity</div>
              <span className="chip">{PH[phase]}</span>
            </div>
            <div className="scroll" ref={feed} aria-live="polite">
              {!events.length && (
                <p className="muted pad">Run the simulation to watch the five agents work through the Red Sea closure.</p>
              )}
              {events.map((e: any) => (
                <div className={`ev ${e.level}`} key={e.seq}>
                  <span className="mono t">{e.ts.slice(11, 19)}</span>
                  <span className="ag">{e.agent}</span>
                  <span className="msg">{e.message}</span>
                  {e.source === 'tinyfish' && <span className="chip tfc">TinyFish</span>}
                </div>
              ))}
            </div>
          </Card>

          <Card id="gauge" className="h1" tone="graph">
            <div className="row between">
              <div className="ttl">Confidence</div>
              <span className="chip glasschip">Human approval</span>
            </div>
            <svg className="alg" viewBox="-150 -150 300 168" aria-hidden="true">
              {Array.from({ length: 57 }, (_, i) => {
                const a = ((180 + (i / 56) * 180) * Math.PI) / 180;
                const r2 = i % 7 === 0 ? 112 : 118;
                return (
                  <line
                    key={i}
                    x1={136 * Math.cos(a)}
                    y1={136 * Math.sin(a)}
                    x2={r2 * Math.cos(a)}
                    y2={r2 * Math.sin(a)}
                    stroke={i / 56 <= conf / 100 ? '#E8FF1F' : 'rgba(255,255,255,.3)'}
                    strokeWidth="3.2"
                    strokeLinecap="round"
                  />
                );
              })}
              <text y="-22" textAnchor="middle" fontWeight="200" fontSize="52" fill="#fff" letterSpacing="-2">
                {Math.round(conf)}
                <tspan fontSize="17" dy="-24" fill="rgba(255,255,255,.56)">
                  %
                </tspan>
              </text>
              <text y="0" textAnchor="middle" fontSize="12" fontWeight="500" fill="rgba(255,255,255,.38)">
                {sum?.degraded ? 'modelled' : 'evidence-backed'}
              </text>
            </svg>
            <div className="steps">
              {AGENTS.map((a: string, i: number) => (
                <div className="srow" key={a}>
                  <i className={order[i] ? (i === latest && phase === 'ASSESSING' ? 'on pulse' : 'on') : ''} />
                  <span>{a.replace(' Agent', '')}</span>
                  <span className="muted mono">
                    {order[i] ? (i === latest && phase === 'ASSESSING' ? 'working' : 'done') : '—'}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card id="k1" className="h2 kpi" tone="lime">
            <div className="cap dark">Lanes at risk</div>
            <div className="kv">
              <DotNum text={String(Math.round(lanesN))} pitch={6} />
            </div>
            <div className="muted dark foot">of {network.lanes.length} lanes</div>
          </Card>

          <Card id="k2" className="h2 kpi">
            <div className="cap">Vessels to reroute</div>
            <div className="kv">
              <DotNum text={String(Math.round(vesN))} pitch={6} />
            </div>
            <div className="muted foot">
              {network.vessels.filter((v: any) => v.route === 'cape').length} already on the Cape route
            </div>
          </Card>

          <Card id="k3" className="h2 kpi">
            <div className="cap">Extra transit</div>
            <div className="kv">
              <DotNum text={'+' + dayN.toFixed(1)} pitch={6} />
              <span className="muted"> days</span>
            </div>
            <div className="muted foot mono">
              {sum ? '+' + Math.round(sum.extraNm).toLocaleString() + ' nm avg' : 'Cape of Good Hope'}
            </div>
          </Card>

          <Card id="k4" className="h2 kpi">
            <div className="row between">
              <div className="cap">Cold-chain slack</div>
              {sum && <span className={`chip risk-${sum.risk}`}>{sum.risk}</span>}
            </div>
            <div className="kv">
              <span className="big mono">{sum ? sum.slackDays.toFixed(1) : '—'}</span>
              <span className="muted"> days</span>
            </div>
            <Ticks frac={sum ? Math.max(0, Math.min(1, sum.slackDays / 10)) : 0} />
          </Card>

          <Card id="evid" className="h3" tone="pink">
            <div className="row between">
              <div className="ttl">Evidence</div>
              <span className="muted dark2">
                {evidence.length} source{evidence.length === 1 ? '' : 's'}
              </span>
            </div>
            <div className="scroll low">
              {!evidence.length && (
                <p className="muted pad">
                  {d
                    ? 'No external evidence retrieved. This assessment is modelled locally.'
                    : 'Sources appear here with their link and retrieval time.'}
                </p>
              )}
              {evidence.map((e: any) => (
                <article className="evi" key={e.id}>
                  <a href={safeUrl(e.sourceUrl)} target="_blank" rel="noopener noreferrer">
                    {e.title}
                  </a>
                  <div className="mono muted2">
                    {e.provider} · {new Date(e.retrievedAt).toLocaleString()} · {Math.round(e.confidence * 100)}%
                  </div>
                  <p>{e.summary}</p>
                </article>
              ))}
              {s.audits.map((a: any, i: number) => (
                <figure className="aud" key={i}>
                  <img alt={'Audit capture of ' + a.title} src={'data:image/jpeg;base64,' + a.imageBase64} />
                  <figcaption className="mono muted2">Audit capture · {new Date(a.capturedAt).toLocaleString()}</figcaption>
                </figure>
              ))}
            </div>
          </Card>

          <Card id="dec" className="h3" tone="copper">
            <div className="row between">
              <div className="ttl">Recommendation</div>
              {d && <span className="chip">{SEV[d.severity]}</span>}
            </div>
            {!d ? (
              <p className="muted pad">
                {phase === 'ASSESSING' ? 'Agents are still working…' : 'The recommendation appears after the assessment.'}
              </p>
            ) : (
              <>
                <p className="decact">{d.action}</p>
                <p className="decwhy">{d.reasoning}</p>
                <div className="decfoot">
                  <span className="muted mono">Operator approval required</span>
                  <button className="btn" disabled={phase !== 'AWAITING_APPROVAL'} onClick={() => s.approve()}>
                    {phase === 'REROUTED' ? 'Approved' : 'Approve reroute'}
                  </button>
                </div>
              </>
            )}
          </Card>

          <Card id="sys" className="h3" tone="green">
            <div className="row between">
              <div className="ttl">Fleet</div>
              <span className="chip">Demo data</span>
            </div>
            <div className="sysrow">
              <span className="cap">TinyFish</span>
              <span className="mono">{label}</span>
            </div>
            <div className="sysrow">
              <span className="cap">Credits left</span>
              <span className="mono">{credits}</span>
            </div>
            <div className="fleet">
              {network.vessels.map((v: any) => (
                <div key={v.id} className="frow">
                  <div>
                    <b>{v.id}</b>
                    <div className="muted mono">{network.lanes.find((l: any) => l.id === v.laneId)?.name}</div>
                  </div>
                  <span className={`mono ${v.route === 'cape' ? 'cape' : 'muted'}`}>
                    {v.route === 'cape'
                      ? `Cape +${v.extraDays.toFixed(1)}d`
                      : v.rerouteEligible
                        ? 'Suez'
                        : 'Committed'}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
