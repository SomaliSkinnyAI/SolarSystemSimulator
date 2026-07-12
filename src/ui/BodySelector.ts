import * as THREE from 'three';
import { CelestialBody } from '../physics/CelestialBody';
import { CameraConfig } from '../types';
import { SceneManager } from '../rendering/SceneManager';
import { sceneToPhysics } from '../utils/CoordinateSystem';

// ---------------------------------------------------------------------------
// BodySelector — raycasting, selection ring, God Mode click-to-place
// ---------------------------------------------------------------------------
export class BodySelector {
  private camera: THREE.Camera;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private getBodies: () => CelestialBody[];
  private cameraConfig: CameraConfig;
  private sceneManager: SceneManager;
  private getLogScale: () => boolean;

  private raycaster = new THREE.Raycaster();
  private mouse     = new THREE.Vector2();

  private _selectedBody: CelestialBody | null = null;

  // Screen-space selection brackets (DOM) — a 3D ring would clash with
  // planetary ring systems and vanish inside/behind geometry.
  private marker: HTMLDivElement;
  private _projTmp = new THREE.Vector3();
  private _edgeTmp = new THREE.Vector3();

  // God Mode
  private godMode = false;
  private eclipticPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private _mouseDownPos: { x: number; y: number } | null = null;

  // Callbacks
  onBodySelected?: (body: CelestialBody | null) => void;

  /** Fires when the user clicks in God Mode. Passes scene + physics coords. */
  onGodModeClick?: (scenePos: THREE.Vector3, physicsPos: THREE.Vector3) => void;

  constructor(
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    getBodies: () => CelestialBody[],
    cameraConfig: CameraConfig,
    sceneManager: SceneManager,
    getLogScale: () => boolean
  ) {
    this.camera       = camera;
    this.renderer     = renderer;
    this.scene        = scene;
    this.getBodies    = getBodies;
    this.cameraConfig = cameraConfig;
    this.sceneManager = sceneManager;
    this.getLogScale  = getLogScale;

    // Selection brackets — four corner ticks tracking the body on screen
    this.marker = document.createElement('div');
    this.marker.id = 'selection-marker';
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      const span = document.createElement('span');
      span.className = `sel-corner sel-${corner}`;
      this.marker.appendChild(span);
    }
    this.marker.style.display = 'none';
    document.body.appendChild(this.marker);

    // Event listeners
    renderer.domElement.addEventListener('click',     e => this._onClick(e));
    renderer.domElement.addEventListener('dblclick',  e => this._onDblClick(e));
    renderer.domElement.addEventListener('mousedown', e => this._onMouseDown(e));
    renderer.domElement.addEventListener('mouseup',   e => this._onMouseUp(e));

