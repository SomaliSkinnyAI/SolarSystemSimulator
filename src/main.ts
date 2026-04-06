import * as THREE from 'three';
import { SimulationConfig, RenderConfig, CameraConfig } from './types';
import { cloneInitialBodies, nextBodyId } from './data/solarSystemData';
import { G_REAL, G_EXAGGERATED } from './utils/MathUtils';
import { DISPLAY_SCALE } from './utils/CoordinateSystem';
import { computeBodiesForDate, formatSimDate } from './data/realTimeOrbits';
import { CelestialBody } from './physics/CelestialBody';
import { PhysicsEngine } from './physics/PhysicsEngine';
import { SceneManager } from './rendering/SceneManager';
import { TrailRenderer } from './rendering/TrailRenderer';
import { BodySelector } from './ui/BodySelector';
import { UIManager } from './ui/UIManager';

// ---------------------------------------------------------------------------
// Shared mutable state — all subsystems read from these objects each frame
// ---------------------------------------------------------------------------
const simConfig: SimulationConfig = {
  G: G_REAL,
  softening: 1e5,
  timeStep: 3600,          // 1 hour per physics step
  timeScale: 50000,         // start at 50 000× (Mercury orbit ≈ 2.5 min, Earth ≈ 10 min)
  integrator: 'RK4',
  paused: false,
  gMode: 'realistic',
  stepsPerFrameCap: 300,
  simulationOverloaded: false,
};

const renderConfig: RenderConfig = {
  logScale: false,
  logScaleLerp: 0,
  showTrails: false,
  trailLength: 500,
  showBloom: true,
  bloomStrength: 0.5,
  showAsteroidBelt: true,
  showSolarWind: false,
  showLagrangePoints: false,
  showGravityField: false,
  showAtmospheres: true,
};

const cameraConfig: CameraConfig = {
  focusBodyId: null,
  focusMode: false,
};

// ---------------------------------------------------------------------------
// Scene Manager (creates renderer + scene + camera + postprocessing)
// ---------------------------------------------------------------------------
const sceneManager = new SceneManager(renderConfig, cameraConfig);
const { scene } = sceneManager;

// ---------------------------------------------------------------------------
// Texture loader (shared)
// ---------------------------------------------------------------------------
const textureLoader = new THREE.TextureLoader();

// ---------------------------------------------------------------------------
// Trail renderer
// ---------------------------------------------------------------------------
const trailRenderer = new TrailRenderer(scene);

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------
let bodies: CelestialBody[] = [];

function createBodiesFromState(): void {
  const states = cloneInitialBodies();
  for (const state of states) {
    const body = new CelestialBody(state, textureLoader, scene);
    const trail = trailRenderer.create(state.id, state.trailColor);
    body.trail = trail;
    bodies.push(body);
  }
}

createBodiesFromState();
sceneManager.buildOrbitRings(bodies);

// ---------------------------------------------------------------------------
// Physics engine
// ---------------------------------------------------------------------------
let physics = new PhysicsEngine(bodies, simConfig);

physics.onBodyRemoved = (id) => {
  trailRenderer.dispose(id);
  bodies = physics.bodies; // sync reference
  ui.update(simTimeElapsed, bodies);
};

physics.onBodyMerged = (_survivor, removed) => {
  trailRenderer.dispose(removed);
};

// ---------------------------------------------------------------------------
// Build asteroid belt (after scene is set up)
// ---------------------------------------------------------------------------
sceneManager.buildAsteroidBelt();

// ---------------------------------------------------------------------------
// Body selector (raycasting + God Mode)
// ---------------------------------------------------------------------------
const bodySelector = new BodySelector(
  sceneManager.camera,
  sceneManager.renderer,
  scene,
  () => bodies,
  cameraConfig,
  sceneManager
);

bodySelector.onBodySelected = (body) => {
  if (cameraConfig.focusMode && body) {
    cameraConfig.focusBodyId = body.state.id;
    sceneManager.focusOn(body);
  }
};

// ---------------------------------------------------------------------------
// Planet labels (CSS2D) — must be after bodySelector is created
// ---------------------------------------------------------------------------
function buildAllLabels(): void {
  sceneManager.buildLabels(bodies, (body) => {
    bodySelector.selectBody(body);
  }, (body) => {
    cameraConfig.focusMode = true;
    cameraConfig.focusBodyId = body.state.id;
    sceneManager.focusOn(body);
    bodySelector.selectBody(body);
  });
}
buildAllLabels();

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const ui = new UIManager(
  simConfig, renderConfig, cameraConfig,
  physics, sceneManager, bodySelector,
  () => bodies
);

