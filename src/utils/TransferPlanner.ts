import { BodyState } from '../types';

export interface HohmannTransferEstimate {
  originName: string;
  targetName: string;
  transferType: 'outbound' | 'inbound';
  deltaVDeparture: number;
  deltaVArrival: number;
  deltaVTotal: number;
  timeOfFlight: number;
  idealPhaseAngleDeg: number;
  currentPhaseAngleDeg: number;
  phaseErrorDeg: number;
}

function normalizeRadians(angle: number): number {
  const twoPi = Math.PI * 2;
  return ((angle % twoPi) + twoPi) % twoPi;
}

function normalizeSignedDegrees(angle: number): number {
  let deg = ((angle % 360) + 360) % 360;
  if (deg > 180) deg -= 360;
  return deg;
}

function eclipticLongitude(x: number, z: number): number {
  return Math.atan2(-z, x);
}

export function estimateHohmannTransfer(
  primary: BodyState,
  origin: BodyState,
  target: BodyState,
  G: number
): HohmannTransferEstimate | null {
  if (origin.id === target.id || primary.mass <= 0 || G <= 0) return null;

  const mu = G * primary.mass;
  const originRel = origin.position.clone().sub(primary.position);
  const targetRel = target.position.clone().sub(primary.position);
  const r1 = originRel.length();
  const r2 = targetRel.length();
  if (r1 <= 0 || r2 <= 0 || !Number.isFinite(r1) || !Number.isFinite(r2)) return null;

  const transferA = (r1 + r2) * 0.5;
  const circularV1 = Math.sqrt(mu / r1);
  const circularV2 = Math.sqrt(mu / r2);
  const transferV1 = Math.sqrt(mu * (2 / r1 - 1 / transferA));
  const transferV2 = Math.sqrt(mu * (2 / r2 - 1 / transferA));
  const deltaVDeparture = Math.abs(transferV1 - circularV1);
  const deltaVArrival = Math.abs(circularV2 - transferV2);
  const timeOfFlight = Math.PI * Math.sqrt(Math.pow(transferA, 3) / mu);
  const targetMeanMotion = Math.sqrt(mu / Math.pow(r2, 3));

  const idealPhase = normalizeRadians(Math.PI - targetMeanMotion * timeOfFlight);
  const originLon = eclipticLongitude(originRel.x, originRel.z);
  const targetLon = eclipticLongitude(targetRel.x, targetRel.z);
  const currentPhase = normalizeRadians(targetLon - originLon);

  const idealPhaseAngleDeg = idealPhase * 180 / Math.PI;
  const currentPhaseAngleDeg = currentPhase * 180 / Math.PI;

  return {
    originName: origin.name,
    targetName: target.name,
    transferType: r2 > r1 ? 'outbound' : 'inbound',
    deltaVDeparture,
    deltaVArrival,
    deltaVTotal: deltaVDeparture + deltaVArrival,
    timeOfFlight,
    idealPhaseAngleDeg,
    currentPhaseAngleDeg,
    phaseErrorDeg: normalizeSignedDegrees(currentPhaseAngleDeg - idealPhaseAngleDeg),
  };
}
