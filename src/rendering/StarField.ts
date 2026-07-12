import * as THREE from 'three';
import { randomOnSphere, randRange } from '../utils/MathUtils';

const STAR_COUNT = 18000;
const STAR_SPHERE_RADIUS = 5e5; // scene units — far beyond any planet

export class StarField {
  readonly mesh: THREE.Points;

  constructor() {
    this.mesh = this._build();
    this.mesh.renderOrder = -1; // always behind everything
    this.mesh.frustumCulled = false;
  }

  private _build(): THREE.Points {
    const positions = new Float32Array(STAR_COUNT * 3);
    const colors    = new Float32Array(STAR_COUNT * 3);
    const sizes     = new Float32Array(STAR_COUNT);

    for (let i = 0; i < STAR_COUNT; i++) {
      let sx: number;
      let sy: number;
      let sz: number;

      // Bias a portion of the stars into a soft Milky Way-like band instead of
      // distributing everything uniformly. The sphere still surrounds the scene.
      if (Math.random() < 0.38) {
        const angle = Math.random() * Math.PI * 2;
        const bandOffset = (Math.random() - 0.5) * 0.20;
        const wobble = Math.sin(angle * 3.0) * 0.05;
        sy = bandOffset + wobble;
        const radial = Math.sqrt(Math.max(0.001, 1 - sy * sy));
        sx = Math.cos(angle) * radial;
        sz = Math.sin(angle) * radial;
      } else {
        [sx, sy, sz] = randomOnSphere();
      }
      const r = STAR_SPHERE_RADIUS;
      positions[i * 3]     = sx * r;
      positions[i * 3 + 1] = sy * r;
      positions[i * 3 + 2] = sz * r;

      // Star colour: mostly blue-white, some yellow, rare orange-red
      const roll = Math.random();
      let cr: number, cg: number, cb: number;
      if (roll < 0.60) {
        // Blue-white / white
        const t = Math.random();
        cr = 0.85 + t * 0.15;
        cg = 0.90 + t * 0.10;
        cb = 1.0;
      } else if (roll < 0.85) {
        // Yellow-white (Sun-like)
        cr = 1.0; cg = 0.95; cb = 0.75;
      } else if (roll < 0.96) {
        // Orange
        cr = 1.0; cg = 0.65; cb = 0.35;
      } else {
        // Red giant
        cr = 1.0; cg = 0.25; cb = 0.15;
      }

      const brightness = Math.random() < 0.018 ? randRange(1.3, 2.4) : randRange(0.28, 1.0);
      colors[i * 3]     = cr * brightness;
      colors[i * 3 + 1] = cg * brightness;
      colors[i * 3 + 2] = cb * brightness;

      sizes[i] = Math.random() < 0.018 ? randRange(2.8, 4.6) : randRange(0.55, 2.1);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 1.0 } },
      vertexShader: /* glsl */`
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
      `,
      fragmentShader: /* glsl */`
        #include <common>
        #include <logdepthbuf_pars_fragment>
        uniform float opacity;
        varying vec3 vColor;
        void main() {
          #include <logdepthbuf_fragment>
          // Circular point with a soft stellar core.
          vec2 uv = gl_PointCoord - vec2(0.5);
          float r = length(uv);
          if (r > 0.5) discard;
          float alpha = opacity * (1.0 - smoothstep(0.06, 0.5, r));
          gl_FragColor = vec4(vColor, alpha);
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    return new THREE.Points(geo, mat);
  }

  addToScene(scene: THREE.Scene): void {
    scene.add(this.mesh);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
