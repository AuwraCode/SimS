/**
 * The city's soundscape — entirely synthesized in the Web Audio API, no asset
 * files. Like the building lights, every sound is a READ of live simulation
 * state: a low traffic rumble whose loudness tracks how many cars are actually
 * moving, a soft ambient pad that lifts by day, sirens while emergencies are
 * live, and the odd horn when the queues get bad. The AudioContext can only
 * start from a user gesture (browser autoplay policy), so `resume()` is wired
 * to the first click / play.
 *
 * This lives outside sim/ on purpose: it uses Math.random for horn timing and
 * touches no deterministic stream.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private rumble: GainNode | null = null;
  private pad: GainNode | null = null;
  private siren: GainNode | null = null;
  /** Starts muted: sound is strictly opt-in via the Sound button (a gesture). */
  muted = true;

  /** Start (or resume) audio from a user gesture. Idempotent. */
  resume(): void {
    if (this.ctx === null) {
      this.init();
      return;
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    if (this.master !== null && this.ctx !== null) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.05);
    }
    return this.muted;
  }

  private init(): void {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (Ctor === undefined) return;
    const ctx = new Ctor();
    this.ctx = ctx;
    const master = ctx.createGain();
    master.gain.value = this.muted ? 0 : 0.9;
    master.connect(ctx.destination);
    this.master = master;

    // Traffic rumble: looping brown noise through a low-pass.
    const noise = this.brownNoise(ctx);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 360;
    const rumble = ctx.createGain();
    rumble.gain.value = 0;
    noise.connect(lp);
    lp.connect(rumble);
    rumble.connect(master);
    noise.start();
    this.rumble = rumble;

    // Ambient pad: a soft detuned triad.
    const pad = ctx.createGain();
    pad.gain.value = 0.0;
    pad.connect(master);
    for (const f of [110, 164.81, 220]) {
      const o = ctx.createOscillator();
      o.type = "triangle";
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = 0.09;
      o.connect(g);
      g.connect(pad);
      o.start();
    }
    this.pad = pad;

    // Siren: a sawtooth whose pitch is swept by a slow LFO (the wail).
    const siren = ctx.createGain();
    siren.gain.value = 0;
    siren.connect(master);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 720;
    const lfo = ctx.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 0.5;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 170;
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(siren);
    osc.start();
    lfo.start();
    this.siren = siren;
  }

  private brownNoise(ctx: AudioContext): AudioBufferSourceNode {
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      d[i] = last * 3.5;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    return src;
  }

  /**
   * Per-frame mix. activeFrac/queuedFrac in [0,1], day01 0=night..1=day.
   * Gains glide so the mix never clicks.
   */
  update(activeFrac: number, queuedFrac: number, day01: number, emergency: boolean): void {
    if (this.ctx === null) return;
    const now = this.ctx.currentTime;
    const a = Math.min(1, activeFrac);
    if (this.rumble !== null) this.rumble.gain.setTargetAtTime(0.02 + 0.55 * a, now, 0.5);
    if (this.pad !== null) this.pad.gain.setTargetAtTime(0.08 + 0.1 * day01, now, 0.8);
    if (this.siren !== null) this.siren.gain.setTargetAtTime(emergency ? 0.06 : 0, now, 0.3);
    // Occasional horn when the road is clogged.
    if (!this.muted && queuedFrac > 0.18 && Math.random() < queuedFrac * 0.06) this.honk();
  }

  private honk(): void {
    if (this.ctx === null || this.master === null) return;
    const now = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    o.type = "square";
    o.frequency.value = 360 + Math.random() * 140;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.12, now + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
    o.connect(g);
    g.connect(this.master);
    o.start(now);
    o.stop(now + 0.3);
  }
}
