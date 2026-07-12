import * as THREE from 'three';
import { BodyState } from '../types';
import { physicsToScene, visualRadius, DISPLAY_SCALE } from '../utils/CoordinateSystem';
import { Trail } from '../rendering/TrailRenderer';
import { buildScatteringAtmosphere, AtmosphereHandle, ATMOSPHERE_PARAMS } from '../rendering/AtmosphereShader';
import { buildLitRingMaterial, RingMaterialHandle, RING_SHADOW_GLSL, makeRingShadowUniforms, RingShadowUniforms } from '../rendering/RingShader';
import { patchStandardMaterialForEclipse, makeEclipseUniforms, EclipseUniforms, ECLIPSE_GLSL } from '../rendering/EclipseShadows';

// ---------------------------------------------------------------------------
// Saturn ring UV fix — RingGeometry UVs don't map concentrically by default
// ---------------------------------------------------------------------------
function fixRingUVs(geometry: THREE.RingGeometry, innerR: number, outerR: number): void {
  const pos = geometry.attributes['position'] as THREE.BufferAttribute;
  const uv  = geometry.attributes['uv']  as THREE.BufferAttribute;
  const v3  = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v3.fromBufferAttribute(pos, i);
    const dist = v3.length();
    uv.setXY(i,
      (dist - innerR) / (outerR - innerR),
      Math.atan2(v3.z, v3.x) / (2 * Math.PI) + 0.5
    );
  }
  uv.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Procedural cloud layer for Earth. This is generated at runtime so the existing
