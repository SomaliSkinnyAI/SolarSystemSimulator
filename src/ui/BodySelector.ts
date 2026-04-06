import * as THREE from 'three';
import { CelestialBody } from '../physics/CelestialBody';
import { SpawnRequest, CameraConfig } from '../types';
import { SceneManager } from '../rendering/SceneManager';
import { sceneToPhysics } from '../utils/CoordinateSystem';

// ---------------------------------------------------------------------------
// BodySelector — raycasting, selection ring, God Mode spawn
// ---------------------------------------------------------------------------
export class BodySelector {
  private camera: THREE.Camera;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private getBodies: () => CelestialBody[];
  private cameraConfig: CameraConfig;
  private sceneManager: SceneManager;

  private raycaster = new THREE.Raycaster();
  private mouse     = new THREE.Vector2();

  private _selectedBody: CelestialBody | null = null;

  // Selection ring
  private selectionRing: THREE.Mesh;

  // God Mode
  private godMode = false;
  private dragStart: THREE.Vector3 | null = null;
  private dragCurrent: THREE.Vector3 | null = null;
  private velocityArrow: THREE.ArrowHelper | null = null;
  private eclipticPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Callbacks
  onBodySelected?: (body: CelestialBody | null) => void;
  onSpawnRequested?: (req: SpawnRequest) => void;

  // Pending spawn (resolved in main loop)
  pendingSpawn: SpawnRequest | null = null;

  constructor(
    camera: THREE.Camera,
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    getBodies: () => CelestialBody[],
    cameraConfig: CameraConfig,
    sceneManager: SceneManager
  ) {
    this.camera       = camera;
    this.renderer     = renderer;
    this.scene        = scene;
    this.getBodies    = getBodies;
    this.cameraConfig = cameraConfig;
    this.sceneManager = sceneManager;

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
    renderer.domElement.addEventListener('mousemove', e => this._onMouseMove(e));
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
  // Click
  // ---------------------------------------------------------------------------
  private _onClick(e: MouseEvent): void {
    if (this.godMode) return; // handled in mouseup

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
  // God Mode mouse events
  // ---------------------------------------------------------------------------
  private _onMouseDown(e: MouseEvent): void {
    if (!this.godMode || e.button !== 0) return;
    const pt = this._raycastEcliptic(e);
    if (!pt) return;
    this.dragStart = pt.clone();
    this.dragCurrent = pt.clone();
  }

  private _onMouseMove(e: MouseEvent): void {
    if (!this.godMode || !this.dragStart) return;
    const pt = this._raycastEcliptic(e);
    if (!pt) return;
    this.dragCurrent = pt.clone();

    // Draw velocity arrow
    if (this.velocityArrow) {
      this.scene.remove(this.velocityArrow);
      this.velocityArrow = null;
    }
    const dir = new THREE.Vector3().subVectors(pt, this.dragStart);
    const len = dir.length();
    if (len > 0.05) {
      this.velocityArrow = new THREE.ArrowHelper(
        dir.clone().normalize(),
        this.dragStart,
        len,
        0xFFCC00,
        len * 0.2,
        len * 0.15
      );
      this.scene.add(this.velocityArrow);
    }
  }

  private _onMouseUp(e: MouseEvent): void {
    if (!this.godMode || e.button !== 0 || !this.dragStart) return;

    const spawnPos  = this.dragStart.clone();
    const spawnDrag = this.dragCurrent ?? spawnPos.clone();

    // Remove velocity arrow
    if (this.velocityArrow) {
      this.scene.remove(this.velocityArrow);
      this.velocityArrow = null;
    }
    this.dragStart   = null;
    this.dragCurrent = null;

    // Convert scene velocity to physics m/s
    // Scale factor: 1 scene unit drag = ~200 km/s (tunable for feel)
    const VELOCITY_SCALE = 2e8; // scene units → m/s multiplier
    const sceneVel  = new THREE.Vector3().subVectors(spawnDrag, spawnPos).multiplyScalar(VELOCITY_SCALE);
    const physicsPos = sceneToPhysics(spawnPos, false); // always linear for god mode
    const physicsVel = sceneVel; // velocity scale is already in SI

    this.pendingSpawn = {
      position: physicsPos,
      velocity: physicsVel,
      mass:   1e26,
      radius: 5e7,
      color:  0x88CCFF,
    };
  }

  // ---------------------------------------------------------------------------
  // God Mode toggle
  // ---------------------------------------------------------------------------
  setGodMode(active: boolean): void {
    this.godMode = active;
    const hint = document.getElementById('god-mode-hint')!;
    const cross = document.getElementById('crosshair')!;
    hint.style.display  = active ? 'block' : 'none';
    cross.style.display = active ? 'block' : 'none';
    this.renderer.domElement.style.cursor = active ? 'crosshair' : '';

    if (!active) {
      if (this.velocityArrow) {
        this.scene.remove(this.velocityArrow);
        this.velocityArrow = null;
      }
      this.dragStart = null;
    }
  }

  isGodMode(): boolean { return this.godMode; }

  dispose(): void {
    this.scene.remove(this.selectionRing);
    this.selectionRing.geometry.dispose();
    (this.selectionRing.material as THREE.Material).dispose();
  }
}
