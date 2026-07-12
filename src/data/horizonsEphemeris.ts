import * as THREE from 'three';
import { BodyState } from '../types';
import { TEMPLATES, makeBody } from './realTimeOrbits';
import { assetUrl } from '../utils/assetUrl';

// ---------------------------------------------------------------------------
// Horizons ephemeris cache v2: per-body Float32 binaries with UNIFORM time
// steps (index arithmetic instead of binary search), lazily fetched, plus
// spacecraft trajectory samplers. index.json carries {jd0, stepDays, count}
// per body; sample rows are [x y z vx vy vz] in km and km/s, barycentric
// ecliptic ICRF.
// ---------------------------------------------------------------------------

interface IndexEntry {
  jd0: number;
  stepDays: number;
  count: number;
  file: string;
  spk: string;
  name?: string;
}

interface CacheIndex {
  version: number;
  source: string;
  startTime: string;
  stopTime: string;
  bodies: Record<string, IndexEntry>;
  spacecraft: string[];
}

export interface EphemerisResult {
  bodies: BodyState[];
  source: string;
  cacheRange: string;
}

export interface SampledState {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

/** TDB−UTC offset in days (~69.2 s in the 2020s; cache timestamps are JD_TDB). */
const TDB_MINUS_UTC_DAYS = 69.184 / 86400;

let indexPromise: Promise<CacheIndex | null> | null = null;
const bodyDataCache = new Map<string, Promise<Float32Array | null>>();

function loadIndex(): Promise<CacheIndex | null> {
  if (!indexPromise) {
    indexPromise = fetch(assetUrl('/ephemeris/index.json'))
      .then(async res => (res.ok ? await res.json() as CacheIndex : null))
      .catch(() => null)
      .then(idx => {
        if (!idx) indexPromise = null; // transient failure: allow retry
        return idx;
      });
  }
  return indexPromise;
}

function loadBodyData(entry: IndexEntry): Promise<Float32Array | null> {
  let p = bodyDataCache.get(entry.file);
  if (!p) {
    p = fetch(assetUrl(`/ephemeris/${entry.file}`))
      .then(async res => (res.ok ? new Float32Array(await res.arrayBuffer()) : null))
      .catch(() => null)
      .then(data => {
        if (!data) bodyDataCache.delete(entry.file);
        return data;
      });
    bodyDataCache.set(entry.file, p);
  }
  return p;
}

export function dateToJulianTDB(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate() + date.getUTCHours() / 24
    + date.getUTCMinutes() / 1440 + date.getUTCSeconds() / 86400
    + date.getUTCMilliseconds() / 86400000;
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  // Noon-based JDN formula: subtract 0.5 so midnight UTC maps to JD ×××××.5
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy
    + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
    - 0.5 + TDB_MINUS_UTC_DAYS;
}

/**
 * Cubic Hermite interpolation between uniform samples. Returns SI metres
 * and m/s, mapped into sim axes (ecliptic X→X, Z→Y, Y→−Z).
 */
function sampleEntry(entry: IndexEntry, data: Float32Array, jd: number): SampledState | null {
  const t = (jd - entry.jd0) / entry.stepDays;
  if (t < 0 || t > entry.count - 1) return null;
  const i = Math.min(Math.floor(t), entry.count - 2);
  const u = t - i;
  const dt = entry.stepDays * 86400;

  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const dh00 = (6 * u2 - 6 * u) / dt;
  const dh10 = 3 * u2 - 4 * u + 1;
  const dh01 = (-6 * u2 + 6 * u) / dt;
  const dh11 = 3 * u2 - 2 * u;

  const a = i * 6;
  const b = (i + 1) * 6;
  const p: number[] = [0, 0, 0];
  const v: number[] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p0 = data[a + c]! * 1000;
    const p1 = data[b + c]! * 1000;
    const v0 = data[a + 3 + c]! * 1000;
    const v1 = data[b + 3 + c]! * 1000;
    p[c] = h00 * p0 + h10 * dt * v0 + h01 * p1 + h11 * dt * v1;
    v[c] = dh00 * p0 + dh10 * v0 + dh01 * p1 + dh11 * v1;
  }

  return {
    position: new THREE.Vector3(p[0]!, p[2]!, -p[1]!),
    velocity: new THREE.Vector3(v[0]!, v[2]!, -v[1]!),
  };
}

/**
 * Full planet/moon roster for a date, or null if the cache is missing or the
 * date is out of range (all-or-nothing so sources are never mixed).
 * Spacecraft are NOT part of the roster — they load via samplers.
 */
export async function computeBodiesFromHorizonsCache(date: Date): Promise<EphemerisResult | null> {
  const index = await loadIndex();
  if (!index) return null;

  const jd = dateToJulianTDB(date);
  const bodyIds = Object.keys(TEMPLATES);
  const states: BodyState[] = [];

  const buffers = await Promise.all(bodyIds.map(id => {
    const entry = index.bodies[id];
    return entry ? loadBodyData(entry) : Promise.resolve(null);
  }));

  for (let i = 0; i < bodyIds.length; i++) {
    const id = bodyIds[i]!;
    const entry = index.bodies[id];
    const data = buffers[i];
    const tpl = TEMPLATES[id];
    if (!entry || !data || !tpl) return null;
    const s = sampleEntry(entry, data, jd);
    if (!s) return null;
    states.push(makeBody(tpl, s.position, s.velocity));
  }

  return {
    bodies: states,
    source: `${index.source} cached vectors`,
    cacheRange: `${index.startTime} to ${index.stopTime}`,
  };
}

/** Spacecraft ids present in the cache. */
export async function getAvailableSpacecraft(): Promise<string[]> {
  const index = await loadIndex();
  return index?.spacecraft ?? [];
}

/**
 * Async factory returning a SYNCHRONOUS sampler for one spacecraft:
 * (jdTDB) → state, or null when outside the trajectory's coverage.
 */
export async function getSpacecraftSampler(
  id: string
): Promise<((jd: number) => SampledState | null) | null> {
  const index = await loadIndex();
  const entry = index?.bodies[id];
  if (!entry) return null;
  const data = await loadBodyData(entry);
  if (!data) return null;
  return (jd: number) => sampleEntry(entry, data, jd);
}
