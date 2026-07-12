// ---------------------------------------------------------------------------
// Ctrl+K / '/' command palette: fuzzy-search bodies (select & fly) and
// actions (toggle trails, god mode, tour, …). With 23 bodies — many of them
// tiny hard-to-click moons — this is the fastest navigation primitive.
// ---------------------------------------------------------------------------

export interface PaletteItem {
  label: string;
  kind: 'body' | 'action';
  run: () => void;
}

/** Subsequence fuzzy match; lower score = better, null = no match. */
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastHit = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += lastHit >= 0 ? (ti - lastHit - 1) : ti * 0.5;
      lastHit = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return score + t.length * 0.01;
}

export class CommandPalette {
  private backdrop: HTMLElement;
  private panel: HTMLElement;
  private input: HTMLInputElement;
  private resultsEl: HTMLElement;
  private items: PaletteItem[] = [];
  private filtered: PaletteItem[] = [];
  private activeIdx = 0;

  /** Called each time the palette opens, to refresh the item list. */
  getItems: () => PaletteItem[] = () => [];

  constructor() {
    this.backdrop = document.getElementById('palette-backdrop')!;
    this.panel = document.getElementById('palette')!;
    this.input = document.getElementById('palette-input') as HTMLInputElement;
    this.resultsEl = document.getElementById('palette-results')!;

    this.backdrop.addEventListener('click', () => this.close());
    this.input.addEventListener('input', () => this._filter());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); this._move(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); this._runActive(); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
      e.stopPropagation(); // don't trigger global shortcuts while typing
    });

    window.addEventListener('keydown', (e) => {
      const tag = (e.target as HTMLElement).tagName;
      const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        this.toggle();
      } else if (e.key === '/' && !typing && !this.isOpen) {
        e.preventDefault();
        this.open();
      }
    });
  }

  get isOpen(): boolean { return this.panel.style.display === 'block'; }

  toggle(): void { this.isOpen ? this.close() : this.open(); }

  open(): void {
    this.items = this.getItems();
    this.panel.style.display = 'block';
    this.backdrop.style.display = 'block';
    this.input.value = '';
    this._filter();
    this.input.focus();
  }

  close(): void {
    this.panel.style.display = 'none';
    this.backdrop.style.display = 'none';
    this.input.blur();
  }

  private _filter(): void {
    const q = this.input.value.trim();
    if (!q) {
      this.filtered = this.items.slice(0, 12);
    } else {
      this.filtered = this.items
        .map(item => ({ item, score: fuzzyScore(q, item.label) }))
        .filter((x): x is { item: PaletteItem; score: number } => x.score !== null)
        .sort((a, b) => a.score - b.score)
        .slice(0, 12)
        .map(x => x.item);
    }
    this.activeIdx = 0;
    this._render();
  }

  private _move(dir: number): void {
    if (this.filtered.length === 0) return;
    this.activeIdx = (this.activeIdx + dir + this.filtered.length) % this.filtered.length;
    this._render();
  }

  private _runActive(): void {
    const item = this.filtered[this.activeIdx];
    if (!item) return;
    this.close();
    item.run();
  }

  private _render(): void {
    this.resultsEl.innerHTML = '';
    this.filtered.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'palette-row' + (i === this.activeIdx ? ' active' : '');
      const label = document.createElement('span');
      label.textContent = item.label;
      const kind = document.createElement('span');
      kind.className = 'palette-kind';
      kind.textContent = item.kind;
      row.append(label, kind);
      row.addEventListener('click', () => {
        this.activeIdx = i;
        this._runActive();
      });
      this.resultsEl.appendChild(row);
    });
  }
}
