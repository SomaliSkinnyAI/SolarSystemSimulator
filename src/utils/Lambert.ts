// Universal-variable Lambert solver (Bate–Mueller–White / Vallado).
// Pure math, no Three.js — worker- and test-friendly.

export interface Vec3 { x: number; y: number; z: number }

function stumpffC(z: number): number {
  if (z > 1e-6) return (1 - Math.cos(Math.sqrt(z))) / z;
  if (z < -1e-6) return (Math.cosh(Math.sqrt(-z)) - 1) / (-z);
  return 0.5 - z / 24;
}

function stumpffS(z: number): number {
  if (z > 1e-6) {
    const s = Math.sqrt(z);
    return (s - Math.sin(s)) / (s * s * s);
  }
  if (z < -1e-6) {
    const s = Math.sqrt(-z);
    return (Math.sinh(s) - s) / (s * s * s);
  }
  return 1 / 6 - z / 120;
}

export interface LambertResult {
  v1: Vec3;
  v2: Vec3;
}

/**
 * Solve Lambert's problem: velocities of the conic connecting r1→r2 in
 * time-of-flight `tof` around a body with gravitational parameter `mu`.
 * `longWay` selects the >180° transfer branch. Bisection on the universal
 * variable z — slower than Newton but unconditionally robust.
 * All units SI. Returns null when no single-revolution solution exists.
 */
export function solveLambert(
  r1v: Vec3,
  r2v: Vec3,
  tof: number,
  mu: number,
  longWay = false
): LambertResult | null {
  const r1 = Math.hypot(r1v.x, r1v.y, r1v.z);
  const r2 = Math.hypot(r2v.x, r2v.y, r2v.z);
  if (r1 < 1 || r2 < 1 || tof <= 0) return null;

  const cosDnu = (r1v.x * r2v.x + r1v.y * r2v.y + r1v.z * r2v.z) / (r1 * r2);
  const clamped = Math.max(-1, Math.min(1, cosDnu));
  const tm = longWay ? -1 : 1;
  const A = tm * Math.sqrt(r1 * r2 * (1 + clamped));
  if (Math.abs(A) < 1e-6) return null; // 180° transfer: plane undefined

  const sqrtMu = Math.sqrt(mu);
  const yOf = (z: number): number =>
    r1 + r2 + A * (z * stumpffS(z) - 1) / Math.sqrt(Math.max(stumpffC(z), 1e-300));
  const tofOf = (z: number): number | null => {
    const y = yOf(z);
    if (y < 0) return null;
    const C = stumpffC(z);
    const x = Math.sqrt(y / Math.max(C, 1e-300));
    return (x * x * x * stumpffS(z) + A * Math.sqrt(y)) / sqrtMu;
  };

  // Bracket: z ∈ (zLo, zHi); tof grows monotonically with z
  let zLo = -4 * Math.PI * Math.PI;
  let zHi = 4 * Math.PI * Math.PI * 0.999; // just under one full revolution
  // Raise zLo until y(zLo) > 0 (hyperbolic side can go invalid)
  for (let i = 0; i < 60 && yOf(zLo) < 0; i++) zLo = zLo / 2 + 0.1;

  const tLo = tofOf(zLo);
  const tHi = tofOf(zHi);
  if (tLo === null || tHi === null || tof <= tLo || tof >= tHi) return null;

  let z = 0;
  for (let i = 0; i < 80; i++) {
    z = (zLo + zHi) / 2;
    const t = tofOf(z);
    if (t === null || t < tof) zLo = z;
    else zHi = z;
  }

  const y = yOf(z);
  if (y < 0) return null;
  const f = 1 - y / r1;
  const g = A * Math.sqrt(y / mu);
  const gDot = 1 - y / r2;
  if (Math.abs(g) < 1e-9) return null;

  return {
    v1: {
      x: (r2v.x - f * r1v.x) / g,
      y: (r2v.y - f * r1v.y) / g,
      z: (r2v.z - f * r1v.z) / g,
    },
    v2: {
      x: (gDot * r2v.x - r1v.x) / g,
      y: (gDot * r2v.y - r1v.y) / g,
      z: (gDot * r2v.z - r1v.z) / g,
    },
  };
}