// texture assets stay untouched while Earth gains an independent moving layer.
// ---------------------------------------------------------------------------
function makeEarthCloudTexture(): THREE.CanvasTexture {
  const size = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size / 2;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(canvas.width, canvas.height);

  for (let y = 0; y < canvas.height; y++) {
    const lat = Math.abs((y / canvas.height) * 2 - 1);
    for (let x = 0; x < canvas.width; x++) {
      const nx = x / canvas.width;
      const ny = y / canvas.height;
      const waveA = Math.sin(nx * 42 + Math.sin(ny * 18) * 1.6);
      const waveB = Math.sin(nx * 77 - ny * 31);
      const waveC = Math.sin((nx + ny) * 96);
      const stormBands = Math.sin((ny - 0.5) * 30 + waveA * 1.4);
      const noise = waveA * 0.36 + waveB * 0.28 + waveC * 0.18 + stormBands * 0.34;
      const equatorWeight = Math.max(0, 1 - lat * 1.45);
      const polarWisps = Math.max(0, lat - 0.58) * 0.65;
      const coverage = noise + equatorWeight * 0.18 + polarWisps;
      const alpha = Math.max(0, Math.min(1, (coverage - 0.18) * 1.35));
      const i = (y * canvas.width + x) * 4;
      image.data[i] = 255;
      image.data[i + 1] = 255;
      image.data[i + 2] = 255;
      image.data[i + 3] = Math.round(alpha * 155);
    }
  }

  ctx.putImageData(image, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------
// Procedural gas-giant stripe texture
// ---------------------------------------------------------------------------
function makeStripedTexture(baseColor: number, stripeColor: number): THREE.DataTexture {
  const W = 512, H = 256;
  const data = new Uint8Array(W * H * 3);
  const br = (baseColor >> 16) & 0xff, bg = (baseColor >> 8) & 0xff, bb = baseColor & 0xff;
  const sr = (stripeColor >> 16) & 0xff, sg = (stripeColor >> 8) & 0xff, sb = stripeColor & 0xff;
  for (let y = 0; y < H; y++) {
    const t = (Math.sin(y * 0.25) * 0.5 + 0.5) * (Math.sin(y * 0.07 + 1.2) * 0.3 + 0.7);
    const r = Math.round(br + (sr - br) * t);
    const g = Math.round(bg + (sg - bg) * t);
    const b = Math.round(bb + (sb - bb) * t);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBFormat);
  tex.needsUpdate = true;
  return tex;
}

// Gas giant procedural stripe colours (base, stripe)
const GAS_GIANT_STRIPES: Record<string, [number, number]> = {
  jupiter: [0xC88B3A, 0x9B6A3A],
  saturn:  [0xE8D5A3, 0xC0A870],
  uranus:  [0x7DE8E8, 0x4AABB0],
  neptune: [0x3F54BA, 0x2A3A8A],
};

// ---------------------------------------------------------------------------
// Ring systems. Saturn uses its texture asset; Jupiter/Uranus/Neptune use
// procedural radial strip textures built from real ring radii (planet radii).
// Uranus's near-vertical hoops come free from its 98° axial tilt.
// ---------------------------------------------------------------------------
interface RingStrip { r0: number; r1: number; color: number; alpha: number }
interface RingSpec  { innerR: number; outerR: number; opacity: number; strips: RingStrip[] }

const RING_SPECS: Record<string, RingSpec> = {
  jupiter: {
    innerR: 1.40, outerR: 1.82, opacity: 0.30,
    strips: [
      { r0: 1.40, r1: 1.71, color: 0x8a7a66, alpha: 0.05 },  // halo (very faint)
      { r0: 1.71, r1: 1.81, color: 0xa89478, alpha: 0.16 },  // main ring
    ],
  },
  uranus: {
    innerR: 1.60, outerR: 2.01, opacity: 0.85,
    strips: [
      { r0: 1.637, r1: 1.644, color: 0x3c3c42, alpha: 0.45 }, // ring 6
      { r0: 1.652, r1: 1.659, color: 0x3c3c42, alpha: 0.45 }, // ring 5
      { r0: 1.666, r1: 1.673, color: 0x3c3c42, alpha: 0.45 }, // ring 4
      { r0: 1.750, r1: 1.760, color: 0x46464c, alpha: 0.55 }, // alpha
      { r0: 1.786, r1: 1.796, color: 0x46464c, alpha: 0.55 }, // beta
      { r0: 1.834, r1: 1.840, color: 0x404046, alpha: 0.50 }, // eta
      { r0: 1.863, r1: 1.869, color: 0x48484e, alpha: 0.55 }, // gamma
      { r0: 1.900, r1: 1.907, color: 0x48484e, alpha: 0.55 }, // delta
      { r0: 1.958, r1: 2.006, color: 0x55555c, alpha: 0.75 }, // epsilon (brightest)
    ],
  },
  neptune: {
    innerR: 1.65, outerR: 2.56, opacity: 0.55,
    strips: [
      { r0: 1.677, r1: 1.712, color: 0x5a5450, alpha: 0.12 }, // Galle
      { r0: 2.135, r1: 2.148, color: 0x6a625c, alpha: 0.30 }, // Le Verrier
      { r0: 2.148, r1: 2.310, color: 0x554f4a, alpha: 0.08 }, // Lassell plateau
      { r0: 2.525, r1: 2.545, color: 0x746a62, alpha: 0.40 }, // Adams
    ],
  },
};

function makeRingStripTexture(spec: RingSpec): THREE.DataTexture {
  const W = 1024;
  const data = new Uint8Array(W * 4);
  for (let x = 0; x < W; x++) {
    const r = spec.innerR + (x / (W - 1)) * (spec.outerR - spec.innerR);
    let cr = 0, cg = 0, cb = 0, ca = 0;
    for (const s of spec.strips) {
      if (r >= s.r0 && r <= s.r1) {
        // Soft edges within each strip
        const w = s.r1 - s.r0;
        const t = Math.min((r - s.r0) / w, (s.r1 - r) / w) * 2;
        const soft = Math.min(1, t * 3);
        cr = (s.color >> 16) & 0xff;
        cg = (s.color >> 8) & 0xff;
        cb = s.color & 0xff;
        ca = Math.max(ca, s.alpha * soft * 255);
      }
    }
    data[x * 4] = cr; data[x * 4 + 1] = cg; data[x * 4 + 2] = cb; data[x * 4 + 3] = Math.round(ca);
  }
  const tex = new THREE.DataTexture(data, W, 1, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------
// Earth day/night shader
// ---------------------------------------------------------------------------
const EARTH_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const EARTH_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform sampler2D cloudMap;
  uniform float cloudShift;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  varying vec3 vWorldPos;
  ECLIPSE_CHUNK
  void main() {
    #include <logdepthbuf_fragment>
    float intensity = dot(vWorldNormal, normalize(sunDir));
    float blend = smoothstep(-0.18, 0.30, intensity);
    vec4 day   = texture2D(dayMap, vUv);
    vec4 night = texture2D(nightMap, vUv);

    // Eclipse: the Moon's umbra/penumbra darkens the day side; city lights
    // stay visible inside the shadow (they would switch on).
    float eVis = sunVisibility(vWorldPos);
    float dayLight = blend * mix(0.03, 1.0, eVis);

    // Specular ocean sun-glint: oceans are the blue-dominant day-map pixels
    float oceanMask = smoothstep(0.02, 0.18, day.b - max(day.r, day.g));
    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    vec3 halfV = normalize(normalize(sunDir) + viewDir);
    float glint = pow(max(dot(normalize(vWorldNormal), halfV), 0.0), 90.0);
    vec3 specular = vec3(1.0, 0.93, 0.78) * glint * oceanMask * 0.75 * dayLight;

    // Cloud shadows: sample the cloud layer (rotated by cloudShift) and
    // darken the surface beneath
    float cloudA = texture2D(cloudMap, vec2(vUv.x + cloudShift, vUv.y)).a;
    float cloudShadow = 1.0 - cloudA * 0.42;

    float limb = pow(1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
    vec3 twilight = vec3(0.24, 0.42, 0.70) * smoothstep(-0.22, 0.04, intensity) * (1.0 - blend) * eVis;
    vec3 cityLights = night.rgb * 2.8 * (1.0 - dayLight);
    vec3 color = mix(cityLights, day.rgb * cloudShadow, dayLight) + specular;
    color += twilight + vec3(0.12, 0.20, 0.34) * limb * 0.25 * eVis;
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Animated Sun and atmosphere shaders
// ---------------------------------------------------------------------------
// Shared GLSL 3D value-noise + FBM (sampled on the object-space sphere
// direction, NOT UVs — kills the polar pinch and the longitude seam).
const NOISE3_GLSL = /* glsl */`
  float hash3(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
  }
  float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash3(i), hash3(i + vec3(1,0,0)), u.x),
          mix(hash3(i + vec3(0,1,0)), hash3(i + vec3(1,1,0)), u.x), u.y),
      mix(mix(hash3(i + vec3(0,0,1)), hash3(i + vec3(1,0,1)), u.x),
          mix(hash3(i + vec3(0,1,1)), hash3(i + vec3(1,1,1)), u.x), u.y),
      u.z);
  }
  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise3(p);
      p = p * 2.03 + vec3(19.7);
      a *= 0.5;
    }
    return v;
  }
`;

const SUN_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vObjDir;
  varying vec3 vNormal;
  void main() {
    vObjDir = normalize(position);
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const SUN_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float time;
  varying vec3 vObjDir;
  varying vec3 vNormal;

  ${NOISE3_GLSL}

  void main() {
    #include <logdepthbuf_fragment>
    vec3 dir = normalize(vObjDir);

    // Supergranulation: slow, large convection cells
    float superCells = fbm(dir * 5.0 + vec3(0.0, time * 0.008, 0.0));
    // Domain-warped granulation: fast churning small cells
    vec3 warp = vec3(fbm(dir * 7.0 + time * 0.02)) * 2.4;
    float gran = fbm(dir * 34.0 + warp + vec3(time * 0.05));
    // Bright faculae filaments where warp gradients pinch
    float filaments = pow(fbm(dir * 15.0 - warp * 0.8 + vec3(0.0, -time * 0.015, 0.0)), 3.0);

    // Temperature ramp: deep orange troughs → white-yellow cell centres
    float t = clamp(superCells * 0.45 + gran * 0.75, 0.0, 1.3);
    vec3 cool = vec3(0.95, 0.28, 0.02);
    vec3 hot  = vec3(1.0, 0.96, 0.62);
    vec3 color = mix(cool, hot, t) + vec3(1.0, 0.85, 0.5) * filaments * 0.8;

    // Physically-correct limb darkening: photosphere is BRIGHTER at disk
    // centre (mu=1) and darker at the limb (mu=0) — I/I0 = 1 − u(1 − mu)
    float mu = clamp(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0, 1.0);
    color *= 0.35 + 0.65 * mu;

    // HDR output: exceed the bloom threshold (0.82) so UnrealBloomPass
    // produces the glow naturally from the brightest granules.
    gl_FragColor = vec4(color * 2.6, 1.0);
  }
`;

// Corona: camera-facing billboard quad with radial FBM streamers.
const CORONA_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vQuad;
  void main() {
    vQuad = position.xy;
    // Billboard: strip rotation from the modelView transform
    vec4 mvPosition = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    mvPosition.xy += position.xy;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const CORONA_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float time;
  uniform float sunRadius;   // in quad-local units (quad spans ±1)
  varying vec2 vQuad;

  ${NOISE3_GLSL}

  void main() {
    #include <logdepthbuf_fragment>
    float r = length(vQuad);
    if (r < sunRadius * 0.85) discard; // hidden behind the disk anyway
    float ang = atan(vQuad.y, vQuad.x);

    // Radial streamers: noise stretched hard along the radius
    float streamers = fbm(vec3(cos(ang), sin(ang), 0.0) * 3.0
                        + vec3(0.0, 0.0, r * 1.5 - time * 0.012));
    streamers = 0.55 + 0.45 * streamers;

    // 1/r^2.2 falloff from the limb outward
    float fall = pow(clamp(sunRadius / max(r, 1e-4), 0.0, 1.0), 2.2);
    float limbFade = smoothstep(sunRadius * 0.85, sunRadius * 1.05, r);
    float alpha = fall * limbFade * streamers * 0.55;

    vec3 color = mix(vec3(1.0, 0.55, 0.18), vec3(1.0, 0.85, 0.55), fall);
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

const ATMOS_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

// BackSide shell: visible fragments are on the FAR hemisphere, whose outward
// normals point away from the camera — dot(n, v) is in [-1, 0]. The rim is
// where the dot approaches 0, so the falloff must use -dot (the old
// max(dot, 0) clamped to 0 everywhere, producing a flat hard-edged glow).
const ATMOS_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 glowColor;
  uniform float intensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    #include <logdepthbuf_fragment>
    float facing = clamp(-dot(normalize(vNormal), normalize(vViewDir)), 0.0, 1.0);
    float rim = pow(1.0 - facing, 3.2);
    float alpha = smoothstep(0.0, 1.0, rim) * intensity;
    gl_FragColor = vec4(glowColor, alpha);
  }
`;

// ---------------------------------------------------------------------------
// CelestialBody — owns physics state + Three.js mesh + trail
// ---------------------------------------------------------------------------
export class CelestialBody {
  state: BodyState;
  mesh: THREE.Mesh;
  group: THREE.Group;        // outer group for scene positioning + scaling
  private tiltGroup: THREE.Group; // inner group for axial tilt (holds mesh + rings + atmo)
  trail: Trail | null = null;

  // For Earth's day/night shader
  private earthUniforms: { sunDir: { value: THREE.Vector3 } } | null = null;
  private sunUniforms: { time: { value: number } } | null = null;
  private coronaUniforms: { time: { value: number }; sunRadius: { value: number } } | null = null;
  private cloudMesh: THREE.Mesh | null = null;
  private atmosphereMesh: THREE.Mesh | null = null;
  private scatterAtmo: AtmosphereHandle | null = null;
  private scatterShellScale = 1;
  private ringHandle: RingMaterialHandle | null = null;
  private ringNormalWorld = new THREE.Vector3(0, 1, 0);
  private ringShadowUniforms: RingShadowUniforms | null = null;

  /** Analytic eclipse-shadow uniforms (null for the Sun). main.ts updates these. */
  eclipseUniforms: EclipseUniforms | null = null;
  private earthCloudTexture: THREE.Texture | null = null;
  private earthCloudShift: { value: number } | null = null;

  // Keep a scene ref for later removal
  private scene: THREE.Scene;

  // Visual radius in scene units
  visualRadius: number;

  constructor(
    state: BodyState,
    textureLoader: THREE.TextureLoader,
    scene: THREE.Scene
  ) {
    this.state = state;
    this.scene = scene;
    this.visualRadius = visualRadius(state.radius, state.isEmissive);

    this.group = new THREE.Group();
    this.tiltGroup = new THREE.Group();
    this.group.add(this.tiltGroup);

    this.mesh = this._buildMesh(textureLoader);
    this.tiltGroup.add(this.mesh);

    if (state.id === 'earth') this._buildEarthCloudLayer();
    if (state.hasRings)      this._buildRings(textureLoader);
    if (RING_SPECS[state.id]) this._buildProceduralRings(RING_SPECS[state.id]!);
    if (state.hasAtmosphere) this._buildAtmosphere();

    // Apply axial tilt to the inner group (tilts mesh + rings + atmosphere together)
    // Use YXZ order: first rotate around Y to orient tilt axis azimuth, then X for obliquity
    if (state.axialTilt) {
      this.tiltGroup.rotation.order = 'YXZ';
      this.tiltGroup.rotation.y = state.tiltAxisAngle ?? 0;
      this.tiltGroup.rotation.x = state.axialTilt;
    }

    this._setScenePosition(false, 0);
    scene.add(this.group);
  }

  // ---------------------------------------------------------------------------
  // Mesh construction
  // ---------------------------------------------------------------------------
  private _buildMesh(tl: THREE.TextureLoader): THREE.Mesh {
    const geo = new THREE.SphereGeometry(this.visualRadius, 64, 32);
    let mat: THREE.Material;

    if (this.state.isEmissive) {
      // Sun — fully procedural animated photosphere (3D noise on the sphere
      // direction: no UV seams or polar pinch) with HDR output for bloom.
      const uniforms = { time: { value: 0 } };
      this.sunUniforms = { time: uniforms.time };
      mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SUN_VERT,
        fragmentShader: SUN_FRAG,
      });
      this._buildCorona();
    } else if (this.state.id === 'earth' && this.state.nightTexturePath) {
      // Earth — custom day/night shader with eclipse, ocean glint, cloud shadows
      this.eclipseUniforms = makeEclipseUniforms();
      const cloudTex = makeEarthCloudTexture();
      this.earthCloudTexture = cloudTex;
      const uniforms = {
        dayMap:     { value: null as THREE.Texture | null },
        nightMap:   { value: null as THREE.Texture | null },
        cloudMap:   { value: cloudTex as THREE.Texture },
        cloudShift: { value: 0 },
        sunDir:     { value: new THREE.Vector3(1, 0, 0) },
        ...this.eclipseUniforms,
      };
      this.earthUniforms = uniforms as unknown as { sunDir: { value: THREE.Vector3 } };
      this.earthCloudShift = uniforms.cloudShift;
      mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: EARTH_VERT,
        fragmentShader: EARTH_FRAG.replace('ECLIPSE_CHUNK', ECLIPSE_GLSL),
      });
      if (this.state.texturePath) {
        tl.load(this.state.texturePath, tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          uniforms.dayMap.value = tex; mat.needsUpdate = true;
        });
      }
      tl.load(this.state.nightTexturePath, tex => {
        tex.colorSpace = THREE.SRGBColorSpace;
        uniforms.nightMap.value = tex; mat.needsUpdate = true;
      });
    } else {
      // Standard planet
      mat = new THREE.MeshStandardMaterial({
        color: this.state.color,
        roughness: ['mercury', 'moon', 'mars', 'pluto'].includes(this.state.id) ? 0.92 : 0.72,
        metalness: 0.0,
        emissive: new THREE.Color(this.state.id === 'venus' ? 0x120905 : 0x000000),
        emissiveIntensity: this.state.id === 'venus' ? 0.08 : 0,
      });

      // Analytic eclipse shadows; Saturn additionally gets its ring shadow
      if (this.state.id === 'saturn') {
        this.ringShadowUniforms = makeRingShadowUniforms();
        this.eclipseUniforms = patchStandardMaterialForEclipse(mat, {
          uniforms: this.ringShadowUniforms as unknown as Record<string, { value: unknown }>,
          fragmentDeclarations: RING_SHADOW_GLSL,
          fragmentCode: 'diffuseColor.rgb *= ringShadowFactor(vEclipseWorldPos, uRsInner / 1.25);',
        });
      } else {
        this.eclipseUniforms = patchStandardMaterialForEclipse(mat);
      }

      // Try to load texture; use procedural fallback for gas giants
      const gasGiantStripes = GAS_GIANT_STRIPES[this.state.id];
      if (gasGiantStripes) {
        (mat as THREE.MeshStandardMaterial).map = makeStripedTexture(gasGiantStripes[0], gasGiantStripes[1]);
      }

      if (this.state.texturePath) {
        tl.load(this.state.texturePath, tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          const std = mat as THREE.MeshStandardMaterial;
          std.map = tex;
          // Bump-from-luminance for cratered/rocky bodies: reuses the diffuse
          // texture as a bump map so craters and ridges catch raking light
          // along the terminator. Cheap stand-in until real normal maps.
          if (['mercury', 'moon', 'mars', 'pluto', 'io', 'europa', 'ganymede', 'callisto'].includes(this.state.id)) {
            std.bumpMap = tex;
            std.bumpScale = 0.02;
          }
          mat.needsUpdate = true;
        });
      }
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !this.state.isEmissive;
    mesh.receiveShadow = !this.state.isEmissive;
    return mesh;
  }

  private _buildRings(tl: THREE.TextureLoader): void {
    const innerR = this.visualRadius * 1.25;
    const outerR = this.visualRadius * 2.4;
    const geo = new THREE.RingGeometry(innerR, outerR, 128, 4);
    fixRingUVs(geo, innerR, outerR);

    // Lit ring shader: sun diffuse, planet shadow sweep, backlit
    // forward-scatter glow
    this.ringHandle = buildLitRingMaterial(0.9);
    const mat = this.ringHandle.material;

    tl.load('/textures/saturn_rings.png', tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.uniforms['map']!.value = tex;
      mat.needsUpdate = true;
    });

    const ringMesh = new THREE.Mesh(geo, mat);
    ringMesh.rotation.x = Math.PI / 2;
    this.tiltGroup.add(ringMesh);

    // Ring plane world normal: tiltGroup's rotation is fixed at construction
    this.ringNormalWorld
      .set(0, 1, 0)
      .applyEuler(this.tiltGroup.rotation)
      .normalize();
  }

  private _buildCorona(): void {
    // Billboard quad spanning ±3.2 sun radii; the shader draws the streamers.
    const size = this.visualRadius * 3.2;
    const geo = new THREE.PlaneGeometry(size * 2, size * 2);
    this.coronaUniforms = {
      time: { value: 0 },
      sunRadius: { value: this.visualRadius / size },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.coronaUniforms,
      vertexShader: CORONA_VERT,
      fragmentShader: CORONA_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(geo, mat);
    quad.frustumCulled = false;
    quad.renderOrder = 2;
    // Child of the outer group (not tiltGroup) so group scaling applies but
    // axial tilt doesn't matter — the quad billboards in the vertex shader.
    this.group.add(quad);
  }

  private _buildProceduralRings(spec: RingSpec): void {
    const innerR = this.visualRadius * spec.innerR;
    const outerR = this.visualRadius * spec.outerR;
    const geo = new THREE.RingGeometry(innerR, outerR, 128, 1);
    fixRingUVs(geo, innerR, outerR);

    const mat = new THREE.MeshBasicMaterial({
      map: makeRingStripTexture(spec),
      side: THREE.DoubleSide,
      transparent: true,
      opacity: spec.opacity,
      depthWrite: false,
    });

    const ringMesh = new THREE.Mesh(geo, mat);
    ringMesh.rotation.x = Math.PI / 2;
    this.tiltGroup.add(ringMesh);
  }

  private _buildEarthCloudLayer(): void {
    const geo = new THREE.SphereGeometry(this.visualRadius * 1.012, 64, 32);
    const mat = new THREE.MeshPhongMaterial({
      // Shares the surface shader's cloud texture so cast shadows match
      map: this.earthCloudTexture ?? makeEarthCloudTexture(),
      color: 0xffffff,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      shininess: 6,
    });
    this.cloudMesh = new THREE.Mesh(geo, mat);
    this.cloudMesh.renderOrder = 1;
    this.tiltGroup.add(this.cloudMesh);
  }

  private _buildAtmosphere(): void {
    // Planets with tuned scattering params get the physically-based
    // raymarched atmosphere; the rest keep the cheap fresnel glow shell.
    if (ATMOSPHERE_PARAMS[this.state.id]) {
      const handle = buildScatteringAtmosphere(this.state.id, this.visualRadius);
      if (handle) {
        this.scatterAtmo = handle;
        this.scatterShellScale = ATMOSPHERE_PARAMS[this.state.id]!.shellScale;
        this.group.add(handle.mesh);
        return;
      }
    }

    const atmRadius = this.visualRadius * (this.state.id === 'earth' ? 1.16 : 1.10);
    const geo = new THREE.SphereGeometry(atmRadius, 48, 24);
    const atmColor = this.state.id === 'earth'   ? 0x4488FF
                   : this.state.id === 'venus'   ? 0xFFCCA0
                   : this.state.id === 'mars'    ? 0xCC6644
                   : this.state.id === 'jupiter' ? 0xC49060
                   : this.state.id === 'saturn'  ? 0xD8C090
                   : this.state.id === 'uranus'  ? 0x88DDDD
                   : this.state.id === 'neptune' ? 0x4466CC
                   : 0x8888AA;

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color(atmColor) },
        intensity: { value: this.state.id === 'earth' ? 0.52 : 0.34 },
      },
      vertexShader: ATMOS_VERT,
      fragmentShader: ATMOS_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      depthWrite: false,
    });
    const atmMesh = new THREE.Mesh(geo, mat);
    this.atmosphereMesh = atmMesh;
    this.tiltGroup.add(atmMesh);
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------
  updateScenePosition(logScale: boolean, lerpT: number, realScale: boolean = false): void {
    this._setScenePosition(logScale, lerpT);
    this._updateGroupScale(lerpT, realScale);

    if (this.scatterAtmo) {
      const worldR = this.visualRadius * this.group.scale.x;
      this.scatterAtmo.uniforms.uPlanetCenter.value.copy(this.group.position);
      this.scatterAtmo.uniforms.uPlanetRadius.value = worldR;
      this.scatterAtmo.uniforms.uAtmoRadius.value = worldR * this.scatterShellScale;
    }

    if (this.ringHandle) {
      const worldR = this.visualRadius * this.group.scale.x;
      this.ringHandle.uniforms.uPlanetCenter.value.copy(this.group.position);
      this.ringHandle.uniforms.uPlanetRadius.value = worldR;
      this.ringHandle.uniforms.uRingNormal.value.copy(this.ringNormalWorld);
    }

    if (this.ringShadowUniforms) {
      const worldR = this.visualRadius * this.group.scale.x;
      this.ringShadowUniforms.uRsCenter.value.copy(this.group.position);
      this.ringShadowUniforms.uRsNormal.value.copy(this.ringNormalWorld);
      this.ringShadowUniforms.uRsInner.value = worldR * 1.25;
      this.ringShadowUniforms.uRsOuter.value = worldR * 2.4;
    }
  }

  /**
   * Update sun-dependent uniforms from the Sun's actual scene position
   * (the Sun drifts off the origin under N-body forces; a spawned star can
   * be anywhere).
   */
  updateSunPosition(sunScenePos: THREE.Vector3): void {
    if (this.earthUniforms) {
      this.earthUniforms.sunDir.value
        .copy(sunScenePos).sub(this.group.position).normalize();
    }
    if (this.scatterAtmo) {
      this.scatterAtmo.uniforms.uSunPos.value.copy(sunScenePos);
    }
    if (this.ringHandle) {
      this.ringHandle.uniforms.uSunPos.value.copy(sunScenePos);
    }
    if (this.ringShadowUniforms) {
      this.ringShadowUniforms.uRsSunPos.value.copy(sunScenePos);
    }
  }

  private _setScenePosition(logScale: boolean, lerpT: number): void {
    physicsToScene(this.state.position, logScale, lerpT, this.group.position);
  }

  /**
   * In log-scale mode the entire solar system compresses into ~1.5 scene units,
   * but body meshes are built with physics-derived radii that work in linear space
   * (e.g. Sun ≈ 2.09 units, Jupiter ≈ 0.57 units). Without compensation, the Sun
   * completely swallows the inner planets. We lerp the group scale so that in full
   * log mode every body has a sensible fixed visual radius, while in linear mode
   * the scale is 1.0 (unmodified physics-derived size).
   */
  private _updateGroupScale(lerpT: number, realScale: boolean = false): void {
    if (realScale) {
      // True physical radius in scene units — no exaggeration
      const trueSceneR = this.state.radius / DISPLAY_SCALE;
      const factor = trueSceneR / this.visualRadius;
      this.group.scale.setScalar(Math.max(1e-6, factor));
      return;
    }

    // Linear-mode target radii (scene units). At true scale, planets are
    // microscopic vs. orbital distances, so we exaggerate so they are always
    // visible regardless of zoom level.
    let linearTargetR: number;
    let logTargetR: number;

    if (this.state.isEmissive) {
      linearTargetR = 8.0;  logTargetR = 0.035;
    } else if (['jupiter','saturn','uranus','neptune'].includes(this.state.id)) {
      linearTargetR = 4.0;  logTargetR = 0.025;
    } else if (['mercury','venus','earth','mars'].includes(this.state.id)) {
      linearTargetR = 2.5;  logTargetR = 0.016;
    } else if (this.state.isMoon) {
      // Scale moons proportionally by physical radius so smaller moons are smaller
      // Earth's Moon should be ~27% of Earth's visual size (real ratio)
      linearTargetR = Math.max(0.15, Math.min(0.8, this.state.radius / 2.5e6));
      logTargetR    = Math.max(0.004, Math.min(0.012, this.state.radius / 1.5e8));
    } else {
      linearTargetR = 1.8;  logTargetR = 0.012; // Pluto, Halley, spawned objects
    }

    const linearFactor = linearTargetR / this.visualRadius;
    const logFactor    = logTargetR    / this.visualRadius;
    // Lerp from linear factor (lerpT=0) to log factor (lerpT=1)
    const factor = linearFactor + (logFactor - linearFactor) * lerpT;
    this.group.scale.setScalar(Math.max(0.001, factor));
  }

  /** Rotate the body mesh. Uses real sidereal period if available. */
  rotateBody(dtSeconds: number, timeScale: number = 1): void {
    if (this.sunUniforms) {
      this.sunUniforms.time.value += dtSeconds;
    }
    if (this.coronaUniforms) {
      this.coronaUniforms.time.value += dtSeconds;
    }

    if (this.state.rotationPeriod) {
      // Physics-based rotation: angular velocity = 2π / period, scaled by sim time
      const angularVel = (2 * Math.PI) / this.state.rotationPeriod;
      this.mesh.rotation.y += angularVel * dtSeconds * timeScale;
    } else {
      // Fallback: slow visual rotation
      const speed = this.state.isEmissive ? 0.01 : 0.05;
      this.mesh.rotation.y += speed * dtSeconds;
    }

    if (this.cloudMesh) {
      this.cloudMesh.rotation.y += dtSeconds * timeScale * 0.000025;
      // Keep the surface shader's cloud-shadow sample aligned with the
      // independently-rotating cloud layer
      if (this.earthCloudShift) {
        this.earthCloudShift.value =
          (this.mesh.rotation.y - this.cloudMesh.rotation.y) / (2 * Math.PI);
      }
    }
  }

  /**
   * Set the initial rotation angle for real-time mode.
   * For Earth, computes GMST so the correct side faces the Sun.
   */
  setInitialRotation(date: Date): void {
    if (this.state.id === 'earth') {
      // Sub-solar longitude: at UTC noon Greenwich (lon 0°) faces the Sun,
      // so the sub-solar longitude ≈ 180° − 15°×UT_hours (in degrees east).
      const utHours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
      const subSolarLonRad = (180 - 15 * utHours) * (Math.PI / 180);

      // Sun direction angle in the XZ plane (Earth orbits in XZ)
      const sunAngle = Math.atan2(-this.state.position.x, -this.state.position.z);

      // Rotate so the sub-solar meridian faces the Sun.
      // In Three.js SphereGeometry, lon=0° (Greenwich) faces +X at rotation.y=0.
      // After rotation R, the world normal for longitude λ is (cos(R+λ), 0, -sin(R+λ)).
      // Setting this parallel to sunDir gives R = sunAngle - π/2 - λ.
      // Subtract tiltAxisAngle to compensate for the tiltGroup's Y rotation.
      this.mesh.rotation.y = sunAngle - Math.PI / 2 - subSolarLonRad - (this.state.tiltAxisAngle ?? 0);
    }
  }

  // ---------------------------------------------------------------------------
  // Sun direction for external use (SceneManager needs it for PointLight)
  // ---------------------------------------------------------------------------
  getScenePosition(): THREE.Vector3 {
    return this.group.position;
  }

  setAtmosphereVisible(visible: boolean): void {
    if (this.atmosphereMesh) this.atmosphereMesh.visible = visible;
    if (this.scatterAtmo) this.scatterAtmo.mesh.visible = visible;
    if (this.cloudMesh) this.cloudMesh.visible = visible;
  }

  // ---------------------------------------------------------------------------
  // Disposal
  // ---------------------------------------------------------------------------
  dispose(): void {
    this.scene.remove(this.group);
    this.group.traverse(obj => {
      if (obj instanceof THREE.Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          // material.dispose() does NOT free textures — walk .map and shader
          // uniforms explicitly or every rebuild leaks GPU memory. Textures
          // are per-body (THREE.Cache is off), so disposing here is safe.
          const withMap = m as THREE.Material & { map?: THREE.Texture | null };
          if (withMap.map) withMap.map.dispose();
          if (m instanceof THREE.ShaderMaterial) {
            for (const u of Object.values(m.uniforms)) {
              if (u.value instanceof THREE.Texture) u.value.dispose();
            }
          }
          m.dispose();
        }
      }
    });
  }
}
