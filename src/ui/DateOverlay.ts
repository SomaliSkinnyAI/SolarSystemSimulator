// ---------------------------------------------------------------------------
// DateOverlay — persistent date/time display + date picker modal
// ---------------------------------------------------------------------------

export class DateOverlay {
  private dateEl: HTMLElement;
  private timeEl: HTMLElement;
  private modal: HTMLElement;
  private backdrop: HTMLElement;
  private dateInput: HTMLInputElement;
  private timeInput: HTMLInputElement;

  /** Fires when the user picks a date and clicks Go */
  onDateJump?: (date: Date) => void;

  constructor() {
    this.dateEl    = document.getElementById('date-display')!;
    this.timeEl    = document.getElementById('time-display')!;
    this.modal     = document.getElementById('date-picker-modal')!;
    this.backdrop  = document.getElementById('date-picker-backdrop')!;
    this.dateInput = document.getElementById('date-input') as HTMLInputElement;
    this.timeInput = document.getElementById('time-input') as HTMLInputElement;

    const overlay = document.getElementById('date-overlay')!;
    overlay.addEventListener('click', () => this._openPicker());

    document.getElementById('date-go-btn')!.addEventListener('click', () => this._go());
    document.getElementById('date-cancel-btn')!.addEventListener('click', () => this._closePicker());
    this.backdrop.addEventListener('click', () => this._closePicker());

    // Enter key in inputs triggers Go
    this.dateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._go(); });
    this.timeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._go(); });
  }

  /** Update the displayed date/time (called every frame) */
  updateDisplay(date: Date): void {
    this.dateEl.textContent = date.toISOString().slice(0, 10);
    this.timeEl.textContent = date.toISOString().slice(11, 19) + ' UTC';
  }

  private _openPicker(): void {
    // Pre-fill with current display date
    this.dateInput.value = this.dateEl.textContent ?? '';
    this.timeInput.value = this.timeEl.textContent?.replace(' UTC', '') ?? '12:00:00';
    this.modal.classList.add('open');
    this.backdrop.classList.add('open');
    this.dateInput.focus();
  }

  private _closePicker(): void {
    this.modal.classList.remove('open');
    this.backdrop.classList.remove('open');
  }

  private _go(): void {
    const dateStr = this.dateInput.value;  // YYYY-MM-DD
    const timeStr = this.timeInput.value || '12:00:00';  // HH:MM or HH:MM:SS
    if (!dateStr) return;

    const target = new Date(`${dateStr}T${timeStr}Z`);
    if (isNaN(target.getTime())) return;

    this._closePicker();
    this.onDateJump?.(target);
  }
}
