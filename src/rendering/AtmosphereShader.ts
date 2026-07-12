import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Physically-based single-scattering atmosphere (Rayleigh + Mie raymarch).
//
// Rendered on a BackSide shell slightly larger than the planet. For each
// fragment the view ray is marched through the shell; at every sample the
// transmittance toward the Sun is integrated, giving the blue day-side limb,
// the orange-red terminator, and the sunset-coloured backlit crescent for
// free. Planet centre/radius/sun position are world-space uniforms refreshed
// every frame by CelestialBody.updateScenePosition (group scale changes with
// log/real-scale modes, so nothing here can be baked).
// ---------------------------------------------------------------------------

export interface AtmosphereParams {
  /** Rayleigh scattering coefficients (per unit height), tinted per planet. */
  betaRayleigh: THREE.Vector3;
  /** Mie scattering coefficient. */
  betaMie: number;
  /** Mie phase asymmetry (0.76 ≈ Earth haze forward scatter). */
  mieG: number;
  /** Rayleigh scale height as a fraction of shell thickness. */
  scaleHeightR: number;
  /** Mie scale height as a fraction of shell thickness. */
  scaleHeightM: number;
  /** Overall brightness. */
  intensity: number;
  /** Shell radius as a multiple of the planet's visual radius. */
  shellScale: number;
}

/** Per-planet tuning. Coefficients are artistic but wavelength-ordered. */
export const ATMOSPHERE_PARAMS: Record<string, AtmosphereParams> = {
  earth: {
    betaRayleigh: new THREE.Vector3(5.8, 13.5, 33.1),
    betaMie: 4.0, mieG: 0.76,
    scaleHeightR: 0.25, scaleHeightM: 0.1,
    intensity: 14, shellScale: 1.06,
  },
  venus: {
    // Thick CO2 + sulfuric haze: nearly wavelength-flat, Mie-dominated
    betaRayleigh: new THREE.Vector3(16.0, 14.5, 9.5),
    betaMie: 24.0, mieG: 0.65,
    scaleHeightR: 0.4, scaleHeightM: 0.35,
    intensity: 9, shellScale: 1.05,
  },
  mars: {
    // Thin, dust-dominated: butterscotch sky, blue-ish sunset halo
    betaRayleigh: new THREE.Vector3(12.0, 7.0, 3.5),
    betaMie: 3.0, mieG: 0.70,
    scaleHeightR: 0.3, scaleHeightM: 0.15,
    intensity: 5, shellScale: 1.04,
  },
  titan: {
    // Deep orange photochemical smog
    betaRayleigh: new THREE.Vector3(22.0, 12.0, 4.0),
    betaMie: 14.0, mieG: 0.60,
    scaleHeightR: 0.5, scaleHeightM: 0.4,
    intensity: 7, shellScale: 1.10,
  },
};

const ATMO_SCATTER_VERT = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_vertex>
  varying vec3 vWorldPos;
  void main() {
    vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    #include <logdepthbuf_vertex>
  }
