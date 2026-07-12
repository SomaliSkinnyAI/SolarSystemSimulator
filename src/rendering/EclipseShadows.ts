import * as THREE from 'three';
import { CelestialBody } from '../physics/CelestialBody';

// ---------------------------------------------------------------------------
// Analytic eclipse / transit shadows.
//
// Shadow maps cannot span a PointLight over 1e5 scene units, so occlusion is
// computed analytically per fragment: for up to 4 occluder spheres, the
// visible fraction of the Sun's disk is estimated from the angular radii and
// separation (smooth circle-overlap), giving correct soft penumbra and a
// dark umbra. This is what makes the Moon's shadow crawl across Earth on
// 2026-08-12, and Io's shadow transit Jupiter, on the right dates.
// ---------------------------------------------------------------------------

export const MAX_OCCLUDERS = 4;

export const ECLIPSE_GLSL = /* glsl */`
  uniform vec4 uOccluders[4];      // xyz = world centre, w = radius (0 = unused)
  uniform vec3 uEclipseSunPos;
  uniform float uEclipseSunRadius;

  float sunVisibility(vec3 worldPos) {
    vec3 toSun = uEclipseSunPos - worldPos;
    float distSun = length(toSun);
    vec3 sunDir = toSun / distSun;
    float aSun = uEclipseSunRadius / distSun;
    float vis = 1.0;
    for (int i = 0; i < 4; i++) {
      float r = uOccluders[i].w;
      if (r <= 0.0) continue;
      vec3 toOcc = uOccluders[i].xyz - worldPos;
      float dOcc = length(toOcc);
      if (dOcc >= distSun || dOcc < r * 1.05) continue;
      float aOcc = r / dOcc;
      float sep = acos(clamp(dot(sunDir, toOcc / dOcc), -1.0, 1.0));
      float denom = max(aSun + aOcc - abs(aSun - aOcc), 1e-7);
      float x = clamp((sep - abs(aSun - aOcc)) / denom, 0.0, 1.0);
      float cover = 1.0 - x * x * (3.0 - 2.0 * x);
      // An occluder smaller than the Sun's disk can never fully cover it
      float maxCover = clamp((aOcc * aOcc) / (aSun * aSun), 0.0, 1.0);
      vis *= 1.0 - cover * maxCover;
    }
    return vis;
  }
`;

export interface EclipseUniforms {
  uOccluders: { value: THREE.Vector4[] };
  uEclipseSunPos: { value: THREE.Vector3 };
  uEclipseSunRadius: { value: number };
}

export function makeEclipseUniforms(): EclipseUniforms {
  return {
    uOccluders: {
      value: Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4(0, 0, 0, 0)),
    },
    uEclipseSunPos: { value: new THREE.Vector3() },
    uEclipseSunRadius: { value: 1 },
  };
}

export interface EclipsePatchExtras {
  /** Extra uniforms merged into the program (e.g. ring-shadow uniforms). */
  uniforms?: Record<string, { value: unknown }>;
  /** Extra GLSL declarations appended after the eclipse chunk. */
  fragmentDeclarations?: string;
  /** Extra statements run inside the shading block; may use `eVis`. */
  fragmentCode?: string;
}

/**
 * Patch a MeshStandardMaterial so incoming sunlight is scaled by the
 * analytic visibility term. Returns the shared uniforms to update per frame.
 */
export function patchStandardMaterialForEclipse(
  mat: THREE.Material,
  extras?: EclipsePatchExtras
): EclipseUniforms {
  const uniforms = makeEclipseUniforms();
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms, extras?.uniforms ?? {});
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vEclipseWorldPos;')
      .replace('#include <begin_vertex>',
        '#include <begin_vertex>\nvEclipseWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nvarying vec3 vEclipseWorldPos;\n'
        + ECLIPSE_GLSL + (extras?.fragmentDeclarations ?? ''))
      .replace('#include <map_fragment>',
        `#include <map_fragment>
        {
          float eVis = sunVisibility(vEclipseWorldPos);
          diffuseColor.rgb *= mix(0.05, 1.0, eVis);
          ${extras?.fragmentCode ?? ''}
        }`);
  };
  return uniforms;
}

// ---------------------------------------------------------------------------
// Per-frame updater. Occluder SELECTION (which bodies could shadow which)
// runs at a low cadence from main.ts; POSITIONS refresh every frame.
// ---------------------------------------------------------------------------

/**
 * Pick up to MAX_OCCLUDERS bodies with the largest angular size as seen from
 * `target` looking toward the Sun (only bodies roughly sunward count).
 */
export function selectOccluders(
  target: CelestialBody,
  sun: CelestialBody,
  bodies: CelestialBody[]
): CelestialBody[] {
  const toSun = new THREE.Vector3().subVectors(sun.group.position, target.group.position);
  const sunDist = toSun.length();
  if (sunDist < 1e-9) return [];
  const sunDir = toSun.clone().divideScalar(sunDist);
  const sunAng = (sun.visualRadius * sun.group.scale.x) / sunDist;

  const candidates: Array<{ body: CelestialBody; score: number }> = [];
  const toOcc = new THREE.Vector3();
  for (const b of bodies) {
    if (b === target || b === sun) continue;
    toOcc.subVectors(b.group.position, target.group.position);
    const d = toOcc.length();
    if (d < 1e-9 || d >= sunDist) continue;
    const along = toOcc.dot(sunDir) / d;
    if (along < 0.5) continue; // not remotely sunward
    const ang = (b.visualRadius * b.group.scale.x) / d;
    // Only worth shading if it could cover a meaningful part of the Sun
    if (ang < sunAng * 0.02) continue;
    candidates.push({ body: b, score: ang * along });
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, MAX_OCCLUDERS).map(c => c.body);
}

/** Write current world positions/radii into a body's eclipse uniforms. */
export function updateEclipseUniforms(
  uniforms: EclipseUniforms,
  sun: CelestialBody,
  occluders: CelestialBody[]
): void {
  uniforms.uEclipseSunPos.value.copy(sun.group.position);
  uniforms.uEclipseSunRadius.value = sun.visualRadius * sun.group.scale.x;
  for (let i = 0; i < MAX_OCCLUDERS; i++) {
    const v = uniforms.uOccluders.value[i]!;
    const occ = occluders[i];
    if (occ) {
      const p = occ.group.position;
      v.set(p.x, p.y, p.z, occ.visualRadius * occ.group.scale.x);
    } else {
      v.w = 0;
    }
  }
}
