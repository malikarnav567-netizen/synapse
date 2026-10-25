import { Card } from './ui';
import { useTelemetry } from './lib/telemetry';

/**
 * The cargo IoT ribbon: one tile per reefer container, driven by the live
 * ambient reading at that vessel's coordinate. The tile colour is the cold-chain
 * state, not decoration: green inside limits, amber inside the last 1.6 °C,
 * red over the limit.
 */
export default function CargoPanel({ mode }: { mode: 'live' | 'dummy' }) {
  const snap = useTelemetry(s => s.snap);
  const summary = useTelemetry(s => s.summary);
  const loading = useTelemetry(s => s.loading);

  const reefers = snap?.readings.filter(r => r.kind === 'reefer') ?? [];
  const live = snap?.ambient === 'live';
  const latency = snap?.latencyMs ?? 0;

  return (
    <Card id="iot" className="h4" tone="graph">
      <div className="row between">
        <div className="ttl">
          Cargo telemetry
          <span className="ttlsub">
            {summary ? `${summary.reefers} reefers · ${summary.devices - summary.reefers} gateways` : 'connecting…'}
          </span>
        </div>
        <span className="chips">
          {mode === 'dummy' ? (
            <span className="chip demochip">Dummy data</span>
          ) : live ? (
            <span className="chip livechip">{loading ? 'Refreshing' : 'Open-Meteo live'}</span>
          ) : (
            <span className="chip warnchip">{snap?.stale ? 'Stale · last good' : 'Model ambient'}</span>
          )}
          <span className="chip glasschip mono">{latency ? `${latency} ms` : '—'}</span>
          {summary && <span className="chip glasschip mono">{summary.ambientAvg} °C amb</span>}
        </span>
      </div>

      <div className="ribbon">
        {reefers.map(r => {
          const margin = r.limitC - r.boxC;
          const state = margin < 0 ? 'bad' : margin < 1.6 ? 'warn' : 'ok';
          const pct = Math.max(4, Math.min(100, (r.boxC / r.limitC) * 100));
          return (
            <div key={r.id} className={`tile ${state}`}>
              <div className="tile-top">
                <span className={`dot ${state}`} />
                <b className="mono">{r.id}</b>
                <span className="tile-vessel">{r.laneId}</span>
              </div>
              <div className="tile-temp mono">
                {r.boxC.toFixed(1)}
                <span>°C</span>
              </div>
              <div className="tile-bar">
                <i style={{ width: `${pct}%` }} />
                <u style={{ left: `${Math.min(98, (r.limitC / (r.limitC + 1)) * 100)}%` }} />
              </div>
              <div className="tile-sub mono">
                set {r.setpointC} · amb {r.ambientC.toFixed(0)} · {r.waveM.toFixed(1)} m
              </div>
            </div>
          );
        })}
        {!reefers.length && <div className="tile-skel">Sampling vessel coordinates…</div>}
      </div>

      <div className="iotfoot mono">
        {mode === 'dummy'
          ? 'Dummy mode — seeded climate, no sensor or advisory request'
          : 'Ambient, sea state and swell measured live at each vessel position · box probe is a thermal model'}
        {snap?.lastError ? ` · ${snap.lastError}` : ''}
      </div>
    </Card>
  );
}
