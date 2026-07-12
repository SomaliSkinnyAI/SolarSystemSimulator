import * as THREE from 'three';
import { solveLambert } from '../utils/Lambert';
import { heliocentricStateAtJD, TEMPLATES } from '../data/realTimeOrbits';
import { dateToJulianTDB } from '../data/horizonsEphemeris';
import { G_REAL, SOLAR_MASS, AU } from '../utils/MathUtils';

// ---------------------------------------------------------------------------
// Porkchop-plot mission planner: a departure-date × time-of-flight grid of
// Lambert solutions Earth → target, drawn as a Δv heatmap. Click the sweet
// spot, hit Launch — main.ts jumps the sim to the departure date and spawns
// a probe with the computed injection velocity, and the N-body engine then
// genuinely flies it (arrive on target, or miss if you picked poorly).
// ---------------------------------------------------------------------------

const MU_SUN = G_REAL * SOLAR_MASS;
const DAY = 86400 * 1000;

export interface MissionChoice {
  targetId: string;
  departure: Date;
  tofDays: number;
  /** Heliocentric injection velocity at departure (SI, sim axes). */
  injectionVelocity: THREE.Vector3;
  dvDeparture: number;
  dvArrival: number;
}

interface GridCell {
  dvTotal: number;
  dvDep: number;
  dvArr: number;
  v1: { x: number; y: number; z: number } | null;
}

const COLS = 64; // departure dates
const ROWS = 44; // times of flight

export class MissionPanel {
  private root: HTMLDivElement;
  private canvas: HTMLCanvasElement;
  private infoEl: HTMLDivElement;
  private launchBtn: HTMLButtonElement;
  private titleEl: HTMLDivElement;
  private grid: (GridCell | null)[][] = [];
  private targetId = 'mars';
  private startJD = 0;
  private depStepDays = 0;
  private tofMin = 0;
  private tofStep = 0;
  private selected: { col: number; row: number } | null = null;
  private computing = false;

  onLaunch?: (choice: MissionChoice) => void;

  constructor() {
    this.root = document.createElement('div');
    Object.assign(this.root.style, {
      position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
      zIndex: '395', display: 'none', padding: '16px 18px', borderRadius: '12px',
      background: 'rgba(12, 15, 30, 0.95)', border: '1px solid rgba(120, 140, 200, 0.35)',
      backdropFilter: 'blur(12px)', fontFamily: "'Courier New', monospace",
      color: '#cdd6ee', fontSize: '12px',
    });

    this.titleEl = document.createElement('div');
    Object.assign(this.titleEl.style, { color: '#ffd257', marginBottom: '8px', letterSpacing: '0.08em' });
    this.root.appendChild(this.titleEl);

    this.canvas = document.createElement('canvas');
    this.canvas.width = 560;
    this.canvas.height = 340;
    Object.assign(this.canvas.style, { display: 'block', borderRadius: '6px', cursor: 'crosshair' });
    this.root.appendChild(this.canvas);

    this.infoEl = document.createElement('div');
    Object.assign(this.infoEl.style, { marginTop: '8px', minHeight: '34px', color: '#aab4d4', lineHeight: '1.5' });
    this.infoEl.textContent = 'Computing…';
    this.root.appendChild(this.infoEl);

    const row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end' });
    this.launchBtn = document.createElement('button');
    this.launchBtn.textContent = '🚀 Launch';
    this.launchBtn.disabled = true;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Close';
    for (const b of [this.launchBtn, closeBtn]) {
      Object.assign(b.style, {
        background: 'rgba(60, 75, 125, 0.5)', color: '#dde4f5', border: 'none',
        borderRadius: '6px', fontFamily: 'inherit', fontSize: '12px',
        padding: '5px 14px', cursor: 'pointer',
      });
    }
    row.append(this.launchBtn, closeBtn);
    this.root.appendChild(row);
    document.body.appendChild(this.root);

    closeBtn.addEventListener('click', () => this.close());
    this.launchBtn.addEventListener('click', () => this._launch());
    this.canvas.addEventListener('mousemove', e => this._hover(e, false));
    this.canvas.addEventListener('click', e => this._hover(e, true));
  }

  get isOpen(): boolean { return this.root.style.display !== 'none'; }

  close(): void { this.root.style.display = 'none'; }

  open(targetId: string, fromDate: Date): void {
    this.targetId = targetId;
    this.root.style.display = 'block';
    this.selected = null;
    this.launchBtn.disabled = true;
    const name = TEMPLATES[targetId]?.name ?? targetId;
    this.titleEl.textContent = `MISSION PLANNER — Earth → ${name}`;
    this.infoEl.textContent = 'Computing porkchop plot…';
    void this._compute(fromDate);
  }

  // ---------------------------------------------------------------------------

