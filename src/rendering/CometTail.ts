import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Comet dust + ion tails (Halley). Stateless GPU particles: every particle's
// position is reconstructed in the vertex shader from its static phase/seed
// attributes plus per-frame uniforms (comet position, anti-sun direction,
// velocity direction, activity). Zero per-frame CPU or buffer uploads.
//
// Activity scales with heliocentric distance ((2.5 AU / d)^2, clamped), so
// the tails grow from nothing through perihelion and vanish again — 35 AU
// Halley is a bare nucleus, 0.6 AU Halley is a spectacle.
// ---------------------------------------------------------------------------

const ION_COUNT = 2200;
const DUST_COUNT = 3200;

const TAIL_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  attribute float aPhase;
  attribute vec3 aSeed;
  uniform vec3 uCometPos;
  uniform vec3 uAntiSun;
  uniform vec3 uVelDir;
  uniform float uActivity;
  uniform float uTime;
  uniform float uLength;
  uniform float uCurve;     // 0 = straight ion tail, >0 = dust lag curve
  uniform float uSpread;
  uniform float uFlowSpeed;
  uniform float uBaseSize;
  varying float vFade;
  void main() {
    float t = fract(aPhase + uTime * uFlowSpeed);
    // Direction: anti-sunward, dust curves toward the reversed orbit path
    vec3 dir = normalize(uAntiSun + uCurve * t * (-uVelDir));
    // Perpendicular jitter cone widening along the tail
    vec3 ortho1 = normalize(cross(dir, vec3(0.0, 1.0, 0.0) + aSeed * 0.1));
    vec3 ortho2 = normalize(cross(dir, ortho1));
    float len = uLength * uActivity;
    vec3 pos = uCometPos
      + dir * (t * len)
      + (ortho1 * aSeed.x + ortho2 * aSeed.y) * uSpread * len * t * (0.35 + aSeed.z * 0.3);
    vFade = (1.0 - t) * uActivity;
    vec4 mvPosition = viewMatrix * vec4(pos, 1.0);
    gl_PointSize = uBaseSize * (1.0 + t * 2.0) * clamp(160.0 / max(-mvPosition.z, 1.0), 0.3, 6.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <logdepthbuf_vertex>
  }
`;

const TAIL_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uColor;
  varying float vFade;
  void main() {
    #include <logdepthbuf_fragment>
    vec2 uv = gl_PointCoord - 0.5;
    float r = length(uv);
    if (r > 0.5) discard;
    float alpha = vFade * (1.0 - r * 2.0) * 0.35;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

interface TailUniforms {
  uCometPos: { value: THREE.Vector3 };
  uAntiSun: { value: THREE.Vector3 };
  uVelDir: { value: THREE.Vector3 };
  uActivity: { value: number };
  uTime: { value: number };
  [key: string]: { value: unknown };
}

function buildTail(
  count: number,
  color: number,
  length: number,
  curve: number,
  spread: number,
  flowSpeed: number,
  baseSize: number
): { points: THREE.Points; uniforms: TailUniforms } {
  const phases = new Float32Array(count);
  const seeds = new Float32Array(count * 3);
  const positions = new Float32Array(count * 3); // unused; required attribute
  for (let i = 0; i < count; i++) {
    phases[i] = Math.random();
    seeds[i * 3] = (Math.random() - 0.5) * 2;
    seeds[i * 3 + 1] = (Math.random() - 0.5) * 2;
    seeds[i * 3 + 2] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 3));

  const uniforms: TailUniforms = {
    uCometPos: { value: new THREE.Vector3() },
    uAntiSun: { value: new THREE.Vector3(1, 0, 0) },
    uVelDir: { value: new THREE.Vector3(0, 0, 1) },
    uActivity: { value: 0 },
    uTime: { value: 0 },
    uLength: { value: length },
    uCurve: { value: curve },
    uSpread: { value: spread },
    uFlowSpeed: { value: flowSpeed },
    uBaseSize: { value: baseSize },
    uColor: { value: new THREE.Color(color) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: TAIL_VERT,
    fragmentShader: TAIL_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return { points, uniforms };
}

export class CometTail {
  private ion: { points: THREE.Points; uniforms: TailUniforms };
  private dust: { points: THREE.Points; uniforms: TailUniforms };
  private coma: THREE.Sprite;
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    // Ion tail: straight anti-sunward, blue, fast flow. Length ~0.55 AU peak.
    this.ion = buildTail(ION_COUNT, 0x66aaff, 82, 0.0, 0.05, 0.22, 2.2);
    // Dust tail: slower, warm, curved along the reversed orbit path.
    this.dust = buildTail(DUST_COUNT, 0xffe8c8, 46, 0.85, 0.11, 0.06, 2.8);
    scene.add(this.ion.points);
    scene.add(this.dust.points);

    // Coma glow
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(210,230,255,0.9)');
    g.addColorStop(0.4, 'rgba(160,190,240,0.35)');
    g.addColorStop(1, 'rgba(140,170,230,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.coma = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    scene.add(this.coma);
  }

  /**
   * @param cometPos   comet scene position
   * @param sunPos     sun scene position
   * @param velDir     comet velocity direction (scene space)
   * @param distAU     heliocentric distance in AU
   * @param dtSeconds  wall-clock frame time
   * @param visible    master visibility (hidden in log-scale mode)
   */
  update(
    cometPos: THREE.Vector3,
    sunPos: THREE.Vector3,
    velDir: THREE.Vector3,
    distAU: number,
    dtSeconds: number,
    visible: boolean
  ): void {
    const activity = Math.min(1, (2.5 / Math.max(distAU, 0.2)) ** 2);
    const show = visible && activity > 0.01;
    this.ion.points.visible = show;
    this.dust.points.visible = show;
    this.coma.visible = show;
    if (!show) return;

    for (const tail of [this.ion, this.dust]) {
      tail.uniforms.uCometPos.value.copy(cometPos);
      tail.uniforms.uAntiSun.value.copy(cometPos).sub(sunPos).normalize();
      tail.uniforms.uVelDir.value.copy(velDir);
      tail.uniforms.uActivity.value = activity;
      tail.uniforms.uTime.value += dtSeconds;
    }
    this.coma.position.copy(cometPos);
    const comaScale = 1.5 + activity * 6;
    this.coma.scale.set(comaScale, comaScale, 1);
    (this.coma.material as THREE.SpriteMaterial).opacity = 0.35 + activity * 0.5;
  }

  dispose(): void {
    for (const t of [this.ion, this.dust]) {
      this.scene.remove(t.points);
      t.points.geometry.dispose();
      (t.points.material as THREE.Material).dispose();
    }
    this.scene.remove(this.coma);
    (this.coma.material as THREE.SpriteMaterial).map?.dispose();
    this.coma.material.dispose();
  }
}
