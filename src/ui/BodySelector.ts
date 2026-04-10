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

  // Selection ring
  private selectionRing: THREE.Mesh;

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

    // Selection ring
    const ringGeo = new THREE.RingGeometry(1, 1.08, 64);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xFFFFFF,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
    });
    this.selectionRing = new THREE.Mesh(ringGeo, ringMat);
    this.selectionRing.visible = false;
    this.selectionRing.renderOrder = 1;
    scene.add(this.selectionRing);

    // Event listeners
    renderer.domElement.addEventListener('click',     e => this._onClick(e));
    renderer.domElement.addEventListener('dblclick',  e => this._onDblClick(e));
    renderer.domElement.addEventListener('mousedown', e => this._onMouseDown(e));
    renderer.domElement.addEventListener('mouseup',   e => this._onMouseUp(e));
  }

  // ---------------------------------------------------------------------------
  // Per-frame update — keep selection ring around selected body
  // ---------------------------------------------------------------------------
  update(): void {
    const body = this._selectedBody;
    if (!body) {
      this.selectionRing.visible = false;
      return;
    }
    const r = body.visualRadius * 1.55;
    this.selectionRing.position.copy(body.group.position);
    this.selectionRing.scale.set(r, r, r);
    this.selectionRing.lookAt(this.camera.position);
    this.selectionRing.visible = true;
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
    this.scene.remove(this.selectionRing);
    this.selectionRing.geometry.dispose();
    (this.selectionRing.material as THREE.Material).dispose();
  }
}
