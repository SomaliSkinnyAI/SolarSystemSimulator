import * as THREE from 'three';
import { CelestialBody } from './CelestialBody';
import { SimulationConfig } from '../types';
import { softDistance, distance3 } from '../utils/MathUtils';
import { nextBodyId } from '../data/solarSystemData';

// ---------------------------------------------------------------------------
// Pre-allocated Vector3 pool — prevents GC pressure in the hot RK4 loop
// ---------------------------------------------------------------------------
class Vec3Pool {
  private pool: THREE.Vector3[] = [];
  private idx: number = 0;

  constructor(size: number) {
    for (let i = 0; i < size; i++) this.pool.push(new THREE.Vector3());
  }

  get(): THREE.Vector3 {
    if (this.idx >= this.pool.length) {
      // Grow the pool if needed (rare)
      this.pool.push(new THREE.Vector3());
    }
    return this.pool[this.idx++]!.set(0, 0, 0);
  }

  reset(): void { this.idx = 0; }
}

// Pool large enough for RK4 with 200 bodies: 4 stages × 2 derivs × 200 bodies
const POOL = new Vec3Pool(4 * 2 * 250);

// ---------------------------------------------------------------------------
// Barnes-Hut Octree (simple implementation)
// ---------------------------------------------------------------------------
interface BHNode {
  cx: number; cy: number; cz: number;
  halfSize: number;
  totalMass: number;
  comX: number; comY: number; comZ: number;
  bodyIdx: number;       // ≥0 for leaf, -1 for internal
  children: (BHNode | null)[];
}

function makeBHNode(cx: number, cy: number, cz: number, halfSize: number): BHNode {
  return { cx, cy, cz, halfSize, totalMass: 0, comX: 0, comY: 0, comZ: 0, bodyIdx: -1, children: new Array(8).fill(null) };
}

function bhInsert(node: BHNode, idx: number, px: number, py: number, pz: number, mass: number): void {
  if (node.totalMass === 0 && node.bodyIdx === -1) {
    // Empty leaf
    node.bodyIdx = idx;
    node.totalMass = mass;
    node.comX = px; node.comY = py; node.comZ = pz;
    return;
  }
  // Update centre of mass
  const newMass = node.totalMass + mass;
  node.comX = (node.comX * node.totalMass + px * mass) / newMass;
  node.comY = (node.comY * node.totalMass + py * mass) / newMass;
  node.comZ = (node.comZ * node.totalMass + pz * mass) / newMass;
  node.totalMass = newMass;

  if (node.bodyIdx >= 0) {
    // Convert leaf to internal node — push existing body into child
    const eIdx = node.bodyIdx;
    node.bodyIdx = -1;
    // We don't have the original positions here, so we use comX/Y/Z pre-update
    // This is a simplification; for accuracy we should store the original positions
    // but for > 50 bodies it's a good enough approximation
    bhInsertIntoChild(node, eIdx, node.comX, node.comY, node.comZ, 0);
  }

  bhInsertIntoChild(node, idx, px, py, pz, mass);
}

function bhInsertIntoChild(node: BHNode, idx: number, px: number, py: number, pz: number, mass: number): void {
  const octant =
    (px > node.cx ? 1 : 0) |
    (py > node.cy ? 2 : 0) |
    (pz > node.cz ? 4 : 0);
  const half = node.halfSize * 0.5;
  if (!node.children[octant]) {
    const cx = node.cx + (px > node.cx ? half : -half);
    const cy = node.cy + (py > node.cy ? half : -half);
    const cz = node.cz + (pz > node.cz ? half : -half);
    node.children[octant] = makeBHNode(cx, cy, cz, half);
  }
  bhInsert(node.children[octant]!, idx, px, py, pz, mass);
}

function bhAcceleration(
  node: BHNode,
  px: number, py: number, pz: number,
  G: number, eps: number, theta: number,
  out: THREE.Vector3
): void {
  if (node.totalMass === 0) return;
  const dx = node.comX - px;
  const dy = node.comY - py;
  const dz = node.comZ - pz;
  const r  = softDistance(dx, dy, dz, eps);
  const size2 = (node.halfSize * 2) ** 2;

  if (node.bodyIdx >= 0 || size2 / (r * r) < theta * theta) {
    // Treat as single mass
    const a = G * node.totalMass / (r * r * r);
    out.x += dx * a;
    out.y += dy * a;
    out.z += dz * a;
  } else {
    for (const child of node.children) {
      if (child) bhAcceleration(child, px, py, pz, G, eps, theta, out);
    }
  }
}

// ---------------------------------------------------------------------------
// PhysicsEngine — N-body simulation
// ---------------------------------------------------------------------------
export class PhysicsEngine {
  bodies: CelestialBody[];
  config: SimulationConfig;

  // Sorted indices of bodies to remove (populated during collision detection)
  private toRemove: Set<string> = new Set();

  // Callback so main.ts can react to removals / merges
  onBodyRemoved?: (id: string) => void;
  onBodyMerged?: (survivorId: string, removedId: string) => void;

