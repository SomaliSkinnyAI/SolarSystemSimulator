import * as THREE from 'three';
import { BodyState } from '../types';
import { G_REAL, AU, SOLAR_MASS, circularOrbitVelocity } from '../utils/MathUtils';

// ---------------------------------------------------------------------------
// NASA JPL Keplerian Elements for approximate planet positions
// Source: https://ssd.jpl.nasa.gov/planets/approx_pos.html (Table 2a/2b)
// Valid: 3000 BC – 3000 AD (inner planets), 1800–2050 AD (outer, with corrections)
// ---------------------------------------------------------------------------

const DEG2RAD = Math.PI / 180;

interface OrbitalElements {
  a0: number; aDot: number;         // semi-major axis (AU) and rate (AU/century)
  e0: number; eDot: number;         // eccentricity and rate
  I0: number; IDot: number;         // inclination (deg) and rate (deg/cy)
  L0: number; LDot: number;         // mean longitude (deg) and rate (deg/cy)
  wBar0: number; wBarDot: number;   // longitude of perihelion (deg) and rate
  Omega0: number; OmegaDot: number; // longitude of ascending node (deg) and rate
  // Extra correction terms for outer planets (Table 2b)
  b?: number; c?: number; s?: number; f?: number;
}

const ELEMENTS: Record<string, OrbitalElements> = {
  mercury: { a0: 0.38709927, aDot: 0.00000037, e0: 0.20563593, eDot: 0.00001906, I0: 7.00497902, IDot: -0.00594749, L0: 252.25032350, LDot: 149472.67411175, wBar0: 77.45779628, wBarDot: 0.16047689, Omega0: 48.33076593, OmegaDot: -0.12534081 },
  venus:   { a0: 0.72333566, aDot: 0.00000390, e0: 0.00677672, eDot: -0.00004107, I0: 3.39467605, IDot: -0.00078890, L0: 181.97909950, LDot: 58517.81538729, wBar0: 131.60246718, wBarDot: 0.00268329, Omega0: 76.67984255, OmegaDot: -0.27769418 },
  earth:   { a0: 1.00000261, aDot: 0.00000562, e0: 0.01671123, eDot: -0.00004392, I0: -0.00001531, IDot: -0.01294668, L0: 100.46457166, LDot: 35999.37244981, wBar0: 102.93768193, wBarDot: 0.32327364, Omega0: 0.0, OmegaDot: 0.0 },
  mars:    { a0: 1.52371034, aDot: 0.00001847, e0: 0.09339410, eDot: 0.00007882, I0: 1.84969142, IDot: -0.00813131, L0: -4.55343205, LDot: 19140.30268499, wBar0: -23.94362959, wBarDot: 0.44441088, Omega0: 49.55953891, OmegaDot: -0.29257343 },
  jupiter: { a0: 5.20288700, aDot: -0.00011607, e0: 0.04838624, eDot: -0.00013253, I0: 1.30439695, IDot: -0.00183714, L0: 34.39644051, LDot: 3034.74612775, wBar0: 14.72847983, wBarDot: 0.21252668, Omega0: 100.47390909, OmegaDot: 0.20469106, b: -0.00012452, c: 0.06064060, s: -0.35635438, f: 38.35125000 },
  saturn:  { a0: 9.53667594, aDot: -0.00125060, e0: 0.05386179, eDot: -0.00050991, I0: 2.48599187, IDot: 0.00193609, L0: 49.95424423, LDot: 1222.49362201, wBar0: 92.59887831, wBarDot: -0.41897216, Omega0: 113.66242448, OmegaDot: -0.28867794, b: 0.00025899, c: -0.13434469, s: 0.87320147, f: 38.35125000 },
  uranus:  { a0: 19.18916464, aDot: -0.00196176, e0: 0.04725744, eDot: -0.00004397, I0: 0.77263783, IDot: -0.00242939, L0: 313.23810451, LDot: 428.48202785, wBar0: 170.95427630, wBarDot: 0.40805281, Omega0: 74.01692503, OmegaDot: 0.04240589, b: 0.00058331, c: -0.97731848, s: 0.17689245, f: 7.67025000 },
  neptune: { a0: 30.06992276, aDot: 0.00026291, e0: 0.00859048, eDot: 0.00005105, I0: 1.77004347, IDot: 0.00035372, L0: -55.12002969, LDot: 218.45945325, wBar0: 44.96476227, wBarDot: -0.32241464, Omega0: 131.78422574, OmegaDot: -0.00508664, b: -0.00041348, c: 0.68346318, s: -0.10162547, f: 7.67025000 },
};

