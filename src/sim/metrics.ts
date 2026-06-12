import type { SimsConfig } from "../config";
import type { Scheduler } from "./scheduler";
import type { TrafficEngine } from "./traffic/engine";
import type { Network, TripArrival } from "./types";
import type { WalkSystem } from "./walkers";

/**
 * Live aggregates, sampled once per sim-minute. Pure observations: the only
 * series that feeds back into behaviour is the Router's edge-time EMA, which
 * is drivers reacting to measured traffic — never traffic reacting to the
 * clock.
 */
export class Metrics {
  /** Sample timestamps (s of day). */
  readonly timesS: number[] = [];
  readonly activeTrips: number[] = [];
  /** Mean speed of vehicles en route (km/h); NaN when the road is empty. */
  readonly meanSpeedKmh: number[] = [];
  /** Vehicles currently queued (slower than the queue threshold). */
  readonly queued: number[] = [];
  /** Vehicles stopped longer than the stuck threshold (gridlock telemetry). */
  readonly stuck: number[] = [];
  /** Agents waiting in driveways for room on their home street. */
  readonly waitingDepart: number[] = [];
  /** Pedestrians en route. */
  readonly walkers: number[] = [];
  /** People currently at work (the "businesses are open" signal). */
  readonly atWork: number[] = [];
  /** Per-bridge crossings per minute (arterial / local bridge). */
  readonly bridgeAFlow: number[] = [];
  readonly bridgeBFlow: number[] = [];
  /** Completed legs, in arrival order. */
  readonly trips: TripArrival[] = [];

  private nextSampleT = 0;
  private lastBridgeA = 0;
  private lastBridgeB = 0;
  private readonly bridgeAEdges: number[] = [];
  private readonly bridgeBEdges: number[] = [];
  private readonly sampleEveryS: number;
  private readonly stuckThresholdS: number;
  private readonly queueSpeed = 2; // m/s — slower than this counts as queued

  constructor(cfg: SimsConfig, net: Network) {
    this.sampleEveryS = cfg.metrics.sampleEveryS;
    this.stuckThresholdS = cfg.metrics.stuckThresholdS;
    const cols = [...new Set(net.edges.filter((e) => e.isBridge).map((e) => e.bridgeCol))].sort(
      (a, b) => a - b,
    );
    for (const e of net.edges) {
      if (!e.isBridge) continue;
      (e.bridgeCol === cols[0] ? this.bridgeAEdges : this.bridgeBEdges).push(e.id);
    }
  }

  /** Call after every step; cheap unless a sample boundary was crossed. */
  update(t: number, engine: TrafficEngine, walk: WalkSystem, scheduler: Scheduler): boolean {
    if (scheduler.completed.length > 0) {
      for (const trip of scheduler.completed) this.trips.push(trip);
      scheduler.completed.length = 0;
    }
    if (t < this.nextSampleT) return false;
    this.nextSampleT += this.sampleEveryS;

    let count = 0;
    let speedSum = 0;
    let stuck = 0;
    let queued = 0;
    engine.forEachActive((slot) => {
      count++;
      speedSum += engine.vel[slot];
      if (engine.stoppedS[slot] >= this.stuckThresholdS) stuck++;
      if (engine.vel[slot] < this.queueSpeed) queued++;
    });
    this.timesS.push(t);
    this.activeTrips.push(count);
    this.meanSpeedKmh.push(count > 0 ? (speedSum / count) * 3.6 : Number.NaN);
    this.queued.push(queued);
    this.stuck.push(stuck);
    this.waitingDepart.push(engine.waitingCount);
    this.walkers.push(walk.count);
    let atWork = 0;
    for (let i = 0; i < scheduler.workersAt.length; i++) atWork += scheduler.workersAt[i];
    this.atWork.push(atWork);

    const minutes = this.sampleEveryS / 60;
    let a = 0;
    for (const id of this.bridgeAEdges) a += engine.edgeEntries[id];
    let b = 0;
    for (const id of this.bridgeBEdges) b += engine.edgeEntries[id];
    this.bridgeAFlow.push((a - this.lastBridgeA) / minutes);
    this.bridgeBFlow.push((b - this.lastBridgeB) / minutes);
    this.lastBridgeA = a;
    this.lastBridgeB = b;
    return true;
  }

  /** Mean trip delay vs free-flow (s) over completed car legs (optionally one kind). */
  meanDelayS(kind?: TripArrival["kind"]): number {
    let sum = 0;
    let n = 0;
    for (const trip of this.trips) {
      if (trip.mode !== "car") continue;
      if (kind !== undefined && trip.kind !== kind) continue;
      sum += trip.arriveS - trip.plannedDepartS - trip.freeFlowS;
      n++;
    }
    return n > 0 ? sum / n : 0;
  }
}
