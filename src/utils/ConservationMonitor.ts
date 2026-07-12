import { BodyState } from '../types';

// ---------------------------------------------------------------------------
// Integrator quality meter: total energy, angular momentum, and barycentre
// drift relative to a baseline captured whenever the body set (or G) changes.
// Kinematic spacecraft are excluded — their externally-driven states would
// register as fake non-conservation.
// ---------------------------------------------------------------------------

export interface ConservationSample {
  energy: number;      // J
  Lx: number; Ly: number; Lz: number; // kg·m²/s
  comX: number; comY: number; comZ: number; // m
  totalMass: number;
}

export function measureConservation(states: BodyState[], G: number): ConservationSample {
  const bodies = states.filter(s => !s.isSpacecraft);
  let ke = 0;
  let pe = 0;
  let Lx = 0, Ly = 0, Lz = 0;
  let comX = 0, comY = 0, comZ = 0;
  let M = 0;

  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i]!;
    ke += 0.5 * a.mass * a.velocity.lengthSq();
    Lx += a.mass * (a.position.y * a.velocity.z - a.position.z * a.velocity.y);
    Ly += a.mass * (a.position.z * a.velocity.x - a.position.x * a.velocity.z);
    Lz += a.mass * (a.position.x * a.velocity.y - a.position.y * a.velocity.x);
    comX += a.mass * a.position.x;
    comY += a.mass * a.position.y;
    comZ += a.mass * a.position.z;
    M += a.mass;
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j]!;
      const r = a.position.distanceTo(b.position);
      if (r > 1) pe -= G * a.mass * b.mass / r;
    }
  }

  return {
    energy: ke + pe,
    Lx, Ly, Lz,
    comX: comX / M, comY: comY / M, comZ: comZ / M,
    totalMass: M,
  };
}

export interface ConservationDrift {
  energyPpm: number;
  angMomPpm: number;
  comDriftKm: number;
}

export function driftFrom(baseline: ConservationSample, now: ConservationSample): ConservationDrift {
  const dE = Math.abs(now.energy - baseline.energy) / Math.max(Math.abs(baseline.energy), 1e-30);
  const L0 = Math.hypot(baseline.Lx, baseline.Ly, baseline.Lz);
  const dL = Math.hypot(now.Lx - baseline.Lx, now.Ly - baseline.Ly, now.Lz - baseline.Lz)
    / Math.max(L0, 1e-30);
  const com = Math.hypot(now.comX - baseline.comX, now.comY - baseline.comY, now.comZ - baseline.comZ);
  return {
    energyPpm: dE * 1e6,
    angMomPpm: dL * 1e6,
    comDriftKm: com / 1000,
  };
}
