import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Aurora ovals: FBM curtain shaders on two cone-band rings at magnetic
// latitude ±68°, offset 11° from the rotation axis (Earth's dipole tilt).
// Green at the base fading to violet aloft, rippling continuously, and
// masked to the night side via the same sun-direction plumbing the other
// planet shaders use.
// ---------------------------------------------------------------------------

const AURORA_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec2 vUv;
  varying vec3 vWorldPos;
  void main() {
    vUv = uv;
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const AURORA_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform float time;
  uniform vec3 uSunPos;
  uniform vec3 uPlanetCenter;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  float hash2(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float noise2(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x),
               mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm2(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
      v += a * noise2(p);
      p = p * 2.13 + vec2(11.7);
      a *= 0.5;
    }
    return v;
  }

  void main() {
    #include <logdepthbuf_fragment>
    // Curtain folds: angular noise domain-warped and drifting
    float ang = vUv.x * 24.0;
    float warp = fbm2(vec2(ang * 0.6, time * 0.11));
    float curtain = fbm2(vec2(ang + warp * 3.0, vUv.y * 2.0 - time * 0.20));
    curtain = pow(curtain, 2.1) * 2.0;

    // Bright at the base, fading with altitude (vUv.y: 0 base → 1 top)
    float vertical = (1.0 - vUv.y) * (0.35 + 0.65 * smoothstep(0.0, 0.15, vUv.y));

    // Night-side mask
    vec3 up = normalize(vWorldPos - uPlanetCenter);
    vec3 sunDir = normalize(uSunPos - uPlanetCenter);
    float night = smoothstep(0.15, -0.2, dot(up, sunDir));

    float alpha = curtain * vertical * night * 0.5;
    vec3 color = mix(vec3(0.22, 1.0, 0.55), vec3(0.52, 0.28, 0.92), vUv.y)
               + vec3(0.9, 0.3, 0.4) * smoothstep(0.75, 1.0, vUv.y) * 0.35;
    gl_FragColor = vec4(color * alpha, alpha);
  }
`;

export interface AuroraHandle {
  group: THREE.Group;
  uniforms: {
    time: { value: number };
    uSunPos: { value: THREE.Vector3 };
    uPlanetCenter: { value: THREE.Vector3 };
  };
}

/** Build north+south aurora ovals for a body of the given visual radius. */
export function buildAurora(visualRadius: number): AuroraHandle {
  const uniforms = {
    time: { value: 0 },
    uSunPos: { value: new THREE.Vector3() },
    uPlanetCenter: { value: new THREE.Vector3() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: AURORA_VERT,
    fragmentShader: AURORA_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const group = new THREE.Group();
  const latDeg = 68;
  const spanDeg = 6;      // latitude span of the oval band
  const altitude = 0.055; // curtain height as a fraction of the radius

  for (const hemisphere of [1, -1]) {
    const lat0 = (latDeg * hemisphere * Math.PI) / 180;
    const lat1 = ((latDeg + spanDeg) * hemisphere * Math.PI) / 180;
    const R = visualRadius * 1.012;
    const r0 = R * Math.cos(lat0);
    const r1 = R * Math.cos(lat1);
    const y0 = R * Math.sin(lat0);
    const y1 = R * Math.sin(lat1) + hemisphere * visualRadius * altitude;
    const geo = new THREE.CylinderGeometry(
      hemisphere > 0 ? r1 : r0,
      hemisphere > 0 ? r0 : r1,
      Math.abs(y1 - y0), 96, 6, true
    );
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = (y0 + y1) / 2;
    mesh.renderOrder = 4;
    group.add(mesh);
  }

  // Magnetic dipole offset from the rotation axis
  group.rotation.x = (11 * Math.PI) / 180;
  return { group, uniforms };
}