  private async _compute(fromDate: Date): Promise<void> {
    if (this.computing) return;
    this.computing = true;
    try {
      this.startJD = dateToJulianTDB(fromDate) + 30; // leave a month of runway
      this.depStepDays = (3 * 365) / COLS;

      // Centre the TOF window on the Hohmann time of flight
      const aT = heliocentricStateAtJD(this.targetId, this.startJD)!.position.length();
      const aE = AU;
      const tofHohmann = Math.PI * Math.sqrt(((aE + aT) / 2) ** 3 / MU_SUN) / 86400;
      this.tofMin = Math.max(40, tofHohmann * 0.45);
      const tofMax = Math.min(tofHohmann * 1.9, 365 * 40);
      this.tofStep = (tofMax - this.tofMin) / ROWS;

      this.grid = [];
      for (let c = 0; c < COLS; c++) {
        const col: (GridCell | null)[] = [];
        const depJD = this.startJD + c * this.depStepDays;
        const earth = heliocentricStateAtJD('earth', depJD)!;
        for (let r = 0; r < ROWS; r++) {
          const tofDays = this.tofMin + r * this.tofStep;
          const target = heliocentricStateAtJD(this.targetId, depJD + tofDays);
          if (!target) { col.push(null); continue; }
          let best: GridCell | null = null;
          for (const longWay of [false, true]) {
            const sol = solveLambert(earth.position, target.position, tofDays * 86400, MU_SUN, longWay);
            if (!sol) continue;
            const dvDep = Math.hypot(
              sol.v1.x - earth.velocity.x, sol.v1.y - earth.velocity.y, sol.v1.z - earth.velocity.z);
            const dvArr = Math.hypot(
              sol.v2.x - target.velocity.x, sol.v2.y - target.velocity.y, sol.v2.z - target.velocity.z);
            const total = dvDep + dvArr;
            if (!best || total < best.dvTotal) {
              best = { dvTotal: total, dvDep, dvArr, v1: sol.v1 };
            }
          }
          col.push(best);
        }
        this.grid.push(col);
        if (c % 8 === 7) {
          this._draw();
          await new Promise(res => setTimeout(res, 0));
        }
      }
      this._draw();
      this.infoEl.textContent = 'Hover the map; click a cell to choose a launch window.';
    } finally {
      this.computing = false;
    }
  }

  private _draw(): void {
    const ctx = this.canvas.getContext('2d')!;
    const W = this.canvas.width;
    const H = this.canvas.height;
    ctx.fillStyle = '#0a0c19';
    ctx.fillRect(0, 0, W, H);

    // Δv range for the colormap (robust: ignore the pathological tail)
    const values: number[] = [];
    for (const col of this.grid) for (const cell of col) if (cell) values.push(cell.dvTotal);
    if (values.length === 0) return;
    values.sort((a, b) => a - b);
    const lo = values[0]!;
    const hi = values[Math.floor(values.length * 0.9)]!;

    const cw = W / COLS;
    const ch = H / ROWS;
    for (let c = 0; c < this.grid.length; c++) {
      for (let r = 0; r < ROWS; r++) {
        const cell = this.grid[c]![r];
        if (!cell) continue;
        const t = Math.max(0, Math.min(1, (cell.dvTotal - lo) / Math.max(hi - lo, 1)));
        // Blue (cheap) → teal → yellow → red (expensive)
        const hue = 230 - t * 230;
        ctx.fillStyle = `hsl(${hue}, 75%, ${18 + (1 - t) * 30}%)`;
        ctx.fillRect(c * cw, H - (r + 1) * ch, Math.ceil(cw), Math.ceil(ch));
      }
    }

    if (this.selected) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(this.selected.col * cw, H - (this.selected.row + 1) * ch, cw, ch);
    }

    ctx.fillStyle = 'rgba(205, 214, 238, 0.75)';
    ctx.font = '10px Courier New';
    const startDate = this._depDate(0).toISOString().slice(0, 10);
    const endDate = this._depDate(COLS - 1).toISOString().slice(0, 10);
    ctx.fillText(`departure → ${startDate} … ${endDate}`, 6, H - 6);
    ctx.save();
    ctx.translate(10, 12);
    ctx.fillText(`↑ flight time ${Math.round(this.tofMin)}–${Math.round(this.tofMin + ROWS * this.tofStep)} d`, 0, 0);
    ctx.restore();
  }

  private _depDate(col: number): Date {
    // JD → Date (inverse of dateToJulianTDB, TDB offset ignored at day scale)
    const jd = this.startJD + col * this.depStepDays;
    return new Date((jd - 2440587.5) * DAY);
  }

  private _hover(e: MouseEvent, select: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - rect.left) / rect.width * COLS);
    const row = Math.floor((1 - (e.clientY - rect.top) / rect.height) * ROWS);
    if (col < 0 || col >= this.grid.length || row < 0 || row >= ROWS) return;
    const cell = this.grid[col]?.[row];
    if (!cell) return;
    const dep = this._depDate(col).toISOString().slice(0, 10);
    const tof = Math.round(this.tofMin + row * this.tofStep);
    this.infoEl.innerHTML =
      `Depart <b>${dep}</b> · flight <b>${tof} d</b> · ` +
      `Δv dep <b>${(cell.dvDep / 1000).toFixed(2)}</b> + arr <b>${(cell.dvArr / 1000).toFixed(2)}</b> ` +
      `= <b>${(cell.dvTotal / 1000).toFixed(2)} km/s</b>` +
      (select ? ' — ready to launch' : '');
    if (select) {
      this.selected = { col, row };
      this.launchBtn.disabled = false;
      this._draw();
    }
  }

  private _launch(): void {
    if (!this.selected) return;
    const cell = this.grid[this.selected.col]?.[this.selected.row];
    if (!cell || !cell.v1) return;
    const choice: MissionChoice = {
      targetId: this.targetId,
      departure: this._depDate(this.selected.col),
      tofDays: Math.round(this.tofMin + this.selected.row * this.tofStep),
      injectionVelocity: new THREE.Vector3(cell.v1.x, cell.v1.y, cell.v1.z),
      dvDeparture: cell.dvDep,
      dvArrival: cell.dvArr,
    };
    this.close();
    this.onLaunch?.(choice);
  }
}
