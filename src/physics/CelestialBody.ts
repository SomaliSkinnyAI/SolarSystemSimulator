import * as THREE from 'three';
import { BodyState } from '../types';
import { physicsToScene, visualRadius, DISPLAY_SCALE } from '../utils/CoordinateSystem';
import { Trail } from '../rendering/TrailRenderer';

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
// Procedural Sun texture — canvas radial gradient, used as fallback
// ---------------------------------------------------------------------------
function makeSunCanvasTexture(): THREE.CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0.0, '#fff7c0');
  grad.addColorStop(0.3, '#ffdd44');
  grad.addColorStop(0.7, '#ff8800');
  grad.addColorStop(1.0, '#cc3300');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
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
// Earth day/night shader
// ---------------------------------------------------------------------------
const EARTH_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const EARTH_FRAG = /* glsl */`
  uniform sampler2D dayMap;
  uniform sampler2D nightMap;
  uniform vec3 sunDir;
  varying vec2 vUv;
  varying vec3 vNormal;
  varying vec3 vWorldNormal;
  void main() {
    float intensity = dot(vWorldNormal, normalize(sunDir));
    float blend = smoothstep(-0.18, 0.30, intensity);
    vec4 day   = texture2D(dayMap, vUv);
    vec4 night = texture2D(nightMap, vUv);
    float limb = pow(1.0 - max(dot(normalize(vNormal), vec3(0.0, 0.0, 1.0)), 0.0), 2.0);
    vec3 twilight = vec3(0.24, 0.42, 0.70) * smoothstep(-0.22, 0.04, intensity) * (1.0 - blend);
    vec3 cityLights = night.rgb * 2.8 * (1.0 - blend);
    vec3 color = mix(cityLights, day.rgb, blend);
    color += twilight + vec3(0.12, 0.20, 0.34) * limb * 0.25;
    gl_FragColor = vec4(color, 1.0);
  }
`;

// ---------------------------------------------------------------------------
// Animated Sun and atmosphere shaders
// ---------------------------------------------------------------------------
const SUN_VERT = /* glsl */`
  varying vec2 vUv;
  varying vec3 vNormal;
  void main() {
    vUv = uv;
    vNormal = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const SUN_FRAG = /* glsl */`
  uniform sampler2D sunMap;
  uniform float time;
  varying vec2 vUv;
  varying vec3 vNormal;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  void main() {
    vec2 flowUv = vec2(vUv.x + time * 0.012, vUv.y);
    vec3 tex = texture2D(sunMap, flowUv).rgb;
    float granules = noise(vUv * 46.0 + time * 0.45);
    float cells = noise(vUv * 16.0 - time * 0.18);
    float rim = pow(1.0 - max(vNormal.z, 0.0), 1.6);
    vec3 plasma = mix(vec3(1.0, 0.42, 0.04), vec3(1.0, 0.92, 0.42), cells);
    vec3 color = max(tex, plasma) * (1.15 + granules * 0.55);
    color += vec3(1.0, 0.45, 0.05) * rim * 1.2;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const ATMOS_VERT = /* glsl */`
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vViewDir = normalize(-mvPosition.xyz);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const ATMOS_FRAG = /* glsl */`
  uniform vec3 glowColor;
  uniform float intensity;
  varying vec3 vNormal;
  varying vec3 vViewDir;
  void main() {
    float fresnel = pow(1.0 - max(dot(normalize(vNormal), normalize(vViewDir)), 0.0), 2.6);
    float alpha = smoothstep(0.0, 1.0, fresnel) * intensity;
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
  private cloudMesh: THREE.Mesh | null = null;
  private atmosphereMesh: THREE.Mesh | null = null;

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
      // Sun — animated emissive shader so UnrealBloomPass picks it up.
      const fallback = makeSunCanvasTexture();
      const uniforms = {
        sunMap: { value: fallback as THREE.Texture },
        time:   { value: 0 },
      };
      this.sunUniforms = { time: uniforms.time };
      mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: SUN_VERT,
        fragmentShader: SUN_FRAG,
      });
      if (this.state.texturePath) {
        tl.load(this.state.texturePath, tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          uniforms.sunMap.value = tex;
          mat.needsUpdate = true;
        });
      }
    } else if (this.state.id === 'earth' && this.state.nightTexturePath) {
      // Earth — custom day/night shader
      const uniforms = {
        dayMap:   { value: null as THREE.Texture | null },
        nightMap: { value: null as THREE.Texture | null },
        sunDir:   { value: new THREE.Vector3(1, 0, 0) },
      };
      this.earthUniforms = uniforms as unknown as { sunDir: { value: THREE.Vector3 } };
      mat = new THREE.ShaderMaterial({
        uniforms,
        vertexShader: EARTH_VERT,
        fragmentShader: EARTH_FRAG,
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

      // Try to load texture; use procedural fallback for gas giants
      const gasGiantStripes = GAS_GIANT_STRIPES[this.state.id];
      if (gasGiantStripes) {
        (mat as THREE.MeshStandardMaterial).map = makeStripedTexture(gasGiantStripes[0], gasGiantStripes[1]);
      }

      if (this.state.texturePath) {
        tl.load(this.state.texturePath, tex => {
          tex.colorSpace = THREE.SRGBColorSpace;
          tex.anisotropy = 8;
          (mat as THREE.MeshStandardMaterial).map = tex;
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

    const mat = new THREE.MeshBasicMaterial({
      color: 0xC2B280,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
    });

    tl.load('/textures/saturn_rings.png', tex => {
      tex.colorSpace = THREE.SRGBColorSpace;
      mat.map = tex; mat.needsUpdate = true;
    });

    const ringMesh = new THREE.Mesh(geo, mat);
    ringMesh.rotation.x = Math.PI / 2;
    ringMesh.receiveShadow = true;
    this.tiltGroup.add(ringMesh);
  }

  private _buildEarthCloudLayer(): void {
    const geo = new THREE.SphereGeometry(this.visualRadius * 1.012, 64, 32);
    const mat = new THREE.MeshPhongMaterial({
      map: makeEarthCloudTexture(),
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

    if (this.earthUniforms) {
      const bodyPos = this.group.position;
      const dir = new THREE.Vector3(-bodyPos.x, -bodyPos.y, -bodyPos.z).normalize();
      this.earthUniforms.sunDir.value.copy(dir);
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
        if (Array.isArray(obj.material)) {
          obj.material.forEach(m => m.dispose());
        } else {
          (obj.material as THREE.Material).dispose();
        }
      }
    });
  }
}
