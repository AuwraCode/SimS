/**
 * Speed → color ramp. Ratio is v / EDGE speed limit (not a global max —
 * otherwise slow local streets would render permanently "congested" and the
 * actual jams would not stand out).
 */
const STEPS = 48;

export function makeSpeedRamp(): string[] {
  const ramp: string[] = [];
  for (let i = 0; i < STEPS; i++) {
    const r = i / (STEPS - 1);
    const hue = 125 * r; // 0 = red (stopped) → 125 = green (free flow)
    ramp.push(`hsl(${hue.toFixed(0)} 85% 55%)`);
  }
  return ramp;
}

export function rampColor(ramp: string[], ratio: number): string {
  const r = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
  return ramp[Math.round(r * (STEPS - 1))];
}
