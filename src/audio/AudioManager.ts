// ---------------------------------------------------------------------------
// Generative WebAudio soundscape — zero assets. A deep space pad (detuned
// oscillators + filtered noise) that brightens near the Sun, plus small
// interaction SFX (select ping, spawn thump, merge boom). Autoplay policy:
// the context starts on the first user gesture.
// ---------------------------------------------------------------------------

export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private padFilter: BiquadFilterNode | null = null;
  private muted: boolean;

  constructor() {
    this.muted = localStorage.getItem('sss-muted') === '1';
    const boot = () => {
      this._init();
      window.removeEventListener('pointerdown', boot);
      window.removeEventListener('keydown', boot);
    };
    window.addEventListener('pointerdown', boot);
    window.addEventListener('keydown', boot);
  }

  get isMuted(): boolean { return this.muted; }

  setMuted(muted: boolean): void {
    this.muted = muted;
    localStorage.setItem('sss-muted', muted ? '1' : '0');
    if (this.master && this.ctx) {
      this.master.gain.linearRampToValueAtTime(
        muted ? 0 : 0.14, this.ctx.currentTime + 0.4);
    }
  }

  toggleMuted(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private _init(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.14;
    this.master.connect(ctx.destination);

    // --- Ambient pad: two detuned deep oscillators through a slow filter ---
    const padGain = ctx.createGain();
    padGain.gain.value = 0.5;
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 160;
    this.padFilter.Q.value = 0.8;

    for (const [freq, type] of [[54, 'sine'], [54.35, 'sine'], [108.2, 'triangle']] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = freq > 100 ? 0.12 : 0.4;
      osc.connect(g).connect(this.padFilter);
      osc.start();
    }

    // Airy noise bed
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * 0.35;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = 'bandpass';
    noiseFilter.frequency.value = 420;
    noiseFilter.Q.value = 0.45;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = 0.05;
    noise.connect(noiseFilter).connect(noiseGain).connect(padGain);
    noise.start();

    // Slow LFO breathing the filter open/closed
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.02;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 60;
    lfo.connect(lfoGain).connect(this.padFilter.frequency);
    lfo.start();

    this.padFilter.connect(padGain).connect(this.master);
  }

  /** Brighten the pad when the camera is near the Sun (distance in scene units). */
  updateListener(camDistToSun: number): void {
    if (!this.padFilter || !this.ctx) return;
    const closeness = Math.max(0, Math.min(1, 1 - camDistToSun / 600));
    const target = 120 + closeness * 420;
    this.padFilter.frequency.setTargetAtTime(target, this.ctx.currentTime, 1.5);
  }

  private _blip(freqFrom: number, freqTo: number, duration: number, gain: number, type: OscillatorType = 'sine'): void {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freqFrom, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(Math.max(freqTo, 1), ctx.currentTime + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(1e-4, ctx.currentTime + duration);
    osc.connect(g).connect(this.master);
    osc.start();
    osc.stop(ctx.currentTime + duration + 0.05);
  }

  selectPing(): void { this._blip(880, 1320, 0.18, 0.25); }
  spawnThump(): void { this._blip(150, 48, 0.35, 0.5, 'triangle'); }
  uiTick(): void { this._blip(660, 660, 0.06, 0.12); }

  mergeBoom(massKg: number): void {
    if (!this.ctx || !this.master || this.muted) return;
    const ctx = this.ctx;
    const size = Math.max(0, Math.min(1, (Math.log10(Math.max(massKg, 1)) - 15) / 15));
    this._blip(90 + 40 * size, 28, 0.9, 0.5 + size * 0.4, 'sawtooth');
    // Noise burst
    const buf = ctx.createBuffer(1, ctx.sampleRate * 0.5, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 300 + size * 500;
    const g = ctx.createGain();
    g.gain.value = 0.3 + size * 0.3;
    src.connect(f).connect(g).connect(this.master);
    src.start();
  }
}
