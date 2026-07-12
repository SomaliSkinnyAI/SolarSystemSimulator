import * as THREE from 'three';
import { BodyState, SimulationConfig, RenderConfig } from '../types';

// ---------------------------------------------------------------------------
// Full-simulation snapshots: export/import as JSON, plus localStorage
// autosave. Captures every body's physical state (including God-Mode
// creations mid-flyby), the sim/render configs, and the clock.
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;

interface SerializedBody extends Omit<BodyState, 'position' | 'velocity' | 'acceleration'> {
  position: [number, number, number];
  velocity: [number, number, number];
}

export interface Snapshot {
  schemaVersion: number;
  savedAt: string;
  epochMs: number;
  simTimeElapsed: number;
  realTimeMode: boolean;
  simConfig: SimulationConfig;
  renderConfig: RenderConfig;
  bodies: SerializedBody[];
}

export function serializeSnapshot(
  bodies: BodyState[],
  simConfig: SimulationConfig,
  renderConfig: RenderConfig,
  epoch: Date,
  simTimeElapsed: number,
  realTimeMode: boolean
): string {
  const snapshot: Snapshot = {
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    epochMs: epoch.getTime(),
    simTimeElapsed,
    realTimeMode,
    simConfig: { ...simConfig },
    renderConfig: { ...renderConfig },
    bodies: bodies.map(s => ({
      ...s,
      position: [s.position.x, s.position.y, s.position.z],
      velocity: [s.velocity.x, s.velocity.y, s.velocity.z],
      acceleration: undefined,
    } as unknown as SerializedBody)),
  };
  return JSON.stringify(snapshot);
}

export function deserializeSnapshot(json: string): {
  snapshot: Snapshot;
  states: BodyState[];
} | null {
  let snapshot: Snapshot;
  try {
    snapshot = JSON.parse(json) as Snapshot;
  } catch {
    return null;
  }
  if (snapshot.schemaVersion !== SCHEMA_VERSION || !Array.isArray(snapshot.bodies)) {
    return null;
  }
  const states: BodyState[] = snapshot.bodies.map(b => ({
    ...b,
    position: new THREE.Vector3(...b.position),
    velocity: new THREE.Vector3(...b.velocity),
    acceleration: new THREE.Vector3(),
  }));
  return { snapshot, states };
}
