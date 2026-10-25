/**
 * Maritime route model for the 3D globe.
 *
 * Great-circle interpolation is only used *between* these waypoints. Every
 * waypoint set below is hand-placed inside a navigable channel, so the drawn
 * lane hugs the sea instead of cutting across Arabia or the Indian peninsula.
 */
export type LonLat = [number, number];

export interface Port {
  id: string;
  name: string;
  coord: LonLat;
  kind: 'origin' | 'destination' | 'transit';
}

export const PORTS: Port[] = [
  { id: 'mumbai', name: 'Mumbai', coord: [72.8, 18.9], kind: 'origin' },
  { id: 'colombo', name: 'Colombo', coord: [79.8, 6.9], kind: 'origin' },
  { id: 'jebel-ali', name: 'Jebel Ali', coord: [55.05, 25.0], kind: 'origin' },
  { id: 'shanghai', name: 'Shanghai', coord: [121.5, 31.0], kind: 'origin' },
  { id: 'suez', name: 'Suez', coord: [32.55, 29.95], kind: 'transit' },
  { id: 'cape-town', name: 'Cape Town', coord: [18.43, -33.9], kind: 'transit' },
  { id: 'durban', name: 'Durban', coord: [31.03, -29.87], kind: 'transit' },
  { id: 'rotterdam', name: 'Rotterdam', coord: [4.1, 51.9], kind: 'destination' },
  { id: 'hamburg', name: 'Hamburg', coord: [9.9, 53.5], kind: 'destination' },
  { id: 'felixstowe', name: 'Felixstowe', coord: [1.3, 51.9], kind: 'destination' },
  { id: 'los-angeles', name: 'Los Angeles', coord: [-118.2, 33.7], kind: 'destination' },
];

/** UKMTO-style high-risk band: southern Red Sea, Bab-el-Mandeb, Gulf of Aden. */
export const ZONE: LonLat[] = [
  [41.6, 12.2],
  [44.2, 11.4],
  [52.6, 11.0],
  [52.9, 15.0],
  [48.5, 15.9],
  [45.0, 16.7],
  [42.6, 18.4],
];

/** Gulf of Guinea piracy watch area (route-relevant for Cape diversions). */
export const GULF_OF_GUINEA: LonLat[] = [
  [-4.5, 1.0],
  [3.0, -0.5],
  [8.5, 2.0],
  [7.5, 6.0],
  [2.0, 7.0],
  [-3.5, 5.0],
];

/* ---------- sea legs ---------- */
const ADEN_EAST_TO_WEST: LonLat[] = [
  [54.0, 13.8], [52.0, 13.0], [49.5, 12.6], [47.0, 12.3], [45.2, 12.3], [43.8, 12.6],
];

const RED_SEA_SOUTH_TO_NORTH: LonLat[] = [
  [43.0, 13.8], [42.2, 15.2], [41.4, 16.8], [40.4, 18.4], [39.3, 20.2], [38.1, 22.0],
  [36.8, 23.8], [35.5, 25.5], [34.3, 27.2], [33.3, 28.6], [32.55, 29.95],
];

const SUEZ_CANAL: LonLat[] = [
  [32.45, 30.4], [32.3, 31.26],
];

const MEDITERRANEAN: LonLat[] = [
  [31.9, 31.0], [30.0, 32.4], [27.5, 33.2], [25.0, 33.9], [22.0, 34.6], [19.0, 35.4],
  [16.0, 36.4], [13.0, 37.2], [10.0, 37.8], [7.0, 37.8], [4.0, 37.5], [1.0, 36.9],
  [-2.0, 36.3], [-5.6, 36.0],
];

const ATLANTIC_EU: LonLat[] = [
  [-7.2, 37.4], [-9.2, 39.0], [-9.8, 42.0], [-9.6, 44.6], [-7.8, 46.8], [-5.2, 48.5],
  [-3.2, 49.5], [-1.2, 50.1], [0.6, 50.7], [2.0, 51.2], [3.2, 51.6], [4.1, 51.9],
];

const HAMBURG_TAIL: LonLat[] = [
  [-1.2, 50.1], [0.6, 50.7], [2.0, 51.2], [3.4, 51.9], [4.6, 52.5], [6.0, 53.3],
  [7.6, 53.9], [8.6, 54.1], [9.9, 53.5],
];

const FELIXSTOWE_TAIL: LonLat[] = [
  [-1.2, 50.1], [0.6, 50.7], [2.0, 51.2], [2.4, 51.5], [1.3, 51.9],
];

/**
 * Cape of Good Hope diversion, drawn from the Gulf of Aden southward. Large
 * vessels pass east of Madagascar, inside the Mozambique Channel, then round
 * the Cape and run north-west well clear of the West African shelf.
 */
const CAPE_SOUTH: LonLat[] = [
  [54.0, 13.8], [56.5, 13.0], [59.0, 11.8], [61.5, 10.0], [63.6, 6.4], [65.2, 1.5],
  [66.3, -4.5], [66.4, -11.5], [64.0, -19.0], [58.5, -27.0], [51.0, -33.5],
  [43.0, -37.5], [35.0, -38.4], [27.5, -36.2], [21.0, -35.2], [17.0, -33.0],
  [13.0, -28.8], [10.2, -23.0], [7.0, -17.0], [3.4, -11.0], [0.0, -5.0],
  [-4.0, 0.5], [-8.4, 6.0], [-12.0, 11.5], [-15.0, 16.5], [-17.2, 21.0],
  [-17.0, 26.0], [-13.0, 31.0], [-10.0, 35.0], [-9.2, 39.0], [-9.8, 42.0],
  [-9.6, 44.6], [-7.8, 46.8],
];

