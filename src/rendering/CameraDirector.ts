import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ---------------------------------------------------------------------------
// Cinematic camera: eased fly-to transitions (replacing instant snaps) and
// an auto-orbit mode. The destination is a GETTER evaluated every frame —
// planets keep moving during the flight, so the end point must track them.
// ---------------------------------------------------------------------------

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

interface Flight {
  fromPos: THREE.Vector3;
  fromTarget: THREE.Vector3;
  getTarget: () => THREE.Vector3;
  /** Camera offset direction from the target at arrival. */
  offsetDir: THREE.Vector3;
  distance: number;
  t: number;
  duration: number;
  onDone?: (() => void) | undefined;
}

export class CameraDirector {
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private flight: Flight | null = null;
  private _endPos = new THREE.Vector3();

  constructor(camera: THREE.PerspectiveCamera, controls: OrbitControls) {
    this.camera = camera;
    this.controls = controls;
  }

  get flying(): boolean { return this.flight !== null; }

  /**
   * Fly the camera so `getTarget()` fills the view from `distance` scene
   * units away. `offsetDir` (optional) fixes the approach direction;
   * otherwise the current camera→target direction is kept.
   */
  flyTo(
    getTarget: () => THREE.Vector3,
    distance: number,
    opts: { duration?: number; offsetDir?: THREE.Vector3; onDone?: () => void } = {}
  ): void {
    const target = getTarget();
    const offsetDir = opts.offsetDir?.clone().normalize()
      ?? this.camera.position.clone().sub(target).normalize();
    if (offsetDir.lengthSq() < 1e-12) offsetDir.set(0, 0.35, 1).normalize();

    this.flight = {
      fromPos: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      getTarget,
      offsetDir,
      distance,
      t: 0,
      duration: opts.duration ?? 1.8,
      onDone: opts.onDone,
    };
    this.controls.enabled = false; // damping must not fight the tween
  }

  /** Cancel any in-progress flight (e.g. the user grabbed the mouse). */
  cancel(): void {
    if (this.flight) {
      this.flight = null;
      this.controls.enabled = true;
    }
  }

  setAutoOrbit(on: boolean, speed = 0.5): void {
    this.controls.autoRotate = on;
    this.controls.autoRotateSpeed = speed;
  }

  update(dt: number): void {
    const f = this.flight;
    if (!f) return;
    f.t = Math.min(1, f.t + dt / f.duration);
    const e = easeInOutCubic(f.t);
    const target = f.getTarget();
    this._endPos.copy(target).addScaledVector(f.offsetDir, f.distance);
    this.camera.position.lerpVectors(f.fromPos, this._endPos, e);
    this.controls.target.lerpVectors(f.fromTarget, target, e);
    if (f.t >= 1) {
      const done = f.onDone;
      this.flight = null;
      this.controls.enabled = true;
      done?.();
    }
  }
}
