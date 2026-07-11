import { BodyState } from '../types';
import { formatDistance, formatVelocity, orbitalElementsFromState } from './MathUtils';

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
