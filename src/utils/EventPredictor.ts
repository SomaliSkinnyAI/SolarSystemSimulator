import * as THREE from 'three';
import { BodyState } from '../types';
import { formatDistance, formatVelocity, orbitalElementsFromState } from './MathUtils';
import { computeBodiesForDate, TEMPLATES } from '../data/realTimeOrbits';
import { computeBodiesFromHorizonsCache } from '../data/horizonsEphemeris';

export interface EventScanSummary {
  closestMajorPair: string;
  closestMajorDistance: string;
  tightestConjunction: string;
  tightestConjunctionAngle: string;
  fastestBody: string;
  fastestBodySpeed: string;
  mostEccentricOrbit: string;
  mostEccentricValue: string;
}

function longitudeFromSun(body: BodyState, sun: BodyState): number {
  const rel = body.position.clone().sub(sun.position);
  return Math.atan2(-rel.z, rel.x);
}

function angularSeparationDeg(a: number, b: number): number {
  const twoPi = Math.PI * 2;
  let diff = Math.abs(((a - b) % twoPi + twoPi) % twoPi);
  if (diff > Math.PI) diff = twoPi - diff;
  return diff * 180 / Math.PI;
}

export function scanSystemEvents(bodies: BodyState[], G: number): EventScanSummary | null {
  const sun = bodies.find(b => b.id === 'sun');
  if (!sun) return null;

  const majorBodies = bodies.filter(b => b.id !== 'sun' && !b.isMoon);
  if (majorBodies.length < 2) return null;

  let closestA = majorBodies[0]!;
  let closestB = majorBodies[1]!;
  let closestDistance = closestA.position.distanceTo(closestB.position);

  let conjA = closestA;
  let conjB = closestB;
  let conjAngle = 360;

  let fastest = majorBodies[0]!;
  let fastestSpeed = fastest.velocity.clone().sub(sun.velocity).length();

  let eccentric = majorBodies[0]!;
  let eccentricity = -1;

  for (let i = 0; i < majorBodies.length; i++) {
    const a = majorBodies[i]!;
    const relSpeed = a.velocity.clone().sub(sun.velocity).length();
    if (relSpeed > fastestSpeed) {
      fastest = a;
      fastestSpeed = relSpeed;
    }

    const relPos = a.position.clone().sub(sun.position);
    const relVel = a.velocity.clone().sub(sun.velocity);
    const elements = orbitalElementsFromState(
      G, sun.mass,
      relPos.x, relPos.y, relPos.z,
      relVel.x, relVel.y, relVel.z
    );
    if (elements.bound && elements.eccentricity > eccentricity) {
      eccentric = a;
      eccentricity = elements.eccentricity;
    }

    for (let j = i + 1; j < majorBodies.length; j++) {
      const b = majorBodies[j]!;
      const dist = a.position.distanceTo(b.position);
      if (dist < closestDistance) {
        closestA = a;
        closestB = b;
        closestDistance = dist;
      }

      const sep = angularSeparationDeg(longitudeFromSun(a, sun), longitudeFromSun(b, sun));
      if (sep < conjAngle) {
        conjA = a;
        conjB = b;
        conjAngle = sep;
      }
    }
  }

  return {
    closestMajorPair: `${closestA.name} / ${closestB.name}`,
    closestMajorDistance: formatDistance(closestDistance),
    tightestConjunction: `${conjA.name} / ${conjB.name}`,
    tightestConjunctionAngle: `${conjAngle.toFixed(2)} deg`,
    fastestBody: fastest.name,
    fastestBodySpeed: formatVelocity(fastestSpeed),
    mostEccentricOrbit: eccentric.name,
    mostEccentricValue: eccentricity >= 0 ? eccentricity.toFixed(3) : '--',
  };
}

// ---------------------------------------------------------------------------
// Forward scan: upcoming eclipses, conjunctions, and oppositions with dates.
// Coarse-samples the ephemeris (Horizons cache when in range, Keplerian
// fallback otherwise) every 6 hours, detects local minima of each event
// metric under threshold, then refines by resampling the bracketing window.
// ---------------------------------------------------------------------------