ui.onReset = () => {
  // Dispose all current bodies + trails
  for (const b of bodies) b.dispose();
  trailRenderer.disposeAll();
  bodies = [];
  physics.bodies = [];

  // Recreate
  createBodiesFromState();
  physics = new PhysicsEngine(bodies, simConfig);
  physics.onBodyRemoved = (id) => {
    trailRenderer.dispose(id);
    bodies = physics.bodies;
  };
  physics.onBodyMerged = (_s, removed) => trailRenderer.dispose(removed);

  simTimeElapsed = 0;
  bodySelector.deselectBody();
  sceneManager.resetCamera(renderConfig.logScale);
  trailRenderer.clearAll();
  trailLastPos.clear();
  sceneManager.clearOrbitRings();
  sceneManager.buildOrbitRings(bodies);
  sceneManager.clearLabels();
  buildAllLabels();
};

ui.onDeleteBody = (id) => {
  physics.removeBody(id);
  trailRenderer.dispose(id);
  bodies = physics.bodies;
};

ui.onRealTimeToggle = (enabled) => {
  realTimeMode = enabled;

  // Dispose all current bodies + trails
  for (const b of bodies) b.dispose();
  trailRenderer.disposeAll();
  bodies = [];
  physics.bodies = [];
  sceneManager.clearLabels();
  sceneManager.clearOrbitRings();

  if (enabled) {
    realTimeStartDate = new Date();
    const states = computeBodiesForDate(realTimeStartDate);
    for (const state of states) {
      const body = new CelestialBody(state, textureLoader, scene);
      body.setInitialRotation(realTimeStartDate);
      const trail = trailRenderer.create(state.id, state.trailColor);
      body.trail = trail;
      bodies.push(body);
    }
  } else {
    createBodiesFromState();
  }

  physics = new PhysicsEngine(bodies, simConfig);
  physics.onBodyRemoved = (id) => {
    trailRenderer.dispose(id);
    bodies = physics.bodies;
  };
  physics.onBodyMerged = (_s, removed) => trailRenderer.dispose(removed);

  simTimeElapsed = 0;
  bodySelector.deselectBody();
  sceneManager.resetCamera(renderConfig.logScale);
  trailRenderer.clearAll();
  trailLastPos.clear();
  sceneManager.buildOrbitRings(bodies);
  buildAllLabels();
};

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();
let simTimeElapsed = 0;
let realTimeMode = false;
let realTimeStartDate = new Date();

// Distance-based trail sampling — push a point when a body moves ≥ threshold
// in scene space. This works correctly at any time scale.
const MIN_TRAIL_DIST_SQ = 0.0025 * 0.0025; // 0.0025 scene units²
const trailLastPos = new Map<string, THREE.Vector3>();

// Track log scale toggle to reposition camera on change
let prevLogScale = renderConfig.logScale;

