import * as THREE from 'three';
import { SimulationConfig, RenderConfig, CameraConfig } from './types';
import { cloneInitialBodies, nextBodyId } from './data/solarSystemData';
import { G_REAL, G_EXAGGERATED } from './utils/MathUtils';
import { DISPLAY_SCALE } from './utils/CoordinateSystem';
import { computeBodiesForDate, formatSimDate } from './data/realTimeOrbits';
import { computeBodiesFromHorizonsCache, getSpacecraftSampler, getAvailableSpacecraft, dateToJulianTDB, SampledState } from './data/horizonsEphemeris';
import { SPACECRAFT, makeSpacecraftState } from './data/spacecraft';
import { scanSystemEvents } from './utils/EventPredictor';
import { measureConservation, driftFrom, ConservationSample } from './utils/ConservationMonitor';
import { CelestialBody } from './physics/CelestialBody';
import { selectOccluders, updateEclipseUniforms } from './rendering/EclipseShadows';
import { CometTail } from './rendering/CometTail';
import { AU } from './utils/MathUtils';
import { TransportBar } from './ui/TransportBar';
import { EventsPanel } from './ui/EventsPanel';
import { TourController } from './ui/TourController';
import { CommandPalette, PaletteItem } from './ui/CommandPalette';
import { AudioManager } from './audio/AudioManager';
import { UpcomingEvent } from './utils/EventPredictor';
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
  relativity: true,
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
  showGodRays: true,
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
  rebaseConservation();
}

physics.onBodyRemoved = onBodyGone;
physics.onBodyMerged = (survivorId) => {
  const survivor = physics.bodies.find(b => b.state.id === survivorId);
  audio.mergeBoom(survivor?.state.mass ?? 1e20);
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
  sceneManager,
  () => renderConfig.logScale
);

bodySelector.onBodySelected = (body) => {
  if (body) audio.selectPing();
  if (cameraConfig.focusMode && body) {
    cameraConfig.focusBodyId = body.state.id;
    sceneManager.focusOn(body);
  }
};

// Grabbing the mouse cancels any cinematic camera flight
sceneManager.renderer.domElement.addEventListener('pointerdown', () => {
  sceneManager.director.cancel();
});

// ---------------------------------------------------------------------------
// Spawn panel (God Mode configuration)
// ---------------------------------------------------------------------------
const spawnPanel = new SpawnPanel(scene, simConfig.G);

bodySelector.onGodModeClick = (scenePos, physicsPos) => {
  spawnPanel.updateG(simConfig.G);
  spawnPanel.open(scenePos, physicsPos, bodies);
};

