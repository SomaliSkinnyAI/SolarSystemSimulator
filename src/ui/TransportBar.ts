import { SimulationConfig } from '../types';
import { UpcomingEvent } from '../utils/EventPredictor';

// ---------------------------------------------------------------------------
// Bottom-centre transport dock: play/pause, time-scale stepper with a
// human-readable "1 s = X" readout, current date, tour/link buttons, and a
// timeline scrubber spanning the ephemeris cache range with event tick marks.
// ---------------------------------------------------------------------------

// sim-seconds per wall-second: 1× … ~4 months/s
const SPEED_PRESETS: number[] = [1, 60, 600, 3600, 21600, 86400, 604800, 2_592_000, 10_000_000];

function humanizeSpan(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(0)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(0)} min`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds < 31.5e6) return `${(seconds / 86400).toFixed(1)} d`;
  return `${(seconds / 31.557e6).toFixed(2)} yr`;
}

export class TransportBar {
  private simConfig: SimulationConfig;
  private playBtn: HTMLButtonElement;
  private speedEl: HTMLElement;
  private dateEl: HTMLElement;
  private slider: HTMLInputElement;
  private ticksEl: HTMLElement;
  private scrubbing = false;
  private rangeStart: number;
  private rangeEnd: number;

  onScrub?: (date: Date) => void;
  onScrubStart?: () => void;
  onScrubEnd?: () => void;
  onDateClick?: () => void;
  onTour?: () => void;
  onCopyLink?: () => void;
  onEventJump?: (ev: UpcomingEvent) => void;

  constructor(simConfig: SimulationConfig) {
    this.simConfig = simConfig;
    this.playBtn = document.getElementById('tb-play') as HTMLButtonElement;
    this.speedEl = document.getElementById('tb-speed')!;
    this.dateEl = document.getElementById('tb-date')!;
    this.slider = document.getElementById('timeline-slider') as HTMLInputElement;
    this.ticksEl = document.getElementById('timeline-ticks')!;

    // Timeline spans the Horizons cache range
    this.rangeStart = Date.UTC(2024, 0, 1);
    this.rangeEnd = Date.UTC(2028, 11, 31);

    this.playBtn.addEventListener('click', () => {
      this.simConfig.paused = !this.simConfig.paused;
    });
    document.getElementById('tb-slower')!.addEventListener('click', () => this._step(-1));
    document.getElementById('tb-faster')!.addEventListener('click', () => this._step(1));
    this.dateEl.addEventListener('click', () => this.onDateClick?.());
    document.getElementById('tb-tour')!.addEventListener('click', () => this.onTour?.());
    document.getElementById('tb-link')!.addEventListener('click', () => this.onCopyLink?.());

    this.slider.addEventListener('pointerdown', () => {
      this.scrubbing = true;
      this.onScrubStart?.();
    });
    this.slider.addEventListener('input', () => {
      if (this.scrubbing) this.onScrub?.(this.sliderDate());
    });
    const endScrub = () => {
      if (this.scrubbing) {
        this.scrubbing = false;
        this.onScrubEnd?.();
      }
    };
    this.slider.addEventListener('pointerup', endScrub);
    this.slider.addEventListener('pointercancel', endScrub);
  }

  private _step(dir: 1 | -1): void {
    const ts = this.simConfig.timeScale;
    // Find nearest preset, then step
    let idx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < SPEED_PRESETS.length; i++) {
      const diff = Math.abs(Math.log(SPEED_PRESETS[i]! / ts));
      if (diff < bestDiff) { bestDiff = diff; idx = i; }
    }
    idx = Math.max(0, Math.min(SPEED_PRESETS.length - 1, idx + dir));
    this.simConfig.timeScale = SPEED_PRESETS[idx]!;
  }

  private sliderDate(): Date {
    const t = Number(this.slider.value) / 10000;
    return new Date(this.rangeStart + t * (this.rangeEnd - this.rangeStart));
  }

  /** Per-frame refresh from main.ts. */
  update(simDate: Date, paused: boolean): void {
    this.playBtn.textContent = paused ? '▶' : '⏸';
    this.speedEl.textContent = paused
      ? 'paused'
      : `1 s = ${humanizeSpan(this.simConfig.timeScale)}`;
    this.dateEl.textContent = simDate.toISOString().slice(0, 10);
    if (!this.scrubbing) {
      const t = (simDate.getTime() - this.rangeStart) / (this.rangeEnd - this.rangeStart);
      this.slider.value = String(Math.round(Math.max(0, Math.min(1, t)) * 10000));
    }
  }

  /** Render event tick marks on the timeline. */
  setEvents(events: UpcomingEvent[]): void {
    this.ticksEl.innerHTML = '';
    for (const ev of events) {
      const t = (ev.date.getTime() - this.rangeStart) / (this.rangeEnd - this.rangeStart);
      if (t < 0 || t > 1) continue;
      const tick = document.createElement('div');
      tick.className = `timeline-tick ${ev.type}`;
      tick.style.left = `${(t * 100).toFixed(2)}%`;
      tick.title = `${ev.label} — ${ev.detail}`;
      tick.addEventListener('click', () => this.onEventJump?.(ev));
      this.ticksEl.appendChild(tick);
    }
  }
}
