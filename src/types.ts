import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Core physics state for a single body
// ---------------------------------------------------------------------------
export interface BodyState {
  id: string;
  name: string;
  mass: number;           // kg
  radius: number;         // meters (physical radius)
  position: THREE.Vector3;  // meters, SI
  velocity: THREE.Vector3;  // m/s, SI
  acceleration: THREE.Vector3;
  color: number;          // hex fallback colour
  texturePath: string | null;
  nightTexturePath: string | null;  // Earth city lights
  isEmissive: boolean;    // true for the Sun
  hasRings: boolean;      // true for Saturn
  hasAtmosphere: boolean;
  trailColor: number;
  isMoon: boolean;
  parentId: string | null;
  rotationPeriod?: number;  // sidereal rotation period in seconds (positive = prograde)
  axialTilt?: number;       // obliquity in radians
  tiltAxisAngle?: number;   // azimuthal angle of tilt axis in sim XZ plane (radians)
}

// ---------------------------------------------------------------------------
// Simulation configuration (shared mutable object)
// ---------------------------------------------------------------------------
export type Integrator = 'RK4' | 'Verlet';

export interface SimulationConfig {
  G: number;              // gravitational constant (m³ kg⁻¹ s⁻²)
  softening: number;      // ε in metres, prevents singularities
  timeStep: number;       // fixed physics step in seconds (3600 = 1 hour)
  timeScale: number;      // multiplier: 1 = real time, 1e6 = 1M× faster
  integrator: Integrator;
  paused: boolean;
  gMode: 'realistic' | 'exaggerated';
  stepsPerFrameCap: number; // max physics steps per render frame
  simulationOverloaded: boolean; // true when steps are being capped
}

// ---------------------------------------------------------------------------
// Render / visual configuration (shared mutable object)
// ---------------------------------------------------------------------------
export interface RenderConfig {
  logScale: boolean;
  logScaleLerp: number;      // 0..1 animation progress for scale switch
  realScale: boolean;         // true = bodies shown at true physical proportions
  showTrails: boolean;
  trailLength: number;       // max trail points per body
  showBloom: boolean;
  bloomStrength: number;
  showAsteroidBelt: boolean;
  showSolarWind: boolean;
  showLagrangePoints: boolean;
  showGravityField: boolean;
  showAtmospheres: boolean;
}

// ---------------------------------------------------------------------------
// Camera configuration (shared mutable object)
// ---------------------------------------------------------------------------
export interface CameraConfig {
  focusBodyId: string | null;
  focusMode: boolean;
}

// ---------------------------------------------------------------------------
// Internal RK4 derivative state (used only in PhysicsEngine)
// ---------------------------------------------------------------------------
export interface DerivativeState {
  dpos: THREE.Vector3;
  dvel: THREE.Vector3;
}

// ---------------------------------------------------------------------------
// God Mode spawn request — built in BodySelector, consumed in main.ts
// ---------------------------------------------------------------------------
export interface SpawnRequest {
  position: THREE.Vector3;  // SI metres
  velocity: THREE.Vector3;  // m/s
  mass: number;
  radius: number;
  color: number;
}

// ---------------------------------------------------------------------------
// Info panel data (refreshed every frame by UIManager)
// ---------------------------------------------------------------------------
export interface InfoData {
  fps: number;
  bodyCount: number;
  selectedName: string;
  selectedVelocity: number;   // m/s magnitude
  selectedDistance: number;   // metres from Sun
  selectedPeriod: number;     // seconds (0 if unbound)
  selectedEscapeV: number;    // m/s escape velocity at surface
  simTimeElapsed: number;     // seconds of simulated time
  stepsOverloaded: boolean;
}

// ---------------------------------------------------------------------------
// Barnes-Hut Octree node (internal to PhysicsEngine)
// ---------------------------------------------------------------------------
export interface OctNode {
  cx: number; cy: number; cz: number;  // centre of bounding box
  size: number;                          // half-width
  totalMass: number;
  comX: number; comY: number; comZ: number;  // centre of mass
  bodyIndex: number;                     // -1 = internal node
  children: (OctNode | null)[];          // 8 children
}