    // Track pointer travel for ALL pointer types so releasing a camera drag
    // never counts as a click (deselecting the current body), and implement
    // touch double-tap (dblclick is unreliable on touch screens).
    renderer.domElement.addEventListener('pointerdown', e => {
      this._pointerDownPos = { x: e.clientX, y: e.clientY };
    });
    renderer.domElement.addEventListener('pointerup', e => this._onPointerUp(e));
  }

  private _pointerDownPos: { x: number; y: number } | null = null;
  private _lastTap: { time: number; x: number; y: number } | null = null;

  private _wasDrag(e: { clientX: number; clientY: number }): boolean {
    if (!this._pointerDownPos) return false;
    const dx = e.clientX - this._pointerDownPos.x;
    const dy = e.clientY - this._pointerDownPos.y;
    return dx * dx + dy * dy > 36; // 6 px
  }

  private _onPointerUp(e: PointerEvent): void {
    if (e.pointerType !== 'touch' || this.godMode || this._wasDrag(e)) return;
    const now = performance.now();
    const isDoubleTap = this._lastTap
      && now - this._lastTap.time < 350
      && (e.clientX - this._lastTap.x) ** 2 + (e.clientY - this._lastTap.y) ** 2 < 576;
    const body = this._raycastBodies(e);
    if (isDoubleTap && body) {
      this.selectBody(body);
      this.cameraConfig.focusMode = true;
      this.cameraConfig.focusBodyId = body.state.id;
      this.sceneManager.focusOn(body);
      this._lastTap = null;
    } else {
      if (body) this.selectBody(body);
      this._lastTap = { time: now, x: e.clientX, y: e.clientY };
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update — keep selection ring around selected body
  // ---------------------------------------------------------------------------
  update(): void {
    const body = this._selectedBody;
    if (!body) {
      this.marker.style.display = 'none';
      return;
    }

    // Project the body centre to screen space
    const proj = this._projTmp.copy(body.group.position).project(this.camera);
    if (proj.z > 1 || proj.z < -1) {
      this.marker.style.display = 'none'; // behind the camera
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const cx = rect.left + (proj.x + 1) / 2 * rect.width;
    const cy = rect.top + (1 - proj.y) / 2 * rect.height;

    // Projected pixel radius: displace the centre by one display radius
    // along the camera's right axis and measure the screen-space distance
    const displayR = body.visualRadius * body.group.scale.x;
    this._edgeTmp.set(1, 0, 0)
      .applyQuaternion(this.camera.quaternion)
      .multiplyScalar(displayR)
      .add(body.group.position)
      .project(this.camera);
    const ex = rect.left + (this._edgeTmp.x + 1) / 2 * rect.width;
    const ey = rect.top + (1 - this._edgeTmp.y) / 2 * rect.height;
    const pxRadius = Math.hypot(ex - cx, ey - cy);

    const half = Math.max(16, Math.min(220, pxRadius * 1.45 + 8));
    this.marker.style.display = 'block';
    this.marker.style.left = `${cx - half}px`;
    this.marker.style.top = `${cy - half}px`;
    this.marker.style.width = `${half * 2}px`;
    this.marker.style.height = `${half * 2}px`;
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------
  get selectedBody(): CelestialBody | null { return this._selectedBody; }

  selectBody(body: CelestialBody | null): void {
    this._selectedBody = body;
    this.onBodySelected?.(body);
  }

  deselectBody(): void { this.selectBody(null); }

  // ---------------------------------------------------------------------------
  // Raycasting helpers
  // ---------------------------------------------------------------------------
  private _setMouseFromEvent(e: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.mouse.x = ((e.clientX - rect.left) / rect.width)  * 2 - 1;
    this.mouse.y = -((e.clientY - rect.top)  / rect.height) * 2 + 1;
  }

  private _raycastBodies(e: MouseEvent): CelestialBody | null {
    this._setMouseFromEvent(e);
    this.raycaster.setFromCamera(this.mouse, this.camera);

    const meshes = this.getBodies().map(b => b.mesh);
    const hits   = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;

    const hitMesh = hits[0]!.object as THREE.Mesh;
    return this.getBodies().find(b => b.mesh === hitMesh) ?? null;
  }

  private _raycastEcliptic(e: MouseEvent): THREE.Vector3 | null {
    this._setMouseFromEvent(e);
    this.raycaster.setFromCamera(this.mouse, this.camera);
    const hit = new THREE.Vector3();
    const ok  = this.raycaster.ray.intersectPlane(this.eclipticPlane, hit);
    return ok ? hit : null;
  }

  // ---------------------------------------------------------------------------
  // Click — body selection (non-God Mode)
  // ---------------------------------------------------------------------------
  private _onClick(e: MouseEvent): void {
    if (this.godMode) return; // handled in mouseUp
    if (this._wasDrag(e)) return; // camera drag release, not a click

    const body = this._raycastBodies(e);
    if (body) {
      this.selectBody(body);
    } else {
      this.deselectBody();
    }
  }

  // ---------------------------------------------------------------------------
  // Double-click to zoom/focus on a planet
  // ---------------------------------------------------------------------------
  private _onDblClick(e: MouseEvent): void {
    if (this.godMode) return;

    const body = this._raycastBodies(e);
    if (body) {
      this.selectBody(body);
      this.cameraConfig.focusMode = true;
      this.cameraConfig.focusBodyId = body.state.id;
      this.sceneManager.focusOn(body);
    }
  }

  // ---------------------------------------------------------------------------
  // God Mode — click-to-place (mouseDown/mouseUp with drag threshold)
  // ---------------------------------------------------------------------------
  private _onMouseDown(e: MouseEvent): void {
    if (!this.godMode || e.button !== 0) return;
    this._mouseDownPos = { x: e.clientX, y: e.clientY };
  }

  private _onMouseUp(e: MouseEvent): void {
    if (!this.godMode || e.button !== 0 || !this._mouseDownPos) return;

    // Only treat as a click if mouse didn't move more than 5px (not a camera drag)
    const dx = e.clientX - this._mouseDownPos.x;
    const dy = e.clientY - this._mouseDownPos.y;
    this._mouseDownPos = null;
    if (dx * dx + dy * dy > 25) return;

    const scenePos = this._raycastEcliptic(e);
    if (!scenePos) return;

    const physicsPos = sceneToPhysics(scenePos, this.getLogScale());
    this.onGodModeClick?.(scenePos, physicsPos);
  }

  // ---------------------------------------------------------------------------
  // God Mode toggle
  // ---------------------------------------------------------------------------
  setGodMode(active: boolean): void {
    this.godMode = active;
    const hint  = document.getElementById('god-mode-hint')!;
    const cross = document.getElementById('crosshair')!;
    hint.style.display  = active ? 'block' : 'none';
    cross.style.display = active ? 'block' : 'none';
    this.renderer.domElement.style.cursor = active ? 'crosshair' : '';

    if (!active) {
      this._mouseDownPos = null;
    }
  }

  isGodMode(): boolean { return this.godMode; }

  dispose(): void {
    this.marker.remove();
  }
}
