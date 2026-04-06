import * as THREE from 'three';
import { AU } from './MathUtils';

// ---------------------------------------------------------------------------
// Display scale — 1 metre in physics space = 1/DISPLAY_SCALE scene units.
// At DISPLAY_SCALE = 1e9:  1 AU ≈ 149.6 scene units  (comfortable range).
// ---------------------------------------------------------------------------
export const DISPLAY_SCALE = 1e9; // metres per scene unit

// ---------------------------------------------------------------------------
// Logarithmic scale transform
//
// Maps physics position (metres) → scene position using:
//   scene_axis = sign(x) * log10(1 + |x| / AU)
//
// Key values:
//   0 AU   → 0
//   1 AU   → 1
//   5 AU   → 1.78
//   30 AU  → 2.48
// This lets Neptune (~30 AU) and Mercury (~0.4 AU) coexist in the same view.
// ---------------------------------------------------------------------------
export function logScaleAxis(metres: number): number {
  const au = metres / AU;
  return Math.sign(au) * Math.log10(1 + Math.abs(au));
}

export function logScaleAxisInverse(sceneVal: number): number {
  const au = Math.sign(sceneVal) * (Math.pow(10, Math.abs(sceneVal)) - 1);
  return au * AU;
}

// ---------------------------------------------------------------------------
// Primary conversion functions
// ---------------------------------------------------------------------------

/** Convert a physics position (SI metres) to Three.js scene units. */
export function physicsToScene(
  pos: THREE.Vector3,
  logScale: boolean,
  lerpT: number = logScale ? 1 : 0,
  out: THREE.Vector3 = new THREE.Vector3()
): THREE.Vector3 {
  if (lerpT <= 0) {
    out.set(pos.x / DISPLAY_SCALE, pos.y / DISPLAY_SCALE, pos.z / DISPLAY_SCALE);
  } else if (lerpT >= 1) {
    out.set(logScaleAxis(pos.x), logScaleAxis(pos.y), logScaleAxis(pos.z));
  } else {
    const linX = pos.x / DISPLAY_SCALE;
    const linY = pos.y / DISPLAY_SCALE;
    const linZ = pos.z / DISPLAY_SCALE;
    const logX = logScaleAxis(pos.x);
    const logY = logScaleAxis(pos.y);
    const logZ = logScaleAxis(pos.z);
    out.set(
      linX + (logX - linX) * lerpT,
      linY + (logY - linY) * lerpT,
      linZ + (logZ - linZ) * lerpT
    );
  }
  return out;
}

/** Convert a scene position back to physics metres (linear only — log inverse is approximate). */
export function sceneToPhysics(scenePos: THREE.Vector3, logScale: boolean): THREE.Vector3 {
  if (!logScale) {
    return scenePos.clone().multiplyScalar(DISPLAY_SCALE);
  }
  return new THREE.Vector3(
    logScaleAxisInverse(scenePos.x),
    logScaleAxisInverse(scenePos.y),
    logScaleAxisInverse(scenePos.z)
  );
}

/** Convert a physics radius (metres) to a scene radius. Always linear. */
export function physicsRadiusToScene(radiusMetres: number): number {
  return radiusMetres / DISPLAY_SCALE;
}

/**
 * Compute a visually pleasing display radius.
 * The Sun's actual radius would be microscopic vs. AU distances; we apply
 * a minimum visual size and an exaggeration factor so bodies are always visible.
 */
export function visualRadius(physicsRadius: number, isEmissive: boolean): number {
  const raw = physicsRadiusToScene(physicsRadius);
  // Minimum visual radius in scene units (makes tiny bodies still clickable/visible)
  const minRadius = 0.2;
  // Exaggerate radii for visual clarity (not physically accurate scaling)
  const exaggeration = isEmissive ? 3.0 : 8.0;
  return Math.max(raw * exaggeration, minRadius);
}