export interface UpcomingEvent {
  type: 'solar-eclipse' | 'lunar-eclipse' | 'conjunction' | 'opposition';
  date: Date;
  label: string;
  detail: string;
  /** Body to aim the camera at when jumping to this event. */
  focusBodyId: string;
}

type PosMap = Map<string, THREE.Vector3>;

async function positionsAt(date: Date): Promise<PosMap | null> {
  const horizons = await computeBodiesFromHorizonsCache(date);
  const states = horizons ? horizons.bodies : computeBodiesForDate(date);
  const map: PosMap = new Map();
  for (const s of states) map.set(s.id, s.position);
  return map.size > 0 ? map : null;
}

/** Angular separation (deg) of two directions from an observer position. */
function sepFrom(observer: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3): number {
  const da = a.clone().sub(observer).normalize();
  const db = b.clone().sub(observer).normalize();
  return Math.acos(Math.max(-1, Math.min(1, da.dot(db)))) * 180 / Math.PI;
}

function angularRadiusDeg(observer: THREE.Vector3, center: THREE.Vector3, radius: number): number {
  return Math.asin(Math.min(1, radius / observer.distanceTo(center))) * 180 / Math.PI;
}

interface Metric {
  key: string;
  type: UpcomingEvent['type'];
  label: string;
  focusBodyId: string;
  /**
   * Coarse local minima below this trigger refinement. Must be LOOSE:
   * a solar eclipse metric is negative for only ~±2 h, far narrower than
   * the 6 h sampling step, so the sampled minimum sits well above zero.
   */
  detectBelow: number;
  /** The refined minimum must dip below this for a real event. */
  keepBelow: number;
  evaluate(pos: PosMap): number | null;
}

