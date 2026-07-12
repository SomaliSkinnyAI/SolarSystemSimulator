import * as THREE from 'three';
import { SimulationConfig, RenderConfig, CameraConfig } from './types';
import { cloneInitialBodies, nextBodyId } from './data/solarSystemData';
import { G_REAL, G_EXAGGERATED } from './utils/MathUtils';
import { DISPLAY_SCALE } from './utils/CoordinateSystem';
import { computeBodiesForDate, formatSimDate } from './data/realTimeOrbits';
import { computeBodiesFromHorizonsCache } from './data/horizonsEphemeris';
import { scanSystemEvents } from './utils/EventPredictor';
import { CelestialBody } from './physics/CelestialBody';
import { selectOccluders, updateEclipseUniforms } from './rendering/EclipseShadows';
import { PhysicsEngine } from './physics/PhysicsEngine';
import { SceneManager } from './rendering/SceneManager';
import { TrailRenderer } from './rendering/TrailRenderer';
import { BodySelector } from './ui/BodySelector';
import { UIManager } from './ui/UIManager';
import { DateOverlay } from './ui/DateOverlay';
import { SpawnPanel } from './ui/SpawnPanel';

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
  realScale: false,
  showTrails: false,
  trailLength: 500,
  showBloom: true,
  bloomStrength: 0.5,
  exposure: 1.08,
  showLensflare: true,
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
sceneManager.buildOrbitRings(bodies, renderConfig.realScale);

// ---------------------------------------------------------------------------
// Physics engine
// ---------------------------------------------------------------------------
let physics = new PhysicsEngine(bodies, simConfig);

/**
 * Central cleanup when a body leaves the simulation (delete or collision
 * merge): trail, label, orbit ring, selection, camera focus, stale caches.
 */
function onBodyGone(id: string): void {
  trailRenderer.dispose(id);
  trailLastPos.delete(id);
  sceneManager.removeLabel(id);
  sceneManager.removeOrbitRing(id);
  if (bodySelector.selectedBody?.state.id === id) {
    bodySelector.deselectBody();
  }
  if (cameraConfig.focusBodyId === id) {
    cameraConfig.focusBodyId = null;
    cameraConfig.focusMode = false;
  }
  bodies = physics.bodies; // sync reference
  ui.update(simTimeElapsed, bodies);
}

physics.onBodyRemoved = onBodyGone;

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
  sceneManager,
  () => renderConfig.logScale
);

bodySelector.onBodySelected = (body) => {
  if (cameraConfig.focusMode && body) {
    cameraConfig.focusBodyId = body.state.id;
    sceneManager.focusOn(body);
  }
};

// ---------------------------------------------------------------------------
// Spawn panel (God Mode configuration)
// ---------------------------------------------------------------------------
const spawnPanel = new SpawnPanel(scene, simConfig.G);

bodySelector.onGodModeClick = (scenePos, physicsPos) => {
  spawnPanel.updateG(simConfig.G);
  spawnPanel.open(scenePos, physicsPos, bodies);
};

spawnPanel.onSpawn = (req) => {
  const id = nextBodyId();
  const state = {
    id,
    name: req.name,
    mass: req.mass,
    radius: req.radius,
    position: req.position.clone(),
    velocity: req.velocity.clone(),
    acceleration: new THREE.Vector3(),
    color: req.color,
    texturePath: null,
    nightTexturePath: null,
    isEmissive: req.isEmissive,
    hasRings: false,
    hasAtmosphere: false,
    trailColor: req.color,
    isMoon: false,
    parentId: null,
  };

  const newBody = new CelestialBody(state, textureLoader, scene);
  const trail   = trailRenderer.create(id, req.color);
  newBody.trail  = trail;

  physics.addBody(newBody);
  bodies = physics.bodies;
  sceneManager.clearLabels();
  buildAllLabels();
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

ui.onGodModeToggle = (active) => {
  if (!active) spawnPanel.close();
};

// ---------------------------------------------------------------------------
// Date overlay (persistent date display + date picker)
// ---------------------------------------------------------------------------
const dateOverlay = new DateOverlay();
const scaleLegend = document.getElementById('scale-legend');
const eventPanel = document.getElementById('event-panel');
let ephemerisSource = 'Default J2000 circular startup state';

function disposeCurrentBodies(): void {
  for (const b of bodies) b.dispose();
  trailRenderer.disposeAll();
  bodies = [];
  physics.bodies = [];
  sceneManager.clearLabels();
  sceneManager.clearOrbitRings();
}

function attachPhysicsCallbacks(): void {
  physics.onBodyRemoved = onBodyGone;
}

function createBodiesFromStates(states: ReturnType<typeof computeBodiesForDate>, rotationDate?: Date): void {
  for (const state of states) {
    const body = new CelestialBody(state, textureLoader, scene);
    if (rotationDate) body.setInitialRotation(rotationDate);
    const trail = trailRenderer.create(state.id, state.trailColor);
    body.trail = trail;
    bodies.push(body);
  }
}

async function statesForDate(targetDate: Date): Promise<{
  states: ReturnType<typeof computeBodiesForDate>;
  source: string;
}> {
  const horizons = await computeBodiesFromHorizonsCache(targetDate);
  if (horizons) {
    return {
      states: horizons.bodies,
      source: `${horizons.source} (${horizons.cacheRange})`,
    };
  }
  return {
    states: computeBodiesForDate(targetDate),
    source: 'JPL approximate Keplerian elements fallback',
  };
}

function rebuildSimulationFromStates(states: ReturnType<typeof computeBodiesForDate>, epoch: Date, useRealTime: boolean): void {
  disposeCurrentBodies();
  createBodiesFromStates(states, useRealTime ? epoch : undefined);
  physics = new PhysicsEngine(bodies, simConfig);
  attachPhysicsCallbacks();

  realTimeMode = useRealTime;
  simEpoch = epoch;
  simTimeElapsed = 0;

  bodySelector.deselectBody();
  trailRenderer.clearAll();
  trailLastPos.clear();
  sceneManager.buildOrbitRings(bodies, renderConfig.realScale);
  buildAllLabels();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[ch] ?? ch));
}