function animate(): void {
  requestAnimationFrame(animate);

  const now    = performance.now();
  const wallDt = Math.min((now - lastTime) / 1000, 0.05); // cap at 50 ms
  lastTime = now;

  sceneManager.trackFPS(wallDt);

  // --- Physics ---
  if (!simConfig.paused) {
    physics.step(wallDt);
    simTimeElapsed += wallDt * simConfig.timeScale;
  }

  // --- Scale lerp (smooth log ↔ linear transition) ---
  const lerpT = sceneManager.updateScaleLerp(renderConfig.logScale, wallDt);

  // --- Reposition camera when scale mode changes ---
  if (prevLogScale !== renderConfig.logScale) {
    prevLogScale = renderConfig.logScale;
    sceneManager.onScaleModeChange(renderConfig.logScale);
    trailRenderer.clearAll();   // trails are in old-mode coords, clear them
    trailLastPos.clear();       // reset distance-sampling cache
  }

  // --- Update body mesh positions ---
  const sun = bodies.find(b => b.state.id === 'sun') ?? null;

  for (const body of bodies) {
    body.updateScenePosition(renderConfig.logScale, lerpT);
    body.rotateBody(wallDt, simConfig.timeScale);
  }

  // --- Moon positioning (second pass — needs parent already updated) ---
  // Override moon scene position so moons always clear the parent's inflated sphere.
  // We map the real orbit-ratio (distance / parentRadius) to a compressed scene distance
  // so inner moons aren't swallowed by the parent's exaggerated visual size.
  for (const body of bodies) {
    if (!body.state.isMoon || !body.state.parentId) continue;
    const parent = bodies.find(b => b.state.id === body.state.parentId);
    if (!parent) continue;

    const relPhys = new THREE.Vector3().subVectors(body.state.position, parent.state.position);
    const physDist = relPhys.length();
    if (physDist < 1) continue;
    const dir = relPhys.divideScalar(physDist); // normalise in-place

    // How many parent-radii from the parent centre is this moon in reality?
    const orbitRatio = physDist / parent.state.radius;

    // Parent's displayed radius in scene units
    const parentDisplayR = parent.visualRadius * parent.group.scale.x;

    // Map to scene distance: start at 1.3× parent radius, grow proportionally
    const sceneDist = parentDisplayR * (1.3 + orbitRatio * 0.08);

    body.group.position.copy(parent.group.position).addScaledVector(dir, sceneDist);
  }

  // --- Update planet labels ---
  sceneManager.updateLabels(bodies);

  // --- Sync sun light ---
  sceneManager.syncSunLight(sun);

  // --- Orbit rings (pre-drawn predicted paths) ---
  sceneManager.updateOrbitRings(bodies, renderConfig.logScale, lerpT, simConfig.G);

  // --- Trails (distance-based sampling — works at any time scale) ---
  if (renderConfig.showTrails) {
    for (const body of bodies) {
      if (!body.trail) continue;
      const pos = body.group.position;
      const last = trailLastPos.get(body.state.id);
      if (!last || last.distanceToSquared(pos) >= MIN_TRAIL_DIST_SQ) {
        body.trail.push(pos.x, pos.y, pos.z);
        // Reuse or create the cached Vector3
        const cached = trailLastPos.get(body.state.id);
        if (cached) cached.copy(pos);
        else trailLastPos.set(body.state.id, pos.clone());
      }
      body.trail.update();
    }
  }
  trailRenderer.setAllVisible(renderConfig.showTrails);

  // --- Solar wind ---
  if (renderConfig.showSolarWind) {
    sceneManager.updateSolarWind(wallDt);
  }

  // --- Gravity field ---
  sceneManager.updateGravField(bodies, simConfig.G);

  // --- Camera focus ---
  if (cameraConfig.focusMode && cameraConfig.focusBodyId) {
    const focusBody = bodies.find(b => b.state.id === cameraConfig.focusBodyId);
    sceneManager.updateFocus(focusBody ?? null);
  }

  // --- Lagrange points ---
  if (renderConfig.showLagrangePoints) {
    const selected = bodySelector.selectedBody;
    sceneManager.updateLagrangePoints(sun, selected);
  } else {
    sceneManager.updateLagrangePoints(null, null);
  }

  // --- God Mode spawn ---
  if (bodySelector.pendingSpawn) {
    const req = bodySelector.pendingSpawn;
    bodySelector.pendingSpawn = null;

    const id = nextBodyId();
    const state = {
      id,
      name: `Object ${id}`,
      mass: req.mass,
      radius: req.radius,
      position: req.position.clone(),
      velocity: req.velocity.clone(),
      acceleration: new THREE.Vector3(),
      color: req.color,
      texturePath: null,
      nightTexturePath: null,
      isEmissive: false,
      hasRings: false,
      hasAtmosphere: false,
      trailColor: req.color,
      isMoon: false,
      parentId: null,
    };

    const newBody = new CelestialBody(state, textureLoader, scene);
    const trail   = trailRenderer.create(id, req.color);
    newBody.trail = trail;

    physics.addBody(newBody);
    bodies = physics.bodies;
  }

  // --- Selection ring ---
  bodySelector.update();

  // --- UI refresh ---
  const simDate = realTimeMode ? formatSimDate(realTimeStartDate, simTimeElapsed) : undefined;
  ui.update(simTimeElapsed, bodies, simDate);

  // --- Planet data card ---
  ui.updatePlanetCard(bodies);

  // --- Render ---
  sceneManager.render();
}

animate();
