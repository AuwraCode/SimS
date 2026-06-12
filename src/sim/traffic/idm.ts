import type { SimsConfig } from "../../config";

/**
 * Intelligent Driver Model (Treiber et al.).
 *
 * Why this single formula is where jams come from: each driver accelerates
 * toward a desired speed v0 (the "free road" term 1 − (v/v0)⁴) but is braked
 * by the interaction term (s* / s)², where the desired gap s* grows with speed
 * (v·T) and with closing rate (v·Δv / 2√(ab)). When inflow to a road exceeds
 * its discharge rate, gaps shrink, the interaction term dominates, and
 * vehicles decelerate — each braking driver forces the next to brake slightly
 * harder, so disturbances amplify backwards into stop-and-go waves and
 * standing queues. Nobody "decides" there is a jam; it is the fixed point of
 * many coupled gap-keeping controllers with finite road to share.
 */

export interface Idm {
  a: number;
  b: number;
  s0: number;
  vehLen: number;
  accelFloor: number;
  /** Precomputed 1 / (2√(a·b)). */
  inv2SqrtAB: number;
  turnSpeed: number;
  turnZone: number;
  /** Extra slack (m) on the amber-commit braking-distance test. */
  commitPad: number;
}

export function makeIdm(cfg: SimsConfig): Idm {
  const { a, b, s0, vehicleLength, accelFloor, turnSpeed, turnZone } = cfg.idm;
  return {
    a,
    b,
    s0,
    vehLen: vehicleLength,
    accelFloor,
    inv2SqrtAB: 1 / (2 * Math.sqrt(a * b)),
    turnSpeed,
    turnZone,
    commitPad: 2,
  };
}

/**
 * IDM acceleration. `gap` is bumper-to-bumper distance to the leader (or to a
 * virtual standing wall at a stop line), `vLead` the leader's speed.
 * (v/v0)⁴ is written as two squarings: Math.pow is not identically rounded
 * across JS engines and would break cross-environment determinism.
 */
export function idmAccel(
  idm: Idm,
  v: number,
  v0: number,
  T: number,
  gap: number,
  vLead: number,
): number {
  const dv = v - vLead;
  const sStarRaw = idm.s0 + v * T + v * dv * idm.inv2SqrtAB;
  const sStar = sStarRaw > idm.s0 ? sStarRaw : idm.s0;
  const g = gap > 0.01 ? gap : 0.01;
  const z = v / v0;
  const z2 = z * z;
  const ratio = sStar / g;
  const acc = idm.a * (1 - z2 * z2 - ratio * ratio);
  return acc < idm.accelFloor ? idm.accelFloor : acc > idm.a ? idm.a : acc;
}

/** Zero-allocation output of `ballistic`. */
export const ballisticOut = { dx: 0, v: 0 };

/**
 * Ballistic position update with the stop-within-step correction: when the
 * commanded deceleration would cross v = 0 inside the step, integrate only to
 * the stopping point. Without this, queued vehicles near stop lines roll
 * BACKWARDS (the naive x += v·dt + ½a·dt² keeps integrating past the stop).
 */
export function ballistic(v: number, acc: number, dt: number): void {
  if (v + acc * dt < 0) {
    ballisticOut.dx = acc < 0 ? (-0.5 * v * v) / acc : 0;
    ballisticOut.v = 0;
  } else {
    ballisticOut.dx = v * dt + 0.5 * acc * dt * dt;
    ballisticOut.v = v + acc * dt;
  }
}
