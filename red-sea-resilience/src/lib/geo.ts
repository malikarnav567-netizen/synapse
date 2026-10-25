export type LonLat = [number, number];

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const EARTH_NM = 3440.065;

const toVec = ([lon, lat]: LonLat): [number, number, number] => {
  const phi = lat * RAD;
  const lambda = lon * RAD;
  return [Math.cos(phi) * Math.cos(lambda), Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
};

const toLonLat = ([x, y, z]: [number, number, number]): LonLat => [
  Math.atan2(y, x) * DEG,
  Math.max(-90, Math.min(90, Math.asin(z))) * DEG,
];

/** Points along the great circle between two coordinates (exclusive of both ends). */
export function greatCircle(a: LonLat, b: LonLat, stepDeg = 2): LonLat[] {
  const va = toVec(a);
  const vb = toVec(b);
  const dot = Math.max(-1, Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-6) return [a, b];

  const steps = Math.max(1, Math.min(180, Math.ceil((omega * DEG) / stepDeg)));
  const points: LonLat[] = [];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const s1 = Math.sin((1 - t) * omega) / Math.sin(omega);
    const s2 = Math.sin(t * omega) / Math.sin(omega);
    points.push(toLonLat([
      va[0] * s1 + vb[0] * s2,
      va[1] * s1 + vb[1] * s2,
      va[2] * s1 + vb[2] * s2,
    ]));
  }
  return [a, ...points, b];
}

/** Expand a polyline into great-circle segments so it hugs the sphere. */
export function densify(line: LonLat[], stepDeg = 2): LonLat[] {
  if (line.length < 2) return line.slice();
  const out: LonLat[] = [];
  for (let i = 0; i < line.length - 1; i++) {
    const seg = greatCircle(line[i], line[i + 1], stepDeg);
    out.push(...(i === 0 ? seg : seg.slice(1)));
  }
  return out;
}

export function legNm(a: LonLat, b: LonLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function pathNm(line: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += legNm(line[i - 1], line[i]);
  return total;
}

/** Position at fraction t (0..1) of the path, travelling at constant speed. */
export function pointAt(line: LonLat[], t: number): { coord: LonLat; bearing: number } {
  if (!line.length) return { coord: [0, 0], bearing: 0 };
  if (line.length === 1) return { coord: line[0], bearing: 0 };

  const cumulative: number[] = [0];
  for (let i = 1; i < line.length; i++) cumulative.push(cumulative[i - 1] + legNm(line[i - 1], line[i]));

  const total = cumulative[cumulative.length - 1];
  const target = Math.max(0, Math.min(1, t)) * total;

  let i = 1;
  while (i < cumulative.length - 1 && cumulative[i] < target) i++;
  const a = line[i - 1];
  const b = line[Math.min(line.length - 1, i)];
  const span = Math.max(1e-9, cumulative[i] - cumulative[i - 1]);
  const f = Math.max(0, Math.min(1, (target - cumulative[i - 1]) / span));

  // Unwrap the longitude so a Pacific leg does not interpolate the long way
  // around the planet when it crosses the antimeridian.
  const dLon = ((b[0] - a[0] + 540) % 360) - 180;
  const lon = ((a[0] + dLon * f + 540) % 360) - 180;
  const coord: LonLat = [lon, a[1] + (b[1] - a[1]) * f];
  return { coord, bearing: bearingBetween(a, b) };
}

/** Forward azimuth from a to b, 0° = north. Follows the great circle. */
export function bearingBetween(a: LonLat, b: LonLat): number {
  const phi1 = a[1] * RAD;
  const phi2 = b[1] * RAD;
  const dLambda = (b[0] - a[0]) * RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (Math.atan2(y, x) * DEG + 360) % 360;
}

/** Resample a polyline into `n` points spaced evenly by distance. */
export function resample(line: LonLat[], n: number): LonLat[] {
  if (line.length < 2) return Array.from({ length: n }, () => line[0] ?? [0, 0]);
  const cumulative: number[] = [0];
  for (let i = 1; i < line.length; i++) cumulative.push(cumulative[i - 1] + legNm(line[i - 1], line[i]));
  const total = cumulative[cumulative.length - 1];
  if (!total) return Array.from({ length: n }, () => line[0]);
  const out: LonLat[] = [];
  let seg = 1;
  for (let i = 0; i < n; i++) {
    const target = (i / (n - 1)) * total;
    while (seg < cumulative.length - 1 && cumulative[seg] < target) seg++;
    const a = line[seg - 1];
    const b = line[seg];
    const span = cumulative[seg] - cumulative[seg - 1] || 1;
    const f = (target - cumulative[seg - 1]) / span;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

/** Blend two routes of different shape into one frame of a route-change animation. */
export function morphLine(from: LonLat[], to: LonLat[], t: number, samples = 96): LonLat[] {
  const a = resample(from, samples);
  const b = resample(to, samples);
  const k = Math.max(0, Math.min(1, t));
  const eased = k * k * (3 - 2 * k);
  return a.map(([lonA, latA], i) => {
    let lonB = b[i][0];
    let lonA2 = lonA;
    // Take the short way round the antimeridian.
    if (lonB - lonA2 > 180) lonA2 += 360;
    if (lonA2 - lonB > 180) lonB += 360;
    const lon = lonA2 + (lonB - lonA2) * eased;
    return [((lon + 540) % 360) - 180, latA + (b[i][1] - latA) * eased] as LonLat;
  });
}

export function boundsOf(lines: LonLat[][]): [[number, number], [number, number]] {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const line of lines) {
    for (const [lon, lat] of line) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return [[west, south], [east, north]];
}