function buildMetrics(): Metric[] {
  const rSun = TEMPLATES['sun']!.radius;
  const rMoon = TEMPLATES['moon']!.radius;
  const rEarth = TEMPLATES['earth']!.radius;
  const metrics: Metric[] = [];

  metrics.push({
    key: 'solar-eclipse', type: 'solar-eclipse',
    label: 'Solar eclipse', focusBodyId: 'earth',
    detectBelow: 3.5, keepBelow: 0,
    evaluate(pos) {
      const e = pos.get('earth'), s = pos.get('sun'), m = pos.get('moon');
      if (!e || !s || !m) return null;
      const sep = sepFrom(e, s, m);
      // Include the lunar horizontal parallax (Earth's radius seen from the
      // Moon, ~0.95°): high-latitude eclipses — like 2026-08-12 over
      // Iceland/Spain — never overlap geocentrically, only from the surface.
      const parallax = Math.asin(Math.min(1, rEarth / e.distanceTo(m))) * 180 / Math.PI;
      const limit = angularRadiusDeg(e, s, rSun) + angularRadiusDeg(e, m, rMoon) + parallax;
      return sep - limit;
    },
  });

  metrics.push({
    key: 'lunar-eclipse', type: 'lunar-eclipse',
    label: 'Lunar eclipse', focusBodyId: 'moon',
    detectBelow: 3.5, keepBelow: 0,
    evaluate(pos) {
      const e = pos.get('earth'), s = pos.get('sun'), m = pos.get('moon');
      if (!e || !s || !m) return null;
      // Moon vs the anti-solar point; umbra cone half-angle at Moon range
      const antiSun = e.clone().multiplyScalar(2).sub(s);
      const sep = sepFrom(e, antiSun, m);
      const dMoon = e.distanceTo(m);
      const umbraR = rEarth * 1.01 - dMoon * (rSun - rEarth) / e.distanceTo(s);
      const limit = angularRadiusDeg(e, m, rMoon)
                  + Math.asin(Math.min(1, Math.max(0, umbraR) / dMoon)) * 180 / Math.PI;
      return sep - limit;
    },
  });

  const conjPlanets = ['mercury', 'venus', 'mars', 'jupiter', 'saturn'];
  for (let i = 0; i < conjPlanets.length; i++) {
    for (let j = i + 1; j < conjPlanets.length; j++) {
      const a = conjPlanets[i]!, b = conjPlanets[j]!;
      metrics.push({
        key: `conj-${a}-${b}`, type: 'conjunction',
        label: `${TEMPLATES[a]!.name} – ${TEMPLATES[b]!.name} conjunction`,
        focusBodyId: a,
        detectBelow: 1.6, keepBelow: 0,
        evaluate(pos) {
          const e = pos.get('earth'), pa = pos.get(a), pb = pos.get(b);
          if (!e || !pa || !pb) return null;
          return sepFrom(e, pa, pb) - 1.6;
        },
      });
    }
  }

  for (const p of ['mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
    metrics.push({
      key: `opp-${p}`, type: 'opposition',
      label: `${TEMPLATES[p]!.name} at opposition`,
      focusBodyId: p,
      detectBelow: 2.0, keepBelow: 0,
      evaluate(pos) {
        const e = pos.get('earth'), s = pos.get('sun'), pp = pos.get(p);
        if (!e || !s || !pp) return null;
        const antiSun = e.clone().multiplyScalar(2).sub(s);
        return sepFrom(e, antiSun, pp) - 2.0;
      },
    });
  }

  return metrics;
}

export async function scanUpcomingEvents(
  start: Date,
  days: number,
  onProgress?: (fraction: number) => void
): Promise<UpcomingEvent[]> {
  const stepMs = 6 * 3600 * 1000;
  const nSamples = Math.ceil(days * 24 * 3600 * 1000 / stepMs);
  const metrics = buildMetrics();
  const history = new Map<string, [number, number]>(); // key -> [prev2, prev1]
  const events: UpcomingEvent[] = [];

  for (let i = 0; i < nSamples; i++) {
    const date = new Date(start.getTime() + i * stepMs);
    const pos = await positionsAt(date);
    if (!pos) continue;

    for (const metric of metrics) {
      const value = metric.evaluate(pos);
      if (value === null) continue;
      const h = history.get(metric.key);
      if (h) {
        const [prev2, prev1] = h;
        // Coarse local minimum below the (loose) detection threshold —
        // refine, then keep only if the true minimum crosses keepBelow
        if (prev1 < metric.detectBelow && prev1 <= prev2 && prev1 <= value) {
          const centre = new Date(date.getTime() - stepMs);
          const refined = await refineMinimum(metric, centre, stepMs);
          if (refined.value < metric.keepBelow) {
            events.push({
              type: metric.type,
              date: refined.date,
              label: metric.label,
              detail: `${refined.date.toISOString().slice(0, 10)} ${refined.date.toISOString().slice(11, 16)} UTC`,
              focusBodyId: metric.focusBodyId,
            });
          }
        }
        history.set(metric.key, [prev1, value]);
      } else {
        history.set(metric.key, [value, value]);
      }
    }

    if (i % 120 === 0) {
      onProgress?.(i / nSamples);
      await new Promise(r => setTimeout(r, 0)); // stay off the frame budget
    }
  }

  onProgress?.(1);
  events.sort((a, b) => a.date.getTime() - b.date.getTime());
  return events;
}

async function refineMinimum(
  metric: Metric,
  centre: Date,
  windowMs: number
): Promise<{ date: Date; value: number }> {
  // Two passes: ±window at ~22 min resolution, then ±25 min at ~1.5 min
  let best = { date: centre, value: Infinity };
  for (const [halfWindow, steps] of [[windowMs, 16], [25 * 60 * 1000, 16]] as const) {
    const c = best.value === Infinity ? centre : best.date;
    for (let i = -steps; i <= steps; i++) {
      const d = new Date(c.getTime() + (i / steps) * halfWindow);
      const pos = await positionsAt(d);
      if (!pos) continue;
      const v = metric.evaluate(pos);
      if (v !== null && v < best.value) best = { date: d, value: v };
    }
  }
  return best;
}
