import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';

import { useNet } from './store';
import { deriveStatus, onStatusChange, probe, wallet } from './lib/tf';
import { AGENTS, ZONE, intersectsZone } from './lib/engine';
import { pathNm, type LonLat } from './lib/geo';
import { budgetSnapshot, onBudgetChange, clearCache, type BudgetSnapshot } from './lib/budget';
import { netSnapshot, onNetChange, type NetSnapshot } from './lib/net';
import { getMode, onModeChange, setMode, type DataMode } from './lib/mode';
import { startTelemetry, useTelemetry } from './lib/telemetry';
// The globe is 1 MB of MapLibre: stream it so the console paints first.
const GlobePanel = lazy(() => import('./GlobePanel'));import CargoPanel from './CargoPanel';
import CasesPanel from './CasesPanel';
import { Card, DotNum, Ticks, useCount, safeUrl, SEV } from './ui';

/* ---------- app ---------- */
export default function App() {
  const s = useNet();
  const [status, setStatus] = useState(deriveStatus);
  const [budget, setBudget] = useState<BudgetSnapshot>(budgetSnapshot);
  const [net, setNet] = useState<NetSnapshot>(netSnapshot);
  const [mode, setModeState] = useState<DataMode>(getMode());
  const summary = useTelemetry(t => t.summary);

  const { phase, decision: d, events, network } = s;
  const sum = d?.summary;
  const idle = phase === 'IDLE';

  const [ready, setReady] = useState(false);
  const [mapReady, setMapReady] = useState(false);
  const [shown, setShown] = useState(false);
  const [credits, setCredits] = useState('—');
  const fired = useRef(false);
  const feed = useRef<HTMLDivElement>(null);
  const handleMapReady = useCallback(() => setMapReady(true), []);
  // Simulations wait for the probe and the first map style so lanes exist first.
  const armed = ready && mapReady;

  useEffect(() => onStatusChange(() => setStatus(deriveStatus())), []);
  useEffect(() => onBudgetChange(() => setBudget(budgetSnapshot())), []);
  useEffect(() => onNetChange(() => setNet(netSnapshot())), []);
  useEffect(() => onModeChange(() => setModeState(getMode())), []);

  useEffect(() => {
    probe().finally(() => setReady(true));
    const t = setTimeout(() => setShown(true), 30);
    return () => clearTimeout(t);
  }, []);

  // Telemetry restarts on a mode change so the first sample already has the
  // right provenance (live request vs seeded dummy) instead of a stale chip.
  useEffect(() => startTelemetry(() => useNet.getState().network), [mode]);

  // ?simulate fires once, only when ready (no cleanup: StrictMode double-runs effects)
  useEffect(() => {
    if (!armed || fired.current || !location.search.includes('simulate')) return;
    fired.current = true;
    setTimeout(() => useNet.getState().simulate(), 1200);
  }, [armed]);

  useEffect(() => {
    if (!ready || status === 'NOT_CONFIGURED' || mode === 'dummy') return;
    wallet()
      .then((w: any) => {
        const v = w?.available_balance ?? w?.credits ?? w?.balance ?? w?.remaining ?? w?.credits_remaining;
        if (v != null) {
          const n = Number(v);
          setCredits(Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v));
        }
      })
      .catch(() => {});
  }, [ready, status, phase, mode]);

  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight, behavior: 'smooth' });
  }, [events.length]);

  const switchMode = (next: DataMode) => {
    if (next === mode) return;
    clearCache();                       // a dummy run must never serve live cache
    setMode(next);
  };

  /* ---------- live network figures (not decision-only) ---------- */
  const riskLanes = (network.lanes as any[]).filter((l: any) => intersectsZone(l.geometry as LonLat[], ZONE));
  const riskIds = new Set(riskLanes.map((l: any) => l.id));
  const eligible = (network.vessels as any[]).filter(v => riskIds.has(v.laneId) && v.rerouteEligible && v.route === 'suez');
  const liveExtraDays = eligible.reduce((m, v: any) => {
    const lane: any = network.lanes.find((l: any) => l.id === v.laneId);
    if (!lane?.alternate) return m;
    const extra = pathNm(lane.alternate) - pathNm(lane.geometry);
    return Math.max(m, extra / (14 * 24));
  }, 0);
  const liveSlack = (network.vessels as any[])
    .filter(v => riskIds.has(v.laneId))
    .reduce((m, v: any) => Math.min(m, v.deliveryWindowDays - v.remainingDays - (v.route === 'cape' ? v.extraDays : eligible.some(e => e.id === v.id) ? liveExtraDays : 0)), Infinity);

  const lanesN = useCount(sum?.lanes ?? riskLanes.length);
  const vesN = useCount(sum?.vessels ?? eligible.length);
  const dayN = useCount(sum?.extraDays ?? liveExtraDays);
  const conf = useCount((d?.confidence ?? 0) * 100);
  const slackLive = sum?.slackDays ?? (Number.isFinite(liveSlack) ? liveSlack : 0);

  const evidence = [...(d?.evidence ?? []), ...s.extra].filter((e: any) => e.sourceUrl && e.retrievedAt);
  const label = status === 'CONNECTED' ? 'Live' : status === 'DEGRADED' ? 'Degraded' : 'Local Fallback';
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
            Synapse
            <span>{phase === 'REROUTED' ? 'Reroute applied' : 'Cold-chain disruption control'}</span>
          </h1>
          <div className="ctrls">
            <div className="seg" role="group" aria-label="Data source">
              <button className={mode === 'live' ? 'on' : ''} aria-pressed={mode === 'live'} onClick={() => switchMode('live')}>
                Live data
              </button>
              <button className={mode === 'dummy' ? 'on' : ''} aria-pressed={mode === 'dummy'} onClick={() => switchMode('dummy')}>
                Dummy
              </button>
            </div>
            <div className="seg" role="group" aria-label="Actions">
              <button className="pri" disabled={phase !== 'IDLE' || !armed} onClick={() => s.simulate()} title={armed ? undefined : 'Waiting for map and status checks'}>
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
              <button disabled aria-label="TinyFish status" title={`TinyFish: ${status.replace('_', ' ')} · ${budget.spent}/${budget.cap} calls this hour`}>
                {mode === 'dummy' ? 'Dummy data' : `TinyFish: ${status === 'CONNECTED' ? 'Live' : status === 'DEGRADED' ? 'Degraded' : 'Local Fallback'}`}
              </button>
            </div>
          </div>
        </div>

        <div className="grid">
          <Suspense fallback={<div className="card mapcard mapskel" aria-hidden="true" />}>
            <GlobePanel
              network={network}
              phase={phase}
              status={status}
              evidence={evidence}
              onReady={handleMapReady}
            />
          </Suspense>

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
              <text y="18" textAnchor="middle" fontSize="8.5" fontWeight="400" fill="rgba(255,255,255,.3)" className="mono">
                .55 + .10·domains − .15·degraded
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
            <div className="muted dark foot">of {network.lanes.length} lanes · zone geometry</div>
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
              <div className="cap">Delivery slack</div>
              {sum && <span className={`chip risk-${sum.risk}`}>{sum.risk}</span>}
            </div>
            <div className="kv">
              <span className="big mono">{slackLive.toFixed(1)}</span>
              <span className="muted"> days</span>
            </div>
            <Ticks frac={Math.max(0, Math.min(1, slackLive / 10))} />
            <div className="muted foot mono">
              {summary ? `${summary.breaches} box${summary.breaches === 1 ? '' : 'es'} over limit · live sensors` : 'IoT feed pending'}
            </div>
          </Card>

          <CargoPanel mode={mode} />
          <CasesPanel kind="urgent" />
          <CasesPanel kind="predictive" />

          <Card id="evid" className="h3" tone="pink">
            <div className="row between">
              <div className="ttl">Evidence</div>
              <span className="chips">
                {evidence.length > 0 && <span className="chip tfc">Live signal: confirmed</span>}
                <span className="muted dark2">
                  {evidence.length} source{evidence.length === 1 ? '' : 's'}
                </span>
              </span>
            </div>
            <div className="scroll low">
              {!evidence.length && (
                <p className="muted pad">
                  {mode === 'dummy'
                    ? 'Dummy mode: TinyFish is bypassed, so this stays empty by design.'
                    : d
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
              <span className="chips">
                <span className="chip glasschip mono" title="Paid TinyFish calls this hour / cache hits">
                  TF {budget.spent}/{budget.cap}
                </span>
                <span className="chip glasschip mono" title="Answers served from cache">
                  ⚡{budget.saved}
                </span>
              </span>
            </div>
            <div className="sysrow">
              <span className="cap">TinyFish</span>
              <span className="mono">{mode === 'dummy' ? 'Off (dummy)' : label}</span>
            </div>
            <div className="sysrow">
              <span className="cap">Credits left</span>
              <span className="mono">{mode === 'dummy' ? '—' : credits}</span>
            </div>
            <div className="sysrow">
              <span className="cap">Sensor API p95</span>
              <span className="mono">
                {net.p95 ? `${net.p95} ms` : '—'}
                {net.timeouts ? ` · ${net.timeouts} timeout${net.timeouts === 1 ? '' : 's'}` : ''}
              </span>
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
