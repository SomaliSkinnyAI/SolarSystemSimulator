// Pure math helpers — no Three.js imports so these can move to a Web Worker later.

export const G_REAL = 6.674e-11;        // m³ kg⁻¹ s⁻²
export const G_EXAGGERATED = 6.674e-9;  // 100× — makes orbits visually faster at 1× time scale
export const AU = 1.496e11;             // metres per Astronomical Unit
export const SOLAR_MASS = 1.989e30;     // kg
export const SPEED_OF_LIGHT = 299792458; // m/s

/**
 * Distance of the collinear Lagrange points L1/L2 from the SECONDARY, as a
 * fraction γ of the primary–secondary separation. Solves the Euler quintic
 * by Newton iteration seeded with the Hill-radius estimate (μ/3)^(1/3).
 * μ = m2/(m1+m2).
 */
export function collinearLagrangeGamma(mu: number, which: 'L1' | 'L2'): number {
  let g = Math.cbrt(mu / 3);
  for (let i = 0; i < 30; i++) {
    let f: number;
    let df: number;
    if (which === 'L1') {
      f = g ** 5 - (3 - mu) * g ** 4 + (3 - 2 * mu) * g ** 3 - mu * g ** 2 + 2 * mu * g - mu;
      df = 5 * g ** 4 - 4 * (3 - mu) * g ** 3 + 3 * (3 - 2 * mu) * g ** 2 - 2 * mu * g + 2 * mu;
    } else {
      f = g ** 5 + (3 - mu) * g ** 4 + (3 - 2 * mu) * g ** 3 - mu * g ** 2 - 2 * mu * g - mu;
      df = 5 * g ** 4 + 4 * (3 - mu) * g ** 3 + 3 * (3 - 2 * mu) * g ** 2 - 2 * mu * g - 2 * mu;
    }
    const step = f / df;
    g -= step;
    if (Math.abs(step) < 1e-14) break;
  }
  return g;
}

// ---------------------------------------------------------------------------
// Orbital mechanics
// ---------------------------------------------------------------------------

/** Speed of a circular orbit around a central body. v = √(GM/r) */
export function circularOrbitVelocity(G: number, centralMass: number, radius: number): number {
  return Math.sqrt(G * centralMass / radius);
}

/** Keplerian orbital period. T = 2π √(a³/GM) */
export function keplerPeriod(G: number, totalMass: number, semiMajorAxis: number): number {
  return 2 * Math.PI * Math.sqrt(Math.pow(semiMajorAxis, 3) / (G * totalMass));
}

/** Surface escape velocity. v_esc = √(2GM/r) */
export function escapeVelocity(G: number, mass: number, radius: number): number {
  return Math.sqrt(2 * G * mass / radius);
}

/**
 * Estimate orbital period from current specific orbital energy.
 * Works for bound orbits (returns 0 for unbound/hyperbolic).
 * ε = v²/2 − GM/r   (specific orbital energy)
 * a = −GM/(2ε)       (semi-major axis)
 * T = 2π √(a³/GM)
 */
export function periodFromOrbitalEnergy(
  G: number,
  centralMass: number,
  relX: number, relY: number, relZ: number,
  vx: number, vy: number, vz: number
): number {
  const r = Math.sqrt(relX * relX + relY * relY + relZ * relZ);
  const v2 = vx * vx + vy * vy + vz * vz;
  const eps = v2 / 2 - G * centralMass / r;
  if (eps >= 0) return 0; // unbound
  const a = -G * centralMass / (2 * eps);
  return 2 * Math.PI * Math.sqrt(a * a * a / (G * centralMass));
}

export interface OrbitalElementsSummary {
  semiMajorAxis: number;
  eccentricity: number;
  inclination: number;
  periapsis: number;
  apoapsis: number;
  bound: boolean;
}

/**
 * Estimate osculating orbital elements from a two-body state vector.
 * The simulator uses Y as the ecliptic normal, so inclination is measured
 * against the XZ-plane.
 */
