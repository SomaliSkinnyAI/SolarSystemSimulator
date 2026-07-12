import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PhysicsEngine } from '../src/physics/PhysicsEngine';
import { CelestialBody } from '../src/physics/CelestialBody';
import { measureConservation, driftFrom } from '../src/utils/ConservationMonitor';
import { G_REAL, AU, SOLAR_MASS } from '../src/utils/MathUtils';
import { SimulationConfig, BodyState } from '../src/types';

// PhysicsEngine only touches body.state and dispose() — a DOM-free stub
// stands in for the full CelestialBody.
function makeTestBody(partial: Partial<BodyState>): CelestialBody {
  const state: BodyState = {
    id: partial.id ?? 'test',
    name: partial.name ?? 'Test',
    mass: partial.mass ?? 1e24,
    radius: partial.radius ?? 1e6,
    position: partial.position ?? new THREE.Vector3(),
    velocity: partial.velocity ?? new THREE.Vector3(),
    acceleration: new THREE.Vector3(),
    color: 0xffffff,
    texturePath: null,
    nightTexturePath: null,
    isEmissive: false,
    hasRings: false,
    hasAtmosphere: false,
    trailColor: 0xffffff,
    isMoon: false,
    parentId: null,
    ...partial,
  };
  return { state, dispose() { /* no mesh in tests */ } } as unknown as CelestialBody;
}

function makeConfig(overrides: Partial<SimulationConfig> = {}): SimulationConfig {
  return {
    G: G_REAL,
    softening: 1e5,
    timeStep: 3600,
    timeScale: 3600,
    integrator: 'RK4',
    relativity: false,
    paused: false,
    gMode: 'realistic',
    stepsPerFrameCap: 1_000_000,
    simulationOverloaded: false,
    ...overrides,
  };
}

function makeSunEarth(): CelestialBody[] {
  const v = Math.sqrt(G_REAL * SOLAR_MASS / AU);
  return [
    makeTestBody({ id: 'sun', mass: SOLAR_MASS, radius: 6.957e8 }),
    makeTestBody({
      id: 'earth', mass: 5.972e24, radius: 6.371e6,
      position: new THREE.Vector3(AU, 0, 0),
      velocity: new THREE.Vector3(0, 0, -v),
    }),
  ];
}

describe('RK4 two-body integration', () => {
  it('conserves energy and angular momentum over ~400 days', () => {
    const bodies = makeSunEarth();
    const engine = new PhysicsEngine(bodies, makeConfig());
    const baseline = measureConservation(bodies.map(b => b.state), G_REAL);

    for (let i = 0; i < 10_000; i++) engine.step(1); // 10k hourly substeps

    const drift = driftFrom(baseline, measureConservation(bodies.map(b => b.state), G_REAL));
    expect(drift.energyPpm).toBeLessThan(0.01);   // < 1e-8 relative
    expect(drift.angMomPpm).toBeLessThan(0.01);
  });

  it('returns Earth to its starting longitude after one sidereal year', () => {
    const bodies = makeSunEarth();
    const engine = new PhysicsEngine(bodies, makeConfig());
    const period = 2 * Math.PI * Math.sqrt(AU ** 3 / (G_REAL * SOLAR_MASS));

    const hours = Math.round(period / 3600);
    for (let i = 0; i < hours; i++) engine.step(1);
    // Finish the fractional remainder of the period
    engine.step((period - hours * 3600) / 3600);

    const earth = bodies[1]!.state;
    const angle = Math.atan2(-earth.position.z, earth.position.x);
    expect(Math.abs(angle)).toBeLessThan(0.005); // < 0.3°
  });

  it('applies extra perihelion advance when relativity is enabled', () => {
    // Mercury-like eccentric orbit: perihelion precesses only with 1PN on
    const run = (relativity: boolean): number => {
      const a = 5.79e10;
      const e = 0.2056;
      const rp = a * (1 - e);
      const vp = Math.sqrt(G_REAL * SOLAR_MASS * (2 / rp - 1 / a));
      const bodies = [
        makeTestBody({ id: 'sun', mass: SOLAR_MASS, radius: 6.957e8 }),
        makeTestBody({
          id: 'mercury', mass: 3.301e23, radius: 2.44e6,
          position: new THREE.Vector3(rp, 0, 0),
          velocity: new THREE.Vector3(0, 0, -vp),
        }),
      ];
      const engine = new PhysicsEngine(bodies, makeConfig({ relativity, timeStep: 600, timeScale: 600 }));
      // ~ 4 Mercury years
      for (let i = 0; i < 50_000; i++) engine.step(1);
      // Perihelion direction from the (Laplace-Runge-Lenz-ish) eccentricity vector
      const s = bodies[1]!.state;
      const r = s.position.clone();
      const v = s.velocity.clone();
      const mu = G_REAL * SOLAR_MASS;
      const h = new THREE.Vector3().crossVectors(r, v);
      const eVec = new THREE.Vector3().crossVectors(v, h).divideScalar(mu)
        .sub(r.clone().normalize());
      return Math.atan2(-eVec.z, eVec.x);
    };
    const newtonian = run(false);
    const gr = run(true);
    // GR advance for Mercury ≈ 5e-7 rad per orbit — after 4 orbits ≈ 2e-6 rad.
    // Just assert the 1PN term produces a measurably LARGER perihelion angle
    // than the Newtonian run (which should stay ~fixed).
    expect(gr).not.toBeCloseTo(newtonian, 9);
    expect(gr - newtonian).toBeGreaterThan(0);
  });
});

describe('collision merging', () => {
  it('conserves momentum and volume when bodies merge', () => {
    const bodies = [
      makeTestBody({
        id: 'a', mass: 2e24, radius: 1e6,
        position: new THREE.Vector3(0, 0, 0),
        velocity: new THREE.Vector3(100, 0, 0),
      }),
      makeTestBody({
        id: 'b', mass: 1e24, radius: 8e5,
        position: new THREE.Vector3(1000, 0, 0), // deep overlap
        velocity: new THREE.Vector3(-50, 0, 0),
      }),
    ];
    const engine = new PhysicsEngine(bodies, makeConfig({ timeStep: 1, timeScale: 1 }));
    engine.step(1);

    expect(engine.bodies.length).toBe(1);
    const merged = engine.bodies[0]!.state;
    expect(merged.mass).toBeCloseTo(3e24, 5);
    // Momentum: 2e24·100 − 1e24·50 = 1.5e26 → v = 50 m/s
    expect(merged.velocity.x).toBeCloseTo(50, 3);
    expect(merged.radius).toBeCloseTo(Math.cbrt(1e18 + 5.12e17), 0);
  });

  it('never merges kinematic spacecraft', () => {
    const bodies = [
      makeTestBody({ id: 'craft1', mass: 700, radius: 10, isSpacecraft: true }),
      makeTestBody({ id: 'craft2', mass: 700, radius: 10, isSpacecraft: true }),
    ];
    const engine = new PhysicsEngine(bodies, makeConfig({ timeStep: 1, timeScale: 1 }));
    engine.step(1);
    expect(engine.bodies.length).toBe(2);
  });
});