const join = (...parts: LonLat[][]): LonLat[] => parts.flat();

// Cape approaches join Biscay, so they must not replay the Gibraltar leg.
const CAPE_TAIL: Record<'rotterdam' | 'hamburg' | 'felixstowe', LonLat[]> = {
  rotterdam: [[-5.2, 48.5], [-3.2, 49.5], [-1.2, 50.1], [0.6, 50.7], [2.0, 51.2], [3.2, 51.6], [4.1, 51.9]],
  hamburg: [[-5.2, 48.5], [-3.2, 49.5], [-1.2, 50.1], [0.6, 50.7], [2.0, 51.2], [3.4, 51.9], [4.6, 52.5], [6.0, 53.3], [7.6, 53.9], [8.6, 54.1], [9.9, 53.5]],
  felixstowe: [[-5.2, 48.5], [-3.2, 49.5], [-1.2, 50.1], [0.6, 50.7], [2.0, 51.2], [2.4, 51.5], [1.3, 51.9]],
};

const nearestIndex = (line: LonLat[], target: LonLat): number => {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < line.length; i++) {
    const d = (line[i][0] - target[0]) ** 2 + (line[i][1] - target[1]) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
};

/** Truncate a Suez lane before Bab-el-Mandeb and swing it around the Cape. */
const viaCape = (suez: LonLat[], tail: LonLat[]): LonLat[] => {
  const cut = nearestIndex(suez, [54.0, 13.8]);
  return join(suez.slice(0, cut + 1), CAPE_SOUTH.slice(1), tail);
};

/* ---------- lanes ---------- */
export interface SeaLane {
  id: string;
  name: string;
  origin: string;
  dest: string;
  geometry: LonLat[];
  /** Routing used after an operator approves the Cape diversion. */
  alternate: LonLat[];
  status: 'nominal' | 'rerouted';
}

const mumbaiAden: LonLat[] = [
  [72.8, 18.9], [70.8, 19.4], [68.5, 20.3], [66.0, 21.2], [63.5, 21.6], [61.0, 21.0],
  [59.0, 19.6], [57.5, 17.5], [56.0, 15.6],
];

const colomboAden: LonLat[] = [
  [79.8, 6.9], [77.0, 6.6], [74.0, 7.4], [71.0, 8.6], [68.0, 9.6], [65.0, 10.6],
  [62.0, 11.2], [59.0, 11.6], [56.5, 12.4],
];

const jebelAliAden: LonLat[] = [
  [55.05, 25.0], [56.4, 24.6], [57.3, 22.8], [56.6, 20.0], [55.2, 17.0], [54.9, 15.2],
];

const shanghaiLa: LonLat[] = [
  [121.5, 31.0], [123.0, 29.0], [125.5, 26.5], [129.0, 23.5], [134.0, 21.5],
  [140.0, 20.5], [148.0, 22.0], [158.0, 26.0], [170.0, 30.0], [180.0, 32.0],
  [-170.0, 35.0], [-155.0, 36.0], [-140.0, 35.0], [-128.0, 34.2], [-118.2, 33.7],
];

const l1suez = join(mumbaiAden, ADEN_EAST_TO_WEST, RED_SEA_SOUTH_TO_NORTH, SUEZ_CANAL, MEDITERRANEAN, ATLANTIC_EU);
const l2suez = join(colomboAden, ADEN_EAST_TO_WEST, RED_SEA_SOUTH_TO_NORTH, SUEZ_CANAL, MEDITERRANEAN, HAMBURG_TAIL);
const l3suez = join(jebelAliAden, ADEN_EAST_TO_WEST, RED_SEA_SOUTH_TO_NORTH, SUEZ_CANAL, MEDITERRANEAN, FELIXSTOWE_TAIL);

const capeTail = (dest: keyof typeof CAPE_TAIL): LonLat[] => CAPE_TAIL[dest];

export const SEA_LANES: SeaLane[] = [
  {
    id: 'L1',
    name: 'Mumbai → Rotterdam',
    origin: 'mumbai',
    dest: 'rotterdam',
    geometry: l1suez,
    alternate: viaCape(l1suez, capeTail('rotterdam')),
    status: 'nominal',
  },
  {
    id: 'L2',
    name: 'Colombo → Hamburg',
    origin: 'colombo',
    dest: 'hamburg',
    geometry: l2suez,
    alternate: viaCape(l2suez, capeTail('hamburg')),
    status: 'nominal',
  },
  {
    id: 'L3',
    name: 'Jebel Ali → Felixstowe',
    origin: 'jebel-ali',
    dest: 'felixstowe',
    geometry: l3suez,
    alternate: viaCape(l3suez, capeTail('felixstowe')),
    status: 'nominal',
  },
  {
    id: 'L4',
    name: 'Shanghai → Los Angeles',
    origin: 'shanghai',
    dest: 'los-angeles',
    geometry: shanghaiLa,
    alternate: shanghaiLa,
    status: 'nominal',
  },
];

export const portById = (id: string) => PORTS.find(p => p.id === id);
