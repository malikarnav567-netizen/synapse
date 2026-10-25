import { Card } from './ui';
import { useTelemetry } from './lib/telemetry';
import type { OpsCase } from './lib/predict';

/**
 * Chip text is the *unit the decision is made in*: minutes until a breach for a
 * live fault, the measured value (days of slack, battery %) when there is no
 * crossing to predict. Never "no ETA" — for a machine-down case the ETA is not
 * missing, it does not exist.
 */
const due = (c: OpsCase) => {
  if (c.minutes == null) return c.level === 'urgent' ? 'monitor' : c.metric;
  if (c.minutes <= 0) return 'now';
  if (c.minutes < 90) return `${c.minutes}m`;
  return `${Math.round(c.minutes / 60)}h`;
};

/**
 * Urgent and predictive are deliberately different products, not two tabs of the
 * same list: urgent is "this reading is bad, act now", predictive is "nothing is
 * broken yet, but the live environment projects that it will be".
 */
export default function CasesPanel({ kind }: { kind: 'urgent' | 'predictive' }) {
  const board = useTelemetry(s => s.board);
  const resolved = useTelemetry(s => s.resolved);
  const resolve = useTelemetry(s => s.resolve);
  const snap = useTelemetry(s => s.snap);

  const urgent = kind === 'urgent';
  const list = urgent ? board.urgent : board.predictive;
  const reefers = snap?.readings.filter(r => r.kind === 'reefer') ?? [];
  const tightest = reefers.reduce(
    (a, b) => (b.limitC - b.boxC < a.limitC - a.boxC ? b : a),
    reefers[0],
  );

  return (
    <Card id={urgent ? 'urgent' : 'pred'} className="h3" tone={urgent ? 'pink' : 'blue'}>
      <div className="row between">
        <div className="ttl">
          {urgent ? 'Urgent' : 'Predictive'}
          <span className="ttlsub">{urgent ? 'act now · minutes' : 'plan ahead · hours'}</span>
        </div>
        <span className="chips">
          <span className={`chip ${urgent ? 'critchip' : 'glasschip'}`}>{list.length}</span>
        </span>
      </div>

      <div className="scroll low cases">
        {!list.length && (urgent ? (
          <div className="caseempty">
            <b>All {reefers.length || 6} reefers inside limits</b>
            <span>
              {tightest
                ? `Tightest margin ${(tightest.limitC - tightest.boxC).toFixed(1)} °C on ${tightest.id} (${tightest.boxC.toFixed(1)} °C of ${tightest.limitC} °C)`
                : 'Waiting for the first sensor sample'}
            </span>
            <span>Re-checked every 4 s · this path needs no network</span>
          </div>
        ) : (
          <p className="muted pad">
            {reefers.length
              ? 'No projected breach inside 36 h. Predictive fills from the live forecast peak, swell and voyage geometry.'
              : 'Waiting for the first sensor sample.'}
          </p>
        ))}
        {list.map(c => {
          const done = resolved.includes(c.id);
          return (
            <article key={c.id} className={`case ${c.severity}${done ? ' done' : ''}`}>
              <div className="casehead">
                <span className={`dot ${c.severity === 'critical' ? 'bad' : c.severity === 'high' ? 'warn' : 'ok'}`} />
                <b>{c.title}</b>
                <span className="chip casedue mono">{due(c)}</span>
              </div>
              <p>{c.detail}</p>
              <div className="caseact">
                <button className="mini" disabled={done} onClick={() => resolve(c.id)}>
                  {done ? 'Dispatched' : c.action}
                </button>
                <span className="mono muted2">
                  {c.container} · {c.metric} · {Math.round(c.confidence * 100)}%
                </span>
              </div>
            </article>
          );
        })}
      </div>

      <div className="casefoot mono">
        {urgent
          ? 'Reactive path · latest sensor reading only · survives a dropped network'
          : 'Patient path · live ambient + sea state + voyage geometry · 36 h horizon'}
      </div>
    </Card>
  );
}