function updateEventPanel(): void {
  if (!eventPanel) return;
  const summary = scanSystemEvents(bodies.map(b => b.state), simConfig.G);
  if (!summary) {
    eventPanel.classList.remove('visible');
    return;
  }

  eventPanel.innerHTML = [
    '<div class="event-title">Live Event Scan</div>',
    `<div><span>Closest major pair</span><strong>${escapeHtml(summary.closestMajorPair)}</strong><em>${summary.closestMajorDistance}</em></div>`,
    `<div><span>Tightest alignment</span><strong>${escapeHtml(summary.tightestConjunction)}</strong><em>${summary.tightestConjunctionAngle}</em></div>`,
    `<div><span>Fastest orbit</span><strong>${escapeHtml(summary.fastestBody)}</strong><em>${summary.fastestBodySpeed}</em></div>`,
    `<div><span>Most eccentric</span><strong>${escapeHtml(summary.mostEccentricOrbit)}</strong><em>e = ${summary.mostEccentricValue}</em></div>`,
  ].join('');
  eventPanel.classList.add('visible');
}

dateOverlay.onDateJump = async (targetDate: Date) => {
  simConfig.timeScale = 1;
  const result = await statesForDate(targetDate);
  ephemerisSource = result.source;
  rebuildSimulationFromStates(result.states, targetDate, true);
  ui.setRealTimeEnabled(true);
};

ui.onReset = () => {
  disposeCurrentBodies();
  createBodiesFromState();
  physics = new PhysicsEngine(bodies, simConfig);
  attachPhysicsCallbacks();

  simTimeElapsed = 0;
  simEpoch = J2000;
  realTimeMode = false;
  ephemerisSource = 'Default J2000 circular startup state';
  bodySelector.deselectBody();
  sceneManager.resetCamera(renderConfig.logScale);
  trailRenderer.clearAll();
  trailLastPos.clear();
  sceneManager.clearOrbitRings();
  sceneManager.buildOrbitRings(bodies, renderConfig.realScale);
  sceneManager.clearLabels();
  buildAllLabels();
  ui.setRealTimeEnabled(false);
};

ui.onDeleteBody = (id) => {
  physics.removeBody(id); // fires onBodyRemoved → onBodyGone cleanup
};

ui.onRealTimeToggle = async (enabled) => {
  if (enabled === realTimeMode) return; // guard against re-entrant calls from setRealTimeEnabled

  if (enabled) {
    const epoch = new Date();
    const result = await statesForDate(epoch);
    ephemerisSource = result.source;
    rebuildSimulationFromStates(result.states, epoch, true);
  } else {
    ephemerisSource = 'Default J2000 circular startup state';
    disposeCurrentBodies();
    createBodiesFromState();
    physics = new PhysicsEngine(bodies, simConfig);
    attachPhysicsCallbacks();
    realTimeMode = false;
    simEpoch = J2000;
    simTimeElapsed = 0;
    bodySelector.deselectBody();
    trailRenderer.clearAll();
    trailLastPos.clear();
    sceneManager.buildOrbitRings(bodies, renderConfig.realScale);
    buildAllLabels();
  }

  sceneManager.resetCamera(renderConfig.logScale);
};