export function orbitalElementsFromState(
  G: number,
  centralMass: number,
  rx: number, ry: number, rz: number,
  vx: number, vy: number, vz: number
): OrbitalElementsSummary {
  const mu = G * centralMass;
  const r = Math.sqrt(rx * rx + ry * ry + rz * rz);
  const v2 = vx * vx + vy * vy + vz * vz;

  const hx = ry * vz - rz * vy;
  const hy = rz * vx - rx * vz;
  const hz = rx * vy - ry * vx;
  const h = Math.sqrt(hx * hx + hy * hy + hz * hz);

  if (r <= 0 || h <= 0 || mu <= 0) {
    return { semiMajorAxis: 0, eccentricity: 0, inclination: 0, periapsis: 0, apoapsis: 0, bound: false };
  }

  // e = (v x h) / mu - r / |r|
  const vCrossHx = vy * hz - vz * hy;
  const vCrossHy = vz * hx - vx * hz;
  const vCrossHz = vx * hy - vy * hx;
  const ex = vCrossHx / mu - rx / r;
  const ey = vCrossHy / mu - ry / r;
  const ez = vCrossHz / mu - rz / r;
  const e = Math.sqrt(ex * ex + ey * ey + ez * ez);

  const eps = v2 / 2 - mu / r;
  if (eps >= 0) {
    return { semiMajorAxis: 0, eccentricity: e, inclination: Math.acos(hy / h), periapsis: 0, apoapsis: 0, bound: false };
  }

  const a = -mu / (2 * eps);
  return {
    semiMajorAxis: a,
    eccentricity: e,
    inclination: Math.acos(Math.max(-1, Math.min(1, hy / h))),
    periapsis: a * (1 - e),
    apoapsis: a * (1 + e),
    bound: true,
  };
}

// ---------------------------------------------------------------------------
// Lagrange point approximations (distances from the primary)
// ---------------------------------------------------------------------------

/** L1 distance from primary (Hill sphere approximation). */
export function lagrangeL1Distance(primaryMass: number, secondaryMass: number, separation: number): number {
  return separation * Math.pow(secondaryMass / (3 * primaryMass), 1 / 3);
}

/** L2 is symmetric to L1 on the far side. */
export function lagrangeL2Distance(primaryMass: number, secondaryMass: number, separation: number): number {
  return lagrangeL1Distance(primaryMass, secondaryMass, separation);
}

// ---------------------------------------------------------------------------
// Distance with softening — prevents division-by-zero in gravity
// ---------------------------------------------------------------------------

/** √(dx²+dy²+dz²+ε²) */
export function softDistance(dx: number, dy: number, dz: number, epsilon: number): number {
  return Math.sqrt(dx * dx + dy * dy + dz * dz + epsilon * epsilon);
}

/** Plain 3D distance (no softening). */
export function distance3(dx: number, dy: number, dz: number): number {
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------
// Circular buffer helpers
// ---------------------------------------------------------------------------

/** Push a value into a circular Float32Array buffer of stride `stride`. */
export function circularPush(
  buffer: Float32Array,
  head: number,
  maxCount: number,
  stride: number,
  values: number[]
): number {
  const base = head * stride;
  for (let i = 0; i < stride; i++) {
    buffer[base + i] = values[i] ?? 0;
  }
  return (head + 1) % maxCount;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

export function formatDistance(metres: number): string {
  const au = metres / AU;
  if (au >= 0.01) return `${au.toFixed(3)} AU`;
  const km = metres / 1000;
  return `${km.toExponential(2)} km`;
}

export function formatVelocity(mps: number): string {
  return `${(mps / 1000).toFixed(2)} km/s`;
}

export function formatMass(kg: number): string {
  const exp = Math.floor(Math.log10(kg));
  const mantissa = kg / Math.pow(10, exp);
  return `${mantissa.toFixed(2)} × 10^${exp} kg`;
}

export function formatTime(seconds: number): string {
  if (seconds < 3600) return `${seconds.toFixed(0)} s`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} hr`;
  if (seconds < 86400 * 365.25) return `${(seconds / 86400).toFixed(1)} d`;
  return `${(seconds / (86400 * 365.25)).toFixed(2)} yr`;
}

// ---------------------------------------------------------------------------
// Colour utilities
// ---------------------------------------------------------------------------

/** Linearly interpolate between two hex colours. */
export function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const rr = Math.round(ar + (br - ar) * t);
  const rg = Math.round(ag + (bg - ag) * t);
  const rb = Math.round(ab + (bb - ab) * t);
  return (rr << 16) | (rg << 8) | rb;
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------

/** Uniform random in [min, max]. */
export function randRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random point on the surface of a unit sphere (Marsaglia). */
export function randomOnSphere(): [number, number, number] {
  let x, y, z, r;
  do {
    x = Math.random() * 2 - 1;
    y = Math.random() * 2 - 1;
    z = Math.random() * 2 - 1;
    r = x * x + y * y + z * z;
  } while (r > 1 || r === 0);
  const inv = 1 / Math.sqrt(r);
  return [x * inv, y * inv, z * inv];
}
