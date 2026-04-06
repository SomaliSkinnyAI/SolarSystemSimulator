import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import { CelestialBody } from '../physics/CelestialBody';
import { StarField } from './StarField';
import { RenderConfig, CameraConfig } from '../types';
import { AU, randRange } from '../utils/MathUtils';
import { DISPLAY_SCALE, physicsToScene } from '../utils/CoordinateSystem';

// ---------------------------------------------------------------------------
// Solar wind particle system
// ---------------------------------------------------------------------------
const SW_COUNT = 2500;
const SW_MAX_DIST = 60; // scene units from Sun

const SOLAR_WIND_VERT = /* glsl */`
  attribute float age;
  attribute float maxAge;
  uniform float time;
  varying float vAlpha;
  void main() {
    vAlpha = clamp(1.0 - age / maxAge, 0.0, 1.0) * 0.5;
    gl_PointSize = 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const SOLAR_WIND_FRAG = /* glsl */`
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);
    if (r > 0.5) discard;
    gl_FragColor = vec4(1.0, 0.75, 0.35, vAlpha * (1.0 - r * 2.0));
  }
`;

// ---------------------------------------------------------------------------
// Lagrange point sprite helper
// ---------------------------------------------------------------------------
function makeLagrangeSprite(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.strokeStyle = 'rgba(255,220,60,0.8)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(16, 6); ctx.lineTo(16, 26); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(6, 16); ctx.lineTo(26, 16); ctx.stroke();
  ctx.beginPath(); ctx.arc(16, 16, 6, 0, Math.PI * 2); ctx.stroke();
  return new THREE.CanvasTexture(c);
}

// ---------------------------------------------------------------------------
// SceneManager
// ---------------------------------------------------------------------------
export class SceneManager {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private starField: StarField;
  private sunLight: THREE.PointLight;
  private ambientLight: THREE.AmbientLight;

  // CSS2D label renderer
  private labelRenderer: CSS2DRenderer;
  private labels: Map<string, CSS2DObject> = new Map();

  // Asteroid belt
  private asteroidMesh: THREE.InstancedMesh | null = null;

  // Solar wind
  private swPositions: Float32Array;
  private swVelocities: Float32Array;
  private swAge: Float32Array;
  private swMaxAge: Float32Array;
  private swGeom: THREE.BufferGeometry;
  private swMesh: THREE.Points;
  private swPosAttr: THREE.BufferAttribute;
  private swAgeAttr: THREE.BufferAttribute;

  // Orbit rings (pre-drawn predicted paths)
  private orbitRings: Map<string, {
    line: THREE.LineLoop;
    physicsRadius: number;
    isMoon?: boolean;
    parentGroup?: THREE.Group;
  }> = new Map();
  private static readonly _ringTmp = new THREE.Vector3();
  private static readonly RING_SEGS = 128;

  // Gravity field
  private gravFieldMesh: THREE.Mesh | null = null;
  private gravFieldTex: THREE.DataTexture | null = null;
  private gravFieldFrameSkip = 0;

  // Lagrange points
  private lagrangeSprites: THREE.Sprite[] = [];
  private lagrangeTex: THREE.Texture;

  // FPS tracking
  private fpsSamples: number[] = [];
  fps = 60;

  // Scale lerp
  private scaleLerpT = 0;

  constructor(renderConfig: RenderConfig, cameraConfig: CameraConfig) {
    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    const container = document.getElementById('canvas-container')!;
    container.appendChild(this.renderer.domElement);

    // Scene
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000005);

    // Camera — start at linear-scale position (logScale is false by default)
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.001, 1e8);
    this.camera.position.set(0, 350, 220);
    this.camera.lookAt(0, 0, 0);

    // Controls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.minDistance = 0.05;
    this.controls.maxDistance = 5e5;
    this.controls.zoomSpeed = 2.5;

    // Lights
    this.sunLight = new THREE.PointLight(0xFFF5E0, 2.0, 0, 0); // decay=0: constant reach for both log and linear scale
    this.sunLight.position.set(0, 0, 0);
    this.scene.add(this.sunLight);

    this.ambientLight = new THREE.AmbientLight(0x222233, 0.25);
    this.scene.add(this.ambientLight);

    // Starfield
    this.starField = new StarField();
    this.starField.addToScene(this.scene);

    // Post-processing
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.5,   // strength — subtle glow, keeps planets visible
      0.2,   // radius — tight so bloom stays on the Sun disk
      0.82   // threshold — only emissive Sun exceeds this
    );
    this.composer.addPass(this.bloomPass);
    this.composer.addPass(new OutputPass());

    // CSS2D label renderer (overlays on top of WebGL canvas)
    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(window.innerWidth, window.innerHeight);
    this.labelRenderer.domElement.style.position = 'absolute';
    this.labelRenderer.domElement.style.top = '0';
    this.labelRenderer.domElement.style.left = '0';
    this.labelRenderer.domElement.style.pointerEvents = 'none';
    const labelContainer = document.getElementById('label-container')!;
    labelContainer.appendChild(this.labelRenderer.domElement);

    // Solar wind
    const { positions, velocities, age, maxAge, geom, mesh, posAttr, ageAttr } = this._buildSolarWind();
    this.swPositions  = positions;
    this.swVelocities = velocities;
    this.swAge        = age;
    this.swMaxAge     = maxAge;
    this.swGeom       = geom;
    this.swMesh       = mesh;
    this.swPosAttr    = posAttr;
    this.swAgeAttr    = ageAttr;
    this.scene.add(this.swMesh);

    // Gravity field
    this._buildGravField();

    // Lagrange sprites
    this.lagrangeTex = makeLagrangeSprite();
    for (let i = 0; i < 5; i++) {
      const mat = new THREE.SpriteMaterial({ map: this.lagrangeTex, color: 0xFFDD44, transparent: true, opacity: 0.7, depthWrite: false });
      const sprite = new THREE.Sprite(mat);
      sprite.scale.set(1.5, 1.5, 1);
      sprite.visible = false;
      this.lagrangeSprites.push(sprite);
      this.scene.add(sprite);
    }

    // Apply initial render config
    this.applyRenderConfig(renderConfig);

    // Resize handler
    window.addEventListener('resize', () => this._onResize());
  }

  // ---------------------------------------------------------------------------
  // Asteroid belt — InstancedMesh, visual only
  // ---------------------------------------------------------------------------
  buildAsteroidBelt(): void {
    if (this.asteroidMesh) {
      this.scene.remove(this.asteroidMesh);
      this.asteroidMesh.geometry.dispose();
      (this.asteroidMesh.material as THREE.Material).dispose();
    }
    const geo = new THREE.SphereGeometry(0.008, 4, 3);
    const mat = new THREE.MeshStandardMaterial({ color: 0x888877, roughness: 0.95, metalness: 0.1 });
    const count = 600;
    this.asteroidMesh = new THREE.InstancedMesh(geo, mat, count);
    this.asteroidMesh.castShadow = false;

    const matrix = new THREE.Matrix4();
    const quat   = new THREE.Quaternion();
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const r = ((2.2 + Math.random() * 1.1) * AU) / DISPLAY_SCALE;
      const y = (Math.random() - 0.5) * 0.08 * AU / DISPLAY_SCALE;
      const scale = randRange(0.4, 1.6);
      quat.setFromEuler(new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI));
      matrix.compose(
        new THREE.Vector3(Math.cos(angle) * r, y, Math.sin(angle) * r),
        quat,
        new THREE.Vector3(scale, scale, scale)
      );
      this.asteroidMesh.setMatrixAt(i, matrix);
    }
    this.asteroidMesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.asteroidMesh);
  }

  // ---------------------------------------------------------------------------
  // Solar wind construction & update
  // ---------------------------------------------------------------------------
  private _buildSolarWind(): {
    positions: Float32Array; velocities: Float32Array;
    age: Float32Array; maxAge: Float32Array;
    geom: THREE.BufferGeometry; mesh: THREE.Points;
    posAttr: THREE.BufferAttribute; ageAttr: THREE.BufferAttribute;
  } {
    const positions  = new Float32Array(SW_COUNT * 3);
    const velocities = new Float32Array(SW_COUNT * 3);
    const age        = new Float32Array(SW_COUNT);
    const maxAge     = new Float32Array(SW_COUNT);

    for (let i = 0; i < SW_COUNT; i++) {
      this._resetWindParticle(i, positions, velocities, age, maxAge);
      // Scatter initial ages so particles don't all start at origin
      age[i] = Math.random() * maxAge[i]!;
      const t = age[i]! / maxAge[i]!;
      positions[i * 3]     = velocities[i * 3]!     * maxAge[i]! * t;
      positions[i * 3 + 1] = velocities[i * 3 + 1]! * maxAge[i]! * t;
      positions[i * 3 + 2] = velocities[i * 3 + 2]! * maxAge[i]! * t;
    }

    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(positions, 3);
    const ageAttr = new THREE.BufferAttribute(age, 1);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    ageAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    geom.setAttribute('age', ageAttr);
    geom.setAttribute('maxAge', new THREE.BufferAttribute(maxAge, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 } },
      vertexShader: SOLAR_WIND_VERT,
      fragmentShader: SOLAR_WIND_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Points(geom, mat);
    mesh.frustumCulled = false;
    return { positions, velocities, age, maxAge, geom, mesh, posAttr, ageAttr };
  }

  private _resetWindParticle(
    i: number,
    positions: Float32Array, velocities: Float32Array,
    age: Float32Array, maxAge: Float32Array
  ): void {
    // Emit from near the Sun surface (~2.5 scene units)
    const theta = Math.random() * Math.PI * 2;
    const phi   = Math.acos(2 * Math.random() - 1);
    const r = 2.5;
    const vx = Math.sin(phi) * Math.cos(theta);
    const vy = Math.sin(phi) * Math.sin(theta);
    const vz = Math.cos(phi);
    positions[i * 3]     = vx * r;
    positions[i * 3 + 1] = vy * r;
    positions[i * 3 + 2] = vz * r;
    const speed = randRange(0.08, 0.18);
    velocities[i * 3]     = vx * speed;
    velocities[i * 3 + 1] = vy * speed;
    velocities[i * 3 + 2] = vz * speed;
    age[i]    = 0;
    maxAge[i] = randRange(200, 400);
  }

  updateSolarWind(dt: number): void {
    for (let i = 0; i < SW_COUNT; i++) {
      this.swAge[i]! += dt * 60; // advance in "ticks"
      if (this.swAge[i]! >= this.swMaxAge[i]!) {
        this._resetWindParticle(i, this.swPositions, this.swVelocities, this.swAge, this.swMaxAge);
        continue;
      }
      this.swPositions[i * 3]!     += this.swVelocities[i * 3]!     * dt * 60;
      this.swPositions[i * 3 + 1]! += this.swVelocities[i * 3 + 1]! * dt * 60;
      this.swPositions[i * 3 + 2]! += this.swVelocities[i * 3 + 2]! * dt * 60;
    }
    this.swPosAttr.needsUpdate = true;
    this.swAgeAttr.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Gravity field heatmap — 128×128 DataTexture on the ecliptic plane
  // ---------------------------------------------------------------------------
  private _buildGravField(): void {
    const SIZE = 128;
    const data = new Uint8Array(SIZE * SIZE * 4);
    this.gravFieldTex = new THREE.DataTexture(data, SIZE, SIZE, THREE.RGBAFormat);
    this.gravFieldTex.needsUpdate = true;

    const geo = new THREE.PlaneGeometry(500, 500);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({
      map: this.gravFieldTex,
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.gravFieldMesh = new THREE.Mesh(geo, mat);
    this.gravFieldMesh.visible = false;
    this.scene.add(this.gravFieldMesh);
  }

  updateGravField(bodies: CelestialBody[], G: number): void {
    if (!this.gravFieldTex || !this.gravFieldMesh?.visible) return;
    this.gravFieldFrameSkip++;
    if (this.gravFieldFrameSkip % 5 !== 0) return;

    const SIZE = 128;
    const EXTENT = 250; // scene units from centre
    const data = this.gravFieldTex.image.data as Uint8Array;

    for (let iy = 0; iy < SIZE; iy++) {
      for (let ix = 0; ix < SIZE; ix++) {
        const wx = (ix / SIZE - 0.5) * EXTENT * 2;
        const wz = (iy / SIZE - 0.5) * EXTENT * 2;
        let gMag = 0;
        for (const b of bodies) {
          const dx = b.group.position.x - wx;
          const dy = b.group.position.z - wz;
          const r2 = dx * dx + dy * dy + 1e-4;
          gMag += G * b.state.mass / (r2 * 1e18); // normalise
        }
        const t = Math.min(Math.log10(1 + gMag) / 3, 1);
        const idx = (iy * SIZE + ix) * 4;
        // Blue (cold) → green → red (hot)
        data[idx]     = Math.round(Math.max(0, (t - 0.5) * 2) * 255);
        data[idx + 1] = Math.round(Math.sin(t * Math.PI) * 255);
        data[idx + 2] = Math.round(Math.max(0, (0.5 - t) * 2) * 255);
        data[idx + 3] = 200;
      }
    }
    this.gravFieldTex.needsUpdate = true;
  }

  // ---------------------------------------------------------------------------
  // Lagrange points visualisation
  // ---------------------------------------------------------------------------
  updateLagrangePoints(primary: CelestialBody | null, secondary: CelestialBody | null): void {
    if (!primary || !secondary) {
      this.lagrangeSprites.forEach(s => (s.visible = false));
      return;
    }

    const p1 = primary.group.position;
    const p2 = secondary.group.position;
    const r  = p1.distanceTo(p2);
    const m1 = primary.state.mass;
    const m2 = secondary.state.mass;

    // L1, L2: along the p1→p2 axis at Hill sphere distance from p2
    const hillR = r * Math.pow(m2 / (3 * m1), 1 / 3);
    const axis  = new THREE.Vector3().subVectors(p2, p1).normalize();

    const positions: THREE.Vector3[] = [
      p2.clone().addScaledVector(axis, -hillR),              // L1
      p2.clone().addScaledVector(axis, +hillR),              // L2
      p1.clone().addScaledVector(axis, -(r - hillR)),        // L3 (approx)
      // L4, L5: ±60° from p1→p2
      this._rotateAroundY(p2.clone(), p1, Math.PI / 3),     // L4
      this._rotateAroundY(p2.clone(), p1, -Math.PI / 3),    // L5
    ];

    for (let i = 0; i < 5; i++) {
      this.lagrangeSprites[i]!.position.copy(positions[i]!);
      this.lagrangeSprites[i]!.visible = true;
    }
  }

  private _rotateAroundY(point: THREE.Vector3, pivot: THREE.Vector3, angle: number): THREE.Vector3 {
    const rel = point.sub(pivot);
    const cos = Math.cos(angle), sin = Math.sin(angle);
    return new THREE.Vector3(
      rel.x * cos - rel.z * sin + pivot.x,
      rel.y,
      rel.x * sin + rel.z * cos + pivot.z
    );
  }

  // ---------------------------------------------------------------------------
  // Camera focus
  // ---------------------------------------------------------------------------
  focusOn(body: CelestialBody | null): void {
    if (body) {
      this.controls.target.copy(body.group.position);
      this.controls.update();
    }
  }

  updateFocus(body: CelestialBody | null): void {
    if (body) {
      this.controls.target.copy(body.group.position);
    }
  }

  resetCamera(logScale = false): void {
    if (logScale) {
      this.camera.position.set(0, 4, 2);
    } else {
      // Linear scale: inner solar system (~300 AU FOV). Planets are exaggerated
      // so they're visible; zoom out to see outer planets.
      this.camera.position.set(0, 350, 220);
    }
    this.controls.target.set(0, 0, 0);
    this.controls.update();
  }

  /** Call when the user toggles log ↔ linear scale so the camera repositions. */
  onScaleModeChange(logScale: boolean): void {
    this.resetCamera(logScale);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  render(): void {
    this.controls.update();
    this.composer.render();
    this.labelRenderer.render(this.scene, this.camera);
  }

  // ---------------------------------------------------------------------------
  // FPS tracking
  // ---------------------------------------------------------------------------
  trackFPS(dt: number): void {
    this.fpsSamples.push(1 / Math.max(dt, 0.001));
    if (this.fpsSamples.length > 60) this.fpsSamples.shift();
    this.fps = this.fpsSamples.reduce((a, b) => a + b, 0) / this.fpsSamples.length;
  }

  // ---------------------------------------------------------------------------
  // Scale lerp for smooth linear ↔ log transition
  // ---------------------------------------------------------------------------
  updateScaleLerp(logScale: boolean, dt: number): number {
    const target = logScale ? 1 : 0;
    this.scaleLerpT += (target - this.scaleLerpT) * Math.min(dt * 3, 1);
    if (Math.abs(this.scaleLerpT - target) < 0.001) this.scaleLerpT = target;
    return this.scaleLerpT;
  }

  getScaleLerp(): number { return this.scaleLerpT; }

  // ---------------------------------------------------------------------------
  // Sun light position sync
  // ---------------------------------------------------------------------------
  syncSunLight(sunBody: CelestialBody | null): void {
    if (sunBody) this.sunLight.position.copy(sunBody.group.position);
  }

  // ---------------------------------------------------------------------------
  // Render config application
  // ---------------------------------------------------------------------------
  applyRenderConfig(cfg: RenderConfig): void {
    this.bloomPass.enabled    = cfg.showBloom;
    this.bloomPass.strength   = cfg.bloomStrength;
    if (this.asteroidMesh) this.asteroidMesh.visible = cfg.showAsteroidBelt;
    if (this.swMesh)        this.swMesh.visible       = cfg.showSolarWind;
    if (this.gravFieldMesh) this.gravFieldMesh.visible = cfg.showGravityField;
    this.lagrangeSprites.forEach(s => {
      if (!cfg.showLagrangePoints) s.visible = false;
    });
  }

  // ---------------------------------------------------------------------------
  // Resize
  // ---------------------------------------------------------------------------
  private _onResize(): void {
    const w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
    this.labelRenderer.setSize(w, h);
  }

  // ---------------------------------------------------------------------------
  // Orbit rings — pre-drawn predicted orbital paths for each planet/moon
  // ---------------------------------------------------------------------------
  buildOrbitRings(bodies: CelestialBody[]): void {
    this.clearOrbitRings();
    const N = SceneManager.RING_SEGS;
    const bodyById = new Map(bodies.map(b => [b.state.id, b]));

    for (const body of bodies) {
      if (body.state.isEmissive) continue;

      const positions = new Float32Array(N * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
      const mat = new THREE.LineBasicMaterial({
        color: body.state.trailColor,
        transparent: true,
        opacity: body.state.isMoon ? 0.5 : 0.28,
        depthWrite: false,
      });
      const line = new THREE.LineLoop(geo, mat);
      line.frustumCulled = false;

      if (body.state.isMoon && body.state.parentId) {
        const parentBody = bodyById.get(body.state.parentId);
        if (parentBody) {
          // Place ring as a child of the parent's group so it auto-scales with
          // the parent's visual exaggeration — this puts the moon orbit ring
          // visibly outside the parent's inflated sphere in both scale modes.
          const r_local = body.state.position.clone()
            .sub(parentBody.state.position).length() / DISPLAY_SCALE;
          const posAttr = geo.attributes['position'] as THREE.BufferAttribute;
          for (let i = 0; i < N; i++) {
            const θ = (i / N) * Math.PI * 2;
            posAttr.setXYZ(i, r_local * Math.cos(θ), 0, -r_local * Math.sin(θ));
          }
          posAttr.needsUpdate = true;
          parentBody.group.add(line);
          this.orbitRings.set(body.state.id, { line, physicsRadius: r_local, isMoon: true, parentGroup: parentBody.group });
          continue;
        }
      }

      // Non-moon: ring in world space, centered on the Sun
      const r = body.state.position.length();
      this.scene.add(line);
      this.orbitRings.set(body.state.id, { line, physicsRadius: r });
    }
  }

  /**
   * Called every frame. Updates the world-space ring geometry.
   * Uses the osculating semi-major axis (derived from orbital energy relative to
   * the Sun) instead of the raw instantaneous distance — this keeps the ring
   * stable as the planet moves through its elliptical orbit rather than
   * oscillating between perihelion and aphelion.
   * The ring is centered on the Sun's current physics position so it stays
   * aligned even as the Sun drifts due to N-body perturbations.
   * Moon rings are skipped — they live in the parent group's local space and
   * update automatically when the parent moves.
   */
  updateOrbitRings(bodies: CelestialBody[], logScale: boolean, lerpT: number, G: number): void {
    const N = SceneManager.RING_SEGS;
    const tmp = SceneManager._ringTmp;
    const bodyById = new Map(bodies.map(b => [b.state.id, b]));
    const sun = bodyById.get('sun');
    const sunPhysPos = sun?.state.position ?? new THREE.Vector3();
    const sunVel     = sun?.state.velocity ?? new THREE.Vector3();
    const sunMass    = sun?.state.mass ?? 1.989e30;

    for (const [id, ring] of this.orbitRings) {
      if (ring.isMoon) continue; // auto-updates via parent group transform

      const body = bodyById.get(id);
      if (body) {
        // Relative position and velocity w.r.t. the Sun
        const rx = body.state.position.x - sunPhysPos.x;
        const ry = body.state.position.y - sunPhysPos.y;
        const rz = body.state.position.z - sunPhysPos.z;
        const vx = body.state.velocity.x - sunVel.x;
        const vy = body.state.velocity.y - sunVel.y;
        const vz = body.state.velocity.z - sunVel.z;
        const r   = Math.sqrt(rx*rx + ry*ry + rz*rz);
        const v2  = vx*vx + vy*vy + vz*vz;
        const eps = v2 * 0.5 - G * sunMass / r; // specific orbital energy
        if (eps < 0) {
          // Bound orbit — semi-major axis is a constant of motion
          ring.physicsRadius = -G * sunMass / (2 * eps);
        } else {
          ring.physicsRadius = r; // unbound/escape, fallback to current radius
        }
      }

      const posAttr = ring.line.geometry.attributes['position'] as THREE.BufferAttribute;
      const r = ring.physicsRadius;
      // Centre ring on Sun's current scene position so it follows Sun's drift
      for (let i = 0; i < N; i++) {
        const θ = (i / N) * Math.PI * 2;
        tmp.set(sunPhysPos.x + r * Math.cos(θ), sunPhysPos.y, sunPhysPos.z - r * Math.sin(θ));
        physicsToScene(tmp, logScale, lerpT, tmp);
        posAttr.setXYZ(i, tmp.x, tmp.y, tmp.z);
      }
      posAttr.needsUpdate = true;
    }
  }

  clearOrbitRings(): void {
    for (const [, ring] of this.orbitRings) {
      if (ring.isMoon && ring.parentGroup) {
        ring.parentGroup.remove(ring.line);
      } else {
        this.scene.remove(ring.line);
      }
      ring.line.geometry.dispose();
      (ring.line.material as THREE.Material).dispose();
    }
    this.orbitRings.clear();
  }

  // ---------------------------------------------------------------------------
  // Planet labels — CSS2DRenderer
  // ---------------------------------------------------------------------------
  buildLabels(
    bodies: CelestialBody[],
    onClickBody: (body: CelestialBody) => void,
    onDblClickBody: (body: CelestialBody) => void
  ): void {
    for (const body of bodies) {
      const div = document.createElement('div');
      div.className = body.state.isMoon ? 'planet-label moon-label' : 'planet-label';

      const pip = document.createElement('span');
      pip.className = 'pip';
      const color = '#' + body.state.color.toString(16).padStart(6, '0');
      pip.style.backgroundColor = color;
      pip.style.color = color;
      div.appendChild(pip);

      const nameEl = document.createElement('span');
      nameEl.className = 'name';
      nameEl.textContent = body.state.name;
      div.appendChild(nameEl);

      // Click to select
      div.addEventListener('click', (e) => {
        e.stopPropagation();
        onClickBody(body);
      });

      // Double-click to zoom
      div.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        onDblClickBody(body);
      });

      const labelObj = new CSS2DObject(div);
      labelObj.position.set(0, 0, 0);
      labelObj.center.set(0.5, 1.2);
      this.scene.add(labelObj);
      this.labels.set(body.state.id, labelObj);
    }
  }

  updateLabels(bodies: CelestialBody[]): void {
    const camPos = this.camera.position;
    for (const body of bodies) {
      const label = this.labels.get(body.state.id);
      if (!label) continue;
      label.position.copy(body.group.position);

      // Hide moon labels when camera is far from their parent
      if (body.state.isMoon && body.state.parentId) {
        const parent = bodies.find(b => b.state.id === body.state.parentId);
        if (parent) {
          const distToParent = camPos.distanceTo(parent.group.position);
          // Show moon labels only when zoomed close to the parent planet
          const threshold = parent.visualRadius * parent.group.scale.x * 12;
          label.visible = distToParent < threshold;
        }
      }
    }
  }

  clearLabels(): void {
    for (const [, label] of this.labels) {
      this.scene.remove(label);
      if (label.element.parentNode) {
        label.element.parentNode.removeChild(label.element);
      }
    }
    this.labels.clear();
  }

  dispose(): void {
    this.clearOrbitRings();
    this.clearLabels();
    this.starField.dispose();
    this.renderer.dispose();
    this.composer.dispose();
  }
}