// ---------------------------------------------------------------------------
// Animation loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();
let simTimeElapsed = 0;
let realTimeMode = false;
const J2000 = new Date(Date.UTC(2000, 0, 1, 12, 0, 0));
let simEpoch = J2000;          // date corresponding to simTimeElapsed=0
let simDate = new Date(J2000);  // current simulation date, updated every frame

// Distance-based trail sampling — push a point when a body moves ≥ threshold
// in scene space. This works correctly at any time scale.
const MIN_TRAIL_DIST_SQ = 0.0025 * 0.0025; // 0.0025 scene units²
const trailLastPos = new Map<string, THREE.Vector3>();

// Track log scale / real scale toggles to reposition camera and rebuild orbit rings
let prevLogScale = renderConfig.logScale;
let prevRealScale = renderConfig.realScale;
let eventPanelTimer = 1;

// Eclipse occluder selection cache (rebuilt every 30 frames)
const occluderMap = new Map<string, CelestialBody[]>();
let eclipseFrameCounter = 30;

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

  // --- Rebuild orbit rings when real scale toggles ---
  if (prevRealScale !== renderConfig.realScale) {
    prevRealScale = renderConfig.realScale;
    sceneManager.clearOrbitRings();
    sceneManager.buildOrbitRings(bodies, renderConfig.realScale);
    trailRenderer.clearAll();
    trailLastPos.clear();
  }

  // --- Update body mesh positions ---
  const sun = bodies.find(b => b.state.id === 'sun') ?? null;

  for (const body of bodies) {
    body.updateScenePosition(renderConfig.logScale, lerpT, renderConfig.realScale);
    body.setAtmosphereVisible(renderConfig.showAtmospheres);
    if (!simConfig.paused) body.rotateBody(wallDt, simConfig.timeScale);
  }

  // Sun-dependent shader uniforms (day/night terminator, atmospheres) need
  // the Sun's post-update scene position
  if (sun) {
    for (const body of bodies) body.updateSunPosition(sun.group.position);

    // Eclipse shadows: re-select which bodies can shadow which every 30
    // frames (cheap n² scan), refresh positions of the selected set per frame
    eclipseFrameCounter++;
    if (eclipseFrameCounter >= 30 || occluderMap.size === 0) {
      eclipseFrameCounter = 0;
      occluderMap.clear();
      for (const body of bodies) {
        if (!body.eclipseUniforms) continue;
        occluderMap.set(body.state.id, selectOccluders(body, sun, bodies));
      }
    }
    for (const body of bodies) {
      if (!body.eclipseUniforms) continue;
      updateEclipseUniforms(body.eclipseUniforms, sun, occluderMap.get(body.state.id) ?? []);
    }
  }

  // --- Moon positioning (second pass — needs parent already updated) ---
  // In real scale mode, moons sit at their true physics-derived positions.
  // Otherwise, override so moons clear the parent's inflated sphere.
  if (!renderConfig.realScale) {
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
  }

  // --- Update planet labels ---
  sceneManager.updateLabels(bodies);

  // --- Sync sun light ---
  sceneManager.syncSunLight(sun);

  // --- Orbit rings (pre-drawn predicted paths) ---
  sceneManager.updateOrbitRings(bodies, renderConfig.logScale, lerpT, simConfig.G, renderConfig.realScale);

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

  // (God Mode spawn is handled by SpawnPanel callback)

  // --- Selection ring ---
  bodySelector.update();

  // --- Update simulation date ---
  simDate = new Date(simEpoch.getTime() + simTimeElapsed * 1000);
  dateOverlay.updateDisplay(simDate);
  if (scaleLegend) {
    const scaleMode = renderConfig.realScale
      ? 'True body radii'
      : renderConfig.logScale
        ? 'Log distance scale'
        : 'Educational body scale';
    const physicsMode = simConfig.integrator === 'RK4' ? 'RK4 N-body' : 'Velocity Verlet';
    scaleLegend.innerHTML = [
      `<span>${scaleMode}</span>`,
      `<span>${physicsMode}</span>`,
      `<span>${bodies.length} bodies</span>`,
      `<span>${ephemerisSource}</span>`,
    ].join('');
  }

  eventPanelTimer += wallDt;
  if (eventPanelTimer >= 0.5) {
    eventPanelTimer = 0;
    updateEventPanel();
  }

  // --- UI refresh ---
  const simDateStr = formatSimDate(simEpoch, simTimeElapsed);
  ui.update(simTimeElapsed, bodies, simDateStr);

  // --- Planet data card ---
  ui.updatePlanetCard(bodies);

  // --- Render ---
  sceneManager.render();
}

animate();
