import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { Lensflare, LensflareElement } from 'three/examples/jsm/objects/Lensflare.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

import { CelestialBody } from '../physics/CelestialBody';
import { StarField } from './StarField';
import { CameraDirector } from './CameraDirector';
import { RenderConfig, CameraConfig } from '../types';
import { AU, randRange, collinearLagrangeGamma } from '../utils/MathUtils';
import { DISPLAY_SCALE, physicsToScene } from '../utils/CoordinateSystem';

// ---------------------------------------------------------------------------
// Solar wind particle system
// ---------------------------------------------------------------------------
const SW_COUNT = 2500;
const SW_MAX_DIST = 60; // scene units from Sun

const SOLAR_WIND_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float age;
  attribute float maxAge;
  uniform float time;
  varying float vAlpha;
  void main() {
    vAlpha = clamp(1.0 - age / maxAge, 0.0, 1.0) * 0.5;
    gl_PointSize = 2.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;
const SOLAR_WIND_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying float vAlpha;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);
    if (r > 0.5) discard;
    gl_FragColor = vec4(1.0, 0.75, 0.35, vAlpha * (1.0 - r * 2.0));
  }
`;

// ---------------------------------------------------------------------------
// God rays — luminance-thresholded radial blur toward the Sun's screen
// position, run in linear HDR space before OutputPass. Occlusion comes free:
// the blur source is the Sun's VISIBLE pixels, so a planet crossing the disk
// blocks its own shafts. Fades out as the Sun leaves the frame.
// ---------------------------------------------------------------------------
const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null },
    uSunScreen: { value: new THREE.Vector2(0.5, 0.5) },
    uIntensity: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uSunScreen;
    uniform float uIntensity;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uIntensity <= 0.001) {
        gl_FragColor = base;
        return;
      }
      vec2 delta = (uSunScreen - vUv) * (1.0 / 40.0) * 0.92;
      vec2 uv = vUv;
      vec3 rays = vec3(0.0);
      float decay = 1.0;
      for (int i = 0; i < 40; i++) {
        uv += delta;
        // Only HDR-bright pixels (the Sun disk / corona) feed the shafts
        vec3 s = max(texture2D(tDiffuse, uv).rgb - vec3(1.0), 0.0);
        rays += s * decay;
        decay *= 0.955;
      }
      gl_FragColor = vec4(base.rgb + rays * (uIntensity / 40.0), base.a);
    }
  `,
};

