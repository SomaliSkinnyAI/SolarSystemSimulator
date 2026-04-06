import * as THREE from 'three';
import { randomOnSphere, randRange } from '../utils/MathUtils';

const STAR_COUNT = 12000;
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
      const [sx, sy, sz] = randomOnSphere();
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

      const brightness = randRange(0.35, 1.0);
      colors[i * 3]     = cr * brightness;
      colors[i * 3 + 1] = cg * brightness;
      colors[i * 3 + 2] = cb * brightness;

      sizes[i] = randRange(0.8, 2.5);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('size',     new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: { opacity: { value: 1.0 } },
      vertexShader: /* glsl */`
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size;
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: /* glsl */`
        uniform float opacity;
        varying vec3 vColor;
        void main() {
          // Circular point (disc)
          vec2 uv = gl_PointCoord - vec2(0.5);
          float r = length(uv);
          if (r > 0.5) discard;
          // Soft centre glow
          float alpha = opacity * (1.0 - smoothstep(0.2, 0.5, r));
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