spawnPanel.onSpawn = (req) => {
  audio.spawnThump();
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
  // Spawned bodies get a predicted orbit ring like everyone else
  sceneManager.clearOrbitRings();
  sceneManager.buildOrbitRings(bodies, renderConfig.realScale);
  rebaseConservation();
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
ui.onPhysicsMutated = () => rebaseConservation();

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
  physics.onBodyMerged = (survivorId) => {
    const survivor = physics.bodies.find(b => b.state.id === survivorId);
    audio.mergeBoom(survivor?.state.mass ?? 1e20);
  };
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

  // Real spacecraft ride along in real-time mode, kinematically driven from
  // their Horizons trajectories each frame (positioned at first update)
  if (useRealTime) {
    for (const spec of SPACECRAFT) {
      const body = new CelestialBody(makeSpacecraftState(spec), textureLoader, scene);
      body.group.visible = false; // shown once the sampler has coverage
      bodies.push(body);
    }
  }

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
  rebaseConservation();
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

// --- Conservation baseline (rebased whenever physics itself changes) ---
let consBaseline: ConservationSample | null = null;

function rebaseConservation(): void {
  consBaseline = measureConservation(bodies.map(b => b.state), simConfig.G);
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
// Audio, transport bar, timeline, events, tour, palette, share links
// ---------------------------------------------------------------------------
const audio = new AudioManager();
ui.onMuteToggle = () => audio.toggleMuted();

// In-place date application: light enough for 60 Hz timeline scrubbing —
// copies positions/velocities into the existing bodies instead of the full
// dispose-and-rebuild the date picker uses.
let scrubBusy = false;
let pendingScrubDate: Date | null = null;
let scrubPausedBefore = false;

async function applyDateInPlace(date: Date): Promise<void> {
  if (scrubBusy) {
    pendingScrubDate = date;
    return;
  }
  scrubBusy = true;
  try {
    const result = await statesForDate(date);
    const byId = new Map(result.states.map(s => [s.id, s]));
    // Spacecraft are kinematic extras — compare only the planet/moon roster
    const roster = bodies.filter(b => !b.state.isSpacecraft);
    const sameRoster = roster.length === result.states.length
      && roster.every(b => byId.has(b.state.id));
    ephemerisSource = result.source;
    if (sameRoster) {
      for (const b of roster) {
        const s = byId.get(b.state.id)!;
        b.state.position.copy(s.position);
        b.state.velocity.copy(s.velocity);
      }
      simEpoch = date;
      simTimeElapsed = 0;
      realTimeMode = true;
      trailRenderer.clearAll();
      trailLastPos.clear();
      rebaseConservation();
    } else {
      rebuildSimulationFromStates(result.states, date, true);
    }
    ui.setRealTimeEnabled(true);
  } finally {
    scrubBusy = false;
    if (pendingScrubDate) {
      const next = pendingScrubDate;
      pendingScrubDate = null;
      void applyDateInPlace(next);
    }
  }
}

function jumpToEvent(ev: UpcomingEvent): void {
  void (async () => {
    // Arrive an hour early at watchable speed so the event unfolds on screen
    await applyDateInPlace(new Date(ev.date.getTime() - 3600e3));
    simConfig.timeScale = 600;
    simConfig.paused = false;
    const body = bodies.find(b => b.state.id === ev.focusBodyId);
    const sunBody = bodies.find(b => b.state.id === 'sun');
    if (!body) return;
    bodySelector.selectBody(body);
    cameraConfig.focusMode = true;
    cameraConfig.focusBodyId = body.state.id;
    let offsetDir: THREE.Vector3 | undefined;
    if (ev.type === 'solar-eclipse' && sunBody) {
      // Hover sunward of Earth to watch the Moon's shadow cross the day side
      offsetDir = sunBody.group.position.clone().sub(body.group.position).normalize();
    } else if (ev.type === 'lunar-eclipse' && sunBody) {
      // Anti-sunward of the Moon so it is seen entering Earth's shadow
      offsetDir = body.group.position.clone().sub(sunBody.group.position).normalize();
    }
    const displayR = Math.max(body.visualRadius * body.group.scale.x, 0.02);
    sceneManager.director.flyTo(
      () => body.group.position,
      displayR * (ev.type.includes('eclipse') ? 4.5 : 7),
      { duration: 2.2, ...(offsetDir ? { offsetDir } : {}) }
    );
  })();
}

function copyShareLink(): void {
  const p = sceneManager.camera.position;
  const t = sceneManager.controls.target;
  const params = new URLSearchParams();
  params.set('d', simDate.toISOString());
  if (realTimeMode) params.set('rt', '1');
  params.set('c', [p.x, p.y, p.z, t.x, t.y, t.z].map(v => v.toFixed(3)).join(','));
  if (cameraConfig.focusBodyId) params.set('f', cameraConfig.focusBodyId);
  params.set('ts', String(simConfig.timeScale));
  const flags = (renderConfig.logScale ? 1 : 0)
    | (renderConfig.realScale ? 2 : 0)
    | (renderConfig.showTrails ? 4 : 0);
  params.set('fl', String(flags));
  const url = `${location.origin}${location.pathname}#${params.toString()}`;
  void navigator.clipboard?.writeText(url);
  audio.uiTick();
}

async function applyShareHash(): Promise<void> {
  if (!location.hash.includes('d=')) return;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const dStr = params.get('d');
    if (params.get('rt') === '1' && dStr && !isNaN(Date.parse(dStr))) {
      await applyDateInPlace(new Date(dStr));
    }
    const ts = Number(params.get('ts'));
    if (Number.isFinite(ts) && ts >= 1) simConfig.timeScale = ts;
    const fl = Number(params.get('fl') ?? 0);
    renderConfig.logScale = !!(fl & 1);
    renderConfig.realScale = !!(fl & 2);
    renderConfig.showTrails = !!(fl & 4);
    const c = params.get('c')?.split(',').map(Number);
    if (c && c.length === 6 && c.every(Number.isFinite)) {
      sceneManager.camera.position.set(c[0]!, c[1]!, c[2]!);
      sceneManager.controls.target.set(c[3]!, c[4]!, c[5]!);
      sceneManager.controls.update();
    }
    const f = params.get('f');
    if (f) {
      const b = bodies.find(x => x.state.id === f);
      if (b) {
        cameraConfig.focusMode = true;
        cameraConfig.focusBodyId = f;
        bodySelector.selectBody(b);
      }
    }
  } catch { /* malformed hash — start normally */ }
}

const transportBar = new TransportBar(simConfig);
transportBar.onScrubStart = () => {
  scrubPausedBefore = simConfig.paused;
  simConfig.paused = true;
};
transportBar.onScrub = (date) => { void applyDateInPlace(date); };
transportBar.onScrubEnd = () => { simConfig.paused = scrubPausedBefore; };
transportBar.onDateClick = () => document.getElementById('date-overlay')?.click();
transportBar.onCopyLink = copyShareLink;
transportBar.onEventJump = jumpToEvent;

const eventsPanel = new EventsPanel();
eventsPanel.getStartDate = () => new Date(simDate);
eventsPanel.onJump = jumpToEvent;
eventsPanel.onEventsChanged = (events) => transportBar.setEvents(events);

const tour = new TourController(sceneManager, () => bodies);
tour.onSelectBody = (b) => {
  bodySelector.selectBody(b);
  cameraConfig.focusMode = true;
  cameraConfig.focusBodyId = b.state.id;
};
transportBar.onTour = () => (tour.active ? tour.stop() : tour.start());

/**
 * Drop a small asteroid at the exact Sun–<secondary> L4/L5 point with the
 * local circular co-rotation velocity: under the real N-body forces it then
 * visibly librates in a tadpole orbit — why Jupiter's Trojans exist.
 */
function spawnAtLagrange(secondary: CelestialBody, sign: 1 | -1): void {
  const sunBody = bodies.find(b => b.state.id === 'sun');
  if (!sunBody) return;
  const p1 = sunBody.state.position;
  const v1 = sunBody.state.velocity;
  const rel = new THREE.Vector3().subVectors(secondary.state.position, p1);
  const relV = new THREE.Vector3().subVectors(secondary.state.velocity, v1);
  const R = rel.length();
  if (R < 1) return;
  const normal = new THREE.Vector3().crossVectors(rel, relV).normalize();
  const pos = rel.clone().applyAxisAngle(normal, sign * Math.PI / 3).add(p1);
  // ω = (r × v)/r²; v_L = ω × r_L  (exact co-rotation)
  const omega = new THREE.Vector3().crossVectors(rel, relV).divideScalar(R * R);
  const vel = new THREE.Vector3().crossVectors(omega, pos.clone().sub(p1)).add(v1);
  spawnPanel.onSpawn?.({
    name: `${secondary.state.name} ${sign > 0 ? 'L4' : 'L5'} Trojan`,
    mass: 5e15,
    radius: 5e4,
    position: pos,
    velocity: vel,
    color: 0xB8A888,
    isEmissive: false,
  });
}

const palette = new CommandPalette();
palette.getItems = (): PaletteItem[] => [
  ...bodies.map(b => ({
    label: b.state.name,
    kind: 'body' as const,
    run: () => {
      bodySelector.selectBody(b);
      cameraConfig.focusMode = true;
      cameraConfig.focusBodyId = b.state.id;
      sceneManager.focusOn(b);
    },
  })),
  { label: 'Toggle pause', kind: 'action', run: () => { simConfig.paused = !simConfig.paused; } },
  { label: 'Toggle trails', kind: 'action', run: () => { renderConfig.showTrails = !renderConfig.showTrails; } },
  { label: 'Toggle real scale', kind: 'action', run: () => { renderConfig.realScale = !renderConfig.realScale; } },
  { label: 'Toggle log scale', kind: 'action', run: () => { renderConfig.logScale = !renderConfig.logScale; } },
  { label: 'Photo mode', kind: 'action', run: () => ui.togglePhotoMode() },
  { label: 'Start grand tour', kind: 'action', run: () => tour.start() },
  { label: 'Scan upcoming events', kind: 'action', run: () => void eventsPanel.scan() },
  { label: 'Reset simulation', kind: 'action', run: () => ui.onReset?.() },
  { label: 'Copy shareable link', kind: 'action', run: copyShareLink },
  ...((): PaletteItem[] => {
    const sel = bodySelector.selectedBody;
    if (!sel || sel.state.id === 'sun' || sel.state.isMoon || sel.state.isSpacecraft) return [];
    return [
      { label: `Drop Trojan at Sun–${sel.state.name} L4`, kind: 'action', run: () => spawnAtLagrange(sel, 1) },
      { label: `Drop Trojan at Sun–${sel.state.name} L5`, kind: 'action', run: () => spawnAtLagrange(sel, -1) },
    ];
  })(),
];

// Boot: a share link's encoded moment wins; otherwise open at the real
// current date with Horizons-accurate positions, ticking at true real time.
void (async () => {
  if (location.hash.includes('d=')) {
    await applyShareHash();
    return;
  }
  const epoch = new Date();
  const result = await statesForDate(epoch);
  ephemerisSource = result.source;
  rebuildSimulationFromStates(result.states, epoch, true);
  simConfig.timeScale = 1;
  ui.setRealTimeEnabled(true);
})();

// First-visit onboarding: three dismissible tips
(function onboarding(): void {
  if (localStorage.getItem('sss-onboarded')) return;
  const tips = [
    'Drag to orbit · scroll to zoom · right-drag to pan',
    'Click any planet for its data card · double-click to fly there',
    'Click the date to time-travel · ? for shortcuts · Ctrl+K to search',
  ];
  const el = document.createElement('div');
  Object.assign(el.style, {
    position: 'fixed', bottom: '96px', left: '50%', transform: 'translateX(-50%)',
    zIndex: '500', padding: '8px 18px', borderRadius: '999px',
    background: 'rgba(10,12,25,0.88)', border: '1px solid rgba(120,140,200,0.35)',
    color: '#cdd6ee', fontFamily: "'Courier New', monospace", fontSize: '12px',
    pointerEvents: 'none',
  });
  let idx = 0;
  el.textContent = `${tips[0]}  (click to continue)`;
  document.body.appendChild(el);
  const advance = (): void => {
    idx++;
    if (idx >= tips.length) {
      el.remove();
      window.removeEventListener('pointerdown', advance);
      localStorage.setItem('sss-onboarded', '1');
      return;
    }
    el.textContent = `${tips[idx]}  (click to continue)`;
  };
  window.addEventListener('pointerdown', advance);
})();

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

// Halley's dust + ion tails
const cometTail = new CometTail(scene);
const cometVelDir = new THREE.Vector3();

// Spacecraft trajectory samplers (lazy-loaded from the ephemeris cache)
const spacecraftSamplers = new Map<string, (jd: number) => SampledState | null>();
void (async () => {
  const available = await getAvailableSpacecraft();
  for (const id of available) {
    const sampler = await getSpacecraftSampler(id);
    if (sampler) spacecraftSamplers.set(id, sampler);
  }
})();

/** Kinematic spacecraft update: overwrite state from ephemeris each frame. */
function updateSpacecraft(): void {
  if (!realTimeMode) return;
  const jd = dateToJulianTDB(simDate);
  for (const body of bodies) {
    if (!body.state.isSpacecraft) continue;
    const sampler = spacecraftSamplers.get(body.state.id);
    const s = sampler ? sampler(jd) : null;
    if (s) {
      body.state.position.copy(s.position);
      body.state.velocity.copy(s.velocity);
      body.group.visible = true;
    } else {
      body.group.visible = false; // outside trajectory coverage
    }
  }
}

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

  // --- Kinematic spacecraft (must run before scene-position updates) ---
  simDate = new Date(simEpoch.getTime() + simTimeElapsed * 1000);
  updateSpacecraft();

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

  // --- Asteroid belt orbital clock ---
  sceneManager.updateAsteroidBelt(simTimeElapsed);

  // --- Comet tails (Halley) ---
  {
    const halley = bodies.find(b => b.state.id === 'halley');
    if (halley && sun) {
      const distAU = halley.state.position.distanceTo(sun.state.position) / AU;
      cometVelDir.copy(halley.state.velocity).normalize();
      cometTail.update(
        halley.group.position, sun.group.position,
        cometVelDir, distAU, wallDt, !renderConfig.logScale
      );
    } else {
      cometTail.update(new THREE.Vector3(), new THREE.Vector3(), cometVelDir, 100, wallDt, false);
    }
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
    sceneManager.updateLagrangePoints(sun, selected, renderConfig.logScale, lerpT);
  } else {
    sceneManager.updateLagrangePoints(null, null);
  }

  // (God Mode spawn is handled by SpawnPanel callback)

  // --- Cinematic camera flights ---
  sceneManager.director.update(wallDt);

  // --- Selection ring ---
  bodySelector.update();

  // --- Update simulation date ---
  simDate = new Date(simEpoch.getTime() + simTimeElapsed * 1000);
  dateOverlay.updateDisplay(simDate);
  transportBar.update(simDate, simConfig.paused);
  if (sun) {
    audio.updateListener(sceneManager.camera.position.distanceTo(sun.group.position));
  }
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
    if (!consBaseline) rebaseConservation();
    else {
      const drift = driftFrom(consBaseline, measureConservation(bodies.map(b => b.state), simConfig.G));
      ui.setConservation(drift.energyPpm, drift.angMomPpm, drift.comDriftKm);
    }
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
