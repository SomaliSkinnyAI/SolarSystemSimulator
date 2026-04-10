import * as THREE from 'three';
import { SpawnRequest } from '../types';
import { CelestialBody } from '../physics/CelestialBody';
import { AU } from '../utils/MathUtils';

// ---------------------------------------------------------------------------
// Body presets
// ---------------------------------------------------------------------------
interface Preset {
  label: string;
  mass: number;
  radius: number;
  color: string;
  isEmissive?: boolean;
}

const PRESETS: Record<string, Preset> = {
  asteroid: { label: 'Asteroid',   mass: 1e18,   radius: 2e5,   color: '#887766' },
  moon:     { label: 'Moon',       mass: 7.3e22, radius: 1.7e6, color: '#AAAAAA' },
  rocky:    { label: 'Planet',     mass: 6e24,   radius: 6.4e6, color: '#CC8844' },
  gas:      { label: 'Gas Giant',  mass: 1.9e27, radius: 7e7,   color: '#DDAA66' },
  star:     { label: 'Star',       mass: 2e30,   radius: 7e8,   color: '#FFDD44', isEmissive: true },
};

// ---------------------------------------------------------------------------
// SpawnPanel — God Mode body configuration panel
// ---------------------------------------------------------------------------
export class SpawnPanel {
  private panel: HTMLElement;
  private nameInput: HTMLInputElement;
  private massSlider: HTMLInputElement;
  private massVal: HTMLElement;
  private radiusSlider: HTMLInputElement;
  private radiusVal: HTMLElement;
  private colorInput: HTMLInputElement;
  private orbitTarget: HTMLSelectElement;
  private orbitType: HTMLSelectElement;
  private directionSel: HTMLSelectElement;
  private eccSlider: HTMLInputElement;
  private eccVal: HTMLElement;
  private eccField: HTMLElement;
  private customVelDiv: HTMLElement;
  private vxInput: HTMLInputElement;
  private vyInput: HTMLInputElement;
  private vzInput: HTMLInputElement;
  private infoEl: HTMLElement;
  private directionField: HTMLElement;
  private orbitTypeField: HTMLElement;

  // State
  private spawnScenePos: THREE.Vector3 | null = null;
  private spawnPhysicsPos: THREE.Vector3 | null = null;
  private previewMesh: THREE.Mesh | null = null;
  private bodies: CelestialBody[] = [];
  private scene: THREE.Scene;
  private G: number;
  private _isEmissive = false;

  /** Fires when the user clicks Spawn */
  onSpawn?: (req: SpawnRequest & { name: string; isEmissive: boolean }) => void;

  get isOpen(): boolean { return this.panel.classList.contains('open'); }

