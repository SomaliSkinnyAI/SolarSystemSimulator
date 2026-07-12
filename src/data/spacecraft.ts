import * as THREE from 'three';
import { BodyState } from '../types';

// ---------------------------------------------------------------------------
// Real spacecraft flown kinematically from their Horizons trajectories.
// They live in the bodies array (so selection, labels, data cards and the
// camera all work) but main.ts overwrites their state from the ephemeris
// every frame — RK4 cannot know about their engine burns and flybys.
// ---------------------------------------------------------------------------

export interface SpacecraftSpec {
  id: string;
  name: string;
  massKg: number;
  color: number;
}

export const SPACECRAFT: SpacecraftSpec[] = [
  { id: 'voyager1', name: 'Voyager 1', massKg: 825, color: 0xd8d8e8 },
  { id: 'voyager2', name: 'Voyager 2', massKg: 825, color: 0xc8d0e0 },
  { id: 'newhorizons', name: 'New Horizons', massKg: 478, color: 0xe8d8c0 },
  { id: 'parker', name: 'Parker Solar Probe', massKg: 685, color: 0xffd8a0 },
  { id: 'jwst', name: 'JWST', massKg: 6200, color: 0xffe89a },
];

export function makeSpacecraftState(spec: SpacecraftSpec): BodyState {
  return {
    id: spec.id,
    name: spec.name,
    mass: spec.massKg,
    radius: 10, // metres — never collides, never matters gravitationally
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3(),
    acceleration: new THREE.Vector3(),
    color: spec.color,
    texturePath: null,
    nightTexturePath: null,
    isEmissive: false,
    hasRings: false,
    hasAtmosphere: false,
    trailColor: spec.color,
    isMoon: false,
    parentId: null,
    isSpacecraft: true,
  };
}
