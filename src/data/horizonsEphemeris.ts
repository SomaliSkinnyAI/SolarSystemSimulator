import * as THREE from 'three';
import { BodyState } from '../types';
import { TEMPLATES, makeBody } from './realTimeOrbits';

type HorizonsSample = [number, number, number, number, number, number, number];

interface HorizonsCache {
  source: string;
  generatedAt: string;
  center: string;
  frame: string;
  units: string;
  startTime: string;
  stopTime: string;
  stepSize: string;
  fields: string[];
  targets: Record<string, string>;
  bodies: Record<string, HorizonsSample[]>;
}

export interface EphemerisResult {
  bodies: BodyState[];
  source: string;
  cacheRange: string;
}

const CACHE_URL = '/ephemeris/horizons-2024-2028.json';
let cachePromise: Promise<HorizonsCache | null> | null = null;

function loadCache(): Promise<HorizonsCache | null> {
  if (!cachePromise) {
    cachePromise = fetch(CACHE_URL)
      .then(async res => {
        if (!res.ok) return null;
        return await res.json() as HorizonsCache;
      })
      .catch(() => null)
      .then(cache => {
        // Don't memoize failures — a transient network error would otherwise
        // silently disable Horizons mode until page reload.
        if (!cache) cachePromise = null;
        return cache;
      });
  }
  return cachePromise;
}

/** TDB−UTC offset in days (~69.2 s in the 2020s; cache timestamps are JD_TDB). */
const TDB_MINUS_UTC_DAYS = 69.184 / 86400;

function dateToJD(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate() + date.getUTCHours() / 24
    + date.getUTCMinutes() / 1440 + date.getUTCSeconds() / 86400
    + date.getUTCMilliseconds() / 86400000;
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  // The integer JDN formula is noon-based: subtract 0.5 so midnight UTC maps
  // to JD ×××××.5 (omitting this shifted every lookup +12 hours).
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy
    + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045
    - 0.5 + TDB_MINUS_UTC_DAYS;
}

function bracketSamples(samples: HorizonsSample[], jd: number): [HorizonsSample, HorizonsSample] | null {
  if (samples.length < 2) return null;
  if (jd < samples[0]![0] || jd > samples[samples.length - 1]![0]) return null;

  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]![0] <= jd) lo = mid;
    else hi = mid;
  }
  return [samples[lo]!, samples[hi]!];
}

function sampleToSimVectors(a: HorizonsSample, b: HorizonsSample, jd: number): {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
} {
  const jd0 = a[0];
  const jd1 = b[0];
  const dt = (jd1 - jd0) * 86400;
  const u = Math.max(0, Math.min(1, (jd - jd0) / (jd1 - jd0)));
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

  const p = [0, 0, 0];
  const v = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const p0 = a[i + 1]! * 1000;
    const p1 = b[i + 1]! * 1000;
    const v0 = a[i + 4]! * 1000;
    const v1 = b[i + 4]! * 1000;
    p[i] = h00 * p0 + h10 * dt * v0 + h01 * p1 + h11 * dt * v1;
    v[i] = dh00 * p0 + dh10 * v0 + dh01 * p1 + dh11 * v1;
  }

  // Horizons ecliptic XYZ -> simulator X, Y-up, -Z ecliptic longitude axis.
  return {
    position: new THREE.Vector3(p[0]!, p[2]!, -p[1]!),
    velocity: new THREE.Vector3(v[0]!, v[2]!, -v[1]!),
  };
}

export async function computeBodiesFromHorizonsCache(date: Date): Promise<EphemerisResult | null> {
  const cache = await loadCache();
  if (!cache) return null;

  const jd = dateToJD(date);
  const bodyIds = Object.keys(TEMPLATES);
  const states: BodyState[] = [];

  for (const id of bodyIds) {
    const samples = cache.bodies[id];
    const tpl = TEMPLATES[id];
    if (!samples || !tpl) return null;

    const bracket = bracketSamples(samples, jd);
    if (!bracket) return null;

    const { position, velocity } = sampleToSimVectors(bracket[0], bracket[1], jd);
    states.push(makeBody(tpl, position, velocity));
  }

  return {
    bodies: states,
    source: `${cache.source} cached vectors`,
    cacheRange: `${cache.startTime} to ${cache.stopTime}`,
  };
}
