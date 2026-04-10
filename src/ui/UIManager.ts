import { Pane } from 'tweakpane';
import type { TabPageApi, TabApi, BindingApi, BladeApi } from '@tweakpane/core';
import { SimulationConfig, RenderConfig, CameraConfig } from '../types';
import { CelestialBody } from '../physics/CelestialBody';
import { PhysicsEngine } from '../physics/PhysicsEngine';
import { SceneManager } from '../rendering/SceneManager';
import { BodySelector } from './BodySelector';
import { formatDistance, formatVelocity, formatMass, formatTime, escapeVelocity } from '../utils/MathUtils';
import { G_REAL, G_EXAGGERATED } from '../utils/MathUtils';

// ---------------------------------------------------------------------------
// UIManager — Tweakpane v4 control panels
// ---------------------------------------------------------------------------
export class UIManager {
  private pane: Pane;
  private simConfig: SimulationConfig;
  private renderConfig: RenderConfig;
  private cameraConfig: CameraConfig;
  private physics: PhysicsEngine;
  private sceneManager: SceneManager;
  private bodySelector: BodySelector;
  private getBodies: () => CelestialBody[];

  // Callbacks wired in by main.ts
  onReset?: () => void;
  onDeleteBody?: (id: string) => void;
  onRealTimeToggle?: (enabled: boolean) => void;
  onGodModeToggle?: (active: boolean) => void;

  // Real-time proxy — shared with Tweakpane binding
  private realTimeProxy = { enabled: false };

  // Tab pages
  private bodyPage!: TabPageApi;
  private infoPage!: TabPageApi;

  // Track last selected body to detect change
  private _lastSelectedId: string | null = null;

  // Info state refreshed every frame
  private info = {
    fps: 60,
    bodyCount: 0,
    selectedName: '—',
    selectedVelocity: 0,
    selectedDistance: 0,
    selectedPeriod: 0,
    selectedEscapeV: 0,
    simTime: '',
    simDate: '',
    overloaded: false,
  };

  // Monitor binding handles for refresh
  private infoBindings: BindingApi[] = [];
  private bodyBindings: BladeApi[] = [];

  // Body proxy object for sliders
  private bodyProxy = { mass: 1e24, radius: 1e7, vx: 0, vy: 0, vz: 0 };

  // Planet data card elements
  private planetCard: HTMLElement;
  private planetCardAccent: HTMLElement;
  private planetCardHeader: HTMLElement;
  private planetCardGrid: HTMLElement;

  constructor(
    simConfig: SimulationConfig,
    renderConfig: RenderConfig,
    cameraConfig: CameraConfig,
    physics: PhysicsEngine,
    sceneManager: SceneManager,
    bodySelector: BodySelector,
    getBodies: () => CelestialBody[]
  ) {
    this.simConfig     = simConfig;
    this.renderConfig  = renderConfig;
    this.cameraConfig  = cameraConfig;
    this.physics       = physics;
    this.sceneManager  = sceneManager;
    this.bodySelector  = bodySelector;
    this.getBodies     = getBodies;

    this.pane = new Pane({
      title: '☀ Solar System',
      container: document.getElementById('ui-root') ?? undefined,
    });

    // Planet data card
    this.planetCard       = document.getElementById('planet-card')!;
    this.planetCardAccent = this.planetCard.querySelector('.card-accent')!;
    this.planetCardHeader = this.planetCard.querySelector('.card-header')!;
    this.planetCardGrid   = this.planetCard.querySelector('.card-grid')!;

    this._buildTabs();
    this._buildKeyboard();
  }

  // ---------------------------------------------------------------------------
  // Build all tab pages
  // ---------------------------------------------------------------------------
  private _buildTabs(): void {
    const tab: TabApi = this.pane.addTab({
      pages: [
        { title: 'Sim' },
        { title: 'Camera' },
        { title: 'Body' },
        { title: 'Visuals' },
        { title: 'Info' },
      ],
    });

    const [simPage, cameraPage, bodyPage, visualsPage, infoPage] = tab.pages as TabPageApi[];
    this.bodyPage = bodyPage!;
    this.infoPage = infoPage!;

    this._buildSimPage(simPage!);
    this._buildCameraPage(cameraPage!);
    this._buildBodyPage(bodyPage!);
    this._buildVisualsPage(visualsPage!);
    this._buildInfoPage(infoPage!);
  }