  constructor(scene: THREE.Scene, G: number) {
    this.scene = scene;
    this.G = G;

    this.panel          = document.getElementById('spawn-panel')!;
    this.nameInput      = document.getElementById('spawn-name') as HTMLInputElement;
    this.massSlider     = document.getElementById('spawn-mass') as HTMLInputElement;
    this.massVal        = document.getElementById('spawn-mass-val')!;
    this.radiusSlider   = document.getElementById('spawn-radius') as HTMLInputElement;
    this.radiusVal      = document.getElementById('spawn-radius-val')!;
    this.colorInput     = document.getElementById('spawn-color') as HTMLInputElement;
    this.orbitTarget    = document.getElementById('spawn-orbit-target') as HTMLSelectElement;
    this.orbitType      = document.getElementById('spawn-orbit-type') as HTMLSelectElement;
    this.directionSel   = document.getElementById('spawn-direction') as HTMLSelectElement;
    this.eccSlider      = document.getElementById('spawn-eccentricity') as HTMLInputElement;
    this.eccVal         = document.getElementById('spawn-ecc-val')!;
    this.eccField       = document.getElementById('spawn-ecc-field')!;
    this.customVelDiv   = document.getElementById('spawn-custom-vel')!;
    this.vxInput        = document.getElementById('spawn-vx') as HTMLInputElement;
    this.vyInput        = document.getElementById('spawn-vy') as HTMLInputElement;
    this.vzInput        = document.getElementById('spawn-vz') as HTMLInputElement;
    this.infoEl         = document.getElementById('spawn-orbit-info')!;
    this.directionField = document.getElementById('spawn-direction-field')!;
    this.orbitTypeField = document.getElementById('spawn-orbit-type-field')!;

    // Preset buttons
    this.panel.querySelectorAll('.spawn-preset-btn').forEach(btn => {
      btn.addEventListener('click', () =>
        this._applyPreset((btn as HTMLElement).dataset['preset']!)
      );
    });

    // Sliders
    this.massSlider.addEventListener('input', () => this._onMassChange());
    this.radiusSlider.addEventListener('input', () => this._onRadiusChange());
    this.colorInput.addEventListener('input', () => this._updatePreview());

    // Orbit controls
    this.orbitTarget.addEventListener('change', () => this._onOrbitTargetChange());
    this.orbitType.addEventListener('change', () => this._onOrbitTypeChange());
    this.directionSel.addEventListener('change', () => this._updateInfo());
    this.eccSlider.addEventListener('input', () => {
      this.eccVal.textContent = parseFloat(this.eccSlider.value).toFixed(2);
      this._updateInfo();
    });

    // Custom velocity inputs
    [this.vxInput, this.vyInput, this.vzInput].forEach(inp =>
      inp.addEventListener('input', () => this._updateInfo())
    );

    // Buttons
    document.getElementById('spawn-go-btn')!.addEventListener('click', () => this._spawn());
    document.getElementById('spawn-cancel-btn')!.addEventListener('click', () => this.close());

    // Prevent clicks on the panel from reaching the canvas
    this.panel.addEventListener('mousedown', e => e.stopPropagation());
    this.panel.addEventListener('click', e => e.stopPropagation());
  }

  // ---------------------------------------------------------------------------
  // Open / close
  // ---------------------------------------------------------------------------

  /** Open the panel at a new spawn location, or update position if already open. */
  open(scenePos: THREE.Vector3, physicsPos: THREE.Vector3, bodies: CelestialBody[]): void {
    this.spawnScenePos   = scenePos.clone();
    this.spawnPhysicsPos = physicsPos.clone();
    this.bodies = bodies;

    if (!this.isOpen) {
      this._populateOrbitTargets();
      this._autoSelectOrbitTarget();
      this._applyPreset('rocky');
      this.panel.classList.add('open');
    } else {
      // Already open — update position, re-check orbit target
      this._populateOrbitTargets();
      this._autoSelectOrbitTarget();
    }

    this._updatePreview();
    this._updateInfo();
  }

  close(): void {
    this.panel.classList.remove('open');
    this._removePreview();
    this.spawnScenePos = null;
    this.spawnPhysicsPos = null;
  }

  updateG(G: number): void { this.G = G; }

  // ---------------------------------------------------------------------------
  // Orbit target dropdown
  // ---------------------------------------------------------------------------
  private _populateOrbitTargets(): void {
    while (this.orbitTarget.options.length > 2) {
      this.orbitTarget.remove(this.orbitTarget.options.length - 1);
    }
    for (const b of this.bodies) {
      if (b.state.id === 'sun' || b.state.isMoon) continue;
      const opt = document.createElement('option');
      opt.value = b.state.id;
      opt.textContent = b.state.name;
      this.orbitTarget.appendChild(opt);
    }
  }

  private _autoSelectOrbitTarget(): void {
    if (!this.spawnPhysicsPos) return;

    let nearestId = 'sun';
    let nearestDist = Infinity;
    const sun = this.bodies.find(b => b.state.id === 'sun');

    for (const b of this.bodies) {
      if (b.state.isMoon) continue;
      const d = b.state.position.distanceTo(this.spawnPhysicsPos);
      if (d < nearestDist) { nearestDist = d; nearestId = b.state.id; }
    }

    // Only orbit a planet if within ~3x its Hill sphere
    if (nearestId !== 'sun' && sun) {
      const body = this.bodies.find(b => b.state.id === nearestId)!;
      const dSun = body.state.position.distanceTo(sun.state.position);
      const hill = dSun * Math.pow(body.state.mass / (3 * sun.state.mass), 1 / 3);
      if (nearestDist > hill * 3) nearestId = 'sun';
    }

    this.orbitTarget.value = nearestId;
    this._onOrbitTargetChange();
  }

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------
  private _applyPreset(id: string): void {
    const p = PRESETS[id];
    if (!p) return;
    this._isEmissive = p.isEmissive ?? false;

    this.nameInput.value    = p.label;
    this.massSlider.value   = Math.log10(p.mass).toFixed(1);
    this.radiusSlider.value = Math.log10(p.radius).toFixed(1);
    this.colorInput.value   = p.color;
    this._onMassChange();
    this._onRadiusChange();

    this.panel.querySelectorAll('.spawn-preset-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset['preset'] === id);
    });

