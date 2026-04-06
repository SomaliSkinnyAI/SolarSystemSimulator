import * as THREE from 'three';
import { BodyState } from '../types';
import { G_REAL, AU, circularOrbitVelocity, SOLAR_MASS } from '../utils/MathUtils';

// ---------------------------------------------------------------------------
// Helper: create a body in a circular orbit around the Sun.
// startAngleDeg lets us spread planets around the orbit so they don't all
// pile up on the same axis (which produces a "beam" of overlapping trails).
// Orbit is in the XZ plane (Y-up), counter-clockwise viewed from +Y.
//   pos = (a·cos θ,  0, -a·sin θ)
//   vel = (v·sin θ,  0, -v·cos θ)
// ---------------------------------------------------------------------------
function orbitingBody(
  partial: Omit<BodyState, 'position' | 'velocity' | 'acceleration'>
  & { semiMajorAxis: number; startAngleDeg?: number }
): BodyState {
  const { semiMajorAxis, startAngleDeg = 0, ...rest } = partial;
  const v = circularOrbitVelocity(G_REAL, SOLAR_MASS, semiMajorAxis);
  const θ = (startAngleDeg * Math.PI) / 180;
  return {
    ...rest,
    position: new THREE.Vector3(
      semiMajorAxis * Math.cos(θ),
      0,
      -semiMajorAxis * Math.sin(θ)
    ),
    velocity: new THREE.Vector3(
      -v * Math.sin(θ),
      0,
      -v * Math.cos(θ)
    ),
    acceleration: new THREE.Vector3(),
  };
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------
const SUN: BodyState = {
  id: 'sun',
  name: 'Sun',
  mass: SOLAR_MASS,
  radius: 6.957e8,
  position: new THREE.Vector3(0, 0, 0),
  velocity: new THREE.Vector3(0, 0, 0),
  acceleration: new THREE.Vector3(),
  color: 0xFDB813,
  texturePath: '/textures/sun.jpg',
  nightTexturePath: null,
  isEmissive: true,
  hasRings: false,
  hasAtmosphere: false,
  trailColor: 0xFDB813,
  isMoon: false,
  parentId: null,
  rotationPeriod: 2192832,   // 25.38 days sidereal
  axialTilt: 0.1265,         // 7.25°
};

// ---------------------------------------------------------------------------
// Planets (accurate SI initial conditions)
// ---------------------------------------------------------------------------
const MERCURY = orbitingBody({
  id: 'mercury', name: 'Mercury',
  mass: 3.285e23, radius: 2.4397e6,
  startAngleDeg: 0,
  semiMajorAxis: 5.791e10,
  color: 0xB5B5B5,
  texturePath: '/textures/mercury.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x888888,
  isMoon: false, parentId: null,
  rotationPeriod: 5067014,   // 58.646 days
  axialTilt: 0.0006,         // 0.034°
});

const VENUS = orbitingBody({
  id: 'venus', name: 'Venus',
  mass: 4.867e24, radius: 6.0518e6,
  startAngleDeg: 72,
  semiMajorAxis: 1.0821e11,
  color: 0xE8C87E,
  texturePath: '/textures/venus.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0xC8A860,
  isMoon: false, parentId: null,
  rotationPeriod: -20997360, // 243.025 days retrograde (negative)
  axialTilt: 3.0962,         // 177.36° (nearly upside-down)
});

const EARTH = orbitingBody({
  id: 'earth', name: 'Earth',
  mass: 5.972e24, radius: 6.371e6,
  startAngleDeg: 150,
  semiMajorAxis: 1.496e11,
  color: 0x2E86AB,
  texturePath: '/textures/earth_day.jpg',
  nightTexturePath: '/textures/earth_night.jpg',
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0x4090C0,
  isMoon: false, parentId: null,
  rotationPeriod: 86164,     // 23h 56m 4s sidereal
  axialTilt: 0.4091,         // 23.44°
});

const MARS = orbitingBody({
  id: 'mars', name: 'Mars',
  mass: 6.39e23, radius: 3.3895e6,
  startAngleDeg: 240,
  semiMajorAxis: 2.279e11,
  color: 0xC1440E,
  texturePath: '/textures/mars.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0xA03010,
  isMoon: false, parentId: null,
  rotationPeriod: 88642,     // 1.026 days
  axialTilt: 0.4396,         // 25.19°
});

const JUPITER = orbitingBody({
  id: 'jupiter', name: 'Jupiter',
  mass: 1.898e27, radius: 7.1492e7,
  startAngleDeg: 305,
  semiMajorAxis: 7.785e11,
  color: 0xC88B3A,
  texturePath: '/textures/jupiter.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0xA87030,
  isMoon: false, parentId: null,
  rotationPeriod: 35726,     // 9.925 hours
  axialTilt: 0.0546,         // 3.13°
});

const SATURN = orbitingBody({
  id: 'saturn', name: 'Saturn',
  mass: 5.683e26, radius: 6.0268e7,
  startAngleDeg: 35,
  semiMajorAxis: 1.432e12,
  color: 0xE8D5A3,
  texturePath: '/textures/saturn.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: true, hasAtmosphere: true,
  trailColor: 0xC8B580,
  isMoon: false, parentId: null,
  rotationPeriod: 38362,     // 10.66 hours
  axialTilt: 0.4665,         // 26.73°
});

const URANUS = orbitingBody({
  id: 'uranus', name: 'Uranus',
  mass: 8.681e25, radius: 2.5559e7,
  startAngleDeg: 125,
  semiMajorAxis: 2.867e12,
  color: 0x7DE8E8,
  texturePath: '/textures/uranus.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0x50C0C0,
  isMoon: false, parentId: null,
  rotationPeriod: -62035,    // 17.24 hours retrograde
  axialTilt: 1.7064,         // 97.77° (rolls on its side)
});

const NEPTUNE = orbitingBody({
  id: 'neptune', name: 'Neptune',
  mass: 1.024e26, radius: 2.4764e7,
  startAngleDeg: 210,
  semiMajorAxis: 4.515e12,
  color: 0x3F54BA,
  texturePath: '/textures/neptune.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0x3040A0,
  isMoon: false, parentId: null,
  rotationPeriod: 57974,     // 16.11 hours
  axialTilt: 0.4943,         // 28.32°
});

const PLUTO = orbitingBody({
  id: 'pluto', name: 'Pluto',
  mass: 1.303e22, radius: 1.1883e6,
  startAngleDeg: 280,
  semiMajorAxis: 5.906e12,
  color: 0xCAAE8B,
  texturePath: '/textures/pluto.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0xA08060,
  isMoon: false, parentId: null,
  rotationPeriod: -551857,   // 6.387 days retrograde
  axialTilt: 2.1388,         // 122.53°
});

// ---------------------------------------------------------------------------
// Halley's Comet — starts near perihelion (0.586 AU from Sun)
// Perihelion velocity ≈ 54,500 m/s; orbital inclination simplified to ecliptic.
// ---------------------------------------------------------------------------
// Place Halley near aphelion (quiet, far out) so it doesn't create a blazing
// beam across the inner solar system at startup. Aphelion ≈ 35 AU.
const APHELION_HALLEY = 35.08 * AU;
const HALLEY_V_APHELION = Math.sqrt(G_REAL * SOLAR_MASS * (2 / APHELION_HALLEY - 1 / (17.834 * AU)));
const _halleyAngle = 55 * Math.PI / 180;
const HALLEY: BodyState = {
  id: 'halley', name: "Halley's Comet",
  mass: 2.2e14, radius: 5.5e3,
  position: new THREE.Vector3(
    APHELION_HALLEY * Math.cos(_halleyAngle),
    0,
    -APHELION_HALLEY * Math.sin(_halleyAngle)
  ),
  velocity: new THREE.Vector3(
    -HALLEY_V_APHELION * Math.sin(_halleyAngle),
    0,
    -HALLEY_V_APHELION * Math.cos(_halleyAngle)
  ),
  acceleration: new THREE.Vector3(),
  color: 0xCCCCCC,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0xCCCCDD,
  isMoon: false, parentId: null,
};

// ---------------------------------------------------------------------------
// Helper: create a moon in a circular orbit around any parent body.
// startAngleDeg spreads moons around the parent to avoid overlap.
// The moon gets heliocentric position/velocity = parent + orbital offset.
// ---------------------------------------------------------------------------
function moonAroundParent(
  parent: BodyState,
  partial: Omit<BodyState, 'position' | 'velocity' | 'acceleration'>,
  orbitRadius: number,
  startAngleDeg: number = 0
): BodyState {
  const v = circularOrbitVelocity(G_REAL, parent.mass, orbitRadius);
  const parentR = parent.position.length();

  // Base radial and tangential directions from parent's heliocentric position
  const baseDir = parent.position.clone().divideScalar(parentR); // radial outward
  const baseTan = new THREE.Vector3(baseDir.z, 0, -baseDir.x);  // 90° CCW prograde

  // Rotate by startAngle around Y axis to spread moons
  const angle = (startAngleDeg * Math.PI) / 180;
  const cosA = Math.cos(angle), sinA = Math.sin(angle);
  const radDir = new THREE.Vector3(
    baseDir.x * cosA + baseTan.x * sinA,
    0,
    baseDir.z * cosA + baseTan.z * sinA
  ).normalize();
  const tanDir = new THREE.Vector3(
    -baseDir.x * sinA + baseTan.x * cosA,
    0,
    -baseDir.z * sinA + baseTan.z * cosA
  ).normalize();

  return {
    ...partial,
    position: parent.position.clone().addScaledVector(radDir, orbitRadius),
    velocity: parent.velocity.clone().addScaledVector(tanDir, v),
    acceleration: new THREE.Vector3(),
  };
}

// ---------------------------------------------------------------------------
// Earth's Moon
// ---------------------------------------------------------------------------
const MOON = moonAroundParent(EARTH, {
  id: 'moon', name: 'Moon',
  mass: 7.342e22, radius: 1.7374e6,
  color: 0xAAAAAA,
  texturePath: '/textures/moon.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x909090,
  isMoon: true, parentId: 'earth',
  rotationPeriod: 2360621,   // 27.322 days (tidally locked)
  axialTilt: 0.1167,         // 6.687°
}, 3.844e8, 0);

// ---------------------------------------------------------------------------
// Jupiter's Galilean Moons
// ---------------------------------------------------------------------------
const IO = moonAroundParent(JUPITER, {
  id: 'io', name: 'Io',
  mass: 8.932e22, radius: 1.8216e6,
  color: 0xC8B040,
  texturePath: '/textures/io.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0xA09030,
  isMoon: true, parentId: 'jupiter',
  rotationPeriod: 152854,    // 1.769 days (tidally locked)
}, 4.217e8, 0);

const EUROPA = moonAroundParent(JUPITER, {
  id: 'europa', name: 'Europa',
  mass: 4.800e22, radius: 1.5608e6,
  color: 0xBBAA88,
  texturePath: '/textures/europa.png', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x998870,
  isMoon: true, parentId: 'jupiter',
  rotationPeriod: 306720,    // 3.551 days (tidally locked)
}, 6.711e8, 90);

const GANYMEDE = moonAroundParent(JUPITER, {
  id: 'ganymede', name: 'Ganymede',
  mass: 1.482e23, radius: 2.6341e6,
  color: 0x8C8880,
  texturePath: '/textures/ganymede.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x707068,
  isMoon: true, parentId: 'jupiter',
  rotationPeriod: 618153,    // 7.155 days (tidally locked)
}, 1.0704e9, 180);

const CALLISTO = moonAroundParent(JUPITER, {
  id: 'callisto', name: 'Callisto',
  mass: 1.076e23, radius: 2.4103e6,
  color: 0x504840,
  texturePath: '/textures/callisto.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x403830,
  isMoon: true, parentId: 'jupiter',
  rotationPeriod: 1441931,   // 16.689 days (tidally locked)
}, 1.8827e9, 270);

// ---------------------------------------------------------------------------
// Saturn's Major Moons
// ---------------------------------------------------------------------------
const MIMAS = moonAroundParent(SATURN, {
  id: 'mimas', name: 'Mimas',
  mass: 3.749e19, radius: 1.982e5,
  color: 0xC0C0C0,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0xA0A0A0,
  isMoon: true, parentId: 'saturn',
}, 1.855e8, 0);

const ENCELADUS = moonAroundParent(SATURN, {
  id: 'enceladus', name: 'Enceladus',
  mass: 1.080e20, radius: 2.521e5,
  color: 0xF0F0FF,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0xD0D0E0,
  isMoon: true, parentId: 'saturn',
}, 2.380e8, 51);

const TETHYS = moonAroundParent(SATURN, {
  id: 'tethys', name: 'Tethys',
  mass: 6.175e20, radius: 5.310e5,
  color: 0xC8C8C0,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0xA8A8A0,
  isMoon: true, parentId: 'saturn',
}, 2.947e8, 103);

const DIONE = moonAroundParent(SATURN, {
  id: 'dione', name: 'Dione',
  mass: 1.096e21, radius: 5.613e5,
  color: 0xB8B0A8,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x989088,
  isMoon: true, parentId: 'saturn',
}, 3.774e8, 154);

const RHEA = moonAroundParent(SATURN, {
  id: 'rhea', name: 'Rhea',
  mass: 2.307e21, radius: 7.638e5,
  color: 0xB0B0B0,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x909090,
  isMoon: true, parentId: 'saturn',
}, 5.271e8, 206);

const TITAN = moonAroundParent(SATURN, {
  id: 'titan', name: 'Titan',
  mass: 1.345e23, radius: 2.5755e6,
  color: 0xCC9944,
  texturePath: '/textures/titan.jpg', nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: true,
  trailColor: 0xAA7730,
  isMoon: true, parentId: 'saturn',
  rotationPeriod: 1377648,   // 15.945 days (tidally locked)
}, 1.2218e9, 257);

const IAPETUS = moonAroundParent(SATURN, {
  id: 'iapetus', name: 'Iapetus',
  mass: 1.806e21, radius: 7.346e5,
  color: 0x887766,
  texturePath: null, nightTexturePath: null,
  isEmissive: false, hasRings: false, hasAtmosphere: false,
  trailColor: 0x665544,
  isMoon: true, parentId: 'saturn',
}, 3.5613e9, 309);

// ---------------------------------------------------------------------------
// Exported initial state — deep-clone positions/velocities each reset
// ---------------------------------------------------------------------------
export const INITIAL_BODIES: BodyState[] = [
  SUN, MERCURY, VENUS, EARTH, MOON, MARS,
  JUPITER, IO, EUROPA, GANYMEDE, CALLISTO,
  SATURN, MIMAS, ENCELADUS, TETHYS, DIONE, RHEA, TITAN, IAPETUS,
  URANUS, NEPTUNE, PLUTO, HALLEY,
];

/** Deep-clone the initial body array (positions and velocities are Vector3 objects). */
export function cloneInitialBodies(): BodyState[] {
  return INITIAL_BODIES.map(b => ({
    ...b,
    position: b.position.clone(),
    velocity: b.velocity.clone(),
    acceleration: b.acceleration.clone(),
  }));
}

// ---------------------------------------------------------------------------
// Unique ID generator for spawned bodies
// ---------------------------------------------------------------------------
let _spawnCounter = 0;
export function nextBodyId(): string {
  return `spawned_${++_spawnCounter}`;
}

export { G_REAL };
