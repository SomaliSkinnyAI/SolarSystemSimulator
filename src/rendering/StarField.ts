import * as THREE from 'three';
import { randomOnSphere, randRange } from '../utils/MathUtils';

// ---------------------------------------------------------------------------
// Night sky:
//  1. 9,096 real stars (Yale Bright Star Catalog, public/data/stars.json)
//     at true positions with magnitude-scaled brightness and blackbody
//     colors — Orion, the Pleiades, Sirius are actually where they belong.
//  2. Cross-spike sprites on the brightest ~25 stars.
//  3. A procedural Milky Way band painted in the real galactic plane
//     (correct orientation incl. the bulge toward Sagittarius).
//  4. A dim procedural filler dust of faint stars below the catalog limit.
// ---------------------------------------------------------------------------

const STAR_SPHERE_RADIUS = 5e5; // scene units — far beyond any planet
const FILLER_COUNT = 9000;

const STAR_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float size;
  attribute vec3 color;
  varying vec3 vColor;
  void main() {
    vColor = color;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size;
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const STAR_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float opacity;
  varying vec3 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = gl_PointCoord - vec2(0.5);
    float r = length(uv);
    if (r > 0.5) discard;
    float alpha = opacity * (1.0 - smoothstep(0.06, 0.5, r));
    gl_FragColor = vec4(vColor, alpha);
  }
`;

const SPIKE_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float opacity;
  varying vec3 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = gl_PointCoord - vec2(0.5);
    float r = length(uv);
    if (r > 0.5) discard;
    // 4-point diffraction spikes + soft core
    float spikes = max(
      exp(-abs(uv.x) * 40.0) * exp(-abs(uv.y) * 6.0),
      exp(-abs(uv.y) * 40.0) * exp(-abs(uv.x) * 6.0)
    );
    float core = exp(-r * r * 60.0);
    float alpha = opacity * clamp(core * 1.4 + spikes * 0.8, 0.0, 1.0);
    gl_FragColor = vec4(vColor, alpha);
  }
`;

function makeStarMaterial(fragment: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { opacity: { value: 1.0 } },
    vertexShader: STAR_VERT,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

// ---------------------------------------------------------------------------
// Milky Way panorama — equirect canvas in sim spherical coords, evaluated
// through the real sim→equatorial→galactic rotation so the band, bulge and
// dust lane land where they belong.
// ---------------------------------------------------------------------------

// Equatorial → galactic rotation (J2000, rows are galactic basis vectors)
const EQ2GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [ 0.4941094279, -0.4448296300,  0.7469822445],
  [-0.8676661490, -0.1980763734,  0.4559837762],
];
const OBLIQUITY = 23.4392911 * Math.PI / 180;

// Small JS value-noise for the canvas painting
function makeNoise2D(): (x: number, y: number) => number {
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  let seed = 1234567;
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    seed = (seed * 16807) % 2147483647;
    const j = seed % (i + 1);
    const t = p[i]!; p[i] = p[j]!; p[j] = t;
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  const fade = (t: number) => t * t * (3 - 2 * t);
  return (x: number, y: number) => {
    const xi = Math.floor(x) & 255, yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const h = (i: number, j: number) => perm[(perm[(xi + i) & 255]! + yi + j) & 255]! / 255;
    const u = fade(xf), v = fade(yf);
    return (h(0, 0) * (1 - u) + h(1, 0) * u) * (1 - v)
         + (h(0, 1) * (1 - u) + h(1, 1) * u) * v;
  };
}

