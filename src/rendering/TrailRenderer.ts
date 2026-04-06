import * as THREE from 'three';

const MAX_TRAIL_POINTS = 600; // per body

export class Trail {
  private positions: Float32Array;
  private head: number  = 0;
  private count: number = 0;
  private temp: Float32Array;

  readonly line: THREE.Line;
  private posAttr: THREE.BufferAttribute;

  constructor(color: number, scene: THREE.Scene) {
    this.positions = new Float32Array(MAX_TRAIL_POINTS * 3);
    this.temp      = new Float32Array(MAX_TRAIL_POINTS * 3);

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setDrawRange(0, 0);

    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.line = new THREE.Line(geo, mat);
    this.line.frustumCulled = false;
    scene.add(this.line);
  }

  /** Push a new point (scene-space) into the circular buffer. */
  push(x: number, y: number, z: number): void {
    const base = this.head * 3;
    this.positions[base]     = x;
    this.positions[base + 1] = y;
    this.positions[base + 2] = z;
    this.head = (this.head + 1) % MAX_TRAIL_POINTS;
    if (this.count < MAX_TRAIL_POINTS) this.count++;
  }

  /** Rebuild the BufferGeometry from the circular buffer and upload. */
  update(): void {
    if (this.count === 0) return;

    // Reorder circular buffer into temp (oldest → newest)
    const oldest = this.count < MAX_TRAIL_POINTS ? 0 : this.head;
    for (let i = 0; i < this.count; i++) {
      const srcIdx = (oldest + i) % MAX_TRAIL_POINTS;
      const dst    = i * 3;
      const src    = srcIdx * 3;
      this.temp[dst]     = this.positions[src]     ?? 0;
      this.temp[dst + 1] = this.positions[src + 1] ?? 0;
      this.temp[dst + 2] = this.positions[src + 2] ?? 0;
    }

    this.posAttr.array.set(this.temp);
    this.posAttr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, this.count);

    // After rewriting positions in temporal order, reset head so the next push
    // correctly overwrites the oldest element (index 0) rather than a stale slot.
    if (this.count === MAX_TRAIL_POINTS) {
      this.head = 0;
    }
  }

  /** Trim trail to a new max length (used when user changes trailLength setting). */
  trim(newMax: number): void {
    // Simple reset — could be smarter but trail data is cheap to regenerate
    if (newMax < this.count) {
      this.count = newMax;
      this.head  = newMax % MAX_TRAIL_POINTS;
    }
  }

  clear(): void {
    this.head  = 0;
    this.count = 0;
    this.line.geometry.setDrawRange(0, 0);
  }

  setVisible(v: boolean): void {
    this.line.visible = v;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.line);
    this.line.geometry.dispose();
    (this.line.material as THREE.Material).dispose();
  }
}

// ---------------------------------------------------------------------------
// TrailRenderer — owns all Trail instances
// ---------------------------------------------------------------------------
export class TrailRenderer {
  private trails: Map<string, Trail> = new Map();
  private scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  create(bodyId: string, color: number): Trail {
    const trail = new Trail(color, this.scene);
    this.trails.set(bodyId, trail);
    return trail;
  }

  get(bodyId: string): Trail | undefined {
    return this.trails.get(bodyId);
  }

  setAllVisible(visible: boolean): void {
    for (const trail of this.trails.values()) {
      trail.setVisible(visible);
    }
  }

  clearAll(): void {
    for (const trail of this.trails.values()) {
      trail.clear();
    }
  }

  dispose(bodyId: string): void {
    const trail = this.trails.get(bodyId);
    if (trail) {
      trail.dispose(this.scene);
      this.trails.delete(bodyId);
    }
  }

  disposeAll(): void {
    for (const id of this.trails.keys()) {
      this.dispose(id);
    }
  }
}