  // ---------------------------------------------------------------------------
  // Sim tab
  // ---------------------------------------------------------------------------
  private _buildSimPage(page: TabPageApi): void {
    page.addButton({ title: '⏸ Pause / Resume' }).on('click', () => {
      this.simConfig.paused = !this.simConfig.paused;
    });

    page.addBinding(this.simConfig, 'timeScale', {
      label: 'Time Scale', min: 1, max: 1_000_000, step: 1,
    });

    page.addBinding(this.simConfig, 'gMode', {
      label: 'Gravity',
      options: { Realistic: 'realistic', Exaggerated: 'exaggerated' },
    }).on('change', (ev: { value: string }) => {
      this.simConfig.gMode = ev.value as 'realistic' | 'exaggerated';
      this.simConfig.G = ev.value === 'realistic' ? G_REAL : G_EXAGGERATED;
    });

    page.addBinding(this.simConfig, 'integrator', {
      label: 'Integrator',
      options: { RK4: 'RK4', 'Vel.Verlet': 'Verlet' },
    }).on('change', (ev: { value: string }) => {
      this.simConfig.integrator = ev.value as 'RK4' | 'Verlet';
    });

    page.addBlade({ view: 'separator' });

    page.addButton({ title: '↺ Reset Simulation' }).on('click', () => this.onReset?.());

    page.addBlade({ view: 'separator' });

    page.addBinding(this.realTimeProxy, 'enabled', { label: 'Real-Time Positions' })
      .on('change', (ev: { value: boolean }) => {
        if (ev.value) {
          this.simConfig.timeScale = 1;
        }
        this.onRealTimeToggle?.(ev.value);
        this.pane.refresh();
      });

    page.addBlade({ view: 'separator' });

    page.addButton({ title: '⚡ God Mode (G)' }).on('click', () => {
      const nowActive = !this.bodySelector.isGodMode();
      this.bodySelector.setGodMode(nowActive);
      this.onGodModeToggle?.(nowActive);
    });
  }