// ---------------------------------------------------------------------------
// Final dither pass — ±0.5/255 triangular noise on the 8-bit output breaks
// the banding visible in smooth gradients (atmospheres, bloom halos).
// ---------------------------------------------------------------------------
const DitherShader = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    float rand(vec2 co) {
      return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453);
    }
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      // Triangular-distribution dither: sum of two uniforms − 1
      float noise = (rand(gl_FragCoord.xy) + rand(gl_FragCoord.yx + 17.0)) * 0.5 - 0.5;
      gl_FragColor = vec4(color.rgb + noise / 255.0, color.a);
    }
  `,
};

// ---------------------------------------------------------------------------
// Procedural lens-flare element textures (no image assets needed)
// ---------------------------------------------------------------------------
function makeFlareGlowTexture(): THREE.CanvasTexture {
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0.0, 'rgba(255,245,224,1.0)');
  g.addColorStop(0.25, 'rgba(255,235,200,0.55)');
  g.addColorStop(0.6, 'rgba(255,220,170,0.12)');
  g.addColorStop(1.0, 'rgba(255,210,150,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

function makeFlareStarburstTexture(): THREE.CanvasTexture {
  const size = 512;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const cx = size / 2;
  ctx.translate(cx, cx);
  // 6 diffraction spikes
  for (let i = 0; i < 6; i++) {
    const g = ctx.createLinearGradient(0, -cx, 0, cx);
    g.addColorStop(0.0, 'rgba(255,245,230,0)');
    g.addColorStop(0.5, 'rgba(255,245,230,0.85)');
    g.addColorStop(1.0, 'rgba(255,245,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-1.1, -cx, 2.2, size);
    ctx.rotate(Math.PI / 3);
  }
  // Soft core
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 40);
  core.addColorStop(0, 'rgba(255,250,240,0.9)');
  core.addColorStop(1, 'rgba(255,250,240,0)');
  ctx.fillStyle = core;
  ctx.fillRect(-cx, -cx, size, size);
  return new THREE.CanvasTexture(c);
}

function makeFlareGhostTexture(): THREE.CanvasTexture {
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const cx = size / 2;
  // Chromatic-fringed ring: offset RGB circles
  const rings: Array<[string, number]> = [
    ['rgba(255,80,80,0.25)', -1.5],
    ['rgba(90,255,120,0.25)', 0],
    ['rgba(90,140,255,0.25)', 1.5],
  ];
  for (const [color, off] of rings) {
    const g = ctx.createRadialGradient(cx + off, cx, cx * 0.45, cx + off, cx, cx * 0.9);
    g.addColorStop(0.0, 'rgba(0,0,0,0)');
    g.addColorStop(0.55, color);
    g.addColorStop(0.75, color.replace('0.25', '0.08'));
    g.addColorStop(1.0, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(c);
}

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
  director!: CameraDirector;

  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private godraysPass!: ShaderPass;
  private godraysEnabled = true;
  private static readonly _sunProj = new THREE.Vector3();
  private starField: StarField;
  private sunLight: THREE.PointLight;
  private ambientLight: THREE.AmbientLight;
  private lensflare!: Lensflare;

  // CSS2D label renderer
  private labelRenderer: CSS2DRenderer;
  private labels: Map<string, CSS2DObject> = new Map();

  // Asteroid belt
  private asteroidMesh: THREE.InstancedMesh | null = null;
  private beltTimeUniform = { value: 0 };

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
    centerId?: string;  // body this ring orbits around (default: 'sun')
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
    // Renderer. logarithmicDepthBuffer: the camera spans near=0.001 to
    // far=1e8 — a standard depth buffer loses all precision past a few
    // units, z-fighting orbit rings against body surfaces.
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      logarithmicDepthBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

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
    this.director = new CameraDirector(this.camera, this.controls);

    // Lights
    this.sunLight = new THREE.PointLight(0xFFF5E0, 4.0, 0, 0); // decay=0: constant reach for both log and linear scale
    this.sunLight.position.set(0, 0, 0);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1024, 1024);
    this.sunLight.shadow.camera.near = 0.1;
    this.sunLight.shadow.camera.far = 1e6;
    this.sunLight.shadow.bias = -0.00005;
    this.scene.add(this.sunLight);

    // Lens flare — procedural textures, occlusion-tested by Lensflare itself
    // (fades when a planet or the screen edge covers the Sun).
    this.lensflare = new Lensflare();
    const flareTint = new THREE.Color(0xFFF5E0);
    this.lensflare.addElement(new LensflareElement(makeFlareGlowTexture(), 340, 0, flareTint));
    this.lensflare.addElement(new LensflareElement(makeFlareStarburstTexture(), 500, 0, flareTint));
    const ghostTex = makeFlareGhostTexture();
    for (const [size, dist] of [[58, 0.32], [90, 0.5], [70, 0.68], [130, 0.9], [110, 1.2]] as const) {
      this.lensflare.addElement(new LensflareElement(ghostTex, size, dist));
    }
    this.sunLight.add(this.lensflare);

    this.ambientLight = new THREE.AmbientLight(0x182033, 0.13);
    this.scene.add(this.ambientLight);

    // Starfield
    this.starField = new StarField();
    this.starField.addToScene(this.scene);

    // Post-processing. The default EffectComposer target is non-multisampled,
    // which silently discards the canvas's antialias flag — pass an explicit
    // MSAA half-float target so edges stay smooth and bloom works in HDR.
    const dpr = this.renderer.getPixelRatio();
    this.composer = new EffectComposer(this.renderer, new THREE.WebGLRenderTarget(
      window.innerWidth * dpr, window.innerHeight * dpr,
      { samples: 4, type: THREE.HalfFloatType }
    ));
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.5,   // strength — subtle glow, keeps planets visible
      0.2,   // radius — tight so bloom stays on the Sun disk
      0.82   // threshold — only emissive Sun exceeds this
    );
    this.composer.addPass(this.bloomPass);
    this.godraysPass = new ShaderPass(GodRaysShader);
    this.composer.addPass(this.godraysPass);
    this.composer.addPass(new OutputPass());
    this.composer.addPass(new ShaderPass(DitherShader));

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
  /**
   * Living asteroid belt: every rock orbits at its true Keplerian rate, on
   * the GPU. Instances are placed at phase 0 along +X; the vertex shader
   * rotates each by (phase0 + k·uBaseAng), where k is the rock's mean motion
   * quantized to integer multiples of ω0 = 2π/600yr. main.ts feeds
   * uBaseAng = (ω0·simTime) mod 2π (computed in double precision), so shader
   * angles stay small and exact at any simulation time — inner rocks visibly
   * lap outer ones under time-warp, and the Kirkwood gaps persist.
   */
  buildAsteroidBelt(): void {
    if (this.asteroidMesh) {
      this.scene.remove(this.asteroidMesh);
      this.asteroidMesh.geometry.dispose();
      (this.asteroidMesh.material as THREE.Material).dispose();
    }
    const geo = new THREE.SphereGeometry(0.007, 5, 4);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.96,
      metalness: 0.08,
      vertexColors: true,
    });

    const count = 9000;
    const orbit = new Float32Array(count * 4); // r, phase0, k, yAmp
    const GM_SUN = 6.674e-11 * 1.989e30;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms['uBaseAng'] = this.beltTimeUniform;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute vec4 aOrbit;\nuniform float uBaseAng;')
        .replace('#include <project_vertex>', /* glsl */`
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
            float beltAng = aOrbit.y + aOrbit.z * uBaseAng;
            float bc = cos(beltAng), bs = sin(beltAng);
            mvPosition.xz = mat2(bc, -bs, bs, bc) * mvPosition.xz;
            mvPosition.y += aOrbit.w * sin(beltAng * 1.7 + aOrbit.y * 3.0);
          #endif
          mvPosition = modelViewMatrix * mvPosition;
          gl_Position = projectionMatrix * mvPosition;
        `);
    };

    this.asteroidMesh = new THREE.InstancedMesh(geo, mat, count);
    this.asteroidMesh.castShadow = false;
    this.asteroidMesh.frustumCulled = false;

    const matrix = new THREE.Matrix4();
    const quat   = new THREE.Quaternion();
    const color  = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const phase0 = Math.random() * Math.PI * 2;
      const eccentricity = randRange(0.0, 0.22);
      let semiMajorAxisAU = 2.05 + Math.pow(Math.random(), 0.72) * 1.35;
      if (Math.abs(semiMajorAxisAU - 2.50) < 0.035) semiMajorAxisAU += 0.055;
      if (Math.abs(semiMajorAxisAU - 2.82) < 0.040) semiMajorAxisAU -= 0.060;
      const orbitR = semiMajorAxisAU * (1 - eccentricity * eccentricity)
                   / (1 + eccentricity * Math.cos(phase0));
      const r = (orbitR * AU) / DISPLAY_SCALE;
      const inc = randRange(-0.13, 0.13);
      const scale = Math.pow(Math.random(), 2.4) * 2.2 + 0.25;
      quat.setFromEuler(new THREE.Euler(Math.random() * Math.PI, Math.random() * Math.PI, Math.random() * Math.PI));
      // Rock sits at phase 0 (+X); the shader applies the orbital angle
      matrix.compose(
        new THREE.Vector3(r, 0, 0),
        quat,
        new THREE.Vector3(scale, scale, scale)
      );
      this.asteroidMesh.setMatrixAt(i, matrix);

      // True mean motion for this semi-major axis, quantized to k·ω0
      const aMetres = semiMajorAxisAU * AU;
      const n = Math.sqrt(GM_SUN / (aMetres * aMetres * aMetres));
      const k = Math.max(1, Math.round(n / SceneManager.BELT_OMEGA0));
      orbit[i * 4]     = r;
      orbit[i * 4 + 1] = phase0;
      orbit[i * 4 + 2] = k;
      orbit[i * 4 + 3] = Math.sin(inc) * r;

      const metallic = Math.random();
      if (metallic > 0.88) color.setRGB(0.62, 0.58, 0.50);
      else if (metallic > 0.62) color.setRGB(0.46, 0.42, 0.36);
      else color.setRGB(0.30, 0.29, 0.26);
      this.asteroidMesh.setColorAt(i, color);
    }
    geo.setAttribute('aOrbit', new THREE.InstancedBufferAttribute(orbit, 4));
    this.asteroidMesh.instanceMatrix.needsUpdate = true;
    if (this.asteroidMesh.instanceColor) this.asteroidMesh.instanceColor.needsUpdate = true;
    this.scene.add(this.asteroidMesh);
  }

  /** ω0 for belt mean-motion quantization: 2π / 600 years. */
  private static readonly BELT_OMEGA0 = (2 * Math.PI) / (600 * 3.15576e7);

  /** Advance the belt's shared orbital clock (double-precision mod on CPU). */
  updateAsteroidBelt(simTimeSeconds: number): void {
    this.beltTimeUniform.value =
      (SceneManager.BELT_OMEGA0 * simTimeSeconds) % (2 * Math.PI);
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
  /**
   * Exact L1–L5 for the (primary, secondary) pair, computed in PHYSICS space
   * (Euler-quintic collinear points, true equilateral L4/L5 in the actual
   * orbital plane) then mapped through physicsToScene — correct in every
   * view mode, including log scale where naive scene-space math distorts.
   */
  updateLagrangePoints(
    primary: CelestialBody | null,
    secondary: CelestialBody | null,
    logScale = false,
    lerpT = 0
  ): void {
    if (!primary || !secondary || secondary.state.isSpacecraft) {
      this.lagrangeSprites.forEach(s => (s.visible = false));
      return;
    }

    const p1 = primary.state.position;
    const p2 = secondary.state.position;
    const v1 = primary.state.velocity;
    const v2 = secondary.state.velocity;
    const R = p1.distanceTo(p2);
    if (R < 1) {
      this.lagrangeSprites.forEach(s => (s.visible = false));
      return;
    }
    const mu = secondary.state.mass / (primary.state.mass + secondary.state.mass);
    const axis = new THREE.Vector3().subVectors(p2, p1).divideScalar(R);

    const g1 = collinearLagrangeGamma(mu, 'L1');
    const g2 = collinearLagrangeGamma(mu, 'L2');

    // Orbital plane normal from the actual relative motion
    const relV = new THREE.Vector3().subVectors(v2, v1);
    const normal = new THREE.Vector3().crossVectors(axis, relV);
    if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
    normal.normalize();

    const rel = new THREE.Vector3().subVectors(p2, p1);
    const l4 = rel.clone().applyAxisAngle(normal, Math.PI / 3).add(p1);
    const l5 = rel.clone().applyAxisAngle(normal, -Math.PI / 3).add(p1);

    const physPositions: THREE.Vector3[] = [
      p2.clone().addScaledVector(axis, -g1 * R),                 // L1
      p2.clone().addScaledVector(axis, +g2 * R),                 // L2
      p1.clone().addScaledVector(axis, -R * (1 + 5 * mu / 12)),  // L3 (1st order)
      l4,
      l5,
    ];

    const spriteScale = logScale ? 0.05 : 1.5;
    const tmp = SceneManager._ringTmp;
    for (let i = 0; i < 5; i++) {
      physicsToScene(physPositions[i]!, logScale, lerpT, tmp);
      this.lagrangeSprites[i]!.position.copy(tmp);
      this.lagrangeSprites[i]!.scale.set(spriteScale, spriteScale, 1);
      this.lagrangeSprites[i]!.visible = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Camera focus
  // ---------------------------------------------------------------------------
  /** Cinematic eased flight to a body (was an instant snap). */
  focusOn(body: CelestialBody | null): void {
    if (!body) return;
    const displayR = Math.max(body.visualRadius * body.group.scale.x, 0.02);
    this.director.flyTo(() => body.group.position, displayR * 6.5, { duration: 1.7 });
  }

  updateFocus(body: CelestialBody | null): void {
    // While a cinematic flight runs it owns the controls target
    if (body && !this.director.flying) {
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
    this._updateGodRays(sunBody);
  }

  private _updateGodRays(sunBody: CelestialBody | null): void {
    const u = this.godraysPass.uniforms as typeof GodRaysShader.uniforms;
    if (!this.godraysEnabled || !sunBody) {
      u.uIntensity.value = 0;
      return;
    }
    const p = SceneManager._sunProj.copy(sunBody.group.position).project(this.camera);
    if (p.z > 1) { // behind the camera
      u.uIntensity.value = 0;
      return;
    }
    u.uSunScreen.value.set((p.x + 1) / 2, (p.y + 1) / 2);
    // Fade as the Sun approaches / leaves the frame edges
    const edge = Math.min(
      1 - Math.abs(p.x) * 0.55,
      1 - Math.abs(p.y) * 0.55
    );
    u.uIntensity.value = Math.max(0, Math.min(1, edge)) * 0.85;
  }

  // ---------------------------------------------------------------------------
  // Render config application
  // ---------------------------------------------------------------------------
  applyRenderConfig(cfg: RenderConfig): void {
    this.bloomPass.enabled    = cfg.showBloom;
    this.bloomPass.strength   = cfg.bloomStrength;
    this.renderer.toneMappingExposure = cfg.exposure;
    this.lensflare.visible = cfg.showLensflare;
    this.godraysEnabled = cfg.showGodRays;
    // Belt geometry lives in linear scene coordinates — hide it in log mode
    // where the whole system compresses to ~2.5 units
    if (this.asteroidMesh) this.asteroidMesh.visible = cfg.showAsteroidBelt && !cfg.logScale;
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
    // Re-apply pixel ratio: browser zoom or dragging to a different-DPR
    // monitor changes devicePixelRatio after construction.
    const dpr = Math.min(window.devicePixelRatio, 2);
    this.renderer.setPixelRatio(dpr);
    this.composer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
    this.labelRenderer.setSize(w, h);
  }

  /**
   * Photo-mode capture: renders at `scale`× resolution and returns a PNG
   * data URL, then restores the normal viewport.
   */
  captureScreenshot(scale = 2): string {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w * scale, h * scale, false);
    this.composer.setSize(w * scale, h * scale);
    this.bloomPass.resolution.set(w * scale, h * scale);
    this.composer.render();
    const url = this.renderer.domElement.toDataURL('image/png');
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
    this.composer.render();
    return url;
  }

  // ---------------------------------------------------------------------------
  // Orbit rings — pre-drawn predicted orbital paths for each planet/moon
  // ---------------------------------------------------------------------------
  buildOrbitRings(bodies: CelestialBody[], realScale: boolean = false): void {
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
        opacity: body.state.isMoon ? 0.48 : 0.24,
        depthWrite: false,
      });
      const line = new THREE.LineLoop(geo, mat);
      line.frustumCulled = false;

      if (body.state.isMoon && body.state.parentId) {
        const parentBody = bodyById.get(body.state.parentId);
        if (parentBody) {
          const physDist = body.state.position.clone()
            .sub(parentBody.state.position).length();

          if (realScale) {
            // Real scale: moon ring in world space, updated per-frame like planet rings
            this.scene.add(line);
            this.orbitRings.set(body.state.id, {
              line, physicsRadius: physDist,
              isMoon: true, centerId: body.state.parentId,
            });
          } else {
            // Exaggerated: ring in parent group local space at visual offset
            const orbitRatio = physDist / parentBody.state.radius;
            const parentDisplayR = parentBody.visualRadius;
            const sceneDist = parentDisplayR * (1.3 + orbitRatio * 0.08);
            const posAttr = geo.attributes['position'] as THREE.BufferAttribute;
            for (let i = 0; i < N; i++) {
              const θ = (i / N) * Math.PI * 2;
              posAttr.setXYZ(i, sceneDist * Math.cos(θ), 0, -sceneDist * Math.sin(θ));
            }
            posAttr.needsUpdate = true;
            parentBody.group.add(line);
            this.orbitRings.set(body.state.id, { line, physicsRadius: sceneDist, isMoon: true, parentGroup: parentBody.group });
          }
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
  updateOrbitRings(bodies: CelestialBody[], logScale: boolean, lerpT: number, G: number, realScale: boolean = false): void {
    const N = SceneManager.RING_SEGS;
    const tmp = SceneManager._ringTmp;
    const bodyById = new Map(bodies.map(b => [b.state.id, b]));
    const sun = bodyById.get('sun');
    const sunPhysPos = sun?.state.position ?? new THREE.Vector3();
    const sunVel     = sun?.state.velocity ?? new THREE.Vector3();
    const sunMass    = sun?.state.mass ?? 1.989e30;

    for (const [id, ring] of this.orbitRings) {
      // In non-realScale mode, moon rings in parent group auto-update
      if (ring.isMoon && !ring.centerId) continue;

      // Real-scale moon ring: center on parent body
      if (ring.isMoon && ring.centerId) {
        const centerBody = bodyById.get(ring.centerId);
        const moonBody = bodyById.get(id);
        if (!centerBody || !moonBody) continue;

        const posAttr = ring.line.geometry.attributes['position'] as THREE.BufferAttribute;
        const relPos = moonBody.state.position.clone().sub(centerBody.state.position);
        const relVel = moonBody.state.velocity.clone().sub(centerBody.state.velocity);
        const wroteOrbit = this._writeKeplerRing(
          posAttr, centerBody.state.position, centerBody.state.mass,
          relPos, relVel, logScale, lerpT, G
        );
        if (!wroteOrbit) {
          const physDist = relPos.length();
          ring.physicsRadius = physDist;
          const centerPos = centerBody.state.position;
          for (let i = 0; i < N; i++) {
            const θ = (i / N) * Math.PI * 2;
            tmp.set(
              centerPos.x + physDist * Math.cos(θ),
              centerPos.y,
              centerPos.z - physDist * Math.sin(θ)
            );
            physicsToScene(tmp, logScale, lerpT, tmp);
            posAttr.setXYZ(i, tmp.x, tmp.y, tmp.z);
          }
        }
        posAttr.needsUpdate = true;
        continue;
      }

      const posAttr = ring.line.geometry.attributes['position'] as THREE.BufferAttribute;
      const body = bodyById.get(id);
      if (body) {
        // Relative position and velocity w.r.t. the Sun
        const relPos = body.state.position.clone().sub(sunPhysPos);
        const relVel = body.state.velocity.clone().sub(sunVel);
        const wroteOrbit = this._writeKeplerRing(
          posAttr, sunPhysPos, sunMass, relPos, relVel, logScale, lerpT, G
        );
        if (wroteOrbit) {
          posAttr.needsUpdate = true;
          continue;
        }

        const r = relPos.length();
        ring.physicsRadius = r; // unbound/escape, fallback to current radius
      }

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

  private _writeKeplerRing(
    posAttr: THREE.BufferAttribute,
    focusPhysPos: THREE.Vector3,
    centralMass: number,
    relPos: THREE.Vector3,
    relVel: THREE.Vector3,
    logScale: boolean,
    lerpT: number,
    G: number
  ): boolean {
    const N = SceneManager.RING_SEGS;
    const mu = G * centralMass;
    const r = relPos.length();
    if (r < 1 || mu <= 0) return false;

    const h = new THREE.Vector3().crossVectors(relPos, relVel);
    const hMag = h.length();
    if (hMag < 1e-6) return false;

    const v2 = relVel.lengthSq();
    const eps = v2 * 0.5 - mu / r;
    if (eps >= 0) return false;

    const a = -mu / (2 * eps);
    const eVec = new THREE.Vector3().crossVectors(relVel, h).multiplyScalar(1 / mu)
      .addScaledVector(relPos, -1 / r);
    const e = eVec.length();
    if (!Number.isFinite(a) || !Number.isFinite(e) || e >= 0.999) return false;

    const hHat = h.divideScalar(hMag);
    const pHat = e > 1e-4 ? eVec.divideScalar(e) : relPos.clone().normalize();
    const qHat = new THREE.Vector3().crossVectors(hHat, pHat).normalize();
    const semiLatus = a * (1 - e * e);
    if (!Number.isFinite(semiLatus) || semiLatus <= 0) return false;

    const tmpPhys = new THREE.Vector3();
    const tmpScene = SceneManager._ringTmp;
    for (let i = 0; i < N; i++) {
      const theta = (i / N) * Math.PI * 2;
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      const orbitR = semiLatus / (1 + e * cosT);
      tmpPhys.copy(focusPhysPos)
        .addScaledVector(pHat, orbitR * cosT)
        .addScaledVector(qHat, orbitR * sinT);
      physicsToScene(tmpPhys, logScale, lerpT, tmpScene);
      posAttr.setXYZ(i, tmpScene.x, tmpScene.y, tmpScene.z);
    }
    return true;
  }

  /** Remove and dispose a single body's orbit ring (body deleted or merged). */
  removeOrbitRing(id: string): void {
    const ring = this.orbitRings.get(id);
    if (!ring) return;
    if (ring.isMoon && ring.parentGroup) {
      ring.parentGroup.remove(ring.line);
    } else {
      this.scene.remove(ring.line);
    }
    ring.line.geometry.dispose();
    (ring.line.material as THREE.Material).dispose();
    this.orbitRings.delete(id);
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
      // Hidden bodies (spacecraft outside trajectory coverage) hide labels
      label.visible = body.group.visible;
      if (!body.group.visible) continue;

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

  /** Remove a single body's label (body deleted or merged). */
  removeLabel(id: string): void {
    const label = this.labels.get(id);
    if (!label) return;
    this.scene.remove(label);
    if (label.element.parentNode) {
      label.element.parentNode.removeChild(label.element);
    }
    this.labels.delete(id);
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
