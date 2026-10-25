/**
 * Data mode: the single switch between real upstream data and the offline demo.
 *
 * `live`  — cargo telemetry comes from Open-Meteo at the vessels' real
 *           coordinates, advisories come from TinyFish.
 * `dummy` — nothing leaves the browser. Deterministic, seeded readings, so a
 *           demo can be run with no network, no key and no credits.
 *
 * The mode is mirrored in the URL (`?data=dummy`) so a dummy demo link can be
 * shared, and persisted so a reload keeps the operator's choice.
 */

export type DataMode = 'live' | 'dummy';

const KEY = 'synapse.dataMode.v1';
const listeners = new Set<() => void>();

const read = (): DataMode => {
  try {
    const q = new URLSearchParams(location.search).get('data');
    if (q === 'dummy' || q === 'live') return q;
    return localStorage.getItem(KEY) === 'dummy' ? 'dummy' : 'live';
  } catch {
    return 'live';
  }
};

let mode: DataMode = read();

export const getMode = () => mode;
export const isDummy = () => mode === 'dummy';
export const onModeChange = (f: () => void) => {
  listeners.add(f);
  return () => { listeners.delete(f); };
};

export function setMode(next: DataMode) {
  if (next === mode) return;
  mode = next;
  try { localStorage.setItem(KEY, next); } catch { /* private mode */ }
  try {
    const url = new URL(location.href);
    url.searchParams.set('data', next);
    history.replaceState(null, '', url);
  } catch { /* non-browser */ }
  listeners.forEach(f => f());
}
