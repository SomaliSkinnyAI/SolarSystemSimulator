import { CelestialBody } from '../physics/CelestialBody';
import { SceneManager } from '../rendering/SceneManager';

// ---------------------------------------------------------------------------
// Guided grand tour: Sun-outward flight through the system with caption
// cards. Auto-advances after a dwell; Prev/Next/Exit controls.
// ---------------------------------------------------------------------------

interface TourStop {
  bodyId: string;
  title: string;
  text: string;
  dwellSec: number;
}

const STOPS: TourStop[] = [
  { bodyId: 'sun', title: 'The Sun', dwellSec: 10,
    text: '99.86% of the solar system\'s mass. The granulation you see is real convection — cells the size of Texas, churning in real time.' },
  { bodyId: 'mercury', title: 'Mercury', dwellSec: 8,
    text: 'A day on Mercury (176 Earth days) is twice as long as its year (88 days). Its cratered surface swings between −173°C and 427°C.' },
  { bodyId: 'venus', title: 'Venus', dwellSec: 8,
    text: 'The hottest planet, wrapped in sulfuric-acid clouds. It rotates backwards, so the Sun rises in the west — once every 117 Earth days.' },
  { bodyId: 'earth', title: 'Earth', dwellSec: 10,
    text: 'The only place known to host life. Watch the terminator line — city lights trace the continents on the night side.' },
  { bodyId: 'moon', title: 'The Moon', dwellSec: 8,
    text: 'Formed ~4.5 billion years ago, likely from a Mars-sized impact. It drifts 3.8 cm farther from Earth every year.' },
  { bodyId: 'mars', title: 'Mars', dwellSec: 8,
    text: 'Home to Olympus Mons, a volcano three times the height of Everest, and Valles Marineris, a canyon that would span the United States.' },
  { bodyId: 'jupiter', title: 'Jupiter', dwellSec: 10,
    text: 'More massive than all other planets combined. Its four Galilean moons — Io, Europa, Ganymede, Callisto — are worlds in their own right.' },
  { bodyId: 'saturn', title: 'Saturn', dwellSec: 12,
    text: 'The rings are 280,000 km wide but only ~10 metres thick — water ice from a shattered moon. Watch them glow when backlit by the Sun.' },
  { bodyId: 'uranus', title: 'Uranus', dwellSec: 8,
    text: 'Knocked on its side by an ancient impact: its axis is tilted 98°, so its faint charcoal rings stand almost vertical.' },
  { bodyId: 'neptune', title: 'Neptune', dwellSec: 8,
    text: 'The windiest world — 2,100 km/h supersonic storms. It has completed just one orbit since its discovery in 1846.' },
  { bodyId: 'pluto', title: 'Pluto', dwellSec: 8,
    text: 'A Kuiper-belt world with a nitrogen-ice heart. Its orbit is so eccentric it sometimes comes closer to the Sun than Neptune.' },
  { bodyId: 'halley', title: 'Halley\'s Comet', dwellSec: 10,
    text: 'Returns every ~76 years; next perihelion 2061. Time-warp there and watch its ion and dust tails unfurl near the Sun.' },
];

export class TourController {
  private sceneManager: SceneManager;
  private getBodies: () => CelestialBody[];
  private captionEl: HTMLElement;
  private titleEl: HTMLElement;
  private textEl: HTMLElement;
  private index = -1;
  private dwellTimer: number | null = null;

  onSelectBody?: (body: CelestialBody) => void;
  onExit?: () => void;

  constructor(sceneManager: SceneManager, getBodies: () => CelestialBody[]) {
    this.sceneManager = sceneManager;
    this.getBodies = getBodies;
    this.captionEl = document.getElementById('tour-caption')!;
    this.titleEl = this.captionEl.querySelector('.tour-title')!;
    this.textEl = this.captionEl.querySelector('.tour-text')!;
    document.getElementById('tour-prev')!.addEventListener('click', () => this.step(-1));
    document.getElementById('tour-next')!.addEventListener('click', () => this.step(1));
    document.getElementById('tour-exit')!.addEventListener('click', () => this.stop());
  }

  get active(): boolean { return this.index >= 0; }

  start(): void {
    this.index = -1;
    this.captionEl.classList.add('visible');
    this.step(1);
  }

  stop(): void {
    this.index = -1;
    this.captionEl.classList.remove('visible');
    this._clearTimer();
    this.onExit?.();
  }

  step(dir: 1 | -1): void {
    this._clearTimer();
    let next = this.index + dir;
    // Skip stops whose body doesn't exist (e.g. merged away)
    while (next >= 0 && next < STOPS.length) {
      const body = this.getBodies().find(b => b.state.id === STOPS[next]!.bodyId);
      if (body) break;
      next += dir;
    }
    if (next < 0 || next >= STOPS.length) {
      this.stop();
      return;
    }
    this.index = next;
    const stop = STOPS[next]!;
    const body = this.getBodies().find(b => b.state.id === stop.bodyId)!;

    this.titleEl.textContent = `${next + 1}/${STOPS.length} — ${stop.title}`;
    this.textEl.textContent = stop.text;
    this.onSelectBody?.(body);
    this.sceneManager.focusOn(body);

    this.dwellTimer = window.setTimeout(() => {
      if (this.active) this.step(1);
    }, (stop.dwellSec + 1.7) * 1000);
  }

  private _clearTimer(): void {
    if (this.dwellTimer !== null) {
      clearTimeout(this.dwellTimer);
      this.dwellTimer = null;
    }
  }
}
