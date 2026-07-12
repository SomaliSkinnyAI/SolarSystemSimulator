import * as THREE from 'three';
import { AU } from '../utils/MathUtils';
import { DISPLAY_SCALE } from '../utils/CoordinateSystem';
import { assetUrl } from '../utils/assetUrl';

// ---------------------------------------------------------------------------
// Real asteroid swarm: tens of thousands of numbered asteroids propagated
// from their actual JPL orbital elements ENTIRELY on the GPU — the vertex
// shader solves Kepler's equation per point per frame. The Kirkwood gaps,
// the Hilda triangle, and Jupiter's Trojan clouds appear naturally and stay
// astronomically correct at any simulation date. Zero per-frame CPU cost.
// ---------------------------------------------------------------------------

const SWARM_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute vec4 aOrbA;   // a (AU), e, i, om
  attribute vec4 aOrbB;   // w, M_at_base, n (rad/day), size
  attribute vec3 aColor;
  uniform float uDays;    // days since base epoch (small magnitude, fp32-safe)
  uniform float uAuScene; // scene units per AU
  varying vec3 vColor;
  void main() {
    float a = aOrbA.x;
    float e = aOrbA.y;
    float inc = aOrbA.z;
    float om = aOrbA.w;
    float w = aOrbB.x;
    float M = aOrbB.y + aOrbB.z * uDays;

    // Kepler: 4 Newton iterations are ample for e < 0.95
    float E = M + e * sin(M);
    for (int k = 0; k < 4; k++) {
      E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
    }
    float xv = a * (cos(E) - e);
    float yv = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);

    // Perifocal → ecliptic
    float co = cos(om), so = sin(om);
    float cw = cos(w),  sw = sin(w);
    float ci = cos(inc), si = sin(inc);
    float xE = (co * cw - so * sw * ci) * xv + (-co * sw - so * cw * ci) * yv;
    float yE = (so * cw + co * sw * ci) * xv + (-so * sw + co * cw * ci) * yv;
    float zE = (sw * si) * xv + (cw * si) * yv;

    // Ecliptic → sim axes (X, Z→Y up, Y→−Z), heliocentric ≈ barycentric
    vec3 pos = vec3(xE, zE, -yE) * uAuScene;

    vColor = aColor;
    vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
    gl_PointSize = aOrbB.w * clamp(140.0 / max(-mvPosition.z, 1.0), 0.35, 2.6);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const SWARM_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  varying vec3 vColor;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = gl_PointCoord - 0.5;
    if (dot(uv, uv) > 0.25) discard;
    gl_FragColor = vec4(vColor, 0.85);
  }
`;

/** Color-code by dynamical group (semi-major axis). */
function groupColor(a: number): [number, number, number] {
  if (a < 1.8) return [0.95, 0.65, 0.55];        // NEO / Hungaria region
  if (a < 2.5) return [0.72, 0.68, 0.62];        // inner belt
  if (a < 2.82) return [0.62, 0.60, 0.56];       // middle belt
  if (a < 3.4) return [0.52, 0.53, 0.56];        // outer belt
  if (a < 4.3) return [0.55, 0.48, 0.62];        // Hildas
  return [0.45, 0.55, 0.70];                     // Jupiter Trojans
}

export class AsteroidSwarm {
  points: THREE.Points | null = null;
  count = 0;
  private uniforms = {
    uDays: { value: 0 },
    uAuScene: { value: AU / DISPLAY_SCALE },
  };
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  async load(): Promise<void> {
    let bin: Float32Array;
    try {
      const res = await fetch(assetUrl('/data/asteroids.bin'));
      if (!res.ok) return;
      bin = new Float32Array(await res.arrayBuffer());
    } catch {
      return; // swarm is decorative — the sim works fine without it
    }
    const n = Math.floor(bin.length / 8);
    if (n === 0) return;
    this.count = n;

    const positions = new Float32Array(n * 3); // required attribute, unused
    const orbA = new Float32Array(n * 4);
    const orbB = new Float32Array(n * 4);
    const colors = new Float32Array(n * 3);

    for (let i = 0; i < n; i++) {
      const a = bin[i * 8]!;
      const e = bin[i * 8 + 1]!;
      const inc = bin[i * 8 + 2]!;
      const om = bin[i * 8 + 3]!;
      const w = bin[i * 8 + 4]!;
      const m0 = bin[i * 8 + 5]!;
      const nRad = bin[i * 8 + 6]!;
      const H = bin[i * 8 + 7]!;
      orbA[i * 4] = a; orbA[i * 4 + 1] = e; orbA[i * 4 + 2] = inc; orbA[i * 4 + 3] = om;
      // Brightness → point size: H 3 (Ceres) big, H 16 tiny
      const size = Math.max(1.0, 3.4 - (H - 3) * 0.17);
      orbB[i * 4] = w; orbB[i * 4 + 1] = m0; orbB[i * 4 + 2] = nRad; orbB[i * 4 + 3] = size;
      const [r, g, b] = groupColor(a);
      colors[i * 3] = r; colors[i * 3 + 1] = g; colors[i * 3 + 2] = b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aOrbA', new THREE.BufferAttribute(orbA, 4));
    geo.setAttribute('aOrbB', new THREE.BufferAttribute(orbB, 4));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: SWARM_VERT,
      fragmentShader: SWARM_FRAG,
      transparent: true,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = -1;
    this.scene.add(this.points);
  }

  /** @param jdTDB current simulation Julian date */
  setTime(jdTDB: number, baseJD = 2460000.5): void {
    this.uniforms.uDays.value = jdTDB - baseJD;
  }

  setVisible(v: boolean): void {
    if (this.points) this.points.visible = v;
  }

  dispose(): void {
    if (!this.points) return;
    this.scene.remove(this.points);
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
    this.points = null;
  }
}
