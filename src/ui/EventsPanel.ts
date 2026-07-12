import { UpcomingEvent, scanUpcomingEvents } from '../utils/EventPredictor';

// ---------------------------------------------------------------------------
// "Upcoming Events" panel: scans the ephemeris forward from the current sim
// date for eclipses, conjunctions, and oppositions; each row jumps the
// simulation there with the camera pre-positioned.
// ---------------------------------------------------------------------------

const TYPE_ICONS: Record<UpcomingEvent['type'], string> = {
  'solar-eclipse': '☀',
  'lunar-eclipse': '☾',
  'conjunction': '☌',
  'opposition': '☍',
};

export class EventsPanel {
  private listEl: HTMLElement;
  private scanBtn: HTMLButtonElement;
  private scanning = false;
  events: UpcomingEvent[] = [];

  onJump?: (ev: UpcomingEvent) => void;
  onEventsChanged?: (events: UpcomingEvent[]) => void;
  /** Supplies the scan start date (current sim date). */
  getStartDate: () => Date = () => new Date();

  constructor() {
    this.listEl = document.getElementById('up-list')!;
    this.scanBtn = document.getElementById('up-scan') as HTMLButtonElement;
    this.scanBtn.addEventListener('click', () => void this.scan());
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    this.scanBtn.disabled = true;
    try {
      this.events = await scanUpcomingEvents(this.getStartDate(), 730, frac => {
        this.scanBtn.textContent = `${Math.round(frac * 100)}%`;
      });
      this._render();
      this.onEventsChanged?.(this.events);
    } finally {
      this.scanning = false;
      this.scanBtn.disabled = false;
      this.scanBtn.textContent = 'Rescan';
    }
  }

  private _render(): void {
    this.listEl.innerHTML = '';
    if (this.events.length === 0) {
      this.listEl.innerHTML = '<div style="color:#5a6685">No events found in the next 2 years.</div>';
      return;
    }
    for (const ev of this.events) {
      const row = document.createElement('div');
      row.className = `up-row ${ev.type}`;
      const label = document.createElement('span');
      label.className = 'up-label';
      label.textContent = `${TYPE_ICONS[ev.type]} ${ev.label}`;
      const date = document.createElement('span');
      date.className = 'up-date';
      date.textContent = ev.date.toISOString().slice(0, 10);
      row.append(label, date);
      row.addEventListener('click', () => this.onJump?.(ev));
      this.listEl.appendChild(row);
    }
  }
}
