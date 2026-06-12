import type { SimsConfig } from "../config";
import type { TrafficEngine, TripRecord } from "./traffic/engine";

/**
 * Live aggregates, sampled once per sim-minute. These are pure observations —
 * nothing reads them back into behaviour (in Phase 1; Phase 2's re-routing
 * will observe edge travel times, which is drivers reacting to traffic, not
 * traffic reacting to the clock).
 */
export class Metrics {
  /** Sample timestamps (s of day). */
  readonly timesS: number[] = [];
  readonly activeTrips: number[] = [];
  /** Mean speed of vehicles en route (km/h); NaN when the road is empty. */
  readonly meanSpeedKmh: number[] = [];
  /** Vehicles stopped longer than the stuck threshold (gridlock telemetry). */
  readonly stuck: number[] = [];
  /** Agents waiting in driveways for room on their home street. */
  readonly waitingDepart: number[] = [];
  /** Transfers onto bridge edges per minute (calibration telemetry). */
  readonly bridgeFlowPerMin: number[] = [];
  /** Completed trips, in arrival order. */
  readonly trips: TripRecord[] = [];

  private nextSampleT = 0;
  private lastBridgeCrossings = 0;
  private readonly sampleEveryS: number;
  private readonly stuckThresholdS: number;

  constructor(cfg: SimsConfig) {
    this.sampleEveryS = cfg.metrics.sampleEveryS;
    this.stuckThresholdS = cfg.metrics.stuckThresholdS;
  }

  /** Call after every engine step; cheap unless a sample boundary was crossed. */
  update(t: number, engine: TrafficEngine): boolean {
    if (engine.arrivals.length > 0) {
      for (const trip of engine.arrivals) this.trips.push(trip);
      engine.arrivals.length = 0;
    }
    if (t < this.nextSampleT) return false;
    this.nextSampleT += this.sampleEveryS;

    let count = 0;
    let speedSum = 0;
    let stuck = 0;
    engine.forEachActive((slot) => {
      count++;
      speedSum += engine.vel[slot];
      if (engine.stoppedS[slot] >= this.stuckThresholdS) stuck++;
    });
    this.timesS.push(t);
    this.activeTrips.push(count);
    this.meanSpeedKmh.push(count > 0 ? (speedSum / count) * 3.6 : Number.NaN);
    this.stuck.push(stuck);
    this.waitingDepart.push(engine.waitingCount);
    const minutes = this.sampleEveryS / 60;
    this.bridgeFlowPerMin.push((engine.bridgeCrossings - this.lastBridgeCrossings) / minutes);
    this.lastBridgeCrossings = engine.bridgeCrossings;
    return true;
  }

  /** Mean trip delay vs free-flow (s), over completed trips. */
  meanDelayS(): number {
    if (this.trips.length === 0) return 0;
    let sum = 0;
    for (const trip of this.trips) {
      sum += trip.arriveS - trip.plannedDepartS - trip.freeFlowS;
    }
    return sum / this.trips.length;
  }
}