    this._updatePreview();
    this._updateInfo();
  }

  // ---------------------------------------------------------------------------
  // Slider display
  // ---------------------------------------------------------------------------
  private _onMassChange(): void {
    const v = Math.pow(10, parseFloat(this.massSlider.value));
    this.massVal.textContent = v.toExponential(1);
    this._updateInfo();
  }

  private _onRadiusChange(): void {
    const v = Math.pow(10, parseFloat(this.radiusSlider.value));
    this.radiusVal.textContent = v.toExponential(1);
    this._updatePreview();
  }

  // ---------------------------------------------------------------------------
  // Orbit type visibility logic
  // ---------------------------------------------------------------------------
  private _onOrbitTargetChange(): void {
    const hasTarget = this.orbitTarget.value !== 'none';
    this.orbitTypeField.style.display  = hasTarget ? '' : 'none';
    this.directionField.style.display  = hasTarget && this.orbitType.value !== 'custom' ? '' : 'none';

    if (!hasTarget) {
      this.eccField.style.display     = 'none';
      this.customVelDiv.style.display = '';
    } else {
      this._onOrbitTypeChange();
    }
    this._updateInfo();
  }

  private _onOrbitTypeChange(): void {
    const type = this.orbitType.value;
    this.eccField.style.display     = type === 'elliptical' ? '' : 'none';
    this.customVelDiv.style.display = type === 'custom' ? '' : 'none';
    this.directionField.style.display = type !== 'custom' ? '' : 'none';

    // Pre-fill custom velocity with circular orbit velocity for convenience
    if (type === 'custom' && this.spawnPhysicsPos) {
      const target = this.bodies.find(b => b.state.id === this.orbitTarget.value);
      if (target) {
        const relPos  = this.spawnPhysicsPos.clone().sub(target.state.position);
        const r       = relPos.length();
        if (r > 1) {
          const radial  = relPos.clone().normalize();
          const tangent = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), radial).normalize();
          if (tangent.lengthSq() < 0.01) tangent.set(1, 0, 0);
          const speed   = Math.sqrt(this.G * target.state.mass / r);
          const vel     = target.state.velocity.clone().addScaledVector(tangent, speed);
          this.vxInput.value = (vel.x / 1000).toFixed(1);
          this.vyInput.value = (vel.y / 1000).toFixed(1);
          this.vzInput.value = (vel.z / 1000).toFixed(1);
        }
      }
    }

    this._updateInfo();
  }

  // ---------------------------------------------------------------------------
  // Velocity computation
  // ---------------------------------------------------------------------------
  private _computeVelocity(): THREE.Vector3 {
    if (!this.spawnPhysicsPos) return new THREE.Vector3();

    const targetId  = this.orbitTarget.value;
    const orbitType = this.orbitType.value;

    // Custom / no target — use manual velocity (km/s → m/s)
    if (targetId === 'none' || orbitType === 'custom') {
      return new THREE.Vector3(
        (parseFloat(this.vxInput.value) || 0) * 1000,
        (parseFloat(this.vyInput.value) || 0) * 1000,
        (parseFloat(this.vzInput.value) || 0) * 1000,
      );
    }

    const target = this.bodies.find(b => b.state.id === targetId);
    if (!target) return new THREE.Vector3();

    const relPos = this.spawnPhysicsPos.clone().sub(target.state.position);
    const r = relPos.length();
    if (r < 1) return target.state.velocity.clone();

    // Radial and tangential directions
    const radial  = relPos.clone().normalize();
    const up      = new THREE.Vector3(0, 1, 0);
    const tangent = new THREE.Vector3().crossVectors(up, radial).normalize();
    if (tangent.lengthSq() < 0.01) tangent.set(1, 0, 0);

    // Orbital speed
    const mu = this.G * target.state.mass;
    let speed: number;

    if (orbitType === 'circular') {
      speed = Math.sqrt(mu / r);
    } else {
      // Elliptical at periapsis: v = sqrt(mu/r * (1+e))
      const e = parseFloat(this.eccSlider.value);
      speed = Math.sqrt(mu / r * (1 + e));
    }

    const sign = this.directionSel.value === 'retrograde' ? -1 : 1;
    return target.state.velocity.clone().addScaledVector(tangent, speed * sign);
  }

  // ---------------------------------------------------------------------------
  // Info display
  // ---------------------------------------------------------------------------
  private _updateInfo(): void {
    if (!this.spawnPhysicsPos) {
      this.infoEl.innerHTML = '<span class="info-hint">Click in the scene to place body</span>';
      return;
    }

    const targetId = this.orbitTarget.value;

    if (targetId === 'none') {
      const v = this._computeVelocity();
      const s = v.length() / 1000;
      this.infoEl.innerHTML = s > 0.1
        ? `<span class="info-label">Velocity:</span> ${s.toFixed(1)} km/s`
        : '<span class="info-hint">Stationary body</span>';
      return;
    }

    const target = this.bodies.find(b => b.state.id === targetId);
    if (!target) return;

    const r  = this.spawnPhysicsPos.distanceTo(target.state.position);
    const mu = this.G * target.state.mass;

    // Distance
    const distAU = r / AU;
    const distStr = distAU > 0.01
      ? `${distAU.toFixed(3)} AU`
      : `${(r / 1000).toFixed(0)} km`;

    // Velocity (relative to target)
    const vel    = this._computeVelocity();
    const relVel = vel.clone().sub(target.state.velocity);
    const sKms   = relVel.length() / 1000;

    // Period
    const v2  = relVel.lengthSq();
    const eps = v2 / 2 - mu / r;
    let periodStr: string;
    if (eps >= 0) {
      periodStr = 'unbound';
    } else {
      const a = -mu / (2 * eps);
      const T = 2 * Math.PI * Math.sqrt(a ** 3 / mu);
      const days = T / 86400;
      periodStr = days >= 365.25 ? `${(days / 365.25).toFixed(2)} yr` : `${days.toFixed(1)} days`;
    }

    this.infoEl.innerHTML = [
      `<span class="info-label">Distance:</span> ${distStr}`,
      `<span class="info-label">Velocity:</span> ${sKms.toFixed(1)} km/s`,
      `<span class="info-label">Period:</span> ${periodStr}`,
    ].join('<br>');
  }

  // ---------------------------------------------------------------------------
  // Preview sphere
  // ---------------------------------------------------------------------------
  private _updatePreview(): void {
    this._removePreview();
    if (!this.spawnScenePos) return;

    const color = parseInt(this.colorInput.value.replace('#', ''), 16);
    const geo   = new THREE.SphereGeometry(0.5, 16, 8);
    const mat   = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.4, wireframe: true,
    });
    this.previewMesh = new THREE.Mesh(geo, mat);
    this.previewMesh.position.copy(this.spawnScenePos);
    this.scene.add(this.previewMesh);
  }

  private _removePreview(): void {
    if (this.previewMesh) {
      this.scene.remove(this.previewMesh);
      this.previewMesh.geometry.dispose();
      (this.previewMesh.material as THREE.Material).dispose();
      this.previewMesh = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Spawn
  // ---------------------------------------------------------------------------
  private _spawn(): void {
    if (!this.spawnPhysicsPos) return;

    this.onSpawn?.({
      position:   this.spawnPhysicsPos.clone(),
      velocity:   this._computeVelocity(),
      mass:       Math.pow(10, parseFloat(this.massSlider.value)),
      radius:     Math.pow(10, parseFloat(this.radiusSlider.value)),
      color:      parseInt(this.colorInput.value.replace('#', ''), 16),
      name:       this.nameInput.value || 'Object',
      isEmissive: this._isEmissive,
    });

    this._removePreview();
    this.spawnScenePos = null;
    this.spawnPhysicsPos = null;
    this.infoEl.innerHTML = '<span class="info-hint">Click to place next body</span>';
  }
}