`;

const ATMO_SCATTER_FRAG = /* glsl */`
  #include <common>
  #include <logdepthbuf_pars_fragment>
  uniform vec3 uPlanetCenter;
  uniform float uPlanetRadius;
  uniform float uAtmoRadius;
  uniform vec3 uSunPos;
  uniform vec3 uBetaR;
  uniform float uBetaM;
  uniform float uMieG;
  uniform float uScaleHeightR;
  uniform float uScaleHeightM;
  uniform float uIntensity;
  varying vec3 vWorldPos;

  const int VIEW_SAMPLES = 12;
  const int LIGHT_SAMPLES = 5;

  // Returns entry/exit distances of ray (o, d) against sphere (c, r), or
  // vec2(-1) on miss. d must be normalized.
  vec2 raySphere(vec3 o, vec3 d, vec3 c, float r) {
    vec3 oc = o - c;
    float b = dot(oc, d);
    float det = b * b - (dot(oc, oc) - r * r);
    if (det < 0.0) return vec2(-1.0);
    float s = sqrt(det);
    return vec2(-b - s, -b + s);
  }

  float densityAt(vec3 p, float scaleHeight) {
    float h = (length(p - uPlanetCenter) - uPlanetRadius)
            / max(uAtmoRadius - uPlanetRadius, 1e-6);
    return exp(-max(h, 0.0) / scaleHeight);
  }

  // Optical depth along a ray to the shell edge (toward the Sun)
  vec2 lightOpticalDepth(vec3 p, vec3 sunDir) {
    vec2 hit = raySphere(p, sunDir, uPlanetCenter, uAtmoRadius);
    float rayLen = hit.y;
    float stepLen = rayLen / float(LIGHT_SAMPLES);
    vec2 od = vec2(0.0); // x: Rayleigh, y: Mie
    vec3 sp = p + sunDir * stepLen * 0.5;
    for (int i = 0; i < LIGHT_SAMPLES; i++) {
      od.x += densityAt(sp, uScaleHeightR) * stepLen;
      od.y += densityAt(sp, uScaleHeightM) * stepLen;
      sp += sunDir * stepLen;
    }
    return od;
  }

  void main() {
    #include <logdepthbuf_fragment>
    vec3 rayOrigin = cameraPosition;
    vec3 rayDir = normalize(vWorldPos - cameraPosition);

    vec2 atmoHit = raySphere(rayOrigin, rayDir, uPlanetCenter, uAtmoRadius);
    if (atmoHit.y < 0.0) discard;
    float tNear = max(atmoHit.x, 0.0);
    float tFar = atmoHit.y;

    // Stop at the planet surface
    vec2 planetHit = raySphere(rayOrigin, rayDir, uPlanetCenter, uPlanetRadius);
    if (planetHit.x > 0.0) tFar = min(tFar, planetHit.x);

    float pathLen = tFar - tNear;
    if (pathLen <= 0.0) discard;

    // Normalize distances to shell thickness so coefficients are unit-free
    float unit = max(uAtmoRadius - uPlanetRadius, 1e-6);
    float stepLen = pathLen / float(VIEW_SAMPLES);
    vec3 sunDir = normalize(uSunPos - uPlanetCenter);

    vec3 sumR = vec3(0.0);
    float sumM = 0.0;
    vec2 viewOD = vec2(0.0);
    vec3 p = rayOrigin + rayDir * (tNear + stepLen * 0.5);

    for (int i = 0; i < VIEW_SAMPLES; i++) {
      float dR = densityAt(p, uScaleHeightR) * stepLen / unit;
      float dM = densityAt(p, uScaleHeightM) * stepLen / unit;
      viewOD += vec2(dR, dM);

      // Skip samples in the planet's own shadow (night side)
      vec2 nightHit = raySphere(p, sunDir, uPlanetCenter, uPlanetRadius * 0.998);
      if (nightHit.x < 0.0) {
        vec2 lightOD = lightOpticalDepth(p, sunDir) / unit;
        vec3 tau = uBetaR * 0.01 * (viewOD.x + lightOD.x)
                 + vec3(uBetaM * 0.01 * 1.1) * (viewOD.y + lightOD.y);
        vec3 attn = exp(-tau);
        sumR += attn * dR;
        sumM += attn.r * dM;
      }
      p += rayDir * stepLen;
    }

    float cosT = dot(rayDir, sunDir);
    float phaseR = 3.0 / (16.0 * PI) * (1.0 + cosT * cosT);
    float g2 = uMieG * uMieG;
    float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + cosT * cosT))
                 / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * uMieG * cosT, 1.5));

    vec3 color = (sumR * uBetaR * 0.01 * phaseR
                + vec3(sumM * uBetaM * 0.01 * phaseM)) * uIntensity;

    // Soft alpha from total brightness — blended additively anyway
    float lum = dot(color, vec3(0.3, 0.59, 0.11));
    gl_FragColor = vec4(color, clamp(lum * 2.0, 0.0, 1.0));
  }
`;

export interface AtmosphereHandle {
  mesh: THREE.Mesh;
  uniforms: {
    uPlanetCenter: { value: THREE.Vector3 };
    uPlanetRadius: { value: number };
    uAtmoRadius: { value: number };
    uSunPos: { value: THREE.Vector3 };
  };
}

/**
 * Build a scattering-atmosphere shell for a body. `visualRadius` is the
 * unscaled mesh radius; world radius uniforms must be refreshed per frame.
 */
export function buildScatteringAtmosphere(
  bodyId: string,
  visualRadius: number
): AtmosphereHandle | null {
  const params = ATMOSPHERE_PARAMS[bodyId];
  if (!params) return null;

  const shellR = visualRadius * params.shellScale;
  const geo = new THREE.SphereGeometry(shellR, 48, 24);
  const uniforms = {
    uPlanetCenter: { value: new THREE.Vector3() },
    uPlanetRadius: { value: visualRadius },
    uAtmoRadius: { value: shellR },
    uSunPos: { value: new THREE.Vector3() },
    uBetaR: { value: params.betaRayleigh },
    uBetaM: { value: params.betaMie },
    uMieG: { value: params.mieG },
    uScaleHeightR: { value: params.scaleHeightR },
    uScaleHeightM: { value: params.scaleHeightM },
    uIntensity: { value: params.intensity },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: ATMO_SCATTER_VERT,
    fragmentShader: ATMO_SCATTER_FRAG,
    transparent: true,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 3;
  return { mesh, uniforms };
}