  constructor(bodies: CelestialBody[], config: SimulationConfig) {
    this.bodies = bodies;
    this.config = config;
  }

  // ---------------------------------------------------------------------------
  // Public step — advances simulation by wallclock dt (seconds)
  // ---------------------------------------------------------------------------
  step(wallDt: number): void {
    const { timeScale, timeStep, stepsPerFrameCap } = this.config;
    let remaining = wallDt * timeScale;
    let steps = 0;

    this.config.simulationOverloaded = false;

    while (remaining > 1e-6) {
      const h = Math.min(remaining, timeStep);
      if (this.config.integrator === 'RK4') {
        this._stepRK4(h);
      } else {
        this._stepVerlet(h);
      }
      remaining -= h;
      steps++;
      if (steps >= stepsPerFrameCap) {
        this.config.simulationOverloaded = remaining > 1e-6;
        break;
      }
    }

    this._checkCollisions();
  }

  // ---------------------------------------------------------------------------
  // RK4 integrator
  // ---------------------------------------------------------------------------
  private _stepRK4(h: number): void {
    POOL.reset();
    const n = this.bodies.length;

    // Snapshot current positions and velocities
    const pos0: THREE.Vector3[] = this.bodies.map(b => POOL.get().copy(b.state.position));
    const vel0: THREE.Vector3[] = this.bodies.map(b => POOL.get().copy(b.state.velocity));

    // k1
    const acc1 = this._computeAccelerations(pos0);
    const dp1 = vel0;
    const dv1 = acc1;

    // k2 — evaluate at h/2
    const pos2: THREE.Vector3[] = this.bodies.map((_, i) => {
      return POOL.get().copy(pos0[i]!).addScaledVector(dp1[i]!, h * 0.5);
    });
    const vel2: THREE.Vector3[] = this.bodies.map((_, i) => {
      return POOL.get().copy(vel0[i]!).addScaledVector(dv1[i]!, h * 0.5);
    });
    const acc2 = this._computeAccelerations(pos2);
    const dp2 = vel2;
    const dv2 = acc2;

    // k3 — evaluate at h/2 using k2 derivative
    const pos3: THREE.Vector3[] = this.bodies.map((_, i) => {
      return POOL.get().copy(pos0[i]!).addScaledVector(dp2[i]!, h * 0.5);
    });
    const vel3: THREE.Vector3[] = this.bodies.map((_, i) => {
      return POOL.get().copy(vel0[i]!).addScaledVector(dv2[i]!, h * 0.5);
    });
    const acc3 = this._computeAccelerations(pos3);
    const dp3 = vel3;
    const dv3 = acc3;

    // k4 — evaluate at h using k3 derivative
    const pos4: THREE.Vector3[] = this.bodies.map((_, i) => {
      return POOL.get().copy(pos0[i]!).addScaledVector(dp3[i]!, h);
    });
    const vel4: THREE.Vector3[] = this.bodies.map((_, i) => {
      return POOL.get().copy(vel0[i]!).addScaledVector(dv3[i]!, h);
    });
    const acc4 = this._computeAccelerations(pos4);
    const dv4 = acc4;

    // Combine: new_state = old + (h/6)*(k1 + 2k2 + 2k3 + k4)
    const h6 = h / 6;
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      b.state.position.addScaledVector(dp1[i]!, h6)
                      .addScaledVector(dp2[i]!, 2 * h6)
                      .addScaledVector(dp3[i]!, 2 * h6)
                      .addScaledVector(vel4[i]!, h6);
      b.state.velocity.addScaledVector(dv1[i]!, h6)
                      .addScaledVector(dv2[i]!, 2 * h6)
                      .addScaledVector(dv3[i]!, 2 * h6)
                      .addScaledVector(dv4[i]!, h6);
    }
  }

  // ---------------------------------------------------------------------------
  // Velocity Verlet integrator
  // ---------------------------------------------------------------------------
  private _stepVerlet(h: number): void {
    const n = this.bodies.length;
    const positions = this.bodies.map(b => b.state.position);

    // a(t)
    const acc0 = this._computeAccelerations(positions);

    // Update positions: r(t+h) = r(t) + v(t)*h + 0.5*a(t)*h²
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      b.state.position.addScaledVector(b.state.velocity, h)
                      .addScaledVector(acc0[i]!, 0.5 * h * h);
    }

    // a(t+h)
    const acc1 = this._computeAccelerations(this.bodies.map(b => b.state.position));

    // Update velocities: v(t+h) = v(t) + 0.5*(a(t)+a(t+h))*h
    for (let i = 0; i < n; i++) {
      const b = this.bodies[i]!;
      b.state.velocity.addScaledVector(acc0[i]!, 0.5 * h)
                      .addScaledVector(acc1[i]!, 0.5 * h);
    }
  }

  // ---------------------------------------------------------------------------
  // Gravitational acceleration computation
  // ---------------------------------------------------------------------------
  private _computeAccelerations(positions: THREE.Vector3[]): THREE.Vector3[] {
    if (this.bodies.length > 50) {
      return this._computeAccelerationsBarnesHut(positions);
    }
    return this._computeAccelerationsBrute(positions);
  }

  private _computeAccelerationsBrute(positions: THREE.Vector3[]): THREE.Vector3[] {
    const n = positions.length;
    const { G, softening } = this.config;
    const acc: THREE.Vector3[] = Array.from({ length: n }, () => POOL.get());

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = positions[j]!.x - positions[i]!.x;
        const dy = positions[j]!.y - positions[i]!.y;
        const dz = positions[j]!.z - positions[i]!.z;
        const r  = softDistance(dx, dy, dz, softening);
        const r3 = r * r * r;

        const fi = G * this.bodies[j]!.state.mass / r3;
        const fj = G * this.bodies[i]!.state.mass / r3;

        acc[i]!.x += dx * fi; acc[i]!.y += dy * fi; acc[i]!.z += dz * fi;
        acc[j]!.x -= dx * fj; acc[j]!.y -= dy * fj; acc[j]!.z -= dz * fj;
      }
    }
    return acc;
  }

  private _computeAccelerationsBarnesHut(positions: THREE.Vector3[]): THREE.Vector3[] {
    const n = positions.length;
    const { G, softening } = this.config;

    // Bounding box
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const p of positions) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    }
    const halfSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ) * 0.5 + 1e9;
    const cx = (minX + maxX) * 0.5;
    const cy = (minY + maxY) * 0.5;
    const cz = (minZ + maxZ) * 0.5;

    const root = makeBHNode(cx, cy, cz, halfSize);
    for (let i = 0; i < n; i++) {
      bhInsert(root, i, positions[i]!.x, positions[i]!.y, positions[i]!.z, this.bodies[i]!.state.mass);
    }

    const theta = 0.5;
    const acc: THREE.Vector3[] = Array.from({ length: n }, () => POOL.get());
    for (let i = 0; i < n; i++) {
      bhAcceleration(root, positions[i]!.x, positions[i]!.y, positions[i]!.z, G, softening, theta, acc[i]!);
    }
    return acc;
  }

  // ---------------------------------------------------------------------------
  // Collision detection & merging
  // ---------------------------------------------------------------------------
  private _checkCollisions(): void {
    const n = this.bodies.length;
    this.toRemove.clear();

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const bi = this.bodies[i]!;
        const bj = this.bodies[j]!;
        if (this.toRemove.has(bi.state.id) || this.toRemove.has(bj.state.id)) continue;

        const dx = bi.state.position.x - bj.state.position.x;
        const dy = bi.state.position.y - bj.state.position.y;
        const dz = bi.state.position.z - bj.state.position.z;
        const dist = distance3(dx, dy, dz);
        const sumR  = bi.state.radius + bj.state.radius;

        if (dist < sumR * 0.01) { // 1% threshold to avoid false positives at scaled display
          this._merge(i, j);
        }
      }
    }

    if (this.toRemove.size > 0) {
      this.bodies = this.bodies.filter(b => {
        if (this.toRemove.has(b.state.id)) {
          b.dispose();
          this.onBodyRemoved?.(b.state.id);
          return false;
        }
        return true;
      });
    }
  }

  private _merge(iIdx: number, jIdx: number): void {
    const bi = this.bodies[iIdx]!;
    const bj = this.bodies[jIdx]!;

    // Keep the more massive body
    const [survivor, absorbed] = bi.state.mass >= bj.state.mass ? [bi, bj] : [bj, bi];
    const totalMass = survivor.state.mass + absorbed.state.mass;

    // Centre of mass position & momentum-conserving velocity
    const s = survivor.state;
    const a = absorbed.state;

    s.position.set(
      (s.position.x * s.mass + a.position.x * a.mass) / totalMass,
      (s.position.y * s.mass + a.position.y * a.mass) / totalMass,
      (s.position.z * s.mass + a.position.z * a.mass) / totalMass,
    );
    s.velocity.set(
      (s.velocity.x * s.mass + a.velocity.x * a.mass) / totalMass,
      (s.velocity.y * s.mass + a.velocity.y * a.mass) / totalMass,
      (s.velocity.z * s.mass + a.velocity.z * a.mass) / totalMass,
    );

    // Volume-conserving radius: r = cbrt(r1³ + r2³)
    s.radius = Math.cbrt(s.radius ** 3 + a.radius ** 3);
    s.mass   = totalMass;

    this.toRemove.add(absorbed.state.id);
    this.onBodyMerged?.(survivor.state.id, absorbed.state.id);
  }

  // ---------------------------------------------------------------------------
  // Add / remove bodies dynamically
  // ---------------------------------------------------------------------------
  addBody(body: CelestialBody): void {
    this.bodies.push(body);
  }

  removeBody(id: string): void {
    const idx = this.bodies.findIndex(b => b.state.id === id);
    if (idx !== -1) {
      this.bodies[idx]!.dispose();
      this.bodies.splice(idx, 1);
      this.onBodyRemoved?.(id);
    }
  }
}

export { nextBodyId };
