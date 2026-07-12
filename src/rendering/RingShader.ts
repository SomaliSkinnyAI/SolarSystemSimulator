import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Saturn ring lighting: diffuse from the Sun on either face, Henyey-
// Greenstein forward scattering when backlit (the rings glow amber when the
// Sun is behind them), and an analytic planet shadow that sweeps across the
// ring plane as the system time-warps. All positions are world-space
// uniforms refreshed per frame.
// ---------------------------------------------------------------------------

const RING_VERT = /* glsl */`
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

const RING_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform sampler2D map;
  uniform vec3 uSunPos;
  uniform vec3 uPlanetCenter;
  uniform float uPlanetRadius;
  uniform vec3 uRingNormal;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    #include <logdepthbuf_fragment>
    vec4 tex = texture2D(map, vUv);
    if (tex.a < 0.01) discard;

    vec3 toSun = uSunPos - vWorldPos;
    vec3 L = normalize(toSun);
    vec3 V = normalize(vWorldPos - cameraPosition);
    vec3 N = normalize(uRingNormal);

    // Thin slab: lit from whichever face the Sun is on
    float diffuse = clamp(abs(dot(N, L)), 0.0, 1.0);

    // Planet shadow: distance from the planet centre to the fragment→Sun ray
    vec3 toPlanet = uPlanetCenter - vWorldPos;
    float along = dot(toPlanet, L);
    float shadow = 1.0;
    if (along > 0.0 && along < length(toSun)) {
      float b = length(toPlanet - L * along);
      shadow = smoothstep(uPlanetRadius * 0.985, uPlanetRadius * 1.06, b);
    }

    // Forward scattering (backlit glow through the ring particles)
    float g = 0.62;
    float cosVS = dot(V, normalize(vWorldPos - uSunPos));
    float g2 = g * g;
    float hg = (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosVS, 1.5));
    float transmit = hg * (1.0 - tex.a * 0.85);

    vec3 litColor = tex.rgb * (0.06 + 0.94 * diffuse * shadow);
    vec3 scatterColor = vec3(1.0, 0.83, 0.58) * transmit * 2.2 * shadow;

    gl_FragColor = vec4(litColor + scatterColor, tex.a * uOpacity);
  }
`;

export interface RingMaterialHandle {
  material: THREE.ShaderMaterial;
  uniforms: {
    uSunPos: { value: THREE.Vector3 };
    uPlanetCenter: { value: THREE.Vector3 };
    uPlanetRadius: { value: number };
    uRingNormal: { value: THREE.Vector3 };
  };
}

// ---------------------------------------------------------------------------
// Ring shadow cast ON the planet: intersect the fragment→Sun ray with the
// ring plane; if the hit lands inside the ring annulus, darken by an
// analytic A/B/C-band opacity profile (radii in units of the ring inner R).
// Injected into Saturn's MeshStandardMaterial alongside the eclipse chunk.
// ---------------------------------------------------------------------------
export const RING_SHADOW_GLSL = /* glsl */`
  uniform vec3 uRsCenter;
  uniform vec3 uRsNormal;
  uniform vec3 uRsSunPos;
  uniform float uRsInner;
  uniform float uRsOuter;

  float saturnRingAlpha(float q) {
    // q: radius in planet radii (rings span ~1.25 .. 2.4)
    float a = 0.0;
    a += 0.30 * smoothstep(1.24, 1.30, q) * (1.0 - smoothstep(1.45, 1.52, q));  // C ring
    a += 0.88 * smoothstep(1.52, 1.56, q) * (1.0 - smoothstep(1.93, 1.96, q));  // B ring
    a += 0.55 * smoothstep(2.02, 2.06, q) * (1.0 - smoothstep(2.25, 2.28, q));  // A ring
    return a;
  }

  float ringShadowFactor(vec3 worldPos, float planetRadius) {
    vec3 L = normalize(uRsSunPos - worldPos);
    float denom = dot(uRsNormal, L);
    if (abs(denom) < 1e-5) return 1.0;
    float t = dot(uRsNormal, uRsCenter - worldPos) / denom;
    if (t <= 0.0) return 1.0;
    vec3 hit = worldPos + L * t;
    float d = length(hit - uRsCenter);
    if (d < uRsInner || d > uRsOuter) return 1.0;
    float q = d / max(planetRadius, 1e-9);
    return 1.0 - saturnRingAlpha(q) * 0.85;
  }
`;

export interface RingShadowUniforms {
  uRsCenter: { value: THREE.Vector3 };
  uRsNormal: { value: THREE.Vector3 };
  uRsSunPos: { value: THREE.Vector3 };
  uRsInner: { value: number };
  uRsOuter: { value: number };
}

export function makeRingShadowUniforms(): RingShadowUniforms {
  return {
    uRsCenter: { value: new THREE.Vector3() },
    uRsNormal: { value: new THREE.Vector3(0, 1, 0) },
    uRsSunPos: { value: new THREE.Vector3() },
    uRsInner: { value: 1 },
    uRsOuter: { value: 2 },
  };
}

export function buildLitRingMaterial(opacity: number): RingMaterialHandle {
  const uniforms = {
    map: { value: null as THREE.Texture | null },
    uSunPos: { value: new THREE.Vector3() },
    uPlanetCenter: { value: new THREE.Vector3() },
    uPlanetRadius: { value: 1 },
    uRingNormal: { value: new THREE.Vector3(0, 1, 0) },
    uOpacity: { value: opacity },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: RING_VERT,
    fragmentShader: RING_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  return { material, uniforms };
}