function makeMilkyWayTexture(): THREE.CanvasTexture {
  const W = 1024, H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const noise = makeNoise2D();
  const fbm = (x: number, y: number) => {
    let v = 0, a = 0.5, fx = x, fy = y;
    for (let o = 0; o < 4; o++) { v += a * noise(fx, fy); fx *= 2.1; fy *= 2.1; a *= 0.5; }
    return v;
  };

  const cosOb = Math.cos(OBLIQUITY), sinOb = Math.sin(OBLIQUITY);
  for (let py = 0; py < H; py++) {
    // Sim-sphere latitude: +90 at top
    const lat = (0.5 - py / H) * Math.PI;
    for (let px = 0; px < W; px++) {
      const lon = (px / W) * 2 * Math.PI;
      // Sim-frame direction (must match the sphere mapping used below)
      const xs = Math.cos(lat) * Math.cos(lon);
      const ys = Math.sin(lat);
      const zs = Math.cos(lat) * Math.sin(lon);
      // Sim → ecliptic: xE = xs, yE = -zs, zE = ys
      const xE = xs, yE = -zs, zE = ys;
      // Ecliptic → equatorial (rotate by -obliquity about X)
      const xQ = xE;
      const yQ = cosOb * yE - sinOb * zE;
      const zQ = sinOb * yE + cosOb * zE;
      // Equatorial → galactic
      const xG = EQ2GAL[0]![0]! * xQ + EQ2GAL[0]![1]! * yQ + EQ2GAL[0]![2]! * zQ;
      const yG = EQ2GAL[1]![0]! * xQ + EQ2GAL[1]![1]! * yQ + EQ2GAL[1]![2]! * zQ;
      const zG = EQ2GAL[2]![0]! * xQ + EQ2GAL[2]![1]! * yQ + EQ2GAL[2]![2]! * zQ;
      const b = Math.asin(Math.max(-1, Math.min(1, zG)));     // galactic latitude
      const l = Math.atan2(yG, xG);                            // galactic longitude

      const bDeg = b * 180 / Math.PI;
      const lDeg = l * 180 / Math.PI; // 0 = galactic centre (Sagittarius)

      // Band: bright near the plane, cloudy structure along it
      const clouds = 0.45 + 0.55 * fbm(lDeg * 0.055 + 7.3, bDeg * 0.11);
      let band = Math.exp(-(bDeg * bDeg) / (2 * 11 * 11)) * clouds;

      // Central bulge toward l = 0
      const bulge = 0.85 * Math.exp(-(lDeg * lDeg) / (2 * 24 * 24) - (bDeg * bDeg) / (2 * 12 * 12));

      // Dark dust lane hugging the plane, strongest through the inner galaxy
      const laneOffset = 2.2 * Math.sin(lDeg * Math.PI / 90);
      const laneStrength = 0.65 * Math.exp(-(lDeg * lDeg) / (2 * 65 * 65));
      const lane = 1 - laneStrength * Math.exp(-((bDeg - laneOffset) ** 2) / (2 * 2.6 * 2.6))
        * (0.5 + 0.5 * fbm(lDeg * 0.09, bDeg * 0.3 + 41.7));

      let intensity = (band + bulge) * lane;
      intensity = Math.max(0, Math.min(1.25, intensity));

      // Warm core, bluish rim
      const warm = Math.max(0, Math.min(1, bulge * 1.6));
      const r = intensity * (0.62 + 0.30 * warm);
      const g = intensity * (0.64 + 0.22 * warm);
      const bl = intensity * (0.78 + 0.05 * warm);

      const idx = (py * W + px) * 4;
      img.data[idx]     = Math.round(Math.min(1, r) * 255);
      img.data[idx + 1] = Math.round(Math.min(1, g) * 255);
      img.data[idx + 2] = Math.round(Math.min(1, bl) * 255);
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------------------

export class StarField {
  readonly group: THREE.Group;
  private disposables: Array<{ dispose(): void }> = [];

  constructor() {
    this.group = new THREE.Group();
    this.group.renderOrder = -1;

    this._buildMilkyWay();
    this._buildFillerStars();
    void this._buildCatalogStars();
  }

  private _buildMilkyWay(): void {
    const tex = makeMilkyWayTexture();
    const geo = new THREE.SphereGeometry(STAR_SPHERE_RADIUS * 0.98, 48, 24);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      side: THREE.BackSide,
      transparent: true,
      opacity: 0.38,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = -2;
    mesh.frustumCulled = false;
    // Match the canvas mapping: standard sphere UVs put u=0 at -X looking
    // from +Y; our canvas used lon measured from +X toward +Z — rotate to align
    mesh.rotation.y = Math.PI / 2;
    this.group.add(mesh);
    this.disposables.push(geo, mat, tex);
  }

  private _buildFillerStars(): void {
    const positions = new Float32Array(FILLER_COUNT * 3);
    const colors = new Float32Array(FILLER_COUNT * 3);
    const sizes = new Float32Array(FILLER_COUNT);
    for (let i = 0; i < FILLER_COUNT; i++) {
      const [sx, sy, sz] = randomOnSphere();
      positions[i * 3] = sx * STAR_SPHERE_RADIUS;
      positions[i * 3 + 1] = sy * STAR_SPHERE_RADIUS;
      positions[i * 3 + 2] = sz * STAR_SPHERE_RADIUS;
      const t = Math.random();
      const brightness = randRange(0.12, 0.45);
      colors[i * 3]     = (0.82 + t * 0.18) * brightness;
      colors[i * 3 + 1] = (0.86 + t * 0.14) * brightness;
      colors[i * 3 + 2] = brightness;
      sizes[i] = randRange(0.5, 1.3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));
    const mat = makeStarMaterial(STAR_FRAG);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    this.disposables.push(geo, mat);
  }

  private async _buildCatalogStars(): Promise<void> {
    let rows: number[][];
    try {
      const res = await fetch('/data/stars.json');
      if (!res.ok) return;
      rows = await res.json() as number[][];
    } catch {
      return; // filler stars remain as fallback
    }

    const main: number[] = [];
    const mainColors: number[] = [];
    const mainSizes: number[] = [];
    const bright: number[] = [];
    const brightColors: number[] = [];
    const brightSizes: number[] = [];

    for (const row of rows) {
      const [x, y, z, v, r, g, b] = row as [number, number, number, number, number, number, number];
      const px = x * STAR_SPHERE_RADIUS;
      const py = y * STAR_SPHERE_RADIUS;
      const pz = z * STAR_SPHERE_RADIUS;
      // Magnitude → size/brightness. V=-1.5 (Sirius) big, V=6.7 barely there.
      const size = Math.max(0.7, 5.2 * Math.pow(10, -0.11 * v));
      const lum = Math.max(0.14, Math.min(1.0, Math.pow(10, -0.18 * (v - 1.2))));

      if (v < 0.9) {
        bright.push(px, py, pz);
        brightColors.push(r * 1.15, g * 1.15, b * 1.15);
        brightSizes.push(size * 2.6);
      }
      main.push(px, py, pz);
      mainColors.push(r * lum, g * lum, b * lum);
      mainSizes.push(size);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(main), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(mainColors), 3));
    geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(mainSizes), 1));
    const mat = makeStarMaterial(STAR_FRAG);
    const points = new THREE.Points(geo, mat);
    points.frustumCulled = false;
    this.group.add(points);
    this.disposables.push(geo, mat);

    // Diffraction spikes for the brightest stars
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bright), 3));
    sgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(brightColors), 3));
    sgeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(brightSizes), 1));
    const smat = makeStarMaterial(SPIKE_FRAG);
    const spoints = new THREE.Points(sgeo, smat);
    spoints.frustumCulled = false;
    this.group.add(spoints);
    this.disposables.push(sgeo, smat);
  }

  addToScene(scene: THREE.Scene): void {
    scene.add(this.group);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
  }
}