  // ---------------------------------------------------------------------------
  // Camera tab
  // ---------------------------------------------------------------------------
  private _buildCameraPage(page: TabPageApi): void {
    page.addBinding(this.renderConfig, 'logScale', { label: 'Log Scale (L)' });

    page.addBlade({ view: 'separator' });

    page.addBinding(this.cameraConfig, 'focusMode', { label: 'Focus Mode (F)' })
      .on('change', (ev: { value: boolean }) => {
        if (!ev.value) this.sceneManager.resetCamera(this.renderConfig.logScale);
      });

    page.addBlade({ view: 'separator' });

    page.addButton({ title: '⌂ Reset Camera' }).on('click', () => {
      this.cameraConfig.focusMode   = false;
      this.cameraConfig.focusBodyId = null;
      this.sceneManager.resetCamera(this.renderConfig.logScale);
      this.pane.refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Body tab — rebuilt on selection change
  // ---------------------------------------------------------------------------
  private _buildBodyPage(page: TabPageApi): void {
    // Remove old blades
    for (const b of [...this.bodyBindings]) {
      b.dispose();
    }
    this.bodyBindings = [];

    const body = this.bodySelector.selectedBody;

    if (!body) {
      const b = page.addBlade({
        view: 'text',
        label: 'Info',
        parse: (v: string) => v,
        format: (v: string) => v,
        value: 'Click a body to select it',
      } as never);
      this.bodyBindings.push(b);
      return;
    }

    const s = body.state;
    this.bodyProxy = {
      mass:   s.mass,
      radius: s.radius,
      vx:     s.velocity.x,
      vy:     s.velocity.y,
      vz:     s.velocity.z,
    };

    const nameProxy  = { name: s.name };
    const massProxy  = { mass: formatMass(s.mass) };

    this.bodyBindings.push(
      page.addBinding(nameProxy, 'name', { label: 'Name', readonly: true }),
      page.addBinding(massProxy, 'mass', { label: 'Mass', readonly: true }),
    );

    this.bodyBindings.push(page.addBlade({ view: 'separator' }) as BladeApi);

    this.bodyBindings.push(
      page.addBinding(this.bodyProxy, 'mass', {
        label: 'Mass (kg)', min: 1e15, max: 2e30, step: 1e22,
      }).on('change', (ev: { value: number }) => { s.mass = ev.value; }),

      page.addBinding(this.bodyProxy, 'radius', {
        label: 'Radius (m)', min: 1e4, max: 5e9, step: 1e5,
      }).on('change', (ev: { value: number }) => { s.radius = ev.value; }),
    );

    this.bodyBindings.push(page.addBlade({ view: 'separator' }) as BladeApi);

    this.bodyBindings.push(
      page.addBinding(this.bodyProxy, 'vx', {
        label: 'Vel X (m/s)', min: -8e4, max: 8e4, step: 100,
      }).on('change', (ev: { value: number }) => { s.velocity.x = ev.value; }),

      page.addBinding(this.bodyProxy, 'vy', {
        label: 'Vel Y (m/s)', min: -8e4, max: 8e4, step: 100,
      }).on('change', (ev: { value: number }) => { s.velocity.y = ev.value; }),

      page.addBinding(this.bodyProxy, 'vz', {
        label: 'Vel Z (m/s)', min: -8e4, max: 8e4, step: 100,
      }).on('change', (ev: { value: number }) => { s.velocity.z = ev.value; }),
    );

    this.bodyBindings.push(page.addBlade({ view: 'separator' }) as BladeApi);

    const delBtn = page.addButton({ title: '✕ Delete Body' });
    delBtn.on('click', () => {
      this.onDeleteBody?.(s.id);
      this.bodySelector.deselectBody();
    });
    this.bodyBindings.push(delBtn);
  }

  // ---------------------------------------------------------------------------
  // Visuals tab
  // ---------------------------------------------------------------------------
  private _buildVisualsPage(page: TabPageApi): void {
    page.addBinding(this.renderConfig, 'realScale', { label: 'Real Scale' });

    page.addBlade({ view: 'separator' });

    page.addBinding(this.renderConfig, 'showTrails', { label: 'Trails (T)' });

    page.addBinding(this.renderConfig, 'showBloom',  { label: 'Bloom (B)' })
      .on('change', () => this.sceneManager.applyRenderConfig(this.renderConfig));

    page.addBinding(this.renderConfig, 'bloomStrength', {
      label: 'Bloom Strength', min: 0, max: 3, step: 0.05,
    }).on('change', () => this.sceneManager.applyRenderConfig(this.renderConfig));

    page.addBinding(this.renderConfig, 'showAsteroidBelt', { label: 'Asteroid Belt' })
      .on('change', () => this.sceneManager.applyRenderConfig(this.renderConfig));

    page.addBinding(this.renderConfig, 'showSolarWind', { label: 'Solar Wind' })
      .on('change', () => this.sceneManager.applyRenderConfig(this.renderConfig));

    page.addBinding(this.renderConfig, 'showLagrangePoints', { label: 'Lagrange Pts' });

    page.addBinding(this.renderConfig, 'showGravityField', { label: 'Gravity Field' })
      .on('change', () => this.sceneManager.applyRenderConfig(this.renderConfig));

    page.addBlade({ view: 'separator' });

    page.addButton({ title: '📷 Screenshot' }).on('click', () => {
      const link = document.createElement('a');
      link.href     = this.sceneManager.renderer.domElement.toDataURL('image/png');
      link.download = 'solar-system.png';
      link.click();
    });
  }

  // ---------------------------------------------------------------------------
  // Info tab
  // ---------------------------------------------------------------------------
  private _buildInfoPage(page: TabPageApi): void {
    this.infoBindings = [];

    this.infoBindings.push(
      page.addBinding(this.info, 'fps',         { label: 'FPS',      readonly: true }),
      page.addBinding(this.info, 'bodyCount',   { label: 'Bodies',   readonly: true }),
      page.addBinding(this.info, 'simTime',     { label: 'Sim Time', readonly: true }),
      page.addBinding(this.info, 'simDate',     { label: 'Date',     readonly: true }),
      page.addBinding(this.info, 'overloaded',  { label: '⚠ Overld', readonly: true }),
    );

    page.addBlade({ view: 'separator' });

    this.infoBindings.push(
      page.addBinding(this.info, 'selectedName',     { label: 'Selected', readonly: true }),
      page.addBinding(this.info, 'selectedVelocity', { label: 'Speed',    readonly: true }),
      page.addBinding(this.info, 'selectedDistance', { label: 'Dist Sun', readonly: true }),
      page.addBinding(this.info, 'selectedPeriod',   { label: 'Period',   readonly: true }),
      page.addBinding(this.info, 'selectedEscapeV',  { label: 'Esc.Vel', readonly: true }),
    );
  }

  // ---------------------------------------------------------------------------
  // Keyboard shortcuts
  // ---------------------------------------------------------------------------
  private _buildKeyboard(): void {
    window.addEventListener('keydown', (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      switch (e.key) {
        case ' ':
          e.preventDefault();
          this.simConfig.paused = !this.simConfig.paused;
          break;
        case 'f': case 'F':
          this.cameraConfig.focusMode = !this.cameraConfig.focusMode;
          if (!this.cameraConfig.focusMode) this.sceneManager.resetCamera(this.renderConfig.logScale);
          break;
        case 'r': case 'R':
          this.onReset?.();
          break;
        case 't': case 'T':
          this.renderConfig.showTrails = !this.renderConfig.showTrails;
          break;
        case 'g': case 'G': {
          const nowActive = !this.bodySelector.isGodMode();
          this.bodySelector.setGodMode(nowActive);
          this.onGodModeToggle?.(nowActive);
          break;
        }
        case 'b': case 'B':
          this.renderConfig.showBloom = !this.renderConfig.showBloom;
          this.sceneManager.applyRenderConfig(this.renderConfig);
          break;
        case 'l': case 'L':
          this.renderConfig.logScale = !this.renderConfig.logScale;
          break;
        case 'Escape':
          this.bodySelector.deselectBody();
          this.bodySelector.setGodMode(false);
          this.onGodModeToggle?.(false);
          break;
      }
      this.pane.refresh();
    });
  }

  // ---------------------------------------------------------------------------
  // Per-frame update — refresh monitors
  // ---------------------------------------------------------------------------
  update(simTimeElapsed: number, bodies: CelestialBody[], simDate?: string): void {
    const selected = this.bodySelector.selectedBody;
    const sun = bodies.find(b => b.state.id === 'sun') ?? null;

    // Update info
    this.info.fps       = Math.round(this.sceneManager.fps);
    this.info.bodyCount = bodies.length;
    this.info.simTime   = formatTime(simTimeElapsed);
    this.info.simDate   = simDate ?? '';
    this.info.overloaded = this.simConfig.simulationOverloaded;

    if (selected) {
      const s = selected.state;
      this.info.selectedName     = s.name;
      this.info.selectedVelocity = parseFloat(formatVelocity(s.velocity.length()).replace(' km/s',''));
      this.info.selectedDistance = parseFloat(formatDistance(sun ? s.position.distanceTo(sun.state.position) : 0));
      this.info.selectedEscapeV  = parseFloat(formatVelocity(escapeVelocity(this.simConfig.G, s.mass, s.radius)).replace(' km/s',''));

      if (sun && s.id !== 'sun') {
        const rel = s.position.clone().sub(sun.state.position);
        const period = this._orbitalPeriod(
          this.simConfig.G, sun.state.mass,
          rel.x, rel.y, rel.z,
          s.velocity.x - sun.state.velocity.x,
          s.velocity.y - sun.state.velocity.y,
          s.velocity.z - sun.state.velocity.z
        );
        this.info.selectedPeriod = period > 0
          ? parseFloat((period / (86400 * 365.25)).toFixed(2))
          : 0;
      } else {
        this.info.selectedPeriod = 0;
      }

      // Rebuild body tab on new selection
      if (this._lastSelectedId !== s.id) {
        this._lastSelectedId = s.id;
        this._buildBodyPage(this.bodyPage);
      }
    } else {
      this.info.selectedName     = '—';
      this.info.selectedVelocity = 0;
      this.info.selectedDistance = 0;
      this.info.selectedPeriod   = 0;
      this.info.selectedEscapeV  = 0;

      if (this._lastSelectedId !== null) {
        this._lastSelectedId = null;
        this._buildBodyPage(this.bodyPage);
      }
    }

    // Refresh all monitor bindings
    for (const b of this.infoBindings) {
      b.refresh();
    }
  }

  private _orbitalPeriod(
    G: number, M: number,
    rx: number, ry: number, rz: number,
    vx: number, vy: number, vz: number
  ): number {
    const r  = Math.sqrt(rx * rx + ry * ry + rz * rz);
    const v2 = vx * vx + vy * vy + vz * vz;
    const eps = v2 / 2 - G * M / r;
    if (eps >= 0) return 0;
    const a = -G * M / (2 * eps);
    return 2 * Math.PI * Math.sqrt(a * a * a / (G * M));
  }

  // ---------------------------------------------------------------------------
  // Planet data card — HTML overlay in bottom-left
  // ---------------------------------------------------------------------------
  updatePlanetCard(bodies: CelestialBody[]): void {
    const selected = this.bodySelector.selectedBody;
    if (!selected) {
      this.planetCard.classList.remove('visible');
      return;
    }

    const s = selected.state;
    const sun = bodies.find(b => b.state.id === 'sun') ?? null;
    const color = '#' + s.color.toString(16).padStart(6, '0');

    // Accent bar color
    this.planetCardAccent.style.backgroundColor = color;

    // Header
    this.planetCardHeader.textContent = s.name;
    this.planetCardHeader.style.color = color;

    // Data values
    const distFromSun = sun ? s.position.distanceTo(sun.state.position) : 0;
    const velocity = s.velocity.length();
    const escV = escapeVelocity(this.simConfig.G, s.mass, s.radius);

    // Orbital period
    let periodStr = '--';
    if (sun && s.id !== 'sun') {
      const rel = s.position.clone().sub(sun.state.position);
      const period = this._orbitalPeriod(
        this.simConfig.G, sun.state.mass,
        rel.x, rel.y, rel.z,
        s.velocity.x - sun.state.velocity.x,
        s.velocity.y - sun.state.velocity.y,
        s.velocity.z - sun.state.velocity.z
      );
      if (period > 0) {
        const years = period / (86400 * 365.25);
        periodStr = years >= 1
          ? `${years.toFixed(2)} yr`
          : `${(period / 86400).toFixed(1)} days`;
      }
    }

    const rows = [
      ['Mass',         formatMass(s.mass)],
      ['Radius',       `${(s.radius / 1000).toFixed(0)} km`],
      ['Velocity',     formatVelocity(velocity)],
      ['Dist. Sun',    formatDistance(distFromSun)],
      ['Orb. Period',  periodStr],
      ['Esc. Vel.',    formatVelocity(escV)],
    ];

    this.planetCardGrid.innerHTML = rows.map(([label, value]) =>
      `<span class="label">${label}</span><span class="value">${value}</span>`
    ).join('');

    this.planetCard.classList.add('visible');
  }

  /** Sync the Real-Time checkbox state (e.g. after a date jump) */
  setRealTimeEnabled(enabled: boolean): void {
    this.realTimeProxy.enabled = enabled;
    this.pane.refresh();
  }

  dispose(): void {
    this.pane.dispose();
  }
}