// ---------------------------------------------------------------------------
// Julian Date and epoch helpers
// ---------------------------------------------------------------------------

function dateToJD(date: Date): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate() + date.getUTCHours() / 24
    + date.getUTCMinutes() / 1440 + date.getUTCSeconds() / 86400;
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy
    + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function centuriesSinceJ2000(date: Date): number {
  return (dateToJD(date) - 2451545.0) / 36525.0;
}

// ---------------------------------------------------------------------------
// Kepler equation solver (Newton-Raphson)
// ---------------------------------------------------------------------------

function solveKepler(M: number, e: number): number {
  let E = M + e * Math.sin(M); // initial guess
  for (let i = 0; i < 50; i++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < 1e-12) break;
  }
  return E;
}

// ---------------------------------------------------------------------------
// Compute heliocentric position and velocity for a planet at epoch T
// ---------------------------------------------------------------------------

function computeHeliocentricState(
  el: OrbitalElements, T: number
): { position: THREE.Vector3; velocity: THREE.Vector3 } {
  // Current elements
  const a_au = el.a0 + el.aDot * T;
  const a = a_au * AU; // metres
  const e = el.e0 + el.eDot * T;
  const I = (el.I0 + el.IDot * T) * DEG2RAD;
  const L = el.L0 + el.LDot * T; // degrees
  const wBar = el.wBar0 + el.wBarDot * T; // degrees
  const Omega = (el.Omega0 + el.OmegaDot * T) * DEG2RAD; // radians

  // Argument of perihelion
  const omega = (wBar - el.Omega0 - el.OmegaDot * T) * DEG2RAD;

  // Mean anomaly (with correction terms for outer planets)
  let M = (L - wBar) * DEG2RAD;
  if (el.b !== undefined) {
    const ft = el.f! * T;
    M += (el.b! * T * T + el.c! * Math.cos(ft * DEG2RAD) + el.s! * Math.sin(ft * DEG2RAD)) * DEG2RAD;
  }
  // Normalize to [-pi, pi]
  M = ((M % (2 * Math.PI)) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;

  // Solve Kepler's equation
  const E = solveKepler(M, e);

  // Orbital plane coordinates
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const sqrtOneMinusE2 = Math.sqrt(1 - e * e);
  const xOrb = a * (cosE - e);
  const yOrb = a * sqrtOneMinusE2 * sinE;

  // Velocity in orbital plane
  const n = Math.sqrt(G_REAL * SOLAR_MASS / (a * a * a)); // mean motion
  const eDotE = n / (1 - e * cosE); // dE/dt
  const vxOrb = -a * sinE * eDotE;
  const vyOrb = a * sqrtOneMinusE2 * cosE * eDotE;

  // Rotation matrix components
  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosI = Math.cos(I), sinI = Math.sin(I);
  const cosW = Math.cos(omega), sinW = Math.sin(omega);

  // Combined rotation: ecliptic coordinates
  const Px = cosO * cosW - sinO * sinW * cosI;
  const Py = sinO * cosW + cosO * sinW * cosI;
  const Pz = sinW * sinI;

  const Qx = -cosO * sinW - sinO * cosW * cosI;
  const Qy = -sinO * sinW + cosO * cosW * cosI;
  const Qz = cosW * sinI;

  const xEcl = Px * xOrb + Qx * yOrb;
  const yEcl = Py * xOrb + Qy * yOrb;
  const zEcl = Pz * xOrb + Qz * yOrb;

  const vxEcl = Px * vxOrb + Qx * vyOrb;
  const vyEcl = Py * vxOrb + Qy * vyOrb;
  const vzEcl = Pz * vxOrb + Qz * vyOrb;

  // Map ecliptic to simulator coords (Y-up, ecliptic in XZ):
  // ecliptic X → sim X, ecliptic Y → sim -Z, ecliptic Z → sim Y
  return {
    position: new THREE.Vector3(xEcl, zEcl, -yEcl),
    velocity: new THREE.Vector3(vxEcl, vzEcl, -vyEcl),
  };
}

// ---------------------------------------------------------------------------
// Body metadata templates (shared between default and real-time modes)
// ---------------------------------------------------------------------------

interface BodyTemplate {
  id: string; name: string; mass: number; radius: number; color: number;
  texturePath: string | null; nightTexturePath: string | null;
  isEmissive: boolean; hasRings: boolean; hasAtmosphere: boolean;
  trailColor: number; isMoon: boolean; parentId: string | null;
  rotationPeriod?: number; axialTilt?: number; tiltAxisAngle?: number;
}

const TEMPLATES: Record<string, BodyTemplate> = {
  sun:     { id: 'sun', name: 'Sun', mass: SOLAR_MASS, radius: 6.957e8, color: 0xFDB813, texturePath: '/textures/sun.jpg', nightTexturePath: null, isEmissive: true, hasRings: false, hasAtmosphere: false, trailColor: 0xFDB813, isMoon: false, parentId: null, rotationPeriod: 2192832, axialTilt: 0.1265 },
  mercury: { id: 'mercury', name: 'Mercury', mass: 3.285e23, radius: 2.4397e6, color: 0xB5B5B5, texturePath: '/textures/mercury.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x888888, isMoon: false, parentId: null, rotationPeriod: 5067014, axialTilt: 0.0006 },
  venus:   { id: 'venus', name: 'Venus', mass: 4.867e24, radius: 6.0518e6, color: 0xE8C87E, texturePath: '/textures/venus.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0xC8A860, isMoon: false, parentId: null, rotationPeriod: -20997360, axialTilt: 3.0962 },
  earth:   { id: 'earth', name: 'Earth', mass: 5.972e24, radius: 6.371e6, color: 0x2E86AB, texturePath: '/textures/earth_day.jpg', nightTexturePath: '/textures/earth_night.jpg', isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0x4090C0, isMoon: false, parentId: null, rotationPeriod: 86164, axialTilt: 0.4091, tiltAxisAngle: Math.PI },
  mars:    { id: 'mars', name: 'Mars', mass: 6.39e23, radius: 3.3895e6, color: 0xC1440E, texturePath: '/textures/mars.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0xA03010, isMoon: false, parentId: null, rotationPeriod: 88642, axialTilt: 0.4396 },
  jupiter: { id: 'jupiter', name: 'Jupiter', mass: 1.898e27, radius: 7.1492e7, color: 0xC88B3A, texturePath: '/textures/jupiter.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0xA87030, isMoon: false, parentId: null, rotationPeriod: 35726, axialTilt: 0.0546 },
  saturn:  { id: 'saturn', name: 'Saturn', mass: 5.683e26, radius: 6.0268e7, color: 0xE8D5A3, texturePath: '/textures/saturn.jpg', nightTexturePath: null, isEmissive: false, hasRings: true, hasAtmosphere: true, trailColor: 0xC8B580, isMoon: false, parentId: null, rotationPeriod: 38362, axialTilt: 0.4665 },
  uranus:  { id: 'uranus', name: 'Uranus', mass: 8.681e25, radius: 2.5559e7, color: 0x7DE8E8, texturePath: '/textures/uranus.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0x50C0C0, isMoon: false, parentId: null, rotationPeriod: -62035, axialTilt: 1.7064 },
  neptune: { id: 'neptune', name: 'Neptune', mass: 1.024e26, radius: 2.4764e7, color: 0x3F54BA, texturePath: '/textures/neptune.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0x3040A0, isMoon: false, parentId: null, rotationPeriod: 57974, axialTilt: 0.4943 },
  pluto:   { id: 'pluto', name: 'Pluto', mass: 1.303e22, radius: 1.1883e6, color: 0xCAAE8B, texturePath: '/textures/pluto.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0xA08060, isMoon: false, parentId: null, rotationPeriod: -551857, axialTilt: 2.1388 },
  // Moons
  moon:      { id: 'moon', name: 'Moon', mass: 7.342e22, radius: 1.7374e6, color: 0xAAAAAA, texturePath: '/textures/moon.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x909090, isMoon: true, parentId: 'earth', rotationPeriod: 2360621, axialTilt: 0.1167 },
  io:        { id: 'io', name: 'Io', mass: 8.932e22, radius: 1.8216e6, color: 0xC8B040, texturePath: '/textures/io.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0xA09030, isMoon: true, parentId: 'jupiter', rotationPeriod: 152854 },
  europa:    { id: 'europa', name: 'Europa', mass: 4.800e22, radius: 1.5608e6, color: 0xBBAA88, texturePath: '/textures/europa.png', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x998870, isMoon: true, parentId: 'jupiter', rotationPeriod: 306720 },
  ganymede:  { id: 'ganymede', name: 'Ganymede', mass: 1.482e23, radius: 2.6341e6, color: 0x8C8880, texturePath: '/textures/ganymede.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x707068, isMoon: true, parentId: 'jupiter', rotationPeriod: 618153 },
  callisto:  { id: 'callisto', name: 'Callisto', mass: 1.076e23, radius: 2.4103e6, color: 0x504840, texturePath: '/textures/callisto.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x403830, isMoon: true, parentId: 'jupiter', rotationPeriod: 1441931 },
  mimas:     { id: 'mimas', name: 'Mimas', mass: 3.749e19, radius: 1.982e5, color: 0xC0C0C0, texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0xA0A0A0, isMoon: true, parentId: 'saturn' },
  enceladus: { id: 'enceladus', name: 'Enceladus', mass: 1.080e20, radius: 2.521e5, color: 0xF0F0FF, texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0xD0D0E0, isMoon: true, parentId: 'saturn' },
  tethys:    { id: 'tethys', name: 'Tethys', mass: 6.175e20, radius: 5.310e5, color: 0xC8C8C0, texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0xA8A8A0, isMoon: true, parentId: 'saturn' },
  dione:     { id: 'dione', name: 'Dione', mass: 1.096e21, radius: 5.613e5, color: 0xB8B0A8, texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x989088, isMoon: true, parentId: 'saturn' },
  rhea:      { id: 'rhea', name: 'Rhea', mass: 2.307e21, radius: 7.638e5, color: 0xB0B0B0, texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x909090, isMoon: true, parentId: 'saturn' },
  titan:     { id: 'titan', name: 'Titan', mass: 1.345e23, radius: 2.5755e6, color: 0xCC9944, texturePath: '/textures/titan.jpg', nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: true, trailColor: 0xAA7730, isMoon: true, parentId: 'saturn', rotationPeriod: 1377648 },
  iapetus:   { id: 'iapetus', name: 'Iapetus', mass: 1.806e21, radius: 7.346e5, color: 0x887766, texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false, hasAtmosphere: false, trailColor: 0x665544, isMoon: true, parentId: 'saturn' },
};

// Moon orbital radii and start angles for spreading
const MOON_ORBITS: Record<string, { parent: string; radius: number; startAngle: number }> = {
  moon:      { parent: 'earth',   radius: 3.844e8,  startAngle: 0 },
  io:        { parent: 'jupiter', radius: 4.217e8,  startAngle: 0 },
  europa:    { parent: 'jupiter', radius: 6.711e8,  startAngle: 90 },
  ganymede:  { parent: 'jupiter', radius: 1.0704e9, startAngle: 180 },
  callisto:  { parent: 'jupiter', radius: 1.8827e9, startAngle: 270 },
  mimas:     { parent: 'saturn',  radius: 1.855e8,  startAngle: 0 },
  enceladus: { parent: 'saturn',  radius: 2.380e8,  startAngle: 51 },
  tethys:    { parent: 'saturn',  radius: 2.947e8,  startAngle: 103 },
  dione:     { parent: 'saturn',  radius: 3.774e8,  startAngle: 154 },
  rhea:      { parent: 'saturn',  radius: 5.271e8,  startAngle: 206 },
  titan:     { parent: 'saturn',  radius: 1.2218e9, startAngle: 257 },
  iapetus:   { parent: 'saturn',  radius: 3.5613e9, startAngle: 309 },
};

// ---------------------------------------------------------------------------
// Simplified Pluto Keplerian elements (not in JPL Table 2a)
// ---------------------------------------------------------------------------
const PLUTO_ELEMENTS: OrbitalElements = {
  a0: 39.48211675, aDot: -0.00031596,
  e0: 0.24882730, eDot: 0.00005170,
  I0: 17.14001206, IDot: 0.00004818,
  L0: 238.92903833, LDot: 145.20780515,
  wBar0: 224.06891629, wBarDot: -0.04062942,
  Omega0: 110.30393684, OmegaDot: -0.01183482,
};

// ---------------------------------------------------------------------------
// Compute all bodies for a given date
// ---------------------------------------------------------------------------

function makeBody(tpl: BodyTemplate, pos: THREE.Vector3, vel: THREE.Vector3): BodyState {
  return {
    ...tpl,
    position: pos,
    velocity: vel,
    acceleration: new THREE.Vector3(),
  };
}

function placeMoon(
  tpl: BodyTemplate,
  parentPos: THREE.Vector3,
  parentVel: THREE.Vector3,
  parentMass: number,
  orbitRadius: number,
  startAngleDeg: number
): BodyState {
  const v = circularOrbitVelocity(G_REAL, parentMass, orbitRadius);
  const parentR = parentPos.length();
  if (parentR < 1) {
    // Parent at origin (shouldn't happen for planets), fallback
    return makeBody(tpl, parentPos.clone(), parentVel.clone());
  }
  const baseDir = parentPos.clone().divideScalar(parentR);
  const baseTan = new THREE.Vector3(baseDir.z, 0, -baseDir.x);

  const angle = startAngleDeg * DEG2RAD;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const radDir = new THREE.Vector3(
    baseDir.x * cosA + baseTan.x * sinA, 0,
    baseDir.z * cosA + baseTan.z * sinA
  ).normalize();
  const tanDir = new THREE.Vector3(
    -baseDir.x * sinA + baseTan.x * cosA, 0,
    -baseDir.z * sinA + baseTan.z * cosA
  ).normalize();

  return makeBody(
    tpl,
    parentPos.clone().addScaledVector(radDir, orbitRadius),
    parentVel.clone().addScaledVector(tanDir, v)
  );
}

export function computeBodiesForDate(date: Date): BodyState[] {
  const T = centuriesSinceJ2000(date);
  const bodies: BodyState[] = [];

  // Sun at origin (barycentric approximation)
  bodies.push(makeBody(TEMPLATES['sun']!, new THREE.Vector3(), new THREE.Vector3()));

  // Planets from Keplerian elements
  const planetIds = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  const planetStates = new Map<string, { pos: THREE.Vector3; vel: THREE.Vector3 }>();

  for (const id of planetIds) {
    const el = ELEMENTS[id]!;
    const { position, velocity } = computeHeliocentricState(el, T);
    planetStates.set(id, { pos: position, vel: velocity });
    bodies.push(makeBody(TEMPLATES[id]!, position, velocity));
  }

  // Pluto
  const plutoState = computeHeliocentricState(PLUTO_ELEMENTS, T);
  planetStates.set('pluto', { pos: plutoState.position, vel: plutoState.velocity });
  bodies.push(makeBody(TEMPLATES['pluto']!, plutoState.position, plutoState.velocity));

  // Moons — placed relative to their parent's computed position
  for (const [moonId, orbit] of Object.entries(MOON_ORBITS)) {
    const parentState = planetStates.get(orbit.parent);
    const parentTpl = TEMPLATES[orbit.parent]!;
    if (!parentState) continue;
    bodies.push(placeMoon(
      TEMPLATES[moonId]!,
      parentState.pos, parentState.vel,
      parentTpl.mass, orbit.radius, orbit.startAngle
    ));
  }

  // Halley's Comet — keep at default aphelion position (not worth ephemeris for a comet)
  const APHELION_HALLEY = 35.08 * AU;
  const HALLEY_V = Math.sqrt(G_REAL * SOLAR_MASS * (2 / APHELION_HALLEY - 1 / (17.834 * AU)));
  const hAngle = 55 * DEG2RAD;
  bodies.push(makeBody(
    { id: 'halley', name: "Halley's Comet", mass: 2.2e14, radius: 5.5e3, color: 0xCCCCCC,
      texturePath: null, nightTexturePath: null, isEmissive: false, hasRings: false,
      hasAtmosphere: false, trailColor: 0xCCCCDD, isMoon: false, parentId: null },
    new THREE.Vector3(APHELION_HALLEY * Math.cos(hAngle), 0, -APHELION_HALLEY * Math.sin(hAngle)),
    new THREE.Vector3(-HALLEY_V * Math.sin(hAngle), 0, -HALLEY_V * Math.cos(hAngle))
  ));

  return bodies;
}

export function formatSimDate(startDate: Date, simTimeElapsed: number): string {
  const d = new Date(startDate.getTime() + simTimeElapsed * 1000);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
