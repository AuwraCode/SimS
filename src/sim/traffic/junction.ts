import type { Signal } from "../types";

/**
 * Fixed-cycle two-phase signal evaluation.
 *
 * Phase A (vertical/NS approaches) is green during [0, greenS) of the cycle,
 * phase B (horizontal/EW) during [cycle/2, cycle/2 + greenS); the remainders
 * are all-red clearance. The phase is a *periodic* function of absolute time —
 * the identical plan runs at 03:00 and at 08:00 — so signals are
 * One-Rule-compliant infrastructure: they cannot know about rush hour, only
 * meter whatever demand shows up.
 */
export function isApproachGreen(signal: Signal, axis: 0 | 1, t: number): boolean {
  const ph = (t + signal.offsetS) % signal.cycleS;
  if (axis === 0) return ph < signal.greenS;
  const half = signal.cycleS / 2;
  return ph >= half && ph < half + signal.greenS;
}
