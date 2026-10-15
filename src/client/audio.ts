import type { BounceKind } from '../shared/types';

const NOTE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 'E5' -> Hz */
function hz(name: string): number {
  const semis = NOTE[name[0]] + (Number(name.slice(1)) + 1) * 12;
  return 440 * 2 ** ((semis - 69) / 12);
}

// Menu tune: 32 eighth-notes of lead over a bass note per beat.
const LEAD = [
  'E5', '', 'G5', '', 'C6', '', 'G5', 'E5', 'A5', '', 'G5', '', 'E5', '', 'D5', '',
  'E5', '', 'G5', '', 'C6', '', 'D6', 'C6', 'B5', '', 'G5', '', 'D5', 'E5', 'G5', '',
];
const BASS = ['C3', 'C3', 'C3', 'G2', 'A2', 'A2', 'A2', 'E2', 'F2', 'F2', 'F2', 'C3', 'G2', 'G2', 'G2', 'B2'];
const STEP_S = 60 / 132 / 2;

/** All sound is synthesised, so there is nothing to load. */
export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private crowdGain: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private muted = false;
  private sfxVol = 0.8;
  private musicVol = 0.5;
  private musicOn = false;
  private musicTimer: ReturnType<typeof setInterval> | null = null;
  private nextStep = 0;
  private nextTime = 0;

  /** Browsers only allow audio after a click, so call this from one. */
  unlock(): void {
    if (!this.ctx) {
      const ctx = new AudioContext();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.connect(this.master);

      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

      // Crowd bed: filtered noise that runs all the time at a level set by the game.
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const band = ctx.createBiquadFilter();
      band.type = 'bandpass';
      band.frequency.value = 650;
      band.Q.value = 0.5;
      const low = ctx.createBiquadFilter();
      low.type = 'lowpass';
      low.frequency.value = 1700;
      this.crowdGain = ctx.createGain();
      this.crowdGain.gain.value = 0;
      src.connect(band).connect(low).connect(this.crowdGain).connect(this.sfxBus);
      src.start();
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setVolumes(sfx: number, music: number, muted: boolean): void {
    this.sfxVol = sfx;
    this.musicVol = music;
    this.muted = muted;
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.master || !this.sfxBus || !this.musicBus) return;
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.sfxBus.gain.value = this.sfxVol;
    this.musicBus.gain.value = this.musicVol;
  }

  /** How excited the crowd sounds, 0..1. Call every frame. */
  crowd(level: number): void {
    if (this.ctx && this.crowdGain) {
      this.crowdGain.gain.setTargetAtTime(0.05 + level * 0.22, this.ctx.currentTime, 0.4);
    }
  }

  // --- ball ---

  /** power 0..1 */
  kick(power: number): void {
    const p = Math.min(1, Math.max(0.08, power));
    const vary = 0.92 + Math.random() * 0.16;
    this.tone('sine', (110 + 90 * p) * vary, 45, 0.14, 0.9 * p);
    this.burst(1800, 1800, 'highpass', 0.04, 0.35 * p);
  }

  bounce(kind: BounceKind, speed: number): void {
    const v = Math.min(1, speed / 25);
    const vary = 0.9 + Math.random() * 0.2;
    switch (kind) {
      case 'ground':
        this.tone('sine', 190 * vary, 90, 0.08, 0.5 * v);
        break;
      case 'wall':
      case 'board':
        this.tone('triangle', 150 * vary, 70, 0.1, 0.6 * v);
        this.burst(900, 900, 'lowpass', 0.05, 0.25 * v);
        break;
      case 'roof':
        this.tone('triangle', 420 * vary, 300, 0.12, 0.35 * v);
        this.burst(2400, 2400, 'bandpass', 0.05, 0.2 * v);
        break;
      case 'post':
        this.tone('triangle', 830 * vary, 810 * vary, 0.45, 0.5 * v + 0.15);
        this.tone('sine', 1290 * vary, 1270 * vary, 0.3, 0.3 * v + 0.1);
        break;
      case 'net':
        this.burst(2600, 2000, 'bandpass', 0.28, 0.5 * v + 0.1);
        break;
    }
  }

  // --- crowd and referee ---

  /** The crowd erupts. */
  roar(): void {
    this.burst(700, 1500, 'bandpass', 2.4, 0.9, 0.3);
    this.burst(300, 500, 'bandpass', 1.8, 0.5, 0.2);
  }

  /** A collective "ooh" for a save or the woodwork. */
  ooh(): void {
    this.burst(900, 380, 'bandpass', 0.8, 0.5, 0.08);
  }

  whistle(blasts = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;
    for (let i = 0; i < blasts; i++) {
      const long = i === blasts - 1 && blasts > 1;
      const t = ctx.currentTime + i * 0.42;
      const dur = long ? 0.8 : 0.3;
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 2750;
      const trill = ctx.createOscillator();
      trill.frequency.value = 32;
      const depth = ctx.createGain();
      depth.gain.value = 120;
      trill.connect(depth).connect(osc.frequency);
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = 2750;
      filter.Q.value = 4;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
      gain.gain.setValueAtTime(0.22, t + dur);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
      osc.connect(filter).connect(gain).connect(this.sfxBus);
      osc.start(t);
      trill.start(t);
      osc.stop(t + dur + 0.1);
      trill.stop(t + dur + 0.1);
    }
  }

  // --- arcade ---

  /** A power-up or target collected. */
  pickup(): void {
    this.notes(['E5', 'G5', 'C6', 'E6'], 0.06, 0.14);
  }

  /** A fireball leaves the boot. */
  fire(): void {
    this.burst(300, 2400, 'bandpass', 0.5, 0.7, 0.02);
    this.tone('sawtooth', 90, 40, 0.45, 0.35);
  }

  boing(): void {
    this.tone('sine', 320, 760, 0.12, 0.35);
    this.tone('square', 640, 1280, 0.06, 0.08);
  }

  spring(): void {
    this.tone('sine', 180, 900, 0.22, 0.35);
  }

  warp(): void {
    this.tone('sine', 1200, 180, 0.3, 0.28);
    this.tone('triangle', 600, 90, 0.3, 0.18);
  }

  freeze(): void {
    this.notes(['C7', 'G6', 'E6', 'C6'], 0.05, 0.12, 'triangle');
    this.burst(5000, 3000, 'highpass', 0.3, 0.2);
  }

  /** The boot is stunned. */
  stunned(): void {
    this.tone('square', 220, 110, 0.3, 0.16);
    this.tone('square', 233, 117, 0.3, 0.12);
  }

  /** A modifier or the next growth is announced. */
  sting(): void {
    this.notes(['G5', 'D6'], 0.11, 0.14);
  }

  /** The final frenzy begins. */
  siren(): void {
    this.notes(['A5', 'E5', 'A5', 'E5', 'A5', 'E5'], 0.16, 0.16, 'sawtooth');
  }

  private notes(names: string[], gap: number, vol: number, type: OscillatorType = 'square'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    names.forEach((n, i) => this.tone(type, hz(n), hz(n), gap * 1.6, vol, this.sfxBus, ctx.currentTime + i * gap));
  }

  // --- interface ---

  /** Countdown tick; `go` is the higher final one. */
  beep(go = false): void {
    this.tone('square', go ? 880 : 440, go ? 880 : 440, go ? 0.35 : 0.12, 0.18);
  }

  /** Menu move and confirm. */
  blip(confirm = false): void {
    this.tone('square', confirm ? 660 : 520, confirm ? 990 : 520, confirm ? 0.09 : 0.04, 0.12);
  }

  fanfare(won: boolean): void {
    const notes = won ? ['C5', 'E5', 'G5', 'C6'] : ['G4', 'E4', 'C4'];
    const ctx = this.ctx;
    if (!ctx) return;
    notes.forEach((n, i) => this.tone('square', hz(n), hz(n), 0.22, 0.16, this.sfxBus, ctx.currentTime + i * 0.16));
  }

  // --- music ---

  music(on: boolean): void {
    if (on === this.musicOn) return;
    this.musicOn = on;
    if (this.musicTimer) clearInterval(this.musicTimer);
    this.musicTimer = null;
    if (!on || !this.ctx) return;
    this.nextStep = 0;
    this.nextTime = this.ctx.currentTime + 0.05;
    // Schedule a little ahead so timing does not depend on the frame rate.
    this.musicTimer = setInterval(() => this.schedule(), 25);
  }

  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    while (this.nextTime < ctx.currentTime + 0.12) {
      const i = this.nextStep % LEAD.length;
      const t = this.nextTime;
      if (LEAD[i]) this.tone('square', hz(LEAD[i]), hz(LEAD[i]), STEP_S * 0.9, 0.07, this.musicBus, t);
      if (i % 2 === 0) {
        const b = hz(BASS[(i / 2) % BASS.length]);
        this.tone('triangle', b, b, STEP_S * 1.8, 0.2, this.musicBus, t);
      } else {
        this.burst(6000, 6000, 'highpass', 0.03, 0.05, 0.001, this.musicBus, t);
      }
      this.nextStep++;
      this.nextTime += STEP_S;
    }
  }

  // --- building blocks ---

  private tone(
    type: OscillatorType,
    from: number,
    to: number,
    dur: number,
    vol: number,
    bus: GainNode | null = this.sfxBus,
    at?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !bus) return;
    const t = at ?? ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.0001, vol), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** Filtered noise sweeping from one frequency to another, with an optional fade-in. */
  private burst(
    from: number,
    to: number,
    type: BiquadFilterType,
    dur: number,
    vol: number,
    attack = 0.001,
    bus: GainNode | null = this.sfxBus,
    at?: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !bus || !this.noise) return;
    const t = at ?? ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(to, t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(gain).connect(bus);
    src.start(t, Math.random());
    src.stop(t + dur + 0.02);
  }
}
